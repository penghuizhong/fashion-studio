// 多用户模式：认证 / 会话 / 用户 Key 托管
import crypto from 'node:crypto';
import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { getDb } from './db.js';
import { getConfig } from './config.js';

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
  const baseUrl = header('x-api-base-url').replace(/\/+$/, '') || stored.baseUrl || cfg.baseUrl;
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
  app.post('/api/auth/register', needMulti, authLimiter, async (req, res) => {
    const username = String((req.body && req.body.username) || '').trim();
    const password = (req.body && req.body.password) || '';
    if (!USERNAME_RE.test(username)) {
      return res.status(400).json({ error: '用户名需为 3-20 位字母/数字/中文/_/-' });
    }
    if (typeof password !== 'string' || password.length < 8) {
      return res.status(400).json({ error: '密码至少 8 位' });
    }
    const db = getDb();
    if (db.prepare('SELECT id FROM users WHERE username = ?').get(username)) {
      return res.status(409).json({ error: '用户名已存在' });
    }
    const id = randomUUID();
    const hash = await bcrypt.hash(password, 10);
    const t = new Date().toISOString();
    db.transaction(() => {
      db.prepare('INSERT INTO users(id, username, password_hash, created_at) VALUES(?,?,?,?)').run(id, username, hash, t);
      // 首个注册用户：认领全库 user_id IS NULL 的老数据（只执行一次）
      const n = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
      if (n === 1) {
        db.prepare('UPDATE characters SET user_id = ? WHERE user_id IS NULL').run(id);
        db.prepare('UPDATE conversations SET user_id = ? WHERE user_id IS NULL').run(id);
        db.prepare('UPDATE conversation_summaries SET user_id = ? WHERE user_id IS NULL').run(id);
      }
    })();
    db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now()); // 顺手清过期会话
    createSession(req, res, id);
    res.status(201).json({ user: { id, username } });
  });

  // POST /api/auth/login
  app.post('/api/auth/login', needMulti, authLimiter, async (req, res) => {
    const username = String((req.body && req.body.username) || '').trim();
    const password = (req.body && req.body.password) || '';
    const row = getDb().prepare('SELECT * FROM users WHERE username = ?').get(username);
    // 统一错误信息，防用户名枚举
    const pass = row && typeof password === 'string' && (await bcrypt.compare(password, row.password_hash));
    if (!pass) return res.status(401).json({ error: '用户名或密码错误' });
    getDb().prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
    createSession(req, res, row.id);
    res.json({ user: { id: row.id, username: row.username } });
  });

  // POST /api/auth/logout
  app.post('/api/auth/logout', needMulti, (req, res) => {
    destroySession(req, res);
    res.json({ ok: true });
  });

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
}
