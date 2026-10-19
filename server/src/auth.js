// 多用户模式：认证 / 会话 / 用户 Key 托管
import crypto from 'node:crypto';
import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { getDb, getSetting, setSetting } from './db.js';
import { listProviders, getProviderCreds, createProvider, updateProvider, deleteProvider, setDefaultProvider, listModels, createModel, updateModel, deleteModel } from './registry.js';
import { getRoleplayTemplate } from './memory.js';
import { jailbreakPresetAdminList, JAILBREAK_PRESETS } from './jailbreakPresets.js';
import { getConfig } from './config.js';
import { assertPublicHttpsUrl, llmFetch } from './llm.js';
import { fetchUpstreamModels, refreshProviderModels, getCachedModels } from './registry.js';
import { API_PROVIDERS, getProvider, detectProvider } from './providers.js';
import { ah } from './asyncHandler.js';
import { listPresets as listDnaPresets } from './dnaPresets.js';
import {
  listPointsModels,
  listPointsModelRows,
  POINTS_PER_YUAN,
  REASON_LABELS,
  INVITE_REWARD_INVITER,
  INVITE_REWARD_INVITEE,
  INVITE_CHAT_THRESHOLD,
  genInviteCode,
  genRecoveryCode,
  getPointsModel,
  getBalance,
  getLedger,
  grantPoints,
  getSignupBonus,
  setPointsBalance,
} from './points.js';

const COOKIE_NAME = 'soulchat_session';
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000; // 30 天
const RENEW_THRESHOLD_MS = 15 * 24 * 3600 * 1000; // 剩余不足 15 天时顺手续期

// ---------- cookie（手动解析，不引入 cookie-parser） ----------
export function parseCookies(req) {
  const out = {};
  const h = req.headers && req.headers.cookie;
  if (!h) return out;
  for (const part of String(h).split(';')) {
    const i = part.indexOf('=');
    if (i > 0) {
      const k = part.slice(0, i).trim();
      if (k && !(k in out)) {
        try {
          out[k] = decodeURIComponent(part.slice(i + 1).trim());
        } catch {
          out[k] = part.slice(i + 1).trim();
        }
      }
    }
  }
  return out;
}

function setSessionCookie(req, res, token, maxAgeSec) {
  const parts = [`${COOKIE_NAME}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeSec}`];
  if (req.secure) parts.push('Secure'); // trust proxy 下按 X-Forwarded-Proto 自动判断
  res.setHeader('Set-Cookie', parts.join('; '));
}

export function clearSessionCookie(req, res) {
  setSessionCookie(req, res, '', 0);
}

// ---------- 会话 ----------
const sha256hex = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

// 取原始 session 行（含 token，便于续期时重设 cookie）；无/过期返回 null
function getSessionRow(req) {
  const token = parseCookies(req)[COOKIE_NAME];
  if (!token) return null;
  const row = getDb()
    .prepare('SELECT token_hash, user_id, expires_at FROM sessions WHERE token_hash = ?')
    .get(sha256hex(token));
  if (!row || row.expires_at <= Date.now()) return null;
  row.token = token;
  return row;
}

// 从 cookie 取 token → 查 sessions → 返回 user_id 或 null
// 单用户模式下永远返回 null（查询保持原样，不做隔离）
export function currentUserId(req) {
  const cfg = getConfig();
  if (!cfg.multiUser) return null;
  const row = getSessionRow(req);
  return row ? row.user_id : null;
}

// 中间件：解析会话挂到 req.userId；顺手 sliding 续期（非必须，但便宜）
export function sessionMiddleware(req, res, next) {
  req.userId = null;
  const cfg = getConfig();
  if (!cfg.multiUser) return next();
  const row = getSessionRow(req);
  if (!row) return next();
  req.userId = row.user_id;
  if (row.expires_at < Date.now() + RENEW_THRESHOLD_MS) {
    const exp = Date.now() + SESSION_TTL_MS;
    getDb().prepare('UPDATE sessions SET expires_at = ? WHERE token_hash = ?').run(exp, row.token_hash);
    setSessionCookie(req, res, row.token, Math.floor(SESSION_TTL_MS / 1000));
  }
  next();
}

export function createSession(req, res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = Date.now() + SESSION_TTL_MS;
  getDb()
    .prepare('INSERT INTO sessions(token_hash, user_id, expires_at) VALUES(?,?,?)')
    .run(sha256hex(token), userId, expiresAt);
  setSessionCookie(req, res, token, Math.floor(SESSION_TTL_MS / 1000));
  return token;
}

export function destroySession(req, res) {
  const token = parseCookies(req)[COOKIE_NAME];
  if (token) {
    getDb().prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256hex(token));
  }
  clearSessionCookie(req, res);
}

// ---------- AES-256-GCM 用户 Key 托管（v0.2.0: 实现移至 secrets.js，此处 re-export 保持兼容） ----------
import { encryptSecret, decryptSecret } from './secrets.js';
export { encryptSecret, decryptSecret };

// 解密后的用户 API 配置：{ key, baseUrl, chatModel, workerModel, provider }（无配置时全 ''，provider 默认 custom）
// v1.20.0: provider 决定协议参数（关思考/模型 ID 格式），与地址解耦
export function getUserApiKeys(userId) {
  const cfg = getConfig();
  const row = getDb().prepare('SELECT * FROM user_api_keys WHERE user_id = ?').get(userId);
  if (!row) return { key: '', baseUrl: '', chatModel: '', workerModel: '', provider: 'custom' };
  return {
    key: decryptSecret(cfg.masterKey, row.enc_key),
    baseUrl: decryptSecret(cfg.masterKey, row.enc_base_url),
    chatModel: decryptSecret(cfg.masterKey, row.enc_chat_model),
    workerModel: decryptSecret(cfg.masterKey, row.enc_worker_model),
    provider: row.provider || 'custom',
  };
}

export function setUserApiKeys(userId, { key, baseUrl, chatModel, workerModel, provider }) {
  const cfg = getConfig();
  const cur = getUserApiKeys(userId); // 解密后的当前值
  // 合并语义：字段缺席(undefined)=保持原值；空串('')=清除该字段；非空=更新。
  // 注意：前端"保存"时 key 留空表示不覆盖；"清除"按钮才显式传 ''。
  const pick = (v, oldV) => {
    if (v === undefined) return oldV;
    return typeof v === 'string' ? v.trim() : '';
  };
  const next = {
    key: pick(key, cur.key),
    baseUrl: pick(baseUrl, cur.baseUrl),
    chatModel: pick(chatModel, cur.chatModel),
    workerModel: pick(workerModel, cur.workerModel),
    provider: getProvider(pick(provider, cur.provider) || 'custom').id,
  };
  const enc = (v) => (v ? encryptSecret(cfg.masterKey, v) : null);
  getDb()
    .prepare(
      `INSERT INTO user_api_keys(user_id, enc_key, enc_base_url, enc_chat_model, enc_worker_model, provider, updated_at)
       VALUES(?,?,?,?,?,?,?)
       ON CONFLICT(user_id) DO UPDATE SET
         enc_key = excluded.enc_key,
         enc_base_url = excluded.enc_base_url,
         enc_chat_model = excluded.enc_chat_model,
         enc_worker_model = excluded.enc_worker_model,
         provider = excluded.provider,
         updated_at = excluded.updated_at`
    )
    .run(userId, enc(next.key), enc(next.baseUrl), enc(next.chatModel), enc(next.workerModel), next.provider, Date.now());
}

// ---------- LLM 凭证解析（聊天/摘要/记忆提取/导演/模型列表共用） ----------
// key：多用户模式 → 解密后的用户 key || 服务器默认（忽略 X-OpenRouter-Key，会话即身份）
//      单用户模式 → X-OpenRouter-Key || 服务器默认（原有行为）
// baseUrl/chatModel/workerModel：请求头 > 用户存储值 > 服务器默认
export function llmCreds(req, cfg, requestApiKey) {
  const uid = req.userId;
  const stored = cfg.multiUser && uid ? getUserApiKeys(uid) : { key: '', baseUrl: '', chatModel: '', workerModel: '', provider: 'custom' };
  const header = (n) => String((req.headers && req.headers[n]) || '').trim();
  const apiKey = cfg.multiUser ? stored.key || cfg.apiKey : requestApiKey(req) || cfg.apiKey;
  // 用户自填地址（请求头 / 已存储）必须过 SSRF 校验；服务器 .env 默认地址由管理员可信配置，不校验
  const userBase = header('x-api-base-url').replace(/\/+$/, '') || stored.baseUrl;
  const baseUrl = userBase ? assertPublicHttpsUrl(userBase) : cfg.baseUrl;
  const chatModel = header('x-chat-model') || stored.chatModel || cfg.chatModel;
  const workerModel = header('x-worker-model') || stored.workerModel || cfg.extractModel;
  // v1.20.0: 提供商决定协议参数；请求头 > 已存储 > 按地址猜
  const provider = getProvider(header('x-api-provider') || stored.provider || detectProvider(baseUrl)).id;
  return { apiKey, baseUrl, chatModel, workerModel, provider };
}

// v1.18.1: 破限白名单——单用户模式直接放行；多用户模式需 is_admin 或 jailbreak_allowed
export function canUseJailbreak(uid) {
  if (!getConfig().multiUser) return true;
  if (!uid) return false;
  const row = getDb().prepare('SELECT is_admin, jailbreak_allowed FROM users WHERE id = ?').get(uid);
  return !!(row && (row.is_admin || row.jailbreak_allowed));
}

// ---------- 认证路由 ----------
const USERNAME_RE = /^[A-Za-z0-9_\-\u4e00-\u9fa5]{3,20}$/;

export function mountAuthRoutes(app, authLimiter) {
  // 单用户模式下认证路由不可用（原有行为里不存在这些路由）
  const needMulti = (req, res, next) => {
    if (!getConfig().multiUser) return res.status(400).json({ error: '当前为单用户模式，未启用多用户认证' });
    next();
  };

  // POST /api/auth/register
  app.post('/api/auth/register', needMulti, authLimiter, ah(async (req, res) => {
    const username = String((req.body && req.body.username) || '').trim();
    const password = (req.body && req.body.password) || '';
    if (!USERNAME_RE.test(username)) {
      return res.status(400).json({ error: '用户名需为 3-20 位字母/数字/中文/_/-' });
    }
    if (typeof password !== 'string' || password.length < 8) {
      return res.status(400).json({ error: '密码至少 8 位' });
    }
    // bcrypt 最多取 72 字节，超长会被静默截断（前 72 字节相同即视为同一密码），直接拒绝
    if (Buffer.byteLength(password, 'utf8') > 72) {
      return res.status(400).json({ error: '密码太长，最多 72 个字节（中文约 24 个字）' });
    }
    const db = getDb();
    if (db.prepare('SELECT id FROM users WHERE username = ?').get(username)) {
      return res.status(409).json({ error: '用户名已存在' });
    }
    const id = randomUUID();
    const hash = await bcrypt.hash(password, 12);
    const t = new Date().toISOString();
    const isFirst = db.prepare('SELECT COUNT(*) AS n FROM users').get().n === 0;
    // 邀请码：注册时可带 inviteCode；同时生成自己的唯一邀请码
    const inviteCode = String((req.body && req.body.inviteCode) || '').trim().toUpperCase();
    let inviter = null;
    if (inviteCode) {
      inviter = db.prepare('SELECT id FROM users WHERE invite_code = ?').get(inviteCode);
    }
    let myCode = genInviteCode();
    while (db.prepare('SELECT id FROM users WHERE invite_code = ?').get(myCode)) myCode = genInviteCode();
    // 密码重置码：与邀请码独立，注册时发放一次，用于自助找回密码
    let recoveryCode = genRecoveryCode();
    while (db.prepare('SELECT id FROM users WHERE recovery_code = ?').get(recoveryCode)) recoveryCode = genRecoveryCode();
    // 注册奖励改为首次聊天成功后发放（防刷号）：这里只建账，不发积分
    db.transaction(() => {
      db.prepare(
        'INSERT INTO users(id, username, password_hash, created_at, points_balance, billing_mode, is_admin, invite_code, invited_by, recovery_code) VALUES(?,?,?,?,?,?,?,?,?,?)'
      ).run(id, username, hash, t, 0, 'points', isFirst ? 1 : 0, myCode, inviter ? inviter.id : null, recoveryCode);
      // 首个注册用户：认领全库 user_id IS NULL 的老数据（只执行一次）
      if (isFirst) {
        db.prepare('UPDATE characters SET user_id = ? WHERE user_id IS NULL').run(id);
        db.prepare('UPDATE conversations SET user_id = ? WHERE user_id IS NULL').run(id);
        db.prepare('UPDATE conversation_summaries SET user_id = ? WHERE user_id IS NULL').run(id);
      }
    })();
    db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now()); // 顺手清过期会话
    createSession(req, res, id);
    res.status(201).json({ user: { id, username, inviteCode: myCode, recoveryCode } });
  }));

  // POST /api/auth/login
  app.post('/api/auth/login', needMulti, authLimiter, ah(async (req, res) => {
    const username = String((req.body && req.body.username) || '').trim();
    const password = (req.body && req.body.password) || '';
    const row = getDb().prepare('SELECT * FROM users WHERE username = ?').get(username);
    // 统一错误信息，防用户名枚举
    const pass = row && typeof password === 'string' && (await bcrypt.compare(password, row.password_hash));
    if (!pass) return res.status(401).json({ error: '用户名或密码错误' });
    getDb().prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
    createSession(req, res, row.id);
    res.json({ user: { id: row.id, username: row.username } });
  }));

  // POST /api/auth/logout
  app.post('/api/auth/logout', needMulti, (req, res) => {
    destroySession(req, res);
    res.json({ ok: true });
  });

  // POST /api/auth/reset-password：凭用户名 + 密码重置码自助重置密码（限流同登录）
  app.post('/api/auth/reset-password', needMulti, authLimiter, ah(async (req, res) => {
    const username = String((req.body && req.body.username) || '').trim();
    const recoveryCode = String((req.body && req.body.recovery_code) || '').trim().toUpperCase();
    const newPassword = (req.body && req.body.new_password) || '';
    if (typeof newPassword !== 'string' || newPassword.length < 8) {
      return res.status(400).json({ error: '新密码至少 8 位' });
    }
    if (Buffer.byteLength(newPassword, 'utf8') > 72) {
      return res.status(400).json({ error: '新密码太长，最多 72 个字节（中文约 24 个字）' });
    }
    const db = getDb();
    const row = db.prepare('SELECT id, recovery_code FROM users WHERE username = ?').get(username);
    // 统一错误信息，防用户名枚举
    if (!row || !row.recovery_code || row.recovery_code !== recoveryCode) {
      return res.status(401).json({ error: '用户名或重置码错误' });
    }
    const hash = await bcrypt.hash(newPassword, 12);
    // 重置成功后旧重置码作废，换发新码（防泄露过的旧码被复用）
    let newCode = genRecoveryCode();
    while (db.prepare('SELECT id FROM users WHERE recovery_code = ?').get(newCode)) newCode = genRecoveryCode();
    db.transaction(() => {
      db.prepare('UPDATE users SET password_hash = ?, recovery_code = ? WHERE id = ?').run(hash, newCode, row.id);
      // 重置后所有会话失效，需重新登录
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(row.id);
    })();
    res.json({ ok: true, recovery_code: newCode });
  }));

  // GET /api/auth/me
  app.get('/api/auth/me', needMulti, (req, res) => {
    const uid = currentUserId(req);
    if (!uid) return res.status(401).json({ error: '未登录' });
    const row = getDb().prepare('SELECT id, username, is_admin, jailbreak_allowed FROM users WHERE id = ?').get(uid);
    if (!row) return res.status(401).json({ error: '未登录' });
    // v1.18.1: 前端角色设置用 jailbreak_allowed 决定破限开关是否可用
    res.json({ user: { ...row, jailbreak_allowed: !!(row.is_admin || row.jailbreak_allowed) } });
  });

  // PUT /api/user/api-key（需登录；合并语义：字段缺席=保持原值，空串=清除该字段）
  app.put('/api/user/api-key', needMulti, (req, res) => {
    const uid = currentUserId(req);
    if (!uid) return res.status(401).json({ error: '未登录' });
    const b = req.body || {};
    // 自填 API 地址入库前先过 SSRF 校验（非法直接 400，不存储）
    if (typeof b.baseUrl === 'string' && b.baseUrl.trim()) {
      try {
        assertPublicHttpsUrl(b.baseUrl);
      } catch (e) {
        return res.status(e.statusCode || 400).json({ error: e.message });
      }
    }
    setUserApiKeys(uid, {
      key: b.key,
      baseUrl: b.baseUrl,
      chatModel: b.chatModel,
      workerModel: b.workerModel,
      provider: b.provider,
    });
    const saved = getUserApiKeys(uid);
    res.json({ ok: true, hasKey: !!saved.key });
  });

  // GET /api/user/api-key（需登录；绝不返回 key 明文）
  app.get('/api/user/api-key', needMulti, (req, res) => {
    const uid = currentUserId(req);
    if (!uid) return res.status(401).json({ error: '未登录' });
    const s = getUserApiKeys(uid);
    res.json({ hasKey: !!s.key, baseUrl: s.baseUrl, chatModel: s.chatModel, workerModel: s.workerModel, provider: s.provider });
  });

  // v1.20.0: GET /api/providers——API 提供商预设（公开，无密钥）
  app.get('/api/providers', (req, res) => {
    res.json(API_PROVIDERS);
  });

  // v0.2.1: POST /api/user/api-key/test——保存前连通性测试（拉取上游模型列表验证 Key+地址）
  // body: { provider, baseUrl, key }；key 缺席时用已存储的
  app.post(
    '/api/user/api-key/test',
    needMulti,
    ah(async (req, res) => {
      const uid = currentUserId(req);
      if (!uid) return res.status(401).json({ error: '未登录' });
      const b = req.body || {};
      const stored = getUserApiKeys(uid);
      const key = (typeof b.key === 'string' && b.key.trim()) || stored.key;
      const baseUrl = (typeof b.baseUrl === 'string' && b.baseUrl.trim()) || stored.baseUrl;
      const provider = getProvider(b.provider || stored.provider || detectProvider(baseUrl)).id;
      if (!key) return res.json({ ok: false, error: '请填写 API Key' });
      if (!baseUrl) return res.json({ ok: false, error: '请填写 API 地址' });
      let url;
      try {
        url = assertPublicHttpsUrl(baseUrl);
      } catch (e) {
        return res.json({ ok: false, error: e.message });
      }
      try {
        const models = await fetchUpstreamModels({ baseUrl: url, apiKey: key });
        res.json({ ok: true, provider, count: models.length });
      } catch (e) {
        res.json({ ok: false, error: String((e && e.message) || e).slice(0, 200) });
      }
    })
  );

  // ---------- 积分系统 ----------
  const needLogin = (req, res, next) => {
    const uid = currentUserId(req);
    if (!uid) return res.status(401).json({ error: '未登录' });
    req.uid = uid;
    next();
  };

  // GET /api/auth/recovery-code：查看自己的密码重置码（登录态）
  app.get('/api/auth/recovery-code', needMulti, needLogin, (req, res) => {
    const row = getDb().prepare('SELECT recovery_code FROM users WHERE id = ?').get(req.uid);
    res.json({ recovery_code: (row && row.recovery_code) || '' });
  });

  // POST /api/auth/recovery-code/regenerate：重新生成重置码（登录态）
  app.post('/api/auth/recovery-code/regenerate', needMulti, needLogin, (req, res) => {
    const db = getDb();
    let code = genRecoveryCode();
    while (db.prepare('SELECT id FROM users WHERE recovery_code = ?').get(code)) code = genRecoveryCode();
    db.prepare('UPDATE users SET recovery_code = ? WHERE id = ?').run(code, req.uid);
    res.json({ ok: true, recovery_code: code });
  });
  const needAdmin = (req, res, next) => {
    const row = getDb().prepare('SELECT is_admin FROM users WHERE id = ?').get(req.uid);
    if (!row || !row.is_admin) return res.status(403).json({ error: '需要管理员权限' });
    next();
  };

  // GET /api/points：余额 / 计费方式 / 白名单模型 / 是否管理员
  app.get('/api/points', needMulti, needLogin, (req, res) => {
    const cfg = getConfig();
    const u = getDb().prepare('SELECT billing_mode, is_admin FROM users WHERE id = ?').get(req.uid);
    res.json({
      balance: getBalance(req.uid),
      billing_mode: (u && u.billing_mode) || 'points',
      is_admin: !!(u && u.is_admin),
      signup_bonus: getSignupBonus(),
      platform_ready: !!cfg.apiKey,
      models: listPointsModels(true),
    });
  });

  // PUT /api/points/mode：切换计费方式 { mode: 'byok' | 'points' }
  app.put('/api/points/mode', needMulti, needLogin, (req, res) => {
    const mode = String((req.body && req.body.mode) || '').trim();
    if (mode !== 'byok' && mode !== 'points') return res.status(400).json({ error: 'mode 只能是 byok 或 points' });
    getDb().prepare('UPDATE users SET billing_mode = ? WHERE id = ?').run(mode, req.uid);
    res.json({ ok: true, billing_mode: mode });
  });

  // GET /api/points/ledger：消费明细
  app.get('/api/points/ledger', needMulti, needLogin, (req, res) => {
    const limit = Math.min(parseInt(req.query.limit || '20', 10) || 20, 100);
    res.json(
      getLedger(req.uid, limit).map((r) => ({ ...r, reason_label: REASON_LABELS[r.reason] || r.reason }))
    );
  });

  // POST /api/admin/points/grant：管理员发放积分 { username, points }
  app.post('/api/admin/points/grant', needMulti, needLogin, needAdmin, (req, res) => {
    const username = String((req.body && req.body.username) || '').trim();
    const points = Math.floor(Number((req.body && req.body.points) || 0));
    if (!username) return res.status(400).json({ error: '用户名不能为空' });
    if (!points || points <= 0 || points > 1000000)
      return res.status(400).json({ error: '发放数量需在 1~1000000 之间' });
    const target = getDb().prepare('SELECT id, username FROM users WHERE username = ?').get(username);
    if (!target) return res.status(404).json({ error: '用户不存在' });
    const balance = grantPoints(target.id, points, 'admin_grant');
    res.json({ ok: true, username: target.username, granted: points, balance });
  });

  // v1.18.1: POST /api/admin/points/set——管理员直接设用户余额（发放输错时纠正）{ username, balance }
  app.post('/api/admin/points/set', needMulti, needLogin, needAdmin, (req, res) => {
    const username = String((req.body && req.body.username) || '').trim();
    const balance = Math.floor(Number((req.body && req.body.balance) || 0));
    if (!username) return res.status(400).json({ error: '用户名不能为空' });
    if (!Number.isFinite(balance) || balance < 0 || balance > 10000000)
      return res.status(400).json({ error: '余额需在 0~10000000 之间' });
    const target = getDb().prepare('SELECT id, username FROM users WHERE username = ?').get(username);
    if (!target) return res.status(404).json({ error: '用户不存在' });
    const after = setPointsBalance(target.id, balance);
    res.json({ ok: true, username: target.username, balance: after });
  });

  // ---------- v0.2.0: 统一模型注册表管理（供应商 → 模型两层） ----------
  // 密钥只写不读：列表/详情一律掩码；连通测试走服务端代理
  app.get('/api/admin/providers', needMulti, needLogin, needAdmin, (req, res) => {
    res.json({ ok: true, providers: listProviders(false) });
  });
  app.post('/api/admin/providers', needMulti, needLogin, needAdmin, (req, res) => {
    try {
      res.json({ ok: true, provider: createProvider(req.body || {}) });
    } catch (e) {
      res.status(400).json({ error: e.message || '保存失败' });
    }
  });
  app.put('/api/admin/providers/:id', needMulti, needLogin, needAdmin, (req, res) => {
    try {
      res.json({ ok: true, provider: updateProvider(req.params.id, req.body || {}) });
    } catch (e) {
      res.status(400).json({ error: e.message || '保存失败' });
    }
  });
  app.delete('/api/admin/providers/:id', needMulti, needLogin, needAdmin, (req, res) => {
    try {
      res.json(deleteProvider(req.params.id));
    } catch (e) {
      res.status(400).json({ error: e.message || '删除失败' });
    }
  });
  app.post('/api/admin/providers/:id/default', needMulti, needLogin, needAdmin, (req, res) => {
    try {
      setDefaultProvider(req.params.id);
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ error: e.message || '设置失败' });
    }
  });
  // v0.2.1 连通测试 = 拉取上游模型列表（GET /models）：成功即证明 key+地址正确，结果缓存到 providers.models_cache_json
  app.post('/api/admin/providers/:id/test', needMulti, needLogin, needAdmin, async (req, res) => {
    const t0 = Date.now();
    try {
      const r = await refreshProviderModels(req.params.id);
      res.json({ ok: true, latency: Date.now() - t0, count: r.count });
    } catch (e) {
      // 只有“供应商不存在”走 404；上游 401/404 等都是连通失败，走 200 + ok:false（错误信息里带上游状态）
      if (e && e.message === '供应商不存在') return res.status(404).json({ ok: false, error: e.message });
      res.json({ ok: false, latency: Date.now() - t0, error: String((e && e.message) || e).slice(0, 200) });
    }
  });
  // v0.2.1 读缓存的模型列表（上架模型时自动补全模型 ID）
  app.get('/api/admin/providers/:id/models', needMulti, needLogin, needAdmin, async (req, res) => {
    const r = getCachedModels(req.params.id);
    if (!r) return res.status(404).json({ error: '供应商不存在' });
    res.json({ ok: true, models: r.models, cached_at: r.cached_at });
  });

  app.get('/api/admin/models', needMulti, needLogin, needAdmin, (req, res) => {
    res.json({ ok: true, models: listModels({ kind: req.query.kind, activeOnly: false }) });
  });
  app.post('/api/admin/models', needMulti, needLogin, needAdmin, (req, res) => {
    try {
      res.json({ ok: true, model: createModel(req.body || {}) });
    } catch (e) {
      res.status(400).json({ error: e.message || '保存失败' });
    }
  });
  app.put('/api/admin/models/:id', needMulti, needLogin, needAdmin, (req, res) => {
    try {
      res.json({ ok: true, model: updateModel(req.params.id, req.body || {}) });
    } catch (e) {
      res.status(400).json({ error: e.message || '保存失败' });
    }
  });
  app.delete('/api/admin/models/:id', needMulti, needLogin, needAdmin, (req, res) => {
    try {
      res.json(deleteModel(req.params.id));
    } catch (e) {
      res.status(400).json({ error: e.message || '删除失败' });
    }
  });
  // P5: DNA 类目预设管理（schema + 提示词模板存库；单用户模式 400，走 needMulti）
  app.get('/api/admin/dna-presets', needMulti, needLogin, needAdmin, (req, res) => {
    res.json({ ok: true, presets: listDnaPresets(false) });
  });
  app.post('/api/admin/dna-presets', needMulti, needLogin, needAdmin, (req, res) => {
    try {
      const b = req.body || {};
      const id = String(b.id || '').trim().toLowerCase().replace(/[^a-z0-9_]/g, '');
      if (!id) return res.status(400).json({ error: 'id 必填（英文小写/数字/下划线）' });
      if (!String(b.name || '').trim()) return res.status(400).json({ error: '名称必填' });
      const fields = Array.isArray(b.fields) ? b.fields.filter((f) => f && f.key && f.label) : [];
      if (!fields.length) return res.status(400).json({ error: '至少需要一个字段' });
      if(fields.length>64 || new Set(fields.map(f=>f.key)).size!==fields.length || fields.some(f=>!/^[a-z][a-z0-9_]{0,63}$/.test(f.key)||['constructor','prototype','__proto__'].includes(f.key)||typeof f.label!=='string'||f.label.length>100||String(f.hint||'').length>2000))return res.status(400).json({error:'字段 key 必须唯一且安全，字段数最多 64，标签最长 100 字，hint 最长 2000 字'});
      const now = new Date().toISOString();
      getDb().prepare(`INSERT INTO dna_presets(id,name,fields_json,prompt,expand_prompt,sort_order,is_active,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?)`).run(
        id, String(b.name).trim(), JSON.stringify(fields), String(b.prompt || ''), String(b.expand_prompt || '').slice(0, 10000),
        Number(b.sort_order) || 0, b.is_active === false ? 0 : 1, now, now);
      res.json({ ok: true, id });
    } catch (e) {
      res.status(400).json({ error: /UNIQUE|PRIMARY/i.test(e.message) ? 'id 已存在' : (e.message || '保存失败') });
    }
  });
  app.put('/api/admin/dna-presets/:id', needMulti, needLogin, needAdmin, (req, res) => {
    try {
      const b = req.body || {};
      const row = getDb().prepare('SELECT * FROM dna_presets WHERE id=?').get(req.params.id);
      if (!row) return res.status(404).json({ error: '预设不存在' });
      const fields = Array.isArray(b.fields) ? b.fields.filter((f) => f && f.key && f.label) : null;
      if (fields && !fields.length) return res.status(400).json({ error: '至少需要一个字段' });
      if(fields && (fields.length>64 || new Set(fields.map(f=>f.key)).size!==fields.length || fields.some(f=>!/^[a-z][a-z0-9_]{0,63}$/.test(f.key)||['constructor','prototype','__proto__'].includes(f.key)||typeof f.label!=='string'||f.label.length>100||String(f.hint||'').length>2000)))return res.status(400).json({error:'字段 key 必须唯一且安全，字段数最多 64，标签最长 100 字，hint 最长 2000 字'});
      getDb().prepare(`UPDATE dna_presets SET name=?, fields_json=?, prompt=?, expand_prompt=?, sort_order=?, is_active=?, updated_at=? WHERE id=?`).run(
        b.name != null ? String(b.name).trim() : row.name,
        fields ? JSON.stringify(fields) : row.fields_json,
        b.prompt != null ? String(b.prompt) : row.prompt,
        b.expand_prompt != null ? String(b.expand_prompt).slice(0, 10000) : row.expand_prompt,
        b.sort_order != null ? Number(b.sort_order) || 0 : row.sort_order,
        b.is_active != null ? (b.is_active ? 1 : 0) : row.is_active,
        new Date().toISOString(), req.params.id);
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ error: e.message || '保存失败' });
    }
  });
  app.delete('/api/admin/dna-presets/:id', needMulti, needLogin, needAdmin, (req, res) => {
    try {
      const r = getDb().prepare('DELETE FROM dna_presets WHERE id=?').run(req.params.id);
      if (!r.changes) return res.status(404).json({ error: '预设不存在' });
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ error: e.message || '删除失败' });
    }
  });
  // v1.12 模型配置：GET /api/admin/settings → { worker_model, chat_default_model, filter_fallback_models }
  // worker_model：后台模型（群聊导演/记忆/摘要共用），'' = 自动选最便宜
  // chat_default_model：聊天默认模型，'' = 自动选最便宜
  // filter_fallback_models：内容过滤回退链（数组，按优先级）；null = 未设置（用默认 Euryale→Cydonia），[] = 关闭回退
  app.get('/api/admin/settings', needMulti, needLogin, needAdmin, (req, res) => {
    let fb = null;
    try {
      const raw = getSetting('filter_fallback_models', '');
      if (raw) {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) fb = arr;
      }
    } catch {}
    res.json({
      worker_model: getSetting('worker_model', ''),
      chat_default_model: getSetting('chat_default_model', ''),
      filter_fallback_models: fb,
      // v1.18.1: 注册送积分（管理员可配置，默认 100）
      signup_bonus: getSignupBonus(),
      // v1.17.5: 系统提示词模板（管理员可覆盖）
      roleplay_template: getRoleplayTemplate(),
      roleplay_template_custom: String(getSetting('roleplay_template', '') || '').trim().length > 0,
      jailbreak_presets: jailbreakPresetAdminList(),
    });
  });

  // v1.12 模型配置：PUT /api/admin/settings { worker_model?, chat_default_model?, filter_fallback_models? }
  // 值必须为 '' 或已启用的积分模型 model_id；filter_fallback_models 为数组，每项须为已启用模型，[] = 关闭回退
  app.put('/api/admin/settings', needMulti, needLogin, needAdmin, (req, res) => {
    const b = req.body || {};
    const out = {};
    for (const key of ['worker_model', 'chat_default_model']) {
      if (b[key] === undefined) continue;
      const v = String(b[key] || '').trim();
      if (v && !getPointsModel(v)) {
        return res.status(400).json({ error: `模型 ${v} 不存在或未启用` });
      }
      setSetting(key, v);
      out[key] = v;
    }
    if (b.filter_fallback_models !== undefined) {
      const arr = Array.isArray(b.filter_fallback_models) ? b.filter_fallback_models : [];
      const clean = [];
      for (const m of arr) {
        const v = String(m || '').trim();
        if (!v) continue;
        if (!getPointsModel(v)) {
          return res.status(400).json({ error: `模型 ${v} 不存在或未启用` });
        }
        if (!clean.includes(v)) clean.push(v);
      }
      setSetting('filter_fallback_models', JSON.stringify(clean));
      out.filter_fallback_models = clean;
    }
    // v1.17.5: 扮演模式系统模板（空字符串 = 恢复内置）
    if (b.roleplay_template !== undefined) {
      const v = String(b.roleplay_template || '');
      setSetting('roleplay_template', v);
      out.roleplay_template = v;
    }
    // v1.18.1: 注册送积分（0~100000；只影响新用户，已发放不追溯）
    if (b.signup_bonus !== undefined) {
      const v = Math.floor(Number(b.signup_bonus));
      if (!Number.isFinite(v) || v < 0 || v > 100000)
        return res.status(400).json({ error: '注册送积分需在 0~100000 之间' });
      setSetting('signup_bonus', String(v));
      out.signup_bonus = v;
    }
    // v1.17.5: 破限预设 prompt 覆盖（{ key: prompt }；空 prompt = 恢复该预设内置）
    if (b.jailbreak_presets !== undefined) {
      const obj = (b.jailbreak_presets && typeof b.jailbreak_presets === 'object') ? b.jailbreak_presets : {};
      let ov = {};
      try {
        const raw = getSetting('jailbreak_presets_override', '');
        if (raw) ov = JSON.parse(raw) || {};
      } catch {}
      for (const key of Object.keys(JAILBREAK_PRESETS)) {
        if (obj[key] === undefined) continue;
        const p = String(obj[key] || '').trim();
        if (p) ov[key] = { prompt: obj[key] };
        else delete ov[key];
      }
      setSetting('jailbreak_presets_override', JSON.stringify(ov));
      out.jailbreak_presets = jailbreakPresetAdminList();
    }
    res.json({ ok: true, ...out });
  });

  // v1.26.2: 模型连通测试 POST /api/admin/models/test { model_id }
  // 发一个最小请求验证模型可用，返回延迟和成功状态
  app.post('/api/admin/models/test', needMulti, needLogin, needAdmin, ah(async (req, res) => {
    const { model_id } = req.body || {};
    if (!model_id || !String(model_id).trim()) {
      return res.status(400).json({ error: 'model_id 不能为空' });
    }
    const cfg = getConfig();
    // 管理员测试用服务器默认 Key（简化：不走用户 key）
    const apiKey = cfg.apiKey;
    const baseUrl = cfg.baseUrl;
    if (!apiKey && !cfg.mockLlm) {
      return res.status(401).json({ error: '服务器未配置 API Key' });
    }
    if (cfg.mockLlm) {
      return res.json({ ok: true, latency: 10, reply: 'mock' });
    }
    const t0 = Date.now();
    try {
      const r = await llmFetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: String(model_id).trim(),
          messages: [{ role: 'user', content: 'hi' }],
          max_tokens: 5,
        }),
        signal: AbortSignal.timeout(30000),
      });
      const latency = Date.now() - t0;
      if (!r.ok) {
        const t = await r.text().catch(() => '');
        return res.json({ ok: false, latency, error: `HTTP ${r.status}: ${t.slice(0, 200)}` });
      }
      const j = await r.json().catch(() => null);
      const reply = j?.choices?.[0]?.message?.content || '';
      res.json({ ok: true, latency, reply: reply.slice(0, 100) });
    } catch (e) {
      res.json({ ok: false, latency: Date.now() - t0, error: String((e && e.message) || e).slice(0, 200) });
    }
  }));

  // GET /api/admin/users：管理员查看用户列表（q 可选，按用户名模糊搜）
  app.get('/api/admin/users', needMulti, needLogin, needAdmin, (req, res) => {
    const q = String(req.query.q || '').trim();
    const rows = q
      ? getDb()
          .prepare(
            'SELECT id, username, points_balance, billing_mode, created_at FROM users WHERE username LIKE ? ORDER BY created_at DESC LIMIT 50'
          )
          .all(`%${q}%`)
      : getDb()
          .prepare(
            'SELECT id, username, points_balance, billing_mode, created_at FROM users ORDER BY created_at DESC LIMIT 50'
          )
          .all();
    res.json(rows);
  });

  // ---------- 邀请系统 ----------
  // GET /api/invite：我的邀请码与邀请统计
  app.get('/api/invite', needMulti, needLogin, (req, res) => {
    const db = getDb();
    const me = db.prepare('SELECT invite_code FROM users WHERE id = ?').get(req.uid);
    const invited = db.prepare('SELECT COUNT(*) AS n FROM users WHERE invited_by = ?').get(req.uid).n;
    const rewarded = db
      .prepare("SELECT COUNT(*) AS n FROM points_ledger WHERE user_id = ? AND reason = 'invite_reward'")
      .get(req.uid).n;
    res.json({
      code: (me && me.invite_code) || '',
      invitedCount: invited,
      rewardedCount: rewarded,
      inviterReward: INVITE_REWARD_INVITER,
      inviteeBonus: INVITE_REWARD_INVITEE,
      chatThreshold: INVITE_CHAT_THRESHOLD,
    });
  });

  // ---------- 用量统计（管理员） ----------
  // GET /api/admin/stats/overview：总览
  app.get('/api/admin/stats/overview', needMulti, needLogin, needAdmin, (req, res) => {
    const db = getDb();
    const users = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
    const agg = db
      .prepare(
        `SELECT
           COALESCE(SUM(CASE WHEN COALESCE(accounting_delta,delta) > 0 THEN COALESCE(accounting_delta,delta) ELSE 0 END), 0) AS granted,
           COALESCE(SUM(CASE WHEN COALESCE(accounting_delta,delta) < 0 THEN -COALESCE(accounting_delta,delta) ELSE 0 END), 0) AS consumed
         FROM points_ledger`
      )
      .get();
    const balance = db.prepare('SELECT COALESCE(SUM(points_balance), 0) AS s FROM users').get().s;
    // 平台 $ 花费估算：按白名单单价反推（points → 元 → USD，汇率 7.2，仅供参考）
    const tok = db
      .prepare(
        `SELECT model, COALESCE(SUM(tokens_input),0) AS ti, COALESCE(SUM(tokens_output),0) AS too
         FROM points_ledger WHERE COALESCE(accounting_delta,delta) < 0 AND tokens_input IS NOT NULL GROUP BY model`
      )
      .all();
    let estUsd = 0;
    for (const r of tok) {
      const m = getPointsModel(r.model);
      if (m) {
        estUsd += ((r.ti / 1e6) * m.inputPer1M + (r.too / 1e6) * m.outputPer1M) / POINTS_PER_YUAN / 7.2;
      }
    }
    const today = db
      .prepare(
        `SELECT COALESCE(SUM(CASE WHEN COALESCE(accounting_delta,delta) < 0 THEN -COALESCE(accounting_delta,delta) ELSE 0 END), 0) AS consumed,
                COUNT(DISTINCT user_id) AS activeUsers
         FROM points_ledger WHERE substr(created_at, 1, 10) = date('now')`
      )
      .get();
    res.json({
      totalUsers: users,
      totalGranted: agg.granted,
      totalConsumed: agg.consumed,
      totalBalance: balance,
      estCostUsd: Math.round(estUsd * 100) / 100,
      todayConsumed: today.consumed,
      todayActiveUsers: today.activeUsers,
    });
  });

  // GET /api/admin/stats/daily?days=30：每日趋势
  app.get('/api/admin/stats/daily', needMulti, needLogin, needAdmin, (req, res) => {
    const days = Math.min(Math.max(parseInt(req.query.days || '30', 10) || 30, 1), 90);
    const db = getDb();
    const rows = db
      .prepare(
        `SELECT substr(created_at, 1, 10) AS day,
                COALESCE(SUM(CASE WHEN COALESCE(accounting_delta,delta) > 0 THEN COALESCE(accounting_delta,delta) ELSE 0 END), 0) AS granted,
                COALESCE(SUM(CASE WHEN COALESCE(accounting_delta,delta) < 0 THEN -COALESCE(accounting_delta,delta) ELSE 0 END), 0) AS consumed
         FROM points_ledger WHERE created_at >= date('now', ?) GROUP BY day ORDER BY day ASC`
      )
      .all(`-${days} days`);
    const users = db
      .prepare(
        `SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS n FROM users
         WHERE created_at >= date('now', ?) GROUP BY day`
      )
      .all(`-${days} days`);
    const map = new Map();
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
      map.set(d, { day: d, granted: 0, consumed: 0, newUsers: 0, apiCalls: 0 });
    }
    for (const r of rows) {
      if (map.has(r.day)) Object.assign(map.get(r.day), { granted: r.granted, consumed: r.consumed });
    }
    for (const r of users) {
      if (map.has(r.day)) map.get(r.day).newUsers = r.n;
    }
    // v1.19.0: 自带 Key 每日调用次数
    try {
      const apiRows = db
        .prepare(
          `SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS n FROM api_usage
           WHERE created_at >= date('now', ?) GROUP BY day`
        )
        .all(`-${days} days`);
      for (const r of apiRows) {
        if (map.has(r.day)) map.get(r.day).apiCalls = r.n;
      }
    } catch {}
    res.json([...map.values()]);
  });

  // GET /api/admin/stats/models：模型用量分布
  // v1.18.3: 加用途维度（reason），区分聊天/后台任务/AI 生成
  app.get('/api/admin/stats/models', needMulti, needLogin, needAdmin, (req, res) => {
    const rows = getDb()
      .prepare(
        `SELECT model, reason, COUNT(*) AS calls,
                COALESCE(SUM(tokens_input),0) AS inputTokens,
                COALESCE(SUM(tokens_output),0) AS outputTokens,
                COALESCE(SUM(CASE WHEN COALESCE(accounting_delta,delta) < 0 THEN -COALESCE(accounting_delta,delta) ELSE 0 END),0) AS points
         FROM points_ledger WHERE COALESCE(accounting_delta,delta) < 0 AND model IS NOT NULL
         GROUP BY model, reason ORDER BY points DESC`
      )
      .all();
    res.json(rows.map((r) => ({ ...r, reason_label: REASON_LABELS[r.reason] || r.reason })));
  });

  // v1.19.0: GET /api/admin/stats/api-models——自带 Key 调用按模型+用途分布
  app.get('/api/admin/stats/api-models', needMulti, needLogin, needAdmin, (req, res) => {
    let rows = [];
    try {
      rows = getDb()
        .prepare(
          `SELECT model, reason, COUNT(*) AS calls,
                  COALESCE(SUM(tokens_input),0) AS inputTokens,
                  COALESCE(SUM(tokens_output),0) AS outputTokens
           FROM api_usage GROUP BY model, reason ORDER BY calls DESC`
        )
        .all();
    } catch {}
    res.json(rows.map((r) => ({ ...r, reason_label: REASON_LABELS[r.reason] || r.reason })));
  });

  // GET /api/admin/stats/top-users：消费排行
  app.get('/api/admin/stats/top-users', needMulti, needLogin, needAdmin, (req, res) => {
    const limit = Math.min(Math.max(parseInt(req.query.limit || '10', 10) || 10, 1), 50);
    const rows = getDb()
      .prepare(
        `SELECT u.id, u.username, u.is_admin, u.jailbreak_allowed,
                COALESCE(SUM(CASE WHEN COALESCE(l.accounting_delta,l.delta) < 0 THEN -COALESCE(l.accounting_delta,l.delta) ELSE 0 END),0) AS consumed,
                COALESCE(SUM(CASE WHEN COALESCE(l.accounting_delta,l.delta) > 0 THEN COALESCE(l.accounting_delta,l.delta) ELSE 0 END),0) AS granted,
                u.points_balance AS balance,
                COALESCE((SELECT COUNT(*) FROM api_usage a WHERE a.user_id = u.id), 0) AS api_calls
         FROM users u LEFT JOIN points_ledger l ON l.user_id = u.id
         GROUP BY u.id ORDER BY consumed DESC LIMIT ?`
      )
      .all(limit);
    res.json(rows);
  });

  // v1.18.1: PUT /api/admin/users/:id/jailbreak——管理员授权/撤销破限权限 { allowed: true|false }
  app.put('/api/admin/users/:id/jailbreak', needMulti, needLogin, needAdmin, (req, res) => {
    const target = getDb().prepare('SELECT id, username, is_admin FROM users WHERE id = ?').get(req.params.id);
    if (!target) return res.status(404).json({ error: '用户不存在' });
    const allowed = !!((req.body && req.body.allowed));
    getDb().prepare('UPDATE users SET jailbreak_allowed = ? WHERE id = ?').run(allowed ? 1 : 0, target.id);
    res.json({ ok: true, username: target.username, jailbreak_allowed: allowed || !!target.is_admin });
  });

  // ---------- 角色广场审核 ----------
  // GET /api/admin/shared-cards?status=pending：待审列表（被举报多的排前面）
  app.get('/api/admin/shared-cards', needMulti, needLogin, needAdmin, (req, res) => {
    const status = ['pending', 'approved', 'rejected'].includes(req.query.status) ? req.query.status : 'pending';
    const rows = getDb()
      .prepare(
        `SELECT s.id, s.card_json, s.status, s.reject_reason, s.adopt_count, s.like_count,
                s.report_count, s.created_at, s.reviewed_at, u.username AS author_name
         FROM shared_cards s LEFT JOIN users u ON u.id = s.author_id
         WHERE s.status = ? ORDER BY s.report_count DESC, s.created_at ASC LIMIT 100`
      )
      .all(status);
    res.json(
      rows.map((r) => ({
        id: r.id,
        author_name: r.author_name || '(单用户)',
        card: JSON.parse(r.card_json),
        status: r.status,
        reject_reason: r.reject_reason,
        adopt_count: r.adopt_count,
        like_count: r.like_count,
        report_count: r.report_count,
        created_at: r.created_at,
        reviewed_at: r.reviewed_at,
      }))
    );
  });

  // POST /api/admin/shared-cards/:id/review：{ approve: bool, reason? }
  app.post('/api/admin/shared-cards/:id/review', needMulti, needLogin, needAdmin, (req, res) => {
    const db = getDb();
    const r = db.prepare('SELECT * FROM shared_cards WHERE id = ?').get(req.params.id);
    if (!r) return res.status(404).json({ error: '投稿不存在' });
    const approve = !!(req.body && req.body.approve);
    const reason = String((req.body && req.body.reason) || '').trim().slice(0, 200);
    const t = new Date().toISOString();
    if (approve) {
      db.prepare("UPDATE shared_cards SET status = 'approved', reject_reason = '', report_count = 0, reviewed_at = ? WHERE id = ?").run(t, r.id);
    } else {
      db.prepare("UPDATE shared_cards SET status = 'rejected', reject_reason = ?, reviewed_at = ? WHERE id = ?").run(reason || '不符合上架规范', t, r.id);
    }
    res.json({ ok: true, status: approve ? 'approved' : 'rejected' });
  });
}
