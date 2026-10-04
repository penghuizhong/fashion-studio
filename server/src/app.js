import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { rateLimit, ipKeyGenerator } from 'express-rate-limit';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { getConfig, getVersion, assertMultiUserConfig } from './config.js';
import { getDb } from './db.js';
import { chatStream, NO_KEY_MESSAGE, llmFetch, decideSpeakers } from './llm.js';
import {
  sessionMiddleware,
  currentUserId,
  llmCreds,
  mountAuthRoutes,
} from './auth.js';
import {
  estimateTokens,
  DEFAULT_SOUL,
  DEFAULT_USER_MD,
  DEFAULT_MEMORY_MD,
  buildContext,
  buildGroupContext,
  getLabeledHistory,
  summarizeOld,
  extractMemory,
} from './memory.js';

// file 参数/changed 数组用的短键 ↔ 字段名映射
const FILE_FIELDS = { soul: 'soul_md', user: 'user_md', memory: 'memory_md' };

export function createApp() {
  const cfg = getConfig();
  assertMultiUserConfig(cfg); // 多用户模式：MASTER_KEY/SESSION_SECRET 缺失或非法 → 启动报错

  const app = express();
  app.set('trust proxy', 1);
  // helmet 安全头：BEHIND_HTTPS=true（生产经 Caddy 真 HTTPS）时用完整默认；
  // 本地 http 开发时去掉 upgrade-insecure-requests 和 HSTS——前者会让浏览器
  // 把 http 子资源升级成 https 请求，本地没有 TLS 会直接卡死导致白屏（Safari 必现）。
  if (String(process.env.BEHIND_HTTPS || '').toLowerCase() === 'true') {
    app.use(helmet());
  } else {
    app.use(
      helmet({
        contentSecurityPolicy: {
          directives: {
            ...helmet.contentSecurityPolicy.getDefaultDirectives(),
            'upgrade-insecure-requests': null,
          },
        },
        strictTransportSecurity: false,
      })
    );
  }
  // CORS：多用户公开版收紧为同源；单用户模式保持原有宽松行为
  if (cfg.multiUser) {
    app.use(cors({ origin: false }));
  } else {
    app.use(cors());
  }
  app.use(express.json());
  // 会话解析：req.userId（单用户模式恒为 null）
  app.use(sessionMiddleware);

  const db = getDb();
  const now = () => new Date().toISOString();

  // ---------- 限流（超限 429 JSON） ----------
  const tooMany = (req, res) =>
    res.status(429).json({ error: '请求过于频繁，请稍后再试' });
  const limiterOpts = { standardHeaders: 'draft-7', legacyHeaders: false, handler: tooMany, validate: { trustProxy: false } };
  const authLimiter = rateLimit({ ...limiterOpts, windowMs: 15 * 60 * 1000, max: 10 }); // 注册/登录：按 IP 10 次/15 分钟
  const chatLimiter = rateLimit({
    ...limiterOpts,
    windowMs: 60 * 1000,
    max: 30,
    keyGenerator: (req) => req.userId || ipKeyGenerator(req.ip), // 多用户按登录用户，单用户按 IP
  });
  const modelsLimiter = rateLimit({ ...limiterOpts, windowMs: 60 * 1000, max: 10 }); // 模型列表：按 IP 10 次/分钟

  // ---------- 多用户模式：/api/* 统一鉴权（auth/config/health 除外） ----------
  app.use('/api', (req, res, next) => {
    if (!cfg.multiUser) return next();
    const p = req.path;
    if (p.startsWith('/auth/') || p === '/config' || p === '/health') return next();
    if (!req.userId) return res.status(401).json({ error: '未登录，请先登录' });
    next();
  });

  mountAuthRoutes(app, authLimiter);

  // user_id 隔离 helper：单用户模式（req.userId 为 null）时不加任何条件，原样查询
  const uidOf = (req) => (req && req.userId) || null;
  const getChar = (id, req) => {
    const uid = uidOf(req);
    return uid
      ? db.prepare('SELECT * FROM characters WHERE id = ? AND user_id = ?').get(id, uid)
      : db.prepare('SELECT * FROM characters WHERE id = ?').get(id);
  };
  const getConv = (id, req) => {
    const uid = uidOf(req);
    return uid
      ? db.prepare('SELECT * FROM conversations WHERE id = ? AND user_id = ?').get(id, uid)
      : db.prepare('SELECT * FROM conversations WHERE id = ?').get(id);
  };
  // 在已有 WHERE 后追加 user_id 条件（单用户返回空条件）
  const andUid = (req, alias = '') => {
    const uid = uidOf(req);
    return uid ? { sql: ` AND ${alias}user_id = ?`, args: [uid] } : { sql: '', args: [] };
  };
  const char404 = (res) => res.status(404).json({ error: '角色不存在' });
  const conv404 = (res) => res.status(404).json({ error: '对话不存在' });

  // ---------- BYOK：从请求头取用户自己的 Key（后端只透传、不存储、不记日志） ----------
  function requestApiKey(req) {
    const h = req.headers['x-openrouter-key'];
    return typeof h === 'string' ? h.trim() : '';
  }

  // ---------- config（绝不泄露 key） ----------
  app.get('/api/config', (req, res) => {
    const cfg = getConfig();
    res.json({
      version: getVersion(),
      multi_user: !!cfg.multiUser,
      has_key: !!cfg.apiKey,
      chat_model: cfg.chatModel,
      extract_model: cfg.extractModel,
    });
  });

  // ---------- health ----------
  app.get('/api/health', (req, res) => {
    res.json({ ok: true });
  });

  // ---------- 模型列表（动态拉取）：Key 与地址来自请求头，后端只透传、不存储 ----------
  app.get('/api/models', modelsLimiter, async (req, res) => {
    const cfg = getConfig();
    // 多用户模式：聊天链路忽略 X-OpenRouter-Key（会话即身份），用用户托管 key || 服务器默认；
    // 但模型列表是只读预览，允许本次请求显式带 key（用户刚输入还未保存时预览用），不存储。
    const { apiKey: storedKey, baseUrl: base } = llmCreds(req, cfg, requestApiKey);
    const explicitKey = String((req.headers && req.headers['x-openrouter-key']) || '').trim();
    const key = explicitKey || storedKey;
    if (!key && !cfg.mockLlm) return res.status(401).json({ error: NO_KEY_MESSAGE });
    if (cfg.mockLlm) {
      return res.json({
        models: [
          { id: 'mock-model-a', name: 'Mock Model A' },
          { id: 'mock-model-b', name: 'Mock Model B' },
        ],
      });
    }
    try {
      const r = await llmFetch(`${base}/models`, {
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(15000),
      });
      if (!r.ok) {
        const t = await r.text().catch(() => '');
        return res.status(502).json({ error: `拉取模型列表失败 HTTP ${r.status}：${t.slice(0, 200)}` });
      }
      const j = await r.json().catch(() => null);
      const models = Array.isArray(j && j.data)
        ? j.data.map((m) => ({ id: String(m.id || ''), name: String(m.name || m.id || '') })).filter((m) => m.id)
        : [];
      res.json({ models });
    } catch (e) {
      res.status(502).json({ error: `拉取模型列表失败：${String((e && e.message) || e).slice(0, 200)}` });
    }
  });

  // ---------- characters ----------
  app.get('/api/characters', (req, res) => {
    const uid = uidOf(req);
    const rows = uid
      ? db.prepare('SELECT * FROM characters WHERE user_id = ? ORDER BY created_at DESC').all(uid)
      : db.prepare('SELECT * FROM characters ORDER BY created_at DESC').all();
    const f = andUid(req);
    const countStmt = db.prepare(`SELECT COUNT(*) AS n FROM conversations WHERE character_id = ?${f.sql}`);
    res.json(
      rows.map((c) => ({
        ...c,
        conversation_count: countStmt.get(c.id, ...f.args).n,
      }))
    );
  });

  app.post('/api/characters', (req, res) => {
    const { name, avatar, temperature } = req.body || {};
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'name 不能为空' });
    const id = randomUUID();
    const t = now();
    const row = {
      id,
      user_id: uidOf(req),
      name: String(name).trim(),
      avatar: avatar || '🤖',
      soul_md: DEFAULT_SOUL,
      user_md: DEFAULT_USER_MD,
      memory_md: DEFAULT_MEMORY_MD,
      model: '',
      temperature: temperature ?? 0.8,
      created_at: t,
      updated_at: t,
    };
    db.prepare(
      'INSERT INTO characters(id,user_id,name,avatar,soul_md,user_md,memory_md,model,temperature,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)'
    ).run(
      row.id,
      row.user_id,
      row.name,
      row.avatar,
      row.soul_md,
      row.user_md,
      row.memory_md,
      row.model,
      row.temperature,
      row.created_at,
      row.updated_at
    );
    res.status(201).json(row);
  });

  app.get('/api/characters/:id', (req, res) => {
    const c = getChar(req.params.id, req);
    if (!c) return char404(res);
    res.json(c);
  });

  app.put('/api/characters/:id', (req, res) => {
    const c = getChar(req.params.id, req);
    if (!c) return char404(res);
    const { name, avatar, temperature } = req.body || {};
    const next = {
      name: name !== undefined ? String(name).trim() : c.name,
      avatar: avatar !== undefined ? avatar : c.avatar,
      model: c.model,
      temperature: temperature !== undefined ? temperature : c.temperature,
      updated_at: now(),
    };
    if (!next.name) return res.status(400).json({ error: 'name 不能为空' });
    db.prepare('UPDATE characters SET name=?, avatar=?, model=?, temperature=?, updated_at=? WHERE id=?').run(
      next.name,
      next.avatar,
      next.model,
      next.temperature,
      next.updated_at,
      c.id
    );
    res.json(getChar(c.id, req));
  });

  app.delete('/api/characters/:id', (req, res) => {
    const c = getChar(req.params.id, req);
    if (!c) return char404(res);
    const f = andUid(req, 'c.');
    const convIds = db
      .prepare(`SELECT c.id FROM conversations c WHERE c.character_id = ?${f.sql}`)
      .all(c.id, ...f.args)
      .map((r) => r.id);
    db.transaction(() => {
      for (const cid of convIds) {
        db.prepare('DELETE FROM messages WHERE conversation_id = ?').run(cid);
        db.prepare('DELETE FROM conversation_summaries WHERE conversation_id = ?').run(cid);
      }
      db.prepare('DELETE FROM conversations WHERE character_id = ?').run(c.id);
      db.prepare('DELETE FROM group_members WHERE character_id = ?').run(c.id);
      db.prepare('DELETE FROM file_versions WHERE character_id = ?').run(c.id);
      db.prepare('DELETE FROM characters WHERE id = ?').run(c.id);
    })();
    res.json({ ok: true });
  });

  // ---------- files ----------
  app.get('/api/characters/:id/files', (req, res) => {
    const c = getChar(req.params.id, req);
    if (!c) return char404(res);
    res.json({ soul_md: c.soul_md, user_md: c.user_md, memory_md: c.memory_md });
  });

  app.put('/api/characters/:id/files', (req, res) => {
    const c = getChar(req.params.id, req);
    if (!c) return char404(res);
    const body = req.body || {};
    const changed = [];
    const sets = [];
    const args = [];
    const t = now();
    for (const [key, field] of Object.entries(FILE_FIELDS)) {
      if (body[field] === undefined) continue;
      const next = String(body[field]);
      if (next !== (c[field] || '')) {
        changed.push(key);
        sets.push(`${field} = ?`);
        args.push(next);
        db.prepare('INSERT INTO file_versions(character_id, file, content, created_at) VALUES(?,?,?,?)').run(
          c.id,
          key,
          next,
          t
        );
      }
    }
    if (sets.length) {
      db.prepare(`UPDATE characters SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`).run(...args, t, c.id);
    }
    const fresh = getChar(c.id, req);
    res.json({ soul_md: fresh.soul_md, user_md: fresh.user_md, memory_md: fresh.memory_md, changed });
  });

  app.get('/api/characters/:id/file-versions', (req, res) => {
    const c = getChar(req.params.id, req);
    if (!c) return char404(res);
    const limit = Math.min(parseInt(req.query.limit || '20', 10) || 20, 100);
    const file = req.query.file;
    const rows =
      file && FILE_FIELDS[file]
        ? db
            .prepare(
              'SELECT id, file, content, created_at FROM file_versions WHERE character_id = ? AND file = ? ORDER BY id DESC LIMIT ?'
            )
            .all(c.id, file, limit)
        : db
            .prepare(
              'SELECT id, file, content, created_at FROM file_versions WHERE character_id = ? ORDER BY id DESC LIMIT ?'
            )
            .all(c.id, limit);
    res.json(rows);
  });

  // 版本回滚：把指定版本内容写回对应文件，并记一条新版本
  app.post('/api/characters/:id/file-versions/:versionId/rollback', (req, res) => {
    const c = getChar(req.params.id, req);
    if (!c) return char404(res);
    const v = db
      .prepare('SELECT * FROM file_versions WHERE id = ? AND character_id = ?')
      .get(req.params.versionId, c.id);
    if (!v || !FILE_FIELDS[v.file]) return res.status(404).json({ error: '版本不存在' });
    const field = FILE_FIELDS[v.file];
    const t = now();
    db.transaction(() => {
      db.prepare(`UPDATE characters SET ${field} = ?, updated_at = ? WHERE id = ?`).run(v.content, t, c.id);
      db.prepare('INSERT INTO file_versions(character_id, file, content, created_at) VALUES(?,?,?,?)').run(
        c.id,
        v.file,
        v.content,
        t
      );
    })();
    res.json({ ok: true, file: v.file });
  });

  // ---------- conversations ----------
  app.get('/api/characters/:id/conversations', (req, res) => {
    const c = getChar(req.params.id, req);
    if (!c) return char404(res);
    const rows = db
      .prepare(
        `SELECT c.id, c.title, c.created_at, c.updated_at,
           (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count
         FROM conversations c WHERE c.character_id = ?${andUid(req, 'c.').sql} ORDER BY c.updated_at DESC`
      )
      .all(c.id, ...andUid(req, 'c.').args);
    res.json(rows);
  });

  app.post('/api/characters/:id/conversations', (req, res) => {
    const c = getChar(req.params.id, req);
    if (!c) return char404(res);
    const title = String((req.body && req.body.title) || '').trim() || '新对话';
    const id = randomUUID();
    const t = now();
    db.prepare(
      'INSERT INTO conversations(id, character_id, title, user_id, created_at, updated_at) VALUES(?,?,?,?,?,?)'
    ).run(id, c.id, title, uidOf(req), t, t);
    res.status(201).json({ id, character_id: c.id, title, created_at: t, updated_at: t });
  });

  app.put('/api/conversations/:id', (req, res) => {
    const conv = getConv(req.params.id, req);
    if (!conv) return conv404(res);
    const title = String((req.body && req.body.title) || '').trim();
    if (!title) return res.status(400).json({ error: 'title 不能为空' });
    db.prepare('UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?').run(title, now(), conv.id);
    res.json(getConv(conv.id, req));
  });

  app.delete('/api/conversations/:id', (req, res) => {
    const conv = getConv(req.params.id, req);
    if (!conv) return conv404(res);
    db.transaction(() => {
      db.prepare('DELETE FROM messages WHERE conversation_id = ?').run(conv.id);
      db.prepare('DELETE FROM conversation_summaries WHERE conversation_id = ?').run(conv.id);
      db.prepare('DELETE FROM group_members WHERE conversation_id = ?').run(conv.id);
      db.prepare('DELETE FROM conversations WHERE id = ?').run(conv.id);
    })();
    res.json({ ok: true });
  });

  app.get('/api/conversations/:id/messages', (req, res) => {
    const conv = getConv(req.params.id, req);
    if (!conv) return conv404(res);
    const limit = Math.min(parseInt(req.query.limit || '200', 10) || 200, 1000);
    const rows = db
      .prepare(
        `SELECT m.*, ch.name AS character_name, ch.avatar AS character_avatar
         FROM messages m LEFT JOIN characters ch ON ch.id = m.character_id
         WHERE m.conversation_id = ? ORDER BY m.id ASC LIMIT ?`
      )
      .all(conv.id, limit);
    res.json(rows);
  });

  // ---------- 群聊 ----------
  const getGroup = (id, req) => {
    const uid = uidOf(req);
    const conv = uid
      ? db.prepare("SELECT * FROM conversations WHERE id = ? AND type = 'group' AND user_id = ?").get(id, uid)
      : db.prepare("SELECT * FROM conversations WHERE id = ? AND type = 'group'").get(id);
    if (!conv) return null;
    conv.members = db
      .prepare(
        `SELECT ch.* FROM group_members gm JOIN characters ch ON ch.id = gm.character_id
         WHERE gm.conversation_id = ? ORDER BY gm.joined_at ASC`
      )
      .all(id);
    return conv;
  };
  const checkMembers = (ids, req) => {
    const uniq = [...new Set((Array.isArray(ids) ? ids : []).filter(Boolean))];
    if (uniq.length < 2) return { error: '群聊至少需要 2 个角色' };
    if (uniq.length > 8) return { error: '群聊最多 8 个角色' };
    for (const mid of uniq) if (!getChar(mid, req)) return { error: '有不存在的角色' };
    return { ids: uniq };
  };

  app.post('/api/groups', (req, res) => {
    const { error, ids } = checkMembers((req.body || {}).member_ids, req);
    if (error) return res.status(400).json({ error });
    const id = randomUUID();
    const t = now();
    const title =
      String((req.body || {}).name || '').trim() ||
      ids.map((mid) => getChar(mid, req).name).join('、').slice(0, 24);
    db.transaction(() => {
      db.prepare(
        "INSERT INTO conversations(id, character_id, title, type, user_id, created_at, updated_at) VALUES(?, '', ?, 'group', ?, ?, ?)"
      ).run(id, title, uidOf(req), t, t);
      const ins = db.prepare('INSERT INTO group_members(conversation_id, character_id, joined_at) VALUES(?,?,?)');
      ids.forEach((mid) => ins.run(id, mid, t));
    })();
    res.status(201).json(getGroup(id, req));
  });

  app.get('/api/groups', (req, res) => {
    const f = andUid(req, 'c.');
    const rows = db
      .prepare(
        `SELECT c.id, c.title, c.created_at, c.updated_at,
           (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count,
           (SELECT COUNT(*) FROM group_members gm WHERE gm.conversation_id = c.id) AS member_count
         FROM conversations c WHERE c.type = 'group'${f.sql} ORDER BY c.updated_at DESC`
      )
      .all(...f.args);
    res.json(rows);
  });

  app.get('/api/groups/:id', (req, res) => {
    const g = getGroup(req.params.id, req);
    if (!g) return conv404(res);
    res.json(g);
  });

  app.put('/api/groups/:id', (req, res) => {
    const g = getGroup(req.params.id, req);
    if (!g) return conv404(res);
    const title = String((req.body || {}).name || '').trim();
    if (!title) return res.status(400).json({ error: '群名不能为空' });
    db.prepare('UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?').run(title, now(), g.id);
    res.json(getGroup(g.id, req));
  });

  app.put('/api/groups/:id/members', (req, res) => {
    const g = getGroup(req.params.id, req);
    if (!g) return conv404(res);
    const { error, ids } = checkMembers((req.body || {}).member_ids, req);
    if (error) return res.status(400).json({ error });
    const t = now();
    db.transaction(() => {
      db.prepare('DELETE FROM group_members WHERE conversation_id = ?').run(g.id);
      const ins = db.prepare('INSERT INTO group_members(conversation_id, character_id, joined_at) VALUES(?,?,?)');
      ids.forEach((mid) => ins.run(g.id, mid, t));
      db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(t, g.id);
    })();
    res.json(getGroup(g.id, req));
  });

  // ---------- 聊天 SSE ----------
  // ---------- 群聊消息 SSE：导演决策 → 按角色串行流式 ----------
  async function handleGroupMessage(req, res, conv, cfg) {
    // 凭证：多用户模式用用户托管 key（忽略请求头），单用户模式保持请求头优先
    const { apiKey, baseUrl, chatModel, workerModel } = llmCreds(req, cfg, requestApiKey);
    if (!apiKey && !cfg.mockLlm) return res.status(401).json({ error: NO_KEY_MESSAGE });
    const llmOpts = { apiKey, baseUrl };

    const content = String((req.body && req.body.content) ?? '').trim();
    if (!content) return res.status(400).json({ error: 'content 不能为空' });

    const members = db
      .prepare(
        `SELECT ch.* FROM group_members gm JOIN characters ch ON ch.id = gm.character_id
         WHERE gm.conversation_id = ? ORDER BY gm.joined_at ASC`
      )
      .all(conv.id);
    if (members.length < 2) return res.status(400).json({ error: '群成员不足' });
    const memberIds = new Set(members.map((m) => m.id));

    // @点名：提到谁谁必回（最多 3 个）
    const mentioned = members.filter((m) => content.includes('@' + m.name)).map((m) => m.id).slice(0, 3);

    const t = now();
    db.prepare(
      'INSERT INTO messages(conversation_id, role, content, tokens, character_id, created_at) VALUES(?,?,?,?,?,?)'
    ).run(conv.id, 'user', content, estimateTokens(content), null, t);
    db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(t, conv.id);

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

    try {
      // 1. 定发言顺序：@点名 > 导演决策 > fallback（最久没说话的先回）
      const lastSpokeRow = db
        .prepare(
          `SELECT character_id FROM messages
           WHERE conversation_id = ? AND role = 'assistant' AND character_id IS NOT NULL
           ORDER BY id DESC LIMIT 1`
        )
        .get(conv.id);
      const lastSpeakerId = lastSpokeRow ? lastSpokeRow.character_id : null;
      let speakerIds;
      if (mentioned.length) {
        speakerIds = mentioned;
      } else {
        const decided = await decideSpeakers({
          members,
          history: getLabeledHistory(conv.id, 12),
          model: workerModel,
          lastSpeakerId,
          ...llmOpts,
        });
        if (decided && decided.length) {
          speakerIds = decided.filter((id) => memberIds.has(id)).slice(0, 3);
        } else {
          const lastSpoke = db
            .prepare(
              `SELECT character_id, MAX(id) AS last_id FROM messages
               WHERE conversation_id = ? AND character_id IS NOT NULL GROUP BY character_id`
            )
            .all(conv.id);
          const lastMap = new Map(lastSpoke.map((r) => [r.character_id, r.last_id]));
          speakerIds = [...members]
            .sort((a, b) => (lastMap.get(a.id) || 0) - (lastMap.get(b.id) || 0))
            .slice(0, 2)
            .map((m) => m.id);
        }
      }
      if (!speakerIds.length) speakerIds = [members[0].id];

      // 2. 按角色串行流式：每轮重建上下文，后发言者能看到先发言者的回复
      const extractTargets = [];
      let ctxInfo = null;
      let usageInput = 0;
      let usageOutput = 0;
      for (const sid of speakerIds) {
        if (res.destroyed) break;
        const ch = members.find((m) => m.id === sid);
        if (!ch) continue;
        const groupCtx = buildGroupContext(members, conv.id);
        if (!ctxInfo) {
          ctxInfo = { used: groupCtx.usedTokens, budget: groupCtx.budget };
          send('context', ctxInfo);
        }
        const { apiMessages, usedTokens } = groupCtx.buildFor(ch);
        usageInput += usedTokens;
        send('turn_start', { character_id: ch.id, character_name: ch.name, character_avatar: ch.avatar });
        let full = '';
        try {
          await chatStream({
            messages: apiMessages,
            model: chatModel,
            temperature: ch.temperature ?? 0.8,
            ...llmOpts,
            onToken: (delta) => {
              full += delta;
              send('token', { character_id: ch.id, text: delta });
            },
          });
        } catch (e) {
          send('error', { character_id: ch.id, message: `${ch.name} 回复失败：${String((e && e.message) || e)}` });
          continue;
        }
        const outTokens = estimateTokens(full);
        usageOutput += outTokens;
        const row = db
          .prepare(
            'INSERT INTO messages(conversation_id, role, content, tokens, character_id, created_at) VALUES(?,?,?,?,?,?)'
          )
          .run(conv.id, 'assistant', full, outTokens, ch.id, now());
        send('turn_done', {
          character_id: ch.id,
          message_id: Number(row.lastInsertRowid),
          content: full,
          tokens: estimateTokens(full),
        });
        // 该角色发言数每 N 条触发一次记忆提取（各角色独立计数）
        const n = db
          .prepare('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ? AND character_id = ?')
          .get(conv.id, ch.id).n;
        if (n % cfg.extractEveryN === 0) extractTargets.push(ch);
      }

      // 3. 会话级摘要 + 触发到的角色记忆提取（并行）
      await summarizeOld(members[0], conv.id, { ...llmOpts, model: workerModel });
      const memResults = await Promise.all(
        extractTargets.map(async (ch) => ({
          ch,
          changed: await extractMemory(ch, conv.id, { ...llmOpts, model: workerModel }),
        }))
      );
      for (const { ch, changed } of memResults) {
        if (changed.length) send('memory_updated', { character_id: ch.id, files: changed });
      }

      send('done', { title: conv.title, usage: { input: usageInput, output: usageOutput } });
    } catch (e) {
      send('error', { message: String((e && e.message) || e) });
    } finally {
      res.end();
    }
  }

  app.post('/api/conversations/:id/messages', chatLimiter, async (req, res) => {
    const cfg = getConfig();
    const conv = getConv(req.params.id, req);
    if (!conv) return conv404(res);
    if (conv.type === 'group') return handleGroupMessage(req, res, conv, cfg);
    const content = String((req.body && req.body.content) ?? '').trim();
    if (!content) return res.status(400).json({ error: 'content 不能为空' });
    const char = getChar(conv.character_id, req);
    if (!char) return char404(res);

    // 凭证：多用户模式用用户托管 key（忽略请求头），单用户模式保持请求头优先；
    // 都没有且非 mock 直接 401（不落库用户消息）
    const { apiKey, baseUrl, chatModel, workerModel } = llmCreds(req, cfg, requestApiKey);
    if (!apiKey && !cfg.mockLlm) return res.status(401).json({ error: NO_KEY_MESSAGE });
    const llmOpts = { apiKey, baseUrl };

    const t = now();
    db.prepare('INSERT INTO messages(conversation_id, role, content, tokens, created_at) VALUES(?,?,?,?,?)').run(
      conv.id,
      'user',
      content,
      estimateTokens(content),
      t
    );

    let title = conv.title;
    if (!title || title === '新对话') {
      title = content.slice(0, 12);
      db.prepare('UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?').run(title, t, conv.id);
    } else {
      db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(t, conv.id);
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

    try {
      const { apiMessages, usedTokens, budget } = buildContext(char, conv.id);
      send('context', { used: usedTokens, budget });
      let full = '';
      await chatStream({
        messages: apiMessages,
        model: chatModel,
        temperature: char.temperature ?? 0.8,
        apiKey,
        baseUrl,
        onToken: (delta) => {
          full += delta;
          send('token', { text: delta });
        },
      });
      const asst = db
        .prepare('INSERT INTO messages(conversation_id, role, content, tokens, created_at) VALUES(?,?,?,?,?)')
        .run(conv.id, 'assistant', full, estimateTokens(full), now());
      await summarizeOld(char, conv.id, { ...llmOpts, model: workerModel });
      const asstCount = db
        .prepare("SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ? AND role = 'assistant'")
        .get(conv.id).n;
      if (asstCount % cfg.extractEveryN === 0) {
        const changed = await extractMemory(char, conv.id, { ...llmOpts, model: workerModel });
        if (changed.length) send('memory_updated', { files: changed });
      }
      const outTokens = estimateTokens(full);
      send('done', { message_id: Number(asst.lastInsertRowid), content: full, tokens: outTokens, title, usage: { input: usedTokens, output: outTokens } });
    } catch (e) {
      send('error', { message: String((e && e.message) || e) });
    } finally {
      res.end();
    }
  });

  // ---------- 静态前端（存在才挂） ----------
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const distDir = path.resolve(__dirname, '../../client/dist');
  if (fs.existsSync(distDir)) {
    app.use(express.static(distDir));
    // SPA fallback：非 /api 请求返回 index.html
    app.get(/^\/(?!api).*/, (req, res) => res.sendFile(path.join(distDir, 'index.html')));
  }

  return app;
}
