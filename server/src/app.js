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
import { ah, apiErrorHandler } from './asyncHandler.js';
import { chatStream, NO_KEY_MESSAGE, llmFetch, decideSpeakers, generateCardJson } from './llm.js';
import {
  getPresetCards,
  getPresetCard,
  sanitizeCardInput,
  isAdoptableCard,
  CARD_CATEGORIES,
} from './characterCards.js';
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
import {
  listPointsModels,
  getWorkerModel,
  getPointsModel,
  calcPoints,
  deductPoints,
  maybeInviteReward,
  maybeSignupBonus,
  hasSignupBonus,
} from './points.js';

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
  // AUTH_LIMIT_MAX 仅供回归测试调高配额（默认 10，生产不动）
  const authMax = parseInt(process.env.AUTH_LIMIT_MAX || '10', 10) || 10;
  const authLimiter = rateLimit({ ...limiterOpts, windowMs: 15 * 60 * 1000, max: authMax }); // 注册/登录：按 IP 10 次/15 分钟
  const chatLimiter = rateLimit({
    ...limiterOpts,
    windowMs: 60 * 1000,
    max: 30,
    keyGenerator: (req) => req.userId || ipKeyGenerator(req.ip), // 多用户按登录用户，单用户按 IP
  });
  const modelsLimiter = rateLimit({ ...limiterOpts, windowMs: 60 * 1000, max: 10 }); // 模型列表：按 IP 10 次/分钟
  // AI 生成角色卡：10 次/分钟/用户（防刷；生成是低频高价值调用）
  const generateLimiter = rateLimit({
    ...limiterOpts,
    windowMs: 60 * 1000,
    max: 10,
    keyGenerator: (req) => req.userId || ipKeyGenerator(req.ip),
  });
  // 写操作通用限流：POST/PUT/DELETE/PATCH 按用户（或 IP）60 次/分钟，防灌爆 SQLite；
  // 已有更严限流的路由（如聊天 30/分钟）不受影响——限流器叠加，取最严者
  const writeLimiter = rateLimit({
    ...limiterOpts,
    windowMs: 60 * 1000,
    max: 60,
    keyGenerator: (req) => req.userId || ipKeyGenerator(req.ip),
  });
  app.use('/api', (req, res, next) => {
    if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method)) return writeLimiter(req, res, next);
    next();
  });

  // ---------- 多用户模式：/api/* 统一鉴权（auth/config/health 除外） ----------
  app.use('/api', (req, res, next) => {
    if (!cfg.multiUser) return next();
    const p = req.path;
    // 预设角色卡列表公开（未登录可浏览，用于拉新）；领养/生成仍需登录
    if (p.startsWith('/auth/') || p === '/config' || p === '/health' || p === '/character-cards/presets') return next();
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

  // ---------- 积分计费（多用户模式） ----------
  // 解析用户计费方式，返回 { usePoints, userId, balance, chatModel, workerModel, llmOpts }；
  // 积分不足或平台未开通时返回 { error }（调用方直接 402，不落库用户消息）。
  function resolveBilling(req, cfg, creds) {
    const base = {
      usePoints: false,
      chatModel: creds.chatModel,
      workerModel: creds.workerModel,
      llmOpts: { apiKey: creds.apiKey, baseUrl: creds.baseUrl },
    };
    const uid = uidOf(req);
    if (!cfg.multiUser || !uid) return base;
    const u = db.prepare('SELECT billing_mode, points_balance FROM users WHERE id = ?').get(uid);
    if (!u || (u.billing_mode || 'points') !== 'points') return base;
    // 积分模式：模型必须在白名单（服务端强制，前端传什么都没用），后台固定最便宜
    const activeModels = listPointsModels(true);
    const chatModel = getPointsModel(creds.chatModel) ? creds.chatModel : (activeModels[0] && activeModels[0].id) || '';
    if (!cfg.apiKey && !cfg.mockLlm) return { error: '平台模型服务暂未开通，请联系管理员' };
    const balance = u.points_balance || 0;
    // 新用户首聊放行：0 余额但未领过注册奖励时允许聊，聊完即发奖励再扣本轮费用（防刷号）
    if (balance < 1 && !cfg.mockLlm && hasSignupBonus(uid))
      return { error: '积分不足：请联系管理员充值，或在「API 设置」中切换为自带 Key 模式' };
    return {
      usePoints: true,
      userId: uid,
      balance,
      chatModel,
      workerModel: getWorkerModel(),
      llmOpts: { apiKey: cfg.apiKey, baseUrl: cfg.baseUrl }, // 平台 Key，绝不暴露给前端
    };
  }

  // 积分模式后台用量计费回调工厂（记忆/摘要/导演）；onBalance 用于同步最新余额
  function bgBill(bill, cfg, reason, model, onBalance) {
    return (usage) => {
      if (!bill.usePoints || cfg.mockLlm || !usage) return;
      try {
        const pts = calcPoints(model, usage);
        if (pts > 0)
          onBalance(
            deductPoints(bill.userId, pts, reason, null, null, {
              tokensInput: usage.input,
              tokensOutput: usage.output,
              model,
            })
          );
      } catch (e) {
        console.warn('[points] 后台扣费失败:', e.message);
      }
    };
  }

  // 邀请奖励：聊天成功后检查被邀请人是否聊满 N 条，达标则给邀请人发奖励（幂等）
  function checkInviteReward(userId) {
    if (!userId) return;
    try {
      maybeInviteReward(userId);
    } catch (e) {
      console.warn('[points] 邀请奖励检查失败:', e.message);
    }
  }

  // SSE 公共：写头 + 安全 send（客户端断开后不再写）
  function sseInit(res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    return (event, data) => {
      if (res.destroyed) return;
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
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
      // 积分系统：多用户模式可用；platform_ready 表示站长已配置平台 Key
      points_enabled: !!cfg.multiUser,
      platform_ready: !!cfg.apiKey,
      points_models: cfg.multiUser ? listPointsModels(true) : [],
    });
  });

  // ---------- health ----------
  app.get('/api/health', (req, res) => {
    res.json({ ok: true });
  });

  // ---------- 模型列表（动态拉取）：Key 与地址来自请求头，后端只透传、不存储 ----------
  app.get('/api/models', modelsLimiter, ah(async (req, res) => {
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
  }));

  // ---------- 角色卡 ----------
  // 预设卡列表（公开：未登录可浏览，用于拉新）
  app.get('/api/character-cards/presets', (req, res) => {
    res.json({ categories: CARD_CATEGORIES, cards: getPresetCards() });
  });

  // 一键领养：preset_id 或 card（二选一）→ 建角色 + 建对话 + 开场白作为首条消息
  app.post(
    '/api/character-cards/adopt',
    ah(async (req, res) => {
      const body = req.body || {};
      let card = null;
      if (body.preset_id) {
        card = getPresetCard(String(body.preset_id));
        if (!card) return res.status(404).json({ error: '预设角色卡不存在' });
      } else if (body.card) {
        card = sanitizeCardInput(body.card);
        if (!isAdoptableCard(card)) return res.status(400).json({ error: '角色卡数据不完整' });
      } else {
        return res.status(400).json({ error: '缺少 preset_id 或 card' });
      }
      const uid = uidOf(req);
      const t = now();
      const charId = randomUUID();
      const convId = randomUUID();
      const title = `与${card.name}的相遇`;
      db.transaction(() => {
        db.prepare(
          'INSERT INTO characters(id,user_id,name,avatar,soul_md,user_md,memory_md,model,temperature,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)'
        ).run(
          charId,
          uid,
          card.name,
          card.avatar || '🤖',
          card.soul_md,
          DEFAULT_USER_MD,
          DEFAULT_MEMORY_MD,
          '',
          0.8,
          t,
          t
        );
        db.prepare(
          'INSERT INTO conversations(id, character_id, title, user_id, created_at, updated_at) VALUES(?,?,?,?,?,?)'
        ).run(convId, charId, title, uid, t, t);
        db.prepare('INSERT INTO messages(conversation_id, role, content, tokens, created_at) VALUES(?,?,?,?,?)').run(
          convId,
          'assistant',
          card.greeting,
          estimateTokens(card.greeting),
          t
        );
      })();
      res.status(201).json({
        character: getChar(charId, req),
        conversation: { id: convId, character_id: charId, title, created_at: t, updated_at: t },
      });
    })
  );

  // AI 生成角色卡：成功后按真实用量扣积分（积分模式），失败不扣
  app.post(
    '/api/character-cards/generate',
    generateLimiter,
    ah(async (req, res) => {
      const desc = String((req.body && req.body.prompt) || '').trim();
      if (!desc) return res.status(400).json({ error: '请先用一句话描述你想要的角色' });
      if (desc.length > 500) return res.status(400).json({ error: '描述太长了，请控制在 500 字以内' });

      const creds = llmCreds(req, cfg, requestApiKey);
      const uid = uidOf(req);
      let usePoints = false;
      let model = '';
      let apiKey = creds.apiKey;
      let baseUrl = creds.baseUrl;

      if (cfg.multiUser && uid) {
        const u = db.prepare('SELECT billing_mode, points_balance FROM users WHERE id = ?').get(uid);
        if (u && (u.billing_mode || 'points') === 'points') {
          // 积分模式：请求模型必须在白名单内（默认最便宜）；用平台 Key
          const requested = String((req.body && req.body.model) || '').trim();
          model = getPointsModel(requested) ? requested : getWorkerModel();
          if (!model) return res.status(503).json({ error: '平台暂无可用模型' });
          if (!cfg.apiKey && !cfg.mockLlm) return res.status(503).json({ error: '平台模型服务暂未开通，请联系管理员' });
          if (!cfg.mockLlm && (u.points_balance || 0) < 1)
            return res.status(402).json({ error: '积分不足：请联系管理员充值，或在「API 设置」中切换为自带 Key 模式' });
          usePoints = true;
          apiKey = cfg.apiKey;
          baseUrl = cfg.baseUrl;
        }
      }
      if (!model) {
        // 自带 Key 模式（或单用户）：用用户自己的 worker 模型，不扣平台积分
        model = creds.workerModel || creds.chatModel;
        if (!apiKey && !cfg.mockLlm) return res.status(401).json({ error: NO_KEY_MESSAGE });
      }

      const ac = new AbortController();
      req.on('close', () => ac.abort());
      let result;
      try {
        result = await generateCardJson({ desc, model, apiKey, baseUrl, signal: ac.signal });
      } catch (e) {
        return res.status(502).json({ error: String((e && e.message) || e).slice(0, 300) });
      }

      // 成功后扣费（积分模式且非 mock）；失败/解析错误不扣
      let cost = null;
      if (usePoints && !cfg.mockLlm) {
        const usage = result.usage || {
          input: estimateTokens(desc),
          output: estimateTokens(JSON.stringify(result.card)),
        };
        const pts = calcPoints(model, usage);
        let balance;
        try {
          balance = deductPoints(uid, pts, 'character_generate', null, null, {
            tokensInput: usage.input,
            tokensOutput: usage.output,
            model,
          });
        } catch (e) {
          return res.status(402).json({ error: '积分不足，本次生成不计费' });
        }
        cost = {
          points: pts,
          model,
          tokens_input: usage.input,
          tokens_output: usage.output,
          balance,
        };
      }
      res.json({ card: result.card, cost });
    })
  );

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
    const creds = llmCreds(req, cfg, requestApiKey);
    if (!creds.apiKey && !cfg.mockLlm) return res.status(401).json({ error: NO_KEY_MESSAGE });
    // 积分模式：平台 Key + 白名单模型；余额不足 402（不落库用户消息）
    const bill = resolveBilling(req, cfg, creds);
    if (bill.error) return res.status(402).json({ error: bill.error });
    const { chatModel, workerModel, llmOpts } = bill;
    // M7：客户端断开时取消上游 LLM 请求，防悬空连接堆积
    const ac = new AbortController();
    req.on('close', () => ac.abort());
    llmOpts.signal = ac.signal;
    const usePoints = bill.usePoints;
    let pointsBalance = bill.balance;
    const updBal = (b) => {
      pointsBalance = b;
    };

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

    const send = sseInit(res);

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
          onUsage: bgBill(bill, cfg, 'director', workerModel, updBal),
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
        let turnUsage = null;
        try {
          const r = await chatStream({
            messages: apiMessages,
            model: chatModel,
            temperature: ch.temperature ?? 0.8,
            ...llmOpts,
            onToken: (delta) => {
              full += delta;
              send('token', { character_id: ch.id, text: delta });
            },
          });
          turnUsage = r.usage;
        } catch (e) {
          send('error', { character_id: ch.id, message: `${ch.name} 回复失败：${String((e && e.message) || e)}` });
          continue;
        }
        const outTokens = estimateTokens(full);
        usageOutput += outTokens;
        // 注册奖励：首次聊天成功后发放（幂等），每轮只发一次由 maybeSignupBonus 保证
        if (bill.userId) {
          try { maybeSignupBonus(bill.userId); } catch (e) { console.warn('[points] 注册奖励发放失败:', e.message); }
        }
        // 积分扣费（按发言轮次）
        if (usePoints && !cfg.mockLlm) {
          const u = turnUsage || { input: usedTokens, output: outTokens };
          const pts = calcPoints(chatModel, u);
          if (pts > 0) {
            try {
              pointsBalance = deductPoints(bill.userId, pts, 'group_chat', 'conversation', conv.id, {
                tokensInput: u.input,
                tokensOutput: u.output,
                model: chatModel,
              });
            } catch (e) {
              console.warn('[points] 扣费失败:', e.message);
            }
          }
        }
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

      if (usePoints) send('points', { balance: pointsBalance });
      if (bill.userId) checkInviteReward(bill.userId);
      send('done', { title: conv.title, usage: { input: usageInput, output: usageOutput } });
      // 3. 会话级摘要 + 触发到的角色记忆提取放后台（并行），不阻塞 done
      const bgOpts = { ...llmOpts, signal: undefined };
      setImmediate(async () => {
        try {
          await summarizeOld(members[0], conv.id, {
            ...bgOpts,
            model: workerModel,
            onUsage: bgBill(bill, cfg, 'summary', workerModel, updBal),
          });
          await Promise.all(
            extractTargets.map((ch) =>
              extractMemory(ch, conv.id, {
                ...bgOpts,
                model: workerModel,
                onUsage: bgBill(bill, cfg, 'memory', workerModel, updBal),
              })
            )
          );
        } catch (e) {
          console.warn('[bg] 群聊摘要/记忆提取失败:', e.message);
        }
      });
    } catch (e) {
      send('error', { message: String((e && e.message) || e) });
    } finally {
      res.end();
    }
  }

  app.post('/api/conversations/:id/messages', chatLimiter, ah(async (req, res) => {
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
    const creds = llmCreds(req, cfg, requestApiKey);
    if (!creds.apiKey && !cfg.mockLlm) return res.status(401).json({ error: NO_KEY_MESSAGE });
    // 积分模式：平台 Key + 白名单模型；余额不足 402（不落库用户消息）
    const bill = resolveBilling(req, cfg, creds);
    if (bill.error) return res.status(402).json({ error: bill.error });
    const { chatModel, workerModel, llmOpts } = bill;
    // M7：客户端断开时取消上游 LLM 请求，防悬空连接堆积
    const ac = new AbortController();
    req.on('close', () => ac.abort());
    llmOpts.signal = ac.signal;
    const usePoints = bill.usePoints;
    let pointsBalance = bill.balance;
    const updBal = (b) => {
      pointsBalance = b;
    };

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

    const send = sseInit(res);

    try {
      const { apiMessages, usedTokens, budget } = buildContext(char, conv.id);
      send('context', { used: usedTokens, budget });
      let full = '';
      const { usage } = await chatStream({
        messages: apiMessages,
        model: chatModel,
        temperature: char.temperature ?? 0.8,
        ...llmOpts,
        onToken: (delta) => {
          full += delta;
          send('token', { text: delta });
        },
      });
      const asst = db
        .prepare('INSERT INTO messages(conversation_id, role, content, tokens, created_at) VALUES(?,?,?,?,?)')
        .run(conv.id, 'assistant', full, estimateTokens(full), now());
      const outTokens = estimateTokens(full);
      // 注册奖励：首次聊天成功后发放（幂等），再扣本轮费用
      if (bill.userId) {
        try { maybeSignupBonus(bill.userId); } catch (e) { console.warn('[points] 注册奖励发放失败:', e.message); }
      }
      // 积分扣费（主聊天；无真实用量时回退到估算值）
      if (usePoints && !cfg.mockLlm) {
        const u = usage || { input: usedTokens, output: outTokens };
        const pts = calcPoints(chatModel, u);
        if (pts > 0) {
          try {
            pointsBalance = deductPoints(bill.userId, pts, 'chat', 'conversation', conv.id, {
              tokensInput: u.input,
              tokensOutput: u.output,
              model: chatModel,
            });
          } catch (e) {
            console.warn('[points] 扣费失败:', e.message);
          }
        }
      }
      if (usePoints) send('points', { balance: pointsBalance });
      if (bill.userId) checkInviteReward(bill.userId);
      send('done', { message_id: Number(asst.lastInsertRowid), content: full, tokens: outTokens, title, usage: { input: usedTokens, output: outTokens } });
      // 摘要 + 记忆提取放后台，不阻塞 done；去掉请求级 signal（响应结束后不断连带取消）
      const bgOpts = { ...llmOpts, signal: undefined };
      setImmediate(async () => {
        try {
          await summarizeOld(char, conv.id, {
            ...bgOpts,
            model: workerModel,
            onUsage: bgBill(bill, cfg, 'summary', workerModel, updBal),
          });
          const asstCount = db
            .prepare("SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ? AND role = 'assistant'")
            .get(conv.id).n;
          if (asstCount % cfg.extractEveryN === 0) {
            await extractMemory(char, conv.id, {
              ...bgOpts,
              model: workerModel,
              onUsage: bgBill(bill, cfg, 'memory', workerModel, updBal),
            });
          }
        } catch (e) {
          console.warn('[bg] 摘要/记忆提取失败:', e.message);
        }
      });
    } catch (e) {
      send('error', { message: String((e && e.message) || e) });
    } finally {
      res.end();
    }
  }));

  // ---------- 静态前端（存在才挂） ----------
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const distDir = path.resolve(__dirname, '../../client/dist');
  if (fs.existsSync(distDir)) {
    app.use(express.static(distDir));
    // SPA fallback：非 /api 请求返回 index.html
    app.get(/^\/(?!api).*/, (req, res) => res.sendFile(path.join(distDir, 'index.html')));
  }

  // 集中错误处理（必须在所有路由之后）
  app.use(apiErrorHandler);

  return app;
}
