// 多用户模式：认证 / 会话 / 用户 Key 托管
import crypto from 'node:crypto';
import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { getDb } from './db.js';
import { getConfig } from './config.js';
import { assertPublicHttpsUrl } from './llm.js';
import { ah } from './asyncHandler.js';
import {
  SIGNUP_BONUS,
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

// ---------- AES-256-GCM 用户 Key 托管 ----------
// 存储格式：ivBase64:tagBase64:cipherBase64；空值存 NULL，解密空值返回 ''
export function encryptSecret(masterKeyHex, plaintext) {
  if (!plaintext) return null;
  const key = Buffer.from(masterKeyHex, 'hex');
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([c.update(String(plaintext), 'utf8'), c.final()]);
  return `${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${enc.toString('base64')}`;
}

export function decryptSecret(masterKeyHex, stored) {
  if (!stored) return '';
  const parts = String(stored).split(':');
  if (parts.length !== 3) return '';
  try {
    const key = Buffer.from(masterKeyHex, 'hex');
    const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(parts[0], 'base64'));
    d.setAuthTag(Buffer.from(parts[1], 'base64'));
    return Buffer.concat([d.update(Buffer.from(parts[2], 'base64')), d.final()]).toString('utf8');
  } catch {
    return '';
  }
}

// 解密后的用户 API 配置：{ key, baseUrl, chatModel, workerModel }（无配置时全 ''）
export function getUserApiKeys(userId) {
  const cfg = getConfig();
  const row = getDb().prepare('SELECT * FROM user_api_keys WHERE user_id = ?').get(userId);
  if (!row) return { key: '', baseUrl: '', chatModel: '', workerModel: '' };
  return {
    key: decryptSecret(cfg.masterKey, row.enc_key),
    baseUrl: decryptSecret(cfg.masterKey, row.enc_base_url),
    chatModel: decryptSecret(cfg.masterKey, row.enc_chat_model),
    workerModel: decryptSecret(cfg.masterKey, row.enc_worker_model),
  };
}

export function setUserApiKeys(userId, { key, baseUrl, chatModel, workerModel }) {
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
  };
  const enc = (v) => (v ? encryptSecret(cfg.masterKey, v) : null);
  getDb()
    .prepare(
      `INSERT INTO user_api_keys(user_id, enc_key, enc_base_url, enc_chat_model, enc_worker_model, updated_at)
       VALUES(?,?,?,?,?,?)
       ON CONFLICT(user_id) DO UPDATE SET
         enc_key = excluded.enc_key,
         enc_base_url = excluded.enc_base_url,
         enc_chat_model = excluded.enc_chat_model,
         enc_worker_model = excluded.enc_worker_model,
         updated_at = excluded.updated_at`
    )
    .run(userId, enc(next.key), enc(next.baseUrl), enc(next.chatModel), enc(next.workerModel), Date.now());
}

// ---------- LLM 凭证解析（聊天/摘要/记忆提取/导演/模型列表共用） ----------
// key：多用户模式 → 解密后的用户 key || 服务器默认（忽略 X-OpenRouter-Key，会话即身份）
//      单用户模式 → X-OpenRouter-Key || 服务器默认（原有行为）
// baseUrl/chatModel/workerModel：请求头 > 用户存储值 > 服务器默认
export function llmCreds(req, cfg, requestApiKey) {
  const uid = req.userId;
  const stored = cfg.multiUser && uid ? getUserApiKeys(uid) : { key: '', baseUrl: '', chatModel: '', workerModel: '' };
  const header = (n) => String((req.headers && req.headers[n]) || '').trim();
  const apiKey = cfg.multiUser ? stored.key || cfg.apiKey : requestApiKey(req) || cfg.apiKey;
  // 用户自填地址（请求头 / 已存储）必须过 SSRF 校验；服务器 .env 默认地址由管理员可信配置，不校验
  const userBase = header('x-api-base-url').replace(/\/+$/, '') || stored.baseUrl;
  const baseUrl = userBase ? assertPublicHttpsUrl(userBase) : cfg.baseUrl;
  const chatModel = header('x-chat-model') || stored.chatModel || cfg.chatModel;
  const workerModel = header('x-worker-model') || stored.workerModel || cfg.extractModel;
  return { apiKey, baseUrl, chatModel, workerModel };
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
    const row = getDb().prepare('SELECT id, username FROM users WHERE id = ?').get(uid);
    if (!row) return res.status(401).json({ error: '未登录' });
    res.json({ user: row });
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
    });
    const saved = getUserApiKeys(uid);
    res.json({ ok: true, hasKey: !!saved.key });
  });

  // GET /api/user/api-key（需登录；绝不返回 key 明文）
  app.get('/api/user/api-key', needMulti, (req, res) => {
    const uid = currentUserId(req);
    if (!uid) return res.status(401).json({ error: '未登录' });
    const s = getUserApiKeys(uid);
    res.json({ hasKey: !!s.key, baseUrl: s.baseUrl, chatModel: s.chatModel, workerModel: s.workerModel });
  });

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
      signup_bonus: SIGNUP_BONUS,
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

  // ---------- 积分可用模型管理（管理员） ----------
  // GET /api/admin/points/models：全部模型（含未启用）
  app.get('/api/admin/points/models', needMulti, needLogin, needAdmin, (req, res) => {
    res.json(listPointsModelRows());
  });

  // POST /api/admin/points/models：新增 { model_id, name, description?, input_per_1m, output_per_1m }
  app.post('/api/admin/points/models', needMulti, needLogin, needAdmin, (req, res) => {
    const b = req.body || {};
    const model_id = String(b.model_id || '').trim();
    const name = String(b.name || '').trim() || model_id;
    const description = String(b.description || '').trim();
    const input_per_1m = Math.floor(Number(b.input_per_1m));
    const output_per_1m = Math.floor(Number(b.output_per_1m));
    if (!model_id) return res.status(400).json({ error: '模型 ID 不能为空' });
    if (!input_per_1m || input_per_1m <= 0 || !output_per_1m || output_per_1m <= 0)
      return res.status(400).json({ error: '输入/输出单价必须是大于 0 的整数（积分/1M tokens）' });
    try {
      const r = getDb()
        .prepare(
          'INSERT INTO points_models(model_id, name, description, input_per_1m, output_per_1m, is_active, sort_order, created_at) VALUES(?,?,?,?,?,?,?,?)'
        )
        .run(model_id, name, description, input_per_1m, output_per_1m, 1, 999, new Date().toISOString());
      res.json({ ok: true, id: Number(r.lastInsertRowid) });
    } catch (e) {
      if (String(e.message || '').includes('UNIQUE'))
        return res.status(409).json({ error: '该模型 ID 已存在' });
      throw e;
    }
  });

  // PUT /api/admin/points/models/:id：改名/改价/启用/排序（字段缺省=保持）
  app.put('/api/admin/points/models/:id', needMulti, needLogin, needAdmin, (req, res) => {
    const id = Number(req.params.id);
    const b = req.body || {};
    const row = getDb().prepare('SELECT * FROM points_models WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ error: '模型不存在' });
    const patch = {};
    if (b.name !== undefined) patch.name = String(b.name).trim() || row.name;
    if (b.description !== undefined) patch.description = String(b.description).trim();
    if (b.input_per_1m !== undefined) {
      const v = Math.floor(Number(b.input_per_1m));
      if (!v || v <= 0) return res.status(400).json({ error: '输入单价必须是大于 0 的整数' });
      patch.input_per_1m = v;
    }
    if (b.output_per_1m !== undefined) {
      const v = Math.floor(Number(b.output_per_1m));
      if (!v || v <= 0) return res.status(400).json({ error: '输出单价必须是大于 0 的整数' });
      patch.output_per_1m = v;
    }
    if (b.is_active !== undefined) patch.is_active = b.is_active ? 1 : 0;
    if (b.sort_order !== undefined) patch.sort_order = Math.floor(Number(b.sort_order)) || 0;
    const keys = Object.keys(patch);
    if (keys.length) {
      getDb()
        .prepare(`UPDATE points_models SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`)
        .run(...keys.map((k) => patch[k]), id);
    }
    res.json({ ok: true });
  });

  // DELETE /api/admin/points/models/:id：删除
  app.delete('/api/admin/points/models/:id', needMulti, needLogin, needAdmin, (req, res) => {
    const id = Number(req.params.id);
    const r = getDb().prepare('DELETE FROM points_models WHERE id = ?').run(id);
    if (!r.changes) return res.status(404).json({ error: '模型不存在' });
    res.json({ ok: true });
  });

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
           COALESCE(SUM(CASE WHEN delta > 0 THEN delta ELSE 0 END), 0) AS granted,
           COALESCE(SUM(CASE WHEN delta < 0 THEN -delta ELSE 0 END), 0) AS consumed
         FROM points_ledger`
      )
      .get();
    const balance = db.prepare('SELECT COALESCE(SUM(points_balance), 0) AS s FROM users').get().s;
    // 平台 $ 花费估算：按白名单单价反推（points → 元 → USD，汇率 7.2，仅供参考）
    const tok = db
      .prepare(
        `SELECT model, COALESCE(SUM(tokens_input),0) AS ti, COALESCE(SUM(tokens_output),0) AS too
         FROM points_ledger WHERE delta < 0 AND tokens_input IS NOT NULL GROUP BY model`
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
        `SELECT COALESCE(SUM(CASE WHEN delta < 0 THEN -delta ELSE 0 END), 0) AS consumed,
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
                COALESCE(SUM(CASE WHEN delta > 0 THEN delta ELSE 0 END), 0) AS granted,
                COALESCE(SUM(CASE WHEN delta < 0 THEN -delta ELSE 0 END), 0) AS consumed
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
      map.set(d, { day: d, granted: 0, consumed: 0, newUsers: 0 });
    }
    for (const r of rows) {
      if (map.has(r.day)) Object.assign(map.get(r.day), { granted: r.granted, consumed: r.consumed });
    }
    for (const r of users) {
      if (map.has(r.day)) map.get(r.day).newUsers = r.n;
    }
    res.json([...map.values()]);
  });

  // GET /api/admin/stats/models：模型用量分布
  app.get('/api/admin/stats/models', needMulti, needLogin, needAdmin, (req, res) => {
    const rows = getDb()
      .prepare(
        `SELECT model, COUNT(*) AS calls,
                COALESCE(SUM(tokens_input),0) AS inputTokens,
                COALESCE(SUM(tokens_output),0) AS outputTokens,
                COALESCE(SUM(CASE WHEN delta < 0 THEN -delta ELSE 0 END),0) AS points
         FROM points_ledger WHERE delta < 0 AND model IS NOT NULL
         GROUP BY model ORDER BY points DESC`
      )
      .all();
    res.json(rows);
  });

  // GET /api/admin/stats/top-users：消费排行
  app.get('/api/admin/stats/top-users', needMulti, needLogin, needAdmin, (req, res) => {
    const limit = Math.min(Math.max(parseInt(req.query.limit || '10', 10) || 10, 1), 50);
    const rows = getDb()
      .prepare(
        `SELECT u.username,
                COALESCE(SUM(CASE WHEN l.delta < 0 THEN -l.delta ELSE 0 END),0) AS consumed,
                COALESCE(SUM(CASE WHEN l.delta > 0 THEN l.delta ELSE 0 END),0) AS granted,
                u.points_balance AS balance
         FROM users u LEFT JOIN points_ledger l ON l.user_id = u.id
         GROUP BY u.id ORDER BY consumed DESC LIMIT ?`
      )
      .all(limit);
    res.json(rows);
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
