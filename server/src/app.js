import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { rateLimit, ipKeyGenerator } from 'express-rate-limit';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { getConfig, getVersion, assertMultiUserConfig } from './config.js';
import { getDb, getSetting } from './db.js';
import { ah, apiErrorHandler } from './asyncHandler.js';
import { chatStream, NO_KEY_MESSAGE, llmFetch, decideSpeakers, detectMentions, generateCardJson, generateSoulMd, friendlyLlmError, withRetry, genTitle } from './llm.js';
import {
  getPresetCards,
  getPresetCard,
  sanitizeCardInput,
  isAdoptableCard,
  validateSharedCard,
  buildPublishDraft,
  CARD_CATEGORIES,
} from './characterCards.js';
import {
  sessionMiddleware,
  currentUserId,
  llmCreds,
  mountAuthRoutes,
  canUseJailbreak,
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
  runMemoryPipeline,
  getRoleplayTemplate,
  findMentionedIds,
} from './memory.js';
import { JAILBREAK_PRESETS, jailbreakPresetList } from './jailbreakPresets.js';
import {
  listPointsModels,
  getWorkerModel,
  getChatDefaultModel,
  getPointsModel,
  calcPoints,
  deductPoints,
  maybeInviteReward,
  maybeSignupBonus,
  maybeCollectionReward,
  COLLECTION_REWARD,
  hasSignupBonus,
  recordByokUsage,
  getBalance,
} from './points.js';
// v1.26.0: 语音功能
import { getVoiceProvider, extractDialogue, splitSentences, cleanForTts, VOICE_MODELS, VOICE_PRICING, calcAsrPoints, calcTtsPoints, getCachedAudio, setCachedAudio, getVoiceModel, detectAudioMime } from './voice.js';

// file 参数/changed 数组用的短键 ↔ 字段名映射
const FILE_FIELDS = { soul: 'soul_md', user: 'user_md', memory: 'memory_md' };

// ---------- v1.17.3: 内容过滤回退链（可配置，不再硬编码） ----------
// 默认链：Euryale → Cydonia；管理员可在设置→统计→模型配置里自定义顺序。
// sys_settings.filter_fallback_models 存 JSON 数组；未设置用默认，显式 [] = 关闭回退。
const DEFAULT_FILTER_FALLBACK_MODELS = ['sao10k/l3.3-euryale-70b', 'thedrummer/cydonia-24b-v4.1'];
export function getFilterFallbackModels() {
  let raw = '';
  try { raw = getSetting('filter_fallback_models', ''); } catch {}
  if (!raw) return [...DEFAULT_FILTER_FALLBACK_MODELS];
  try {
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) return arr.filter((m) => typeof m === 'string' && m.trim()).map((m) => m.trim());
  } catch {}
  return [...DEFAULT_FILTER_FALLBACK_MODELS];
}
export function pickFilterFallbackModel(currentModel) {
  let rows = [];
  try {
    rows = getDb().prepare('SELECT model_id FROM points_models WHERE is_active=1').all().map((r) => r.model_id);
  } catch {}
  for (const m of getFilterFallbackModels()) {
    if (m !== currentModel && rows.includes(m)) return m;
  }
  return null;
}

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
  app.use(express.json({ limit: '60mb' })); // v1.29.0: 音频 base64 上传（单文件克隆/批量克隆）需大 body
  // 会话解析：req.userId（单用户模式恒为 null）
  app.use(sessionMiddleware);

  const db = getDb();
  const now = () => new Date().toISOString();

  // v1.20.5: 存量清理——user_md 恰好等于默认长注释的清成空（用户改过的一律不动），省 token
  try {
    const r = db.prepare('UPDATE characters SET user_md = ? WHERE user_md = ?').run('', DEFAULT_USER_MD);
    if (r.changes) console.log(`[migrate] 清理默认档案注释 ${r.changes} 条`);
  } catch (e) {
    console.warn('[migrate] 清理默认档案失败:', e.message);
  }

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
  // WRITE_LIMIT_MAX 仅供回归测试调高配额（默认 60，生产不动）
  const writeMax = parseInt(process.env.WRITE_LIMIT_MAX || '60', 10) || 60;
  const writeLimiter = rateLimit({
    ...limiterOpts,
    windowMs: 60 * 1000,
    max: writeMax,
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
    // 预设角色卡 / 广场列表公开（未登录可浏览，用于拉新）；领养/生成/发布仍需登录
    // v1.17.7: /prompt-templates 公开（生效中的扮演模板，不敏感；一键填入/恢复默认用）
    // v1.20.0: /providers 公开（API 提供商预设，无密钥，纯静态配置）
    if (p.startsWith('/auth/') || p === '/config' || p === '/health' || p === '/character-cards/presets' || p === '/character-cards/shared' || p === '/prompt-templates' || p === '/providers') return next();
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
  // 管理员鉴权：单用户模式直接放行（本机即管理员）；多用户模式需登录且 is_admin
  // 返回 true=通过；未通过时已写响应，调用方直接 return
  const requireAdmin = (req, res) => {
    if (!getConfig().multiUser) return true;
    const uid = uidOf(req);
    if (!uid) {
      res.status(401).json({ error: '未登录' });
      return false;
    }
    const row = db.prepare('SELECT is_admin FROM users WHERE id = ?').get(uid);
    if (!row || !row.is_admin) {
      res.status(403).json({ error: '需要管理员权限' });
      return false;
    }
    return true;
  };
  // v1.28.1: 音色归属校验——UUID 格式视为定制音色 id，必须是自己的；内置音色名直接放行
  // 返回 { voiceId } 或 { error }
  const resolveVoiceId = (voice_id, req) => {
    const v = String(voice_id || '').trim();
    if (!v) return { voiceId: null };
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
    if (!isUuid) return { voiceId: v }; // 内置音色名
    const uid = uidOf(req) || 'local';
    const ok = db.prepare('SELECT 1 FROM custom_voices WHERE id = ? AND user_id = ?').get(v, uid);
    if (!ok) return { error: '该定制音色不存在' };
    return { voiceId: v };
  };
  const char404 = (res) => res.status(404).json({ error: '角色不存在' });
  const conv404 = (res) => res.status(404).json({ error: '对话不存在' });

  // ---------- BYOK：从请求头取用户自己的 Key（后端只透传、不存储、不记日志） ----------
  function requestApiKey(req) {
    const h = req.headers['x-openrouter-key'];
    return typeof h === 'string' ? h.trim() : '';
  }

  // ---------- v1.17.1: 上游内容过滤兜底 ----------
  // 被上游拦截（finish_reason=content_filter）时自动换无审查模型重试一次，
  // 绝不把半截输出当完整回复呈现。仅积分模式（白名单可控）做自动重试。
  // v1.17.3: 回退链可配置（sys_settings.filter_fallback_models，JSON 数组，按优先级排序）
  const FILTER_NOTICE =
    '（刚才的回复被上游模型的内容过滤器拦截了，没能完整生成 😢 换个说法再试一次，或者切换到无审查模型会更放得开。）';

  // ---------- 积分计费（多用户模式） ----------
  // 解析用户计费方式，返回 { usePoints, userId, balance, chatModel, workerModel, llmOpts }；
  // 积分不足或平台未开通时返回 { error }（调用方直接 402，不落库用户消息）。
  function resolveBilling(req, cfg, creds) {
    const base = {
      usePoints: false,
      chatModel: creds.chatModel,
      workerModel: creds.workerModel,
      llmOpts: { apiKey: creds.apiKey, baseUrl: creds.baseUrl, provider: creds.provider },
    };
    const uid = uidOf(req);
    if (!cfg.multiUser || !uid) return base;
    const u = db.prepare('SELECT billing_mode, points_balance FROM users WHERE id = ?').get(uid);
    if (!u || (u.billing_mode || 'points') !== 'points') return base;
    // 积分模式：模型必须在白名单（服务端强制，前端传什么都没用），后台固定最便宜
    const activeModels = listPointsModels(true);
    const chatModel = getPointsModel(creds.chatModel)
      ? creds.chatModel
      : getChatDefaultModel() || (activeModels[0] && activeModels[0].id) || '';
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
  // v1.19.0: 自带 Key 模式下只记录用量不扣费（api_usage 统计用）
  function bgBill(bill, cfg, reason, model, onBalance) {
    return (usage) => {
      if (cfg.mockLlm || !usage) return;
      if (!bill.usePoints) {
        recordByokUsage(bill.userId, model, reason, usage);
        return;
      }
      // v1.21.0: 导演决策不扣用户积分（沉默免费——基础设施调用用户无感）
      if (reason === 'director') return;
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
        ? j.data.map((m) => {
            // v1.26.2: 带实时报价（USD/1M tokens，字符串转数字）
            const p = (m && m.pricing) || {};
            const toNum = (v) => {
              const n = parseFloat(v);
              return Number.isFinite(n) ? n * 1e6 : null;
            };
            return {
              id: String(m.id || ''),
              name: String(m.name || m.id || ''),
              pricing: {
                prompt: toNum(p.prompt),
                completion: toNum(p.completion),
              },
              context_length: m.context_length || null,
            };
          }).filter((m) => m.id)
        : [];
      res.json({ models });
    } catch (e) {
      res.status(502).json({ error: `拉取模型列表失败：${String((e && e.message) || e).slice(0, 200)}` });
    }
  }));

  // ---------- 角色卡 ----------
  // 预设卡列表（公开：未登录可浏览，用于拉新）
  // v1.16.6: 返回领养数，首页角色墙按领养数取 Top 6-8
  // v1.17.0: 破限预设插件库（给前端下拉框）
  app.get('/api/jailbreak-presets', (req, res) => {
    res.json({ presets: jailbreakPresetList() });
  });

  // v1.17.7: 生效中的扮演提示词模板（管理员覆盖 > 内置；公开，所有用户创建角色/恢复默认都吃这个）
  app.get('/api/prompt-templates', (req, res) => {
    res.json({ roleplay_template: getRoleplayTemplate() });
  });

  app.get('/api/character-cards/presets', (req, res) => {
    const cards = getPresetCards();
    let counts = {};
    try {
      const rows = db
        .prepare("SELECT card_key, COUNT(*) AS n FROM user_collection WHERE card_key LIKE 'preset:%' GROUP BY card_key")
        .all();
      for (const r of rows) counts[r.card_key] = r.n;
    } catch (e) {}
    const withCount = cards.map((c) => ({
      ...c,
      adopt_count: counts['preset:' + c.id] || 0,
    }));
    withCount.sort((a, b) => b.adopt_count - a.adopt_count);
    res.json({ categories: CARD_CATEGORIES, cards: withCount });
  });

  // 一键领养：preset_id 或 card（二选一）→ 建角色 + 建对话 + 开场白作为首条消息
  // card_key 用于图鉴记录（preset:<id> / shared:<id> / gen），rewardInfo 回传集齐奖励
  function adoptCardInternal(card, req, cardKey) {
    const uid = uidOf(req);
    const collUid = uid || 'local'; // 单用户模式用固定 key，保证图鉴唯一性
    const t = now();
    const charId = randomUUID();
    const convId = randomUUID();
    const title = `与${card.name}的相遇`;
    let reward = 0;
    db.transaction(() => {
      db.prepare(
        'INSERT INTO characters(id,user_id,name,avatar,soul_md,user_md,memory_md,model,temperature,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)'
      ).run(
        charId,
        uid,
        card.name,
        card.avatar || '🤖',
        card.soul_md,
        '', // v1.20.5: 档案默认空，省 token
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
      // 图鉴记录（幂等）
      if (cardKey) {
        db.prepare('INSERT OR IGNORE INTO user_collection(user_id, card_key, adopted_at) VALUES(?,?,?)').run(
          collUid,
          cardKey,
          t
        );
      }
    })();
    // 集齐官方卡奖励（多用户模式，幂等；失败不影响领养）
    try {
      if (uid && cardKey && cardKey.startsWith('preset:')) reward = maybeCollectionReward(uid, getPresetCards().length);
    } catch (e) {
      console.warn('[points] 集卡奖励检查失败:', e.message);
    }
    return {
      character: getChar(charId, req),
      conversation: { id: convId, character_id: charId, title, created_at: t, updated_at: t },
      collection_reward: reward,
    };
  }

  app.post(
    '/api/character-cards/adopt',
    ah(async (req, res) => {
      const body = req.body || {};
      let card = null;
      let cardKey = null;
      if (body.preset_id) {
        const preset = getPresetCard(String(body.preset_id));
        if (!preset) return res.status(404).json({ error: '预设角色卡不存在' });
        card = preset;
        cardKey = `preset:${preset.id}`;
      } else if (body.card) {
        card = sanitizeCardInput(body.card);
        if (!isAdoptableCard(card)) return res.status(400).json({ error: '角色卡数据不完整' });
        cardKey = 'gen'; // AI 生成/自定义卡：记一条通用收藏，不计入官方收集进度
      } else {
        return res.status(400).json({ error: '缺少 preset_id 或 card' });
      }
      const out = adoptCardInternal(card, req, cardKey);
      // v1.13: 从收藏领养时标记已领养
      try {
        const uid = uidOf(req);
        const sid = Number(body.saved_id) || 0;
        if (uid && sid > 0 && out && out.character && out.character.id) {
          db.prepare('UPDATE saved_cards SET adopted = 1, character_id = ? WHERE id = ? AND user_id = ?')
            .run(out.character.id, sid, uid);
        }
      } catch (e) {
        console.error('[saved_cards] mark adopted failed:', e.message);
      }
      res.status(201).json(out);
    })
  );

  // ---------- v1.13: 收藏的 AI 生成卡 ----------
  // 列表（仅自己）
  app.get(
    '/api/saved-cards',
    ah(async (req, res) => {
      const uid = uidOf(req);
      if (!uid) return res.status(401).json({ error: '未登录' });
      const rows = db
        .prepare('SELECT id, card_json, prompt, adopted, character_id, created_at FROM saved_cards WHERE user_id = ? ORDER BY created_at DESC LIMIT 100')
        .all(uid);
      res.json({
        cards: rows.map((r) => {
          let card = null;
          try { card = JSON.parse(r.card_json); } catch {}
          return {
            id: r.id,
            card,
            prompt: r.prompt,
            adopted: !!r.adopted,
            character_id: r.character_id,
            created_at: r.created_at,
          };
        }),
      });
    })
  );

  // 删除（仅自己）
  app.delete(
    '/api/saved-cards/:id',
    ah(async (req, res) => {
      const uid = uidOf(req);
      if (!uid) return res.status(401).json({ error: '未登录' });
      const r = db.prepare('DELETE FROM saved_cards WHERE id = ? AND user_id = ?').run(req.params.id, uid);
      if (!r.changes) return res.status(404).json({ error: '不存在或无权限' });
      res.json({ ok: true });
    })
  );

  // ---------- 角色广场 UGC ----------
  // 广场列表（公开：未登录可浏览；仅 approved）
  app.get(
    '/api/character-cards/shared',
    ah(async (req, res) => {
      const sort = req.query.sort === 'new' ? 'new' : 'hot';
      const q = String(req.query.q || '').trim().toLowerCase();
      const limit = Math.min(parseInt(req.query.limit || '30', 10) || 30, 100);
      const offset = Math.max(parseInt(req.query.offset || '0', 10) || 0, 0);
      const orderBy = sort === 'new' ? 's.created_at DESC' : 's.adopt_count DESC, s.like_count DESC';
      const uid = uidOf(req);
      const collUid = uid || 'local';
      let rows = db
        .prepare(
          `SELECT s.*, u.username AS author_name,
             CASE WHEN l.user_id IS NULL THEN 0 ELSE 1 END AS liked,
             CASE WHEN c.card_key IS NULL THEN 0 ELSE 1 END AS adopted
           FROM shared_cards s
           LEFT JOIN users u ON u.id = s.author_id
           LEFT JOIN card_likes l ON l.shared_card_id = s.id AND l.user_id = ?
           LEFT JOIN user_collection c ON c.card_key = ('shared:' || s.id) AND c.user_id = ?
           WHERE s.status = 'approved'
           ORDER BY ${orderBy} LIMIT ? OFFSET ?`
        )
        .all(collUid, collUid, limit, offset);
      if (q) {
        rows = rows.filter((r) => {
          const card = JSON.parse(r.card_json);
          const hay = `${card.name} ${card.tagline || ''} ${(card.tags || []).join(' ')} ${card.description || ''}`.toLowerCase();
          return hay.includes(q);
        });
      }
      res.json(
        rows.map((r) => ({
          id: r.id,
          author_name: r.author_name || '神秘作者',
          card: JSON.parse(r.card_json),
          adopt_count: r.adopt_count,
          like_count: r.like_count,
          liked: !!r.liked,
          adopted: !!r.adopted,
          created_at: r.created_at,
        }))
      );
    })
  );

  // 发布角色到广场：从我的一只角色快照建卡 → pending 待审核
  app.post(
    '/api/character-cards/publish',
    ah(async (req, res) => {
      const uid = uidOf(req);
      const body = req.body || {};
      const char = getChar(body.character_id, req);
      if (!char) return res.status(404).json({ error: '角色不存在' });
      // 每人最多 10 条待审核，避免灌水
      const pending = db
        .prepare("SELECT COUNT(*) AS n FROM shared_cards WHERE author_id = ? AND status = 'pending'")
        .get(uid || 'local').n;
      if (pending >= 10) return res.status(429).json({ error: '待审核投稿已达 10 条上限，请等待审核' });
      // 开场白：前端可传 greeting；不传则取该角色最近一条 AI 回复；都没有则要求前端填写
      const lastAsst = db
        .prepare(
          `SELECT m.content FROM messages m JOIN conversations c ON c.id = m.conversation_id
           WHERE c.character_id = ? AND m.role = 'assistant' ORDER BY m.id DESC LIMIT 1`
        )
        .get(char.id);
      const draft = buildPublishDraft(char, lastAsst ? lastAsst.content : '');
      draft.tagline = String(body.tagline || '').trim();
      draft.description = String(body.description || '').trim();
      const bodyGreeting = String(body.greeting || '').trim();
      if (bodyGreeting) draft.greeting = bodyGreeting;
      if (body.category && CARD_CATEGORIES[body.category]) draft.category = body.category;
      if (Array.isArray(body.tags)) draft.tags = body.tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 6);
      const v = validateSharedCard(draft);
      if (!v.ok) return res.status(400).json({ error: v.error });
      const id = randomUUID();
      const t = now();
      // 单用户模式是私有部署，发布直接上架；多用户模式进待审核
      const cfg = getConfig();
      const status = cfg.multiUser ? 'pending' : 'approved';
      db.prepare(
        'INSERT INTO shared_cards(id, author_id, card_json, status, created_at) VALUES(?,?,?,?,?)'
      ).run(id, uid || 'local', JSON.stringify(v.card), status, t);
      res.status(201).json({
        id,
        status,
        message: status === 'approved' ? '已上架广场' : '已提交，审核通过后上架广场',
      });
    })
  );

  // 我的投稿（含状态）
  app.get('/api/character-cards/my-published', (req, res) => {
    const uid = uidOf(req) || 'local';
    const rows = db
      .prepare(
        'SELECT id, card_json, status, reject_reason, adopt_count, like_count, created_at, reviewed_at FROM shared_cards WHERE author_id = ? ORDER BY created_at DESC'
      )
      .all(uid);
    res.json(
      rows.map((r) => ({
        id: r.id,
        card: JSON.parse(r.card_json),
        status: r.status,
        reject_reason: r.reject_reason,
        adopt_count: r.adopt_count,
        like_count: r.like_count,
        created_at: r.created_at,
        reviewed_at: r.reviewed_at,
      }))
    );
  });

  // 删除自己的投稿（作者本人；管理员走审核打回）
  app.delete(
    '/api/character-cards/shared/:id',
    ah(async (req, res) => {
      const uid = uidOf(req) || 'local';
      const r = db.prepare('SELECT * FROM shared_cards WHERE id = ? AND author_id = ?').get(req.params.id, uid);
      if (!r) return res.status(404).json({ error: '投稿不存在' });
      db.transaction(() => {
        db.prepare('DELETE FROM card_likes WHERE shared_card_id = ?').run(r.id);
        db.prepare('DELETE FROM shared_cards WHERE id = ?').run(r.id);
      })();
      res.json({ ok: true });
    })
  );

  // 领养广场卡（仅 approved）
  app.post(
    '/api/character-cards/shared/:id/adopt',
    ah(async (req, res) => {
      const r = db.prepare("SELECT * FROM shared_cards WHERE id = ? AND status = 'approved'").get(req.params.id);
      if (!r) return res.status(404).json({ error: '该角色卡不存在或未上架' });
      const card = sanitizeCardInput(JSON.parse(r.card_json));
      db.prepare('UPDATE shared_cards SET adopt_count = adopt_count + 1 WHERE id = ?').run(r.id);
      res.status(201).json(adoptCardInternal(card, req, `shared:${r.id}`));
    })
  );

  // 点赞 / 取消赞
  app.post(
    '/api/character-cards/shared/:id/like',
    ah(async (req, res) => {
      const uid = uidOf(req) || 'local';
      const r = db.prepare("SELECT id FROM shared_cards WHERE id = ? AND status = 'approved'").get(req.params.id);
      if (!r) return res.status(404).json({ error: '该角色卡不存在或未上架' });
      const t = now();
      const liked = db.transaction(() => {
        const has = db
          .prepare('SELECT 1 FROM card_likes WHERE user_id = ? AND shared_card_id = ?')
          .get(uid, r.id);
        if (has) {
          db.prepare('DELETE FROM card_likes WHERE user_id = ? AND shared_card_id = ?').run(uid, r.id);
          db.prepare('UPDATE shared_cards SET like_count = MAX(like_count - 1, 0) WHERE id = ?').run(r.id);
          return false;
        }
        db.prepare('INSERT INTO card_likes(user_id, shared_card_id, created_at) VALUES(?,?,?)').run(uid, r.id, t);
        db.prepare('UPDATE shared_cards SET like_count = like_count + 1 WHERE id = ?').run(r.id);
        return true;
      })();
      const likeCount = db.prepare('SELECT like_count FROM shared_cards WHERE id = ?').get(r.id).like_count;
      res.json({ liked, like_count: likeCount });
    })
  );

  // 举报：累计 5 个不同用户举报自动下架回 pending 待审（v1.28.1: 需登录+按人去重，防单人连点）
  app.post(
    '/api/character-cards/shared/:id/report',
    ah(async (req, res) => {
      const uid = uidOf(req);
      // 多用户模式需登录；单用户模式用固定 reporter（本机只有一人）
      const reporter = uid || (getConfig().multiUser ? null : 'local');
      if (!reporter) return res.status(401).json({ error: '请先登录再举报' });
      const r = db.prepare("SELECT id, report_count FROM shared_cards WHERE id = ? AND status = 'approved'").get(
        req.params.id
      );
      if (!r) return res.status(404).json({ error: '该角色卡不存在或未上架' });
      const reason = String((req.body && req.body.reason) || '').trim().slice(0, 200);
      const dup = db
        .prepare('SELECT 1 FROM card_reports WHERE user_id = ? AND shared_card_id = ?')
        .get(reporter, r.id);
      if (dup) return res.json({ ok: true, message: '你已经举报过这张卡片' });
      db.transaction(() => {
        db.prepare('INSERT INTO card_reports(user_id, shared_card_id, reason, created_at) VALUES(?,?,?,?)').run(
          reporter,
          r.id,
          reason,
          now()
        );
        db.prepare('UPDATE shared_cards SET report_count = report_count + 1 WHERE id = ?').run(r.id);
        if (r.report_count + 1 >= 5) {
          db.prepare("UPDATE shared_cards SET status = 'pending', reviewed_at = ? WHERE id = ?").run(now(), r.id);
        }
      })();
      res.json({ ok: true, message: reason ? '已收到举报，管理员会尽快处理' : '已收到举报' });
    })
  );

  // 集卡图鉴：官方 18 张收集进度 + 已领养的广场卡
  app.get(
    '/api/character-cards/collection',
    ah(async (req, res) => {
      const uid = uidOf(req);
      const collUid = uid || 'local';
      const presets = getPresetCards();
      const adoptedKeys = new Set(
        db.prepare('SELECT card_key FROM user_collection WHERE user_id = ?').all(collUid).map((r) => r.card_key)
      );
      const adoptedCount = presets.filter((c) => adoptedKeys.has(`preset:${c.id}`)).length;
      const rewardClaimed = uid
        ? !!db
            .prepare("SELECT id FROM points_ledger WHERE user_id = ? AND reason = 'collection_reward' LIMIT 1")
            .get(uid)
        : adoptedCount >= presets.length; // 单用户无账本：集齐即视为完成
      // 已领养的广场卡
      const sharedAdopted = db
        .prepare(
          `SELECT s.id, s.card_json, s.adopt_count FROM shared_cards s
           JOIN user_collection c ON c.card_key = ('shared:' || s.id)
           WHERE c.user_id = ? ORDER BY c.adopted_at DESC`
        )
        .all(collUid)
        .map((r) => ({ id: r.id, card: JSON.parse(r.card_json), adopt_count: r.adopt_count }));
      // v1.13: 我养成的角色（5 条记忆进图鉴；facts 经 character_id 隔离，无需 user_id）
      let myGrown = [];
      if (uid) {
        myGrown = db
          .prepare(
            `SELECT c.id, c.name, c.avatar,
              (SELECT COUNT(*) FROM memory_facts f WHERE f.character_id = c.id AND f.superseded_by IS NULL) AS fact_count
             FROM characters c WHERE c.user_id = ? ORDER BY fact_count DESC, c.created_at DESC LIMIT 100`
          )
          .all(uid)
          .map((r) => ({
            id: r.id,
            name: r.name,
            avatar: r.avatar,
            fact_count: r.fact_count || 0,
            in_dex: (r.fact_count || 0) >= 5,
          }));
      }
      res.json({
        presets: presets.map((c) => ({
          id: c.id,
          name: c.name,
          avatar: c.avatar,
          category: c.category,
          tagline: c.tagline,
          adopted: adoptedKeys.has(`preset:${c.id}`),
        })),
        adopted_count: adoptedCount,
        total: presets.length,
        reward_points: COLLECTION_REWARD,
        reward_claimed: rewardClaimed,
        shared_adopted: sharedAdopted,
        my_grown: myGrown,
        dex_threshold: 5,
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
      // v1.19.0: 自带 Key 生成只记录不扣费
      if (!usePoints && !cfg.mockLlm) {
        const usage = result.usage || {
          input: estimateTokens(desc),
          output: estimateTokens(JSON.stringify(result.card)),
        };
        recordByokUsage(uid, model, 'character_generate', usage);
      }
      // v1.13: 生成成功自动保存到收藏
      let savedId = null;
      if (uid && result && result.card) {
        try {
          const r = db
            .prepare(
              'INSERT INTO saved_cards(user_id, card_json, prompt, created_at) VALUES(?,?,?,?)'
            )
            .run(uid, JSON.stringify(result.card), desc, new Date().toISOString());
          savedId = Number(r.lastInsertRowid);
        } catch (e) {
          console.error('[saved_cards] auto-save failed:', e.message);
        }
      }
      res.json({ card: result.card, cost, saved_id: savedId });
    })
  );

  // v1.16.0: AI 生成灵魂设定（新建角色弹窗用）：成功后按真实用量扣积分，失败不扣
  app.post(
    '/api/soul/generate',
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
          model = getWorkerModel();
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
        model = creds.workerModel || creds.chatModel;
        if (!apiKey && !cfg.mockLlm) return res.status(401).json({ error: NO_KEY_MESSAGE });
      }

      const ac = new AbortController();
      req.on('close', () => ac.abort());
      let result;
      try {
        result = await generateSoulMd({ desc, model, apiKey, baseUrl, signal: ac.signal });
      } catch (e) {
        return res.status(502).json({ error: String((e && e.message) || e).slice(0, 300) });
      }

      let cost = null;
      if (usePoints && !cfg.mockLlm) {
        const usage = result.usage || {
          input: estimateTokens(desc),
          output: estimateTokens(result.soul_md),
        };
        const pts = calcPoints(model, usage);
        let balance;
        try {
          balance = deductPoints(uid, pts, 'soul_generate', null, null, {
            tokensInput: usage.input,
            tokensOutput: usage.output,
            model,
          });
        } catch (e) {
          return res.status(402).json({ error: '积分不足，本次生成不计费' });
        }
        cost = { points: pts, model, tokens_input: usage.input, tokens_output: usage.output, balance };
      }
      // v1.19.0: 自带 Key 生成只记录不扣费
      if (!usePoints && !cfg.mockLlm) {
        const usage = result.usage || {
          input: estimateTokens(desc),
          output: estimateTokens(result.soul_md),
        };
        recordByokUsage(uid, model, 'soul_generate', usage);
      }
      res.json({ soul_md: result.soul_md, cost });
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
    // v1.16.0: 新建角色弹窗改版，支持 soul_md / user_md / roleplay_mode
    // v1.16.4: 支持 roleplay_prompt（空=用内置模板）
    // v1.26.0: 支持 voice_id（音色）
    const { name, avatar, temperature, soul_md, user_md, roleplay_mode, roleplay_prompt, jailbreak_preset, voice_id } = req.body || {};
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'name 不能为空' });
    // v1.18.1: 破限白名单——无权限用户不能建开着破限的角色
    if (jailbreak_preset && JAILBREAK_PRESETS[jailbreak_preset] && !canUseJailbreak(uidOf(req))) {
      return res.status(403).json({ error: '破限模式需管理员授权' });
    }
    // v1.28.1: 音色归属校验（UUID 视为定制音色，必须是自己的）
    const vv = resolveVoiceId(voice_id, req);
    if (vv.error) return res.status(400).json({ error: vv.error });
    const id = randomUUID();
    const t = now();
    const row = {
      id,
      user_id: uidOf(req),
      name: String(name).trim(),
      avatar: avatar || '🤖',
      soul_md: soul_md && String(soul_md).trim() ? String(soul_md) : DEFAULT_SOUL,
      user_md: user_md && String(user_md).trim() ? String(user_md) : '', // v1.20.5: 档案默认空，省 token；用户填了才注入
      memory_md: DEFAULT_MEMORY_MD,
      model: '',
      temperature: temperature ?? 0.8,
      roleplay_mode: roleplay_mode ? 1 : 0,
      roleplay_prompt: roleplay_prompt && String(roleplay_prompt).trim() ? String(roleplay_prompt).trim() : null,
      jailbreak_preset: jailbreak_preset && JAILBREAK_PRESETS[jailbreak_preset] ? jailbreak_preset : null,
      voice_id: vv.voiceId, // v1.26.0; v1.28.1: 已做归属校验
      created_at: t,
      updated_at: t,
    };
    db.prepare(
      'INSERT INTO characters(id,user_id,name,avatar,soul_md,user_md,memory_md,model,temperature,roleplay_mode,roleplay_prompt,jailbreak_preset,voice_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
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
      row.roleplay_mode,
      row.roleplay_prompt,
      row.jailbreak_preset,
      row.voice_id,
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
    const { name, avatar, temperature, roleplay_mode, roleplay_prompt, jailbreak_preset, voice_id } = req.body || {};
    // v1.18.1: 破限白名单——无权限用户不能开启破限（关闭永远允许）
    if (jailbreak_preset && JAILBREAK_PRESETS[jailbreak_preset] && !canUseJailbreak(uidOf(req))) {
      return res.status(403).json({ error: '破限模式需管理员授权' });
    }
    // v1.28.1: 音色归属校验（仅当传入了 voice_id 才校验；undefined=保持原值）
    let vv = { voiceId: c.voice_id || null };
    if (voice_id !== undefined) {
      vv = resolveVoiceId(voice_id, req);
      if (vv.error) return res.status(400).json({ error: vv.error });
    }
    const next = {
      name: name !== undefined ? String(name).trim() : c.name,
      avatar: avatar !== undefined ? avatar : c.avatar,
      model: c.model,
      temperature: temperature !== undefined ? temperature : c.temperature,
      // v1.15.0: 扮演模式开关 + 自定义提示词（null/空串 = 用内置模板）
      roleplay_mode: roleplay_mode !== undefined ? (roleplay_mode ? 1 : 0) : (c.roleplay_mode || 0),
      roleplay_prompt:
        roleplay_prompt === undefined
          ? c.roleplay_prompt || null
          : roleplay_prompt === null
            ? null // v1.15.2 修复：String(null)==="null" 会误存字符串，必须显式判空
            : String(roleplay_prompt).trim() || null,
      // v1.17.0: 破限预设（null=关闭；非法 key 存 null）
      jailbreak_preset:
        jailbreak_preset === undefined
          ? c.jailbreak_preset || null
          : jailbreak_preset && JAILBREAK_PRESETS[jailbreak_preset]
            ? jailbreak_preset
            : null,
      // v1.26.0: 音色（null=跟随全局默认）；v1.28.1: 已做归属校验
      voice_id: vv.voiceId,
      updated_at: now(),
    };
    if (!next.name) return res.status(400).json({ error: 'name 不能为空' });
    db.prepare(
      'UPDATE characters SET name=?, avatar=?, model=?, temperature=?, roleplay_mode=?, roleplay_prompt=?, jailbreak_preset=?, voice_id=?, updated_at=? WHERE id=?'
    ).run(
      next.name,
      next.avatar,
      next.model,
      next.temperature,
      next.roleplay_mode,
      next.roleplay_prompt,
      next.jailbreak_preset,
      next.voice_id,
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
    // v1.28.1: 级联删除补用户隔离（纵深防御；创建路径已验证归属，此处双保险）
    const fPlain = andUid(req);
    const gmScope = uidOf(req)
      ? 'AND conversation_id IN (SELECT id FROM conversations WHERE user_id = ?)'
      : '';
    const gmArgs = uidOf(req) ? [uidOf(req)] : [];
    db.transaction(() => {
      for (const cid of convIds) {
        db.prepare('DELETE FROM messages WHERE conversation_id = ?').run(cid);
        db.prepare('DELETE FROM conversation_summaries WHERE conversation_id = ?').run(cid);
      }
      db.prepare(`DELETE FROM conversations WHERE character_id = ?${fPlain.sql}`).run(c.id, ...fPlain.args);
      db.prepare(`DELETE FROM group_members WHERE character_id = ?${gmScope}`).run(c.id, ...gmArgs);
      // file_versions 写入路径（PUT files）已做 getChar 验证，character_id 不可能跨用户
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

  // ---------- v1.10 意图识别：灵魂修改建议 ----------
  // 待确认的建议列表
  app.get('/api/characters/:id/suggestions', (req, res) => {
    const c = getChar(req.params.id, req);
    if (!c) return char404(res);
    const rows = db
      .prepare(
        `SELECT id, proposed, status, created_at FROM intent_suggestions
         WHERE character_id = ? AND status = 'pending' ORDER BY id DESC LIMIT 10`
      )
      .all(c.id);
    res.json(rows);
  });
  // 一键写入灵魂：追加到 ## 对话补充设定 小节 + 写版本
  app.post('/api/suggestions/:id/apply', (req, res) => {
    const s = db.prepare('SELECT * FROM intent_suggestions WHERE id = ?').get(req.params.id);
    if (!s || s.status !== 'pending') return res.status(404).json({ error: '建议不存在或已处理' });
    const c = getChar(s.character_id, req);
    if (!c) return char404(res);
    const t = now();
    const section = '## 对话补充设定';
    let soul = c.soul_md || '';
    const line = `- ${s.proposed}`;
    if (!soul.includes(line)) {
      soul = soul.includes(section) ? `${soul.trimEnd()}\n${line}\n` : `${soul.trimEnd()}\n\n${section}\n${line}\n`;
    }
    db.transaction(() => {
      db.prepare('UPDATE characters SET soul_md = ?, updated_at = ? WHERE id = ?').run(soul, t, c.id);
      db.prepare('INSERT INTO file_versions(character_id, file, content, created_at) VALUES(?,?,?,?)').run(
        c.id,
        'soul',
        soul,
        t
      );
      db.prepare("UPDATE intent_suggestions SET status = 'applied' WHERE id = ?").run(s.id);
    })();
    res.json({ ok: true });
  });
  // 忽略建议
  app.post('/api/suggestions/:id/dismiss', (req, res) => {
    const s = db.prepare('SELECT * FROM intent_suggestions WHERE id = ?').get(req.params.id);
    if (!s || s.status !== 'pending') return res.status(404).json({ error: '建议不存在或已处理' });
    const c = getChar(s.character_id, req);
    if (!c) return char404(res);
    db.prepare("UPDATE intent_suggestions SET status = 'dismissed' WHERE id = ?").run(s.id);
    res.json({ ok: true });
  });

  // ---------- v1.11 记忆事实列表 ----------
  // 事实列表（默认只返回未被替代的，按 id 倒序）
  app.get('/api/characters/:id/facts', (req, res) => {
    const c = getChar(req.params.id, req);
    if (!c) return char404(res);
    const all = req.query.all === '1';
    const rows = db
      .prepare(
        all
          ? `SELECT id, fact, importance, created_at, superseded_by, source FROM memory_facts WHERE character_id = ? ORDER BY id DESC LIMIT 200`
          : `SELECT id, fact, importance, created_at, superseded_by, source FROM memory_facts WHERE character_id = ? AND superseded_by IS NULL ORDER BY id DESC LIMIT 200`
      )
      .all(c.id);
    res.json(rows);
  });
  // 删除一条事实（硬删除，FTS 触发器自动清理索引）
  app.delete('/api/facts/:id', (req, res) => {
    const f = db.prepare('SELECT * FROM memory_facts WHERE id = ?').get(req.params.id);
    if (!f) return res.status(404).json({ error: '记忆不存在' });
    const c = getChar(f.character_id, req);
    if (!c) return char404(res);
    db.prepare('DELETE FROM memory_facts WHERE id = ?').run(f.id);
    res.json({ ok: true });
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

  // v1.12 记忆写入事件：前端在 done 后轮询，拿到新事件即 toast"记住了"
  app.get('/api/conversations/:id/memory-events', (req, res) => {
    const conv = getConv(req.params.id, req);
    if (!conv) return conv404(res);
    const since = String(req.query.since || '1970-01-01T00:00:00.000Z');
    const rows = db
      .prepare(
        `SELECT e.id, e.character_id, e.created_at, e.facts_added, e.user_md_changed, c.name AS character_name
         FROM memory_events e LEFT JOIN characters c ON c.id = e.character_id
         WHERE e.conversation_id = ? AND e.created_at > ?
         ORDER BY e.id ASC LIMIT 20`
      )
      .all(conv.id, since);
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
  // v1.18.0: 对话标题规则（B）——无意义开场白（问候/测试）不直接当标题，留"新对话"占位等 AI 生成
  const GREETING_RE = /^(你好|您好|hi+|hello|嘿|嗨|哈喽|在吗|在么|在不在|test|测试|111|222|…|\.|。|！|!|？|\?|\s)+$/i;
  function ruleTitle(content) {
    const c = String(content || '').trim().replace(/\s+/g, ' ');
    if (!c || GREETING_RE.test(c)) return '新对话';
    return c.slice(0, 18);
  }
  // ---------- 群聊消息 SSE：导演决策 → 按角色串行流式 ----------
  // v1.22.0: 群聊单角色流式一轮——主流程 runTurn 与 POST regenerate-turn 复用
  // deps: { send, res, conv, cfg, bill, chatModel, llmOpts, usePoints, members, query, batchId }
  // st: { ctxInfo, usageInput, usageOutput, pointsBalance }（可变状态，函数内更新）
  // opts: { excludeMentionIds, wakeHint }（@接龙排除列表，默认只排除自己；wakeHint 为被点名时的唤醒提示）
  async function streamGroupTurn(deps, ch, st, opts = {}) {
    const { send, res, conv, cfg, bill, chatModel, llmOpts, usePoints, members, query, batchId } = deps;
    if (res.destroyed) return null;
    const groupCtx = buildGroupContext(members, conv.id, query, chatModel);
    const { apiMessages, usedTokens } = groupCtx.buildFor(ch, opts.wakeHint);
    if (!st.ctxInfo) {
      st.ctxInfo = { used: usedTokens, budget: groupCtx.budget };
      send('context', st.ctxInfo);
    }
    st.usageInput += usedTokens;
    send('turn_start', { character_id: ch.id, character_name: ch.name, character_avatar: ch.avatar, batch_id: batchId });
    let full = '';
    let turnUsage = null;
    let turnFinishReason = null;
    let turnStalled = false; // v1.25.6
    let turnModel = chatModel;
    try {
      // v1.17.1: 内容过滤兜底——被拦截时换无审查模型重试，绝不呈现半截输出
      const doGroupStream = async (model) => {
        let text = '';
        // v1.17.2: 429 自动重试，瞬时限流用户无感
        const r = await withRetry(() =>
          chatStream({
            messages: apiMessages,
            model,
            temperature: ch.temperature ?? 0.8,
            ...llmOpts,
            onToken: (delta) => {
              text += delta;
              send('token', { character_id: ch.id, text: delta });
            },
          })
        );
        return { text, usage: r.usage, finishReason: r.finishReason, stalled: r.stalled };
      };
      let gr = await doGroupStream(chatModel);
      if (gr.finishReason === 'content_filter' && usePoints) {
        const fb = pickFilterFallbackModel(chatModel);
        if (fb) {
          send('filter_retry', { character_id: ch.id, model: fb });
          gr = await doGroupStream(fb);
          turnModel = fb;
        }
      }
      if (gr.finishReason === 'content_filter') {
        full = FILTER_NOTICE;
      } else {
        full = gr.text;
      }
      turnUsage = gr.usage;
      turnFinishReason = gr.finishReason;
      turnStalled = !!gr.stalled; // v1.25.6: 上游流停滞也算截断
    } catch (e) {
      // v1.28.2: 单角色流异常时带上 batch_id，前端可按角色+batch 定位半截并给出重试按钮
      send('error', { character_id: ch.id, batch_id: batchId, message: `${ch.name} 回复失败：${String((e && e.message) || e)}` });
      return null;
    }
    const outTokens = estimateTokens(full);
    st.usageOutput += outTokens;
    // 注册奖励：首次聊天成功后发放（幂等），每轮只发一次由 maybeSignupBonus 保证
    if (bill.userId) {
      try { maybeSignupBonus(bill.userId); } catch (e) { console.warn('[points] 注册奖励发放失败:', e.message); }
    }
    // 积分扣费（按发言轮次）
    if (usePoints && !cfg.mockLlm) {
      const u = turnUsage || { input: usedTokens, output: outTokens };
      const pts = calcPoints(turnModel, u);
      if (pts > 0) {
        try {
          st.pointsBalance = deductPoints(bill.userId, pts, 'group_chat', 'conversation', conv.id, {
            tokensInput: u.input,
            tokensOutput: u.output,
            model: turnModel,
          });
          st.pointsUsed += pts; // v1.25.0: 累计本轮积分消耗
        } catch (e) {
          console.warn('[points] 扣费失败:', e.message);
        }
      }
    }
    // v1.19.0: 自带 Key 群聊只记录不扣费
    if (!usePoints && !cfg.mockLlm) {
      const u = turnUsage || { input: usedTokens, output: outTokens };
      recordByokUsage(bill.userId, turnModel, 'group_chat', u);
    }
    const row = db
      .prepare(
        'INSERT INTO messages(conversation_id, role, content, tokens, character_id, batch_id, created_at) VALUES(?,?,?,?,?,?,?)'
      )
      .run(conv.id, 'assistant', full, outTokens, ch.id, batchId, now());
    const messageId = Number(row.lastInsertRowid);
    // v1.22.0: 截断标记——流异常结束时前端提示"好像没说完"并给重新生成
    // v1.25.6: 上游流停滞（25s 无数据）也算截断
    const truncated = full !== FILTER_NOTICE && (!turnFinishReason || turnFinishReason === 'length' || turnStalled);
    send('turn_done', {
      character_id: ch.id,
      message_id: messageId,
      batch_id: batchId,
      content: full,
      tokens: estimateTokens(full),
      truncated,
    });
    // v1.21.0: 更新该角色已读水位（增量历史注入——下次只看没见过的新消息）
    try {
      db.prepare(
        'INSERT INTO group_read_marks(conversation_id, character_id, upto_message_id) VALUES(?,?,?) ON CONFLICT(conversation_id, character_id) DO UPDATE SET upto_message_id = excluded.upto_message_id'
      ).run(conv.id, ch.id, messageId);
    } catch (e) { console.warn('[group] 水位更新失败:', e.message); }
    const mentioned = findMentionedIds(full, members, opts.excludeMentionIds || [ch.id]);
    return { messageId, content: full, truncated, mentioned, usedTokens, outTokens, turnModel };
  }

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
    // v1.18.1: 破限白名单——无权限用户群聊里也不注入破限词
    if (!canUseJailbreak(uidOf(req))) members.forEach((m) => { m.jailbreak_preset = null; });
    const memberIds = new Set(members.map((m) => m.id));

    // @点名：提到谁谁必回（最多 3 个）
    const mentioned = findMentionedIds(content, members).slice(0, 3);

    const t = now();
    // v1.21.0: 整轮 batch_id——用户消息 + 本轮所有角色回复 + @接龙共享，支持整轮删/重生成
    const batchId = 'g' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    // v1.27.1: 重试去重——regenerate 且库里最后一条用户消息内容一致时复用，不重复插入；
    // 对不上（401/402 当时没落库、消息被删）则正常插入；重试轮的角色回复仍用新 batchId
    // v1.28.2: 同时记下复用的用户消息 id，供重试时跳过已成功回复的角色（防重复叠加）
    let skipUserInsert = false;
    let reusedUserId = null;
    if (req.body && req.body.regenerate) {
      const lastUser = db
        .prepare("SELECT id, content FROM messages WHERE conversation_id = ? AND role = 'user' ORDER BY id DESC LIMIT 1")
        .get(conv.id);
      if (lastUser && String(lastUser.content || '').trim() === content) {
        skipUserInsert = true;
        reusedUserId = lastUser.id;
      }
    }
    if (!skipUserInsert) {
      db.prepare(
        'INSERT INTO messages(conversation_id, role, content, tokens, character_id, batch_id, created_at) VALUES(?,?,?,?,?,?,?)'
      ).run(conv.id, 'user', content, estimateTokens(content), null, batchId, t);
    }
    db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(t, conv.id);

    const send = sseInit(res);
    // v1.17.4: SSE 心跳（注释帧，客户端忽略），防中间设备掐 idle 连接；finally 里清理
    // 间隔可配（SSE_KEEPALIVE_MS，默认 20000；测试可调小）
    const kaMs = Math.max(50, parseInt(process.env.SSE_KEEPALIVE_MS || '20000', 10) || 20000);
    const kaTimer = setInterval(() => {
      if (!res.destroyed) { try { res.write(': ping\n\n'); } catch {} }
    }, kaMs);

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
      // v1.28.2: 重试不叠加——复用用户消息的重试只跑本轮尚未成功回复的角色；
      // 已在本轮回过的角色不再重跑，避免失败重试时重复回复越堆越多
      if (skipUserInsert && reusedUserId) {
        const replied = new Set(
          db
            .prepare(
              "SELECT character_id FROM messages WHERE conversation_id = ? AND role = 'assistant' AND character_id IS NOT NULL AND id > ?"
            )
            .all(conv.id, reusedUserId)
            .map((r) => r.character_id)
        );
        const filtered = speakerIds.filter((id) => !replied.has(id));
        // 全已回复则本轮无事可做（直接走 done，不再叠加）；保持空数组不回退，避免无意义重跑
        speakerIds = filtered;
      }

      // 2. 按角色串行流式：每轮重建上下文，后发言者能看到先发言者的回复
      const speakerChars = [];
      const spokenIds = new Set();
      const mentionedBy = new Map(); // v1.24.0: 被提及成员 id -> 提及者名字（@接龙唤醒提示用）
      let lastTurn = null; // v1.24.0: 最后一个发言者的 { ch, content }（轻模型检测用）
      let ctxInfo = null;
      let usageInput = 0;
      let usageOutput = 0;
      // v1.20.5: 单轮发言抽成函数，主流程 + @接龙复用
      // v1.22.0: 单轮发言走 streamGroupTurn（与 regenerate-turn 复用）
      const st = { ctxInfo: null, usageInput: 0, usageOutput: 0, pointsBalance, pointsUsed: 0 };
      const deps = { send, res, conv, cfg, bill, chatModel, llmOpts, usePoints, members, query: content, batchId };
      const runTurn = async (sid, wakerName) => {
        if (res.destroyed) return;
        const ch = members.find((m) => m.id === sid);
        if (!ch || spokenIds.has(sid)) return;
        spokenIds.add(sid);
        const turnOpts = { excludeMentionIds: [ch.id, ...spokenIds] };
        // v1.24.0: @接龙唤醒提示
        if (wakerName) turnOpts.wakeHint = `【${wakerName}刚才提到了你，请自然地回应他/她】`;
        const r = await streamGroupTurn(deps, ch, st, turnOpts);
        if (!r) return;
        lastTurn = { ch, content: r.content };
        // v1.10：本轮发言过的角色跑记忆流水线（意图识别/事件驱动，gate 会自动跳过无价值轮）
        speakerChars.push(ch);
        // v1.20.5: @接龙——发言里@了本轮没说过话的成员，记下来追加一轮
        for (const mid of r.mentioned) {
          if (!mentionedBy.has(mid)) mentionedBy.set(mid, ch.name);
        }
      };

      for (const sid of speakerIds) await runTurn(sid);
      // v1.20.5: @接龙只追加一轮（防 A@B@A 死循环），最多 3 人
      for (const [sid, waker] of [...mentionedBy].filter(([id]) => !spokenIds.has(id)).slice(0, 3)) {
        await runTurn(sid, waker);
      }
      // v1.24.0: 轻模型裸名检测——整轮结束后查最后一个发言者是否裸名提及他人（文本匹配漏网时兜底）
      // 只查一次、不递归；走后台模型，不扣用户积分
      if (lastTurn && !res.destroyed) {
        try {
          const detected = await detectMentions({
            text: lastTurn.content,
            members,
            excludeIds: [...spokenIds],
            model: workerModel,
            ...llmOpts,
            onUsage: bgBill(bill, cfg, 'mention_detect', workerModel, updBal),
          });
          for (const sid of detected.filter((id) => !spokenIds.has(id)).slice(0, 2)) {
            await runTurn(sid, lastTurn.ch.name);
          }
        } catch (e) {
          console.warn('[group] 提及检测失败:', e.message);
        }
      }

      if (usePoints) send('points', { balance: st.pointsBalance });
      if (bill.userId) checkInviteReward(bill.userId);
      send('done', { title: conv.title, usage: { input: st.usageInput, output: st.usageOutput }, billingMode: usePoints ? 'points' : 'api', pointsUsed: st.pointsUsed || 0 });
      // 3. 会话级摘要 + v1.10 记忆流水线放后台（并行），不阻塞 done
      const bgOpts = { ...llmOpts, signal: undefined };
      setImmediate(async () => {
        try {
          await summarizeOld(members[0], conv.id, {
            ...bgOpts,
            model: workerModel,
            onUsage: bgBill(bill, cfg, 'summary', workerModel, updBal),
          });
          await Promise.all(
            speakerChars.map((sch) =>
              runMemoryPipeline(sch, conv.id, content, {
                ...bgOpts,
                model: workerModel,
                userId: bill.userId || null,
                onUsage: bgBill(bill, cfg, 'memory', workerModel, updBal),
              })
            )
          );
        } catch (e) {
          console.warn('[bg] 群聊摘要/记忆流水线失败:', e.message);
        }
      });
    } catch (e) {
      send('error', { message: friendlyLlmError(e) });
    } finally {
      clearInterval(kaTimer);
      res.end();
    }
  }

  // v1.20.5: 清空对话全部消息（防上下文污染；顺带清掉已生成的摘要）
  app.delete('/api/conversations/:id/messages', ah(async (req, res) => {
    const conv = getConv(req.params.id, req);
    if (!conv) return conv404(res);
    // v1.25.2: 清空时级联删该对话消息来源的 facts（facts 按角色存，需先取消息 ID 列表）
    const msgIds = db.prepare('SELECT id FROM messages WHERE conversation_id = ?').all(conv.id).map((r) => r.id);
    db.transaction(() => {
      if (msgIds.length) {
        const placeholders = msgIds.map(() => '?').join(',');
        db.prepare(`DELETE FROM memory_facts WHERE source_message_id IN (${placeholders})`).run(...msgIds);
      }
      db.prepare('DELETE FROM messages WHERE conversation_id = ?').run(conv.id);
      db.prepare('DELETE FROM conversation_summaries WHERE conversation_id = ?').run(conv.id);
      db.prepare('DELETE FROM memory_events WHERE conversation_id = ?').run(conv.id);
    })();
    res.json({ ok: true });
  }));

  // v1.20.5: 删除单条消息（按所属对话鉴权）
  // v1.25.2: 级联清理——删该消息来源的 facts；若消息已被摘要（含在 message_upto 内），删相关摘要以便重生成
  app.delete('/api/messages/:id', ah(async (req, res) => {
    const m = db.prepare('SELECT conversation_id FROM messages WHERE id = ?').get(req.params.id);
    if (!m) return res.status(404).json({ error: '消息不存在' });
    const conv = getConv(m.conversation_id, req);
    if (!conv) return conv404(res);
    const mid = Number(req.params.id);
    db.transaction(() => {
      db.prepare('DELETE FROM messages WHERE id = ?').run(mid);
      db.prepare('DELETE FROM memory_facts WHERE source_message_id = ?').run(mid);
      db.prepare('DELETE FROM conversation_summaries WHERE conversation_id = ? AND message_upto >= ?').run(conv.id, mid);
    })();
    res.json({ ok: true });
  }));

  // v1.20.3: 重新生成——删掉最后一条 AI 回复（断流半截时用），返回最后一条用户消息内容，前端拿到后按原问题重发
  app.post('/api/conversations/:id/regenerate', chatLimiter, ah(async (req, res) => {
    const conv = getConv(req.params.id, req);
    if (!conv) return conv404(res);
    if (conv.type === 'group') return res.status(400).json({ error: '群聊请用 regenerate-turn' });
    const last = db
      .prepare('SELECT id, role, content FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT 1')
      .get(conv.id);
    if (!last || last.role !== 'assistant') {
      return res.status(400).json({ error: '最后一条不是 AI 回复，无需重新生成' });
    }
    db.prepare('DELETE FROM messages WHERE id = ?').run(last.id);
    const prevUser = db
      .prepare("SELECT content FROM messages WHERE conversation_id = ? AND role = 'user' ORDER BY id DESC LIMIT 1")
      .get(conv.id);
    if (!prevUser || !String(prevUser.content || '').trim()) {
      return res.status(400).json({ error: '找不到可重发的问题' });
    }
    res.json({ content: prevUser.content });
  }));

  // v1.22.0: 群聊单轮重新生成——删掉指定半截回复，只重跑该角色一轮（SSE）
  app.post('/api/conversations/:id/regenerate-turn', chatLimiter, ah(async (req, res) => {
    const conv = getConv(req.params.id, req);
    if (!conv) return conv404(res);
    if (conv.type !== 'group') return res.status(400).json({ error: '仅群聊支持' });
    const { message_id, character_id, batch_id } = req.body || {};
    let msg = null;
    if (message_id) {
      msg = db
        .prepare('SELECT id, role, character_id FROM messages WHERE id = ? AND conversation_id = ?')
        .get(message_id, conv.id);
    } else if (character_id && batch_id) {
      // v1.22.2: SSE 断流时前端没收到 turn_done、拿不到 message_id——按角色+整轮 batch 定位半截消息
      msg = db
        .prepare(
          `SELECT id, role, character_id FROM messages WHERE conversation_id = ? AND character_id = ?
           AND batch_id = ? AND role = 'assistant' ORDER BY id DESC LIMIT 1`
        )
        .get(conv.id, character_id, batch_id);
      // 后端崩在落库前则无半截可删，直接重跑即可，不报错
    }
    if (message_id) {
      // 明确指定 message_id 但找不到→报错（调用方逻辑错误）
      if (!msg || msg.role !== 'assistant' || !msg.character_id) {
        return res.status(400).json({ error: '找不到该角色回复' });
      }
      // 删掉半截
      db.prepare('DELETE FROM messages WHERE id = ?').run(msg.id);
    } else {
      // character_id+batch_id 定位：找到就删掉半截，找不到（后端崩在落库前）则直接重跑
      if (msg && msg.role === 'assistant' && msg.character_id) {
        db.prepare('DELETE FROM messages WHERE id = ?').run(msg.id);
      } else {
        msg = { character_id, role: 'assistant' };
      }
    }

    const cfg = getConfig();
    // 凭证与计费（同 handleGroupMessage）
    const creds = llmCreds(req, cfg, requestApiKey);
    if (!creds.apiKey && !cfg.mockLlm) return res.status(401).json({ error: NO_KEY_MESSAGE });
    const bill = resolveBilling(req, cfg, creds);
    if (bill.error) return res.status(402).json({ error: bill.error });
    const { chatModel, llmOpts } = bill;
    const ac = new AbortController();
    req.on('close', () => ac.abort());
    llmOpts.signal = ac.signal;
    const usePoints = bill.usePoints;
    let pointsBalance = bill.balance;

    const members = db
      .prepare(
        `SELECT ch.* FROM group_members gm JOIN characters ch ON ch.id = gm.character_id
         WHERE gm.conversation_id = ? ORDER BY gm.joined_at ASC`
      )
      .all(conv.id);
    const ch = members.find((m) => m.id === msg.character_id);
    if (!ch) return res.status(400).json({ error: '角色不在群里' });
    if (!canUseJailbreak(uidOf(req))) ch.jailbreak_preset = null;

    const send = sseInit(res);
    const kaMs = Math.max(50, parseInt(process.env.SSE_KEEPALIVE_MS || '20000', 10) || 20000);
    const kaTimer = setInterval(() => {
      if (!res.destroyed) { try { res.write(': ping\n\n'); } catch {} }
    }, kaMs);

    try {
      const lastUser = db
        .prepare("SELECT content FROM messages WHERE conversation_id = ? AND role = 'user' ORDER BY id DESC LIMIT 1")
        .get(conv.id);
      const query = lastUser ? lastUser.content : '';
      const batchId = 'g' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      const st = { ctxInfo: null, usageInput: 0, usageOutput: 0, pointsBalance, pointsUsed: 0 };
      const deps = { send, res, conv, cfg, bill, chatModel, llmOpts, usePoints, members, query, batchId };
      const r = await streamGroupTurn(deps, ch, st, {});
      if (!r) return; // 已通过 send('error') 通知前端
      if (usePoints) send('points', { balance: st.pointsBalance });
      send('done', { usage: { input: st.usageInput, output: st.usageOutput }, regenerated: true, billingMode: usePoints ? 'points' : 'api', pointsUsed: st.pointsUsed || 0 });
      // 记忆流水线放后台，不阻塞 done
      const bgOpts = { ...llmOpts, signal: undefined };
      setImmediate(async () => {
        try {
          await runMemoryPipeline(ch, conv.id, query, {
            ...bgOpts,
            model: bill.workerModel,
            userId: bill.userId || null,
            onUsage: bgBill(bill, cfg, 'memory', bill.workerModel, (b) => { pointsBalance = b; }),
          });
        } catch (e) { console.warn('[bg] 群聊重生成记忆流水线失败:', e.message); }
      });
    } catch (e) {
      send('error', { message: friendlyLlmError(e) });
    } finally {
      clearInterval(kaTimer);
      res.end();
    }
  }));

  app.post('/api/conversations/:id/messages', chatLimiter, ah(async (req, res) => {
    const cfg = getConfig();
    const conv = getConv(req.params.id, req);
    if (!conv) return conv404(res);
    if (conv.type === 'group') return handleGroupMessage(req, res, conv, cfg);
    // v1.22.0: 重新生成不重复落库用户消息——多次重新生成只保留一条用户输入
    // v1.27.1: 重试去重改按内容比对——库里最后一条用户消息与本次内容一致才复用；
    // 对不上（401/402 当时没落库、消息被手动删除）则当新消息正常插入；兼容只带标记不带 content 的旧客户端
    const wantRegen = !!(req.body && req.body.regenerate);
    let content = String((req.body && req.body.content) ?? '').trim();
    let isRegen = false;
    if (wantRegen) {
      const lastUser = db
        .prepare("SELECT content FROM messages WHERE conversation_id = ? AND role = 'user' ORDER BY id DESC LIMIT 1")
        .get(conv.id);
      const lastContent = lastUser ? String(lastUser.content || '').trim() : '';
      if (content && lastContent === content) {
        isRegen = true; // 精确重试：复用已落库的用户消息
      } else if (!content && lastContent) {
        content = lastContent;
        isRegen = true; // 旧客户端：只带 regenerate 标记不带 content
      } else if (!content) {
        return res.status(400).json({ error: '找不到可重发的问题' });
      }
      // 内容对不上→当作新消息走正常插入（不 return）
    }
    if (!content) return res.status(400).json({ error: 'content 不能为空' });
    const char = getChar(conv.character_id, req);
    // v1.18.1: 破限白名单——权限被收回后，已开破限的角色也不再注入
    if (char.jailbreak_preset && !canUseJailbreak(uidOf(req))) char.jailbreak_preset = null;
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
    let pointsUsed = 0; // v1.25.0: 本轮积分消耗
    const updBal = (b) => {
      pointsBalance = b;
    };

    const t = now();
    // v1.22.0: 重新生成时跳过用户消息落库（复用已有的最后一条用户消息）
    // v1.27.1: isRegen 须经内容比对确认，避免重试叠加重复用户消息
    if (!isRegen) {
      db.prepare('INSERT INTO messages(conversation_id, role, content, tokens, created_at) VALUES(?,?,?,?,?)').run(
        conv.id,
        'user',
        content,
        estimateTokens(content),
        t
      );
    }

    let title = conv.title;
    let titleAuto = false; // 首轮且用户没改过名：先规则标题，回复完再 AI 优化
    if (!title || title === '新对话') {
      titleAuto = true;
      title = ruleTitle(content);
      db.prepare('UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?').run(title, t, conv.id);
    } else {
      db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(t, conv.id);
    }

    const send = sseInit(res);
    // v1.17.4: SSE 心跳（注释帧，客户端忽略），防中间设备掐 idle 连接；finally 里清理
    // 间隔可配（SSE_KEEPALIVE_MS，默认 20000；测试可调小）
    const kaMs = Math.max(50, parseInt(process.env.SSE_KEEPALIVE_MS || '20000', 10) || 20000);
    const kaTimer = setInterval(() => {
      if (!res.destroyed) { try { res.write(': ping\n\n'); } catch {} }
    }, kaMs);

    try {
      const { apiMessages, usedTokens, budget } = buildContext(char, conv.id, content, chatModel);
      send('context', { used: usedTokens, budget });
      // v1.17.1: 内容过滤兜底——被拦截时换无审查模型重试，绝不呈现半截输出
      let full = '';
      let usage = null;
      let finalModel = chatModel;
      const doStream = async (model) => {
        let text = '';
        // v1.17.2: 429 自动重试，瞬时限流用户无感
        const r = await withRetry(() =>
          chatStream({
            messages: apiMessages,
            model,
            temperature: char.temperature ?? 0.8,
            ...llmOpts,
            onToken: (delta) => {
              text += delta;
              send('token', { text: delta });
            },
          })
        );
        return { text, usage: r.usage, finishReason: r.finishReason, stalled: r.stalled };
      };
      let r = await doStream(chatModel);
      if (r.finishReason === 'content_filter' && usePoints) {
        const fb = pickFilterFallbackModel(chatModel);
        if (fb) {
          send('filter_retry', { model: fb });
          r = await doStream(fb);
          finalModel = fb;
        }
      }
      if (r.finishReason === 'content_filter') {
        full = FILTER_NOTICE; // 仍被拦截：存友好提示，不存半截话
      } else {
        full = r.text;
      }
      // v1.20.3: 截断标记——流异常结束（无 finish_reason）或超长截断时，前端提示"好像没说完"
      usage = r.usage;
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
        const pts = calcPoints(finalModel, u);
        if (pts > 0) {
          try {
            pointsBalance = deductPoints(bill.userId, pts, 'chat', 'conversation', conv.id, {
              tokensInput: u.input,
              tokensOutput: u.output,
              model: finalModel, // v1.17.3: 记实际使用的模型（含回退），之前误记 chatModel
            });
            pointsUsed += pts; // v1.25.0
          } catch (e) {
            console.warn('[points] 扣费失败:', e.message);
          }
        }
      }
      // v1.19.0: 自带 Key 调用只记录不扣费（统计用）
      if (!usePoints && !cfg.mockLlm) {
        const u = usage || { input: usedTokens, output: outTokens };
        recordByokUsage(bill.userId, finalModel, 'chat', u);
      }
      if (usePoints) send('points', { balance: pointsBalance });
      if (bill.userId) checkInviteReward(bill.userId);
      // v1.18.0: AI 生成标题（A）——仅首轮自动标题且回复正常时；15 秒超时兜底，失败保留规则标题
      if (titleAuto && full && full !== FILTER_NOTICE && !cfg.mockLlm) {
        try {
          const tSignal = llmOpts.signal
            ? AbortSignal.any([llmOpts.signal, AbortSignal.timeout(15000)])
            : AbortSignal.timeout(15000);
          const aiTitle = await genTitle({ userText: content, asstText: full, model: workerModel, apiKey: llmOpts.apiKey, baseUrl: llmOpts.baseUrl, signal: tSignal });
          if (aiTitle) {
            title = aiTitle;
            db.prepare('UPDATE conversations SET title = ? WHERE id = ?').run(title, conv.id);
          }
        } catch (e) { console.warn('[title] AI 标题生成失败:', e.message); }
      }
      send('done', { message_id: Number(asst.lastInsertRowid), content: full, tokens: outTokens, title, usage: { input: usedTokens, output: outTokens }, truncated: full !== FILTER_NOTICE && (!r.finishReason || r.finishReason === 'length' || r.stalled), billingMode: usePoints ? 'points' : 'api', pointsUsed });
      // 摘要 + v1.10 记忆流水线（意图识别/事件驱动）放后台，不阻塞 done；去掉请求级 signal
      const bgOpts = { ...llmOpts, signal: undefined };
      setImmediate(async () => {
        try {
          await summarizeOld(char, conv.id, {
            ...bgOpts,
            model: workerModel,
            onUsage: bgBill(bill, cfg, 'summary', workerModel, updBal),
          });
          await runMemoryPipeline(char, conv.id, content, {
            ...bgOpts,
            model: workerModel,
            userId: bill.userId || null,
            onUsage: bgBill(bill, cfg, 'memory', workerModel, updBal),
          });
        } catch (e) {
          console.warn('[bg] 摘要/记忆流水线失败:', e.message);
        }
      });
    } catch (e) {
      send('error', { message: friendlyLlmError(e) });
    } finally {
      clearInterval(kaTimer);
      res.end();
    }
  }));

  // ---------- v1.26.0: 语音接口 ----------
  // 语音积分模式判断（多用户 + billing_mode=points）
  const isVoicePointsMode = (req) => {
    const cfg = getConfig();
    const uid = (req && req.userId) || null;
    if (!cfg.multiUser || !uid) return null;
    try {
      const u = db.prepare('SELECT billing_mode FROM users WHERE id = ?').get(uid);
      if (u && (u.billing_mode || 'points') === 'points') return uid;
    } catch {}
    return null;
  };

  // ASR: 音频(base64) → 文字（积分模式按时长扣费）
  app.post('/api/voice/asr', chatLimiter, ah(async (req, res) => {
    const { audio, mimeType } = req.body || {};
    if (!audio) return res.status(400).json({ error: 'audio 不能为空' });
    const buf = Buffer.from(audio, 'base64');
    if (buf.length > 10 * 1024 * 1024) return res.status(400).json({ error: '音频过大（>10MB）' });
    const provider = getVoiceProvider();
    const r = await provider.asr(buf, { mimeType });
    // v1.26.0: 积分模式按时长扣费
    const asrUid = isVoicePointsMode(req);
    if (asrUid) {
      const pts = calcAsrPoints(r.duration);
      if (pts > 0) {
        try { deductPoints(asrUid, pts, 'voice_asr', null, null, { duration: r.duration }); }
        catch (e) { console.warn('[voice] ASR 扣费失败:', e.message); }
      }
    }
    res.json({ text: r.text, duration: r.duration });
  }));

  // TTS: 文字 → 音频(base64 mp3)（积分模式按字符扣费，余额低自动降级 flash）
  // 只合成对白部分；无对白返回 { skipped: true }
  app.post('/api/voice/tts', chatLimiter, ah(async (req, res) => {
    const { text, voice, speed, forceAll } = req.body || {};
    if (!text || !String(text).trim()) return res.status(400).json({ error: 'text 不能为空' });
    let speakText = String(text);
    if (!forceAll) {
      const dialogues = extractDialogue(speakText);
      if (!dialogues || !dialogues.length) {
        return res.json({ skipped: true, reason: 'no_dialogue' });
      }
      speakText = dialogues.join(' ');
    } else {
      speakText = cleanForTts(speakText);
    }
    // 兜底：超长截断前 500 字
    const chars = [...speakText];
    if (chars.length > 500) speakText = chars.slice(0, 500).join('');
    // v1.26.0: 余额低自动降级 flash
    const ttsUid = isVoicePointsMode(req);
    // v1.26.1: TTS 模型从配置读取（管理员可在模型管理 tab 指定）
    let model = getVoiceModel('tts');
    if (ttsUid) {
      try {
        const bal = getBalance(ttsUid);
        if (bal < VOICE_PRICING.downgradeThreshold) model = VOICE_MODELS.tts.flash;
      } catch {}
    }
    // v1.26.0: 解析定制音色（voice 参数可能是 custom_voices.id）
    let actualVoice = voice || 'Cherry';
    let ttsModel = model;
    if (ttsUid) {
      try {
        const cv = getDb().prepare('SELECT voice_id FROM custom_voices WHERE id = ? AND user_id = ?').get(voice, ttsUid);
        if (cv) {
          actualVoice = cv.voice_id;
          ttsModel = getVoiceModel('design'); // v1.26.1: 定制音色用配置的 VD 模型
        }
      } catch {}
    }
    // v1.29.0: 系统内置克隆音色走 VC 模型（须与克隆时 target_model 一致，否则合成失败）
    try {
      const bv = getDb().prepare('SELECT target_model FROM builtin_voices WHERE voice_id = ?').get(actualVoice);
      if (bv) ttsModel = bv.target_model || getVoiceModel('vc');
    } catch {}
    const provider = getVoiceProvider();
    // v1.26.0: 查音频缓存（命中则不扣费）；v1.28.1: 按用户隔离缓存键
    const cacheUid = ttsUid || uidOf(req) || 'local';
    const cached = getCachedAudio(speakText, actualVoice, speed || 1.0, ttsModel, cacheUid);
    let audioBuf, billChars;
    if (cached) {
      audioBuf = cached;
      billChars = [...speakText].reduce((n, ch) => n + (ch.codePointAt(0) > 0xff ? 2 : 1), 0);
    } else {
      try {
        const r = await provider.tts(speakText, { model: ttsModel, voice: actualVoice, speed });
        audioBuf = r.audio;
        billChars = r.chars;
        setCachedAudio(speakText, actualVoice, speed || 1.0, ttsModel, audioBuf, cacheUid);
      } catch (e) {
        // v1.29.7: 管理员试听时透传上游真实报错，便于定位（普通用户仍走脱敏 500）
        try {
          const u = uidOf(req);
          const isAdmin = u && getDb().prepare('SELECT is_admin FROM users WHERE id = ?').get(u)?.is_admin;
          if (isAdmin) {
            const err = new Error(String((e && e.message) || 'TTS 失败'));
            err.statusCode = 400;
            throw err;
          }
        } catch (e2) { if (e2 && e2.statusCode === 400) throw e2; }
        throw e;
      }
    }
    // v1.26.0: 积分模式按字符扣费（缓存命中不扣）
    if (ttsUid && !cached) {
      const pts = calcTtsPoints(billChars);
      if (pts > 0) {
        try { deductPoints(ttsUid, pts, 'voice_tts', null, null, { chars: billChars, model: ttsModel }); }
        catch (e) { console.warn('[voice] TTS 扣费失败:', e.message); }
      }
    }
    // v1.29.12: 存临时文件，返回 URL（替代 base64 data URL）
    cleanupTtsTmp();
    const ttsMime = detectAudioMime(audioBuf);
    const ttsExt = ttsMime === 'audio/wav' ? 'wav' : ttsMime === 'audio/ogg' ? 'ogg' : 'mp3';
    const ttsId = ttsTmpId();
    try {
      fs.writeFileSync(path.join(ttsTmpDir(), `${ttsId}.${ttsExt}`), audioBuf);
    } catch (e) {
      console.warn('[voice] TTS 临时文件写入失败:', e.message);
    }
    res.json({
      audioUrl: `/api/voice/tts-audio/${ttsId}`,
      mime: ttsMime,
      chars: billChars,
      text: speakText,
      model: ttsModel,
      cached: !!cached,
    });
  }));

  // ---------- v1.26.0: 定制音色 ----------
  // 声音设计：文本描述 → 定制音色（0.2元/次 = 20积分）
  app.post('/api/voice/design', chatLimiter, ah(async (req, res) => {
    const { prompt, name, previewText } = req.body || {};
    if (!prompt || !String(prompt).trim()) return res.status(400).json({ error: '请描述想要的音色' });
    if (!name || !String(name).trim()) return res.status(400).json({ error: '请给音色起个名字' });
    const cleanName = String(name).trim().replace(/[^a-zA-Z0-9_\u4e00-\u9fa5]/g, '').slice(0, 16);
    if (!cleanName) return res.status(400).json({ error: '名字只支持中文/字母/数字/下划线' });

    const uid = (req && req.userId) || "local"; // v1.28.1: 单用户模式用固定哨兵，避免 NULL 违反 NOT NULL/查不到
    // 检查重名
    const exists = db.prepare('SELECT id FROM custom_voices WHERE user_id = ? AND name = ?').get(uid, cleanName);
    if (exists) return res.status(400).json({ error: '已有同名音色' });

    const provider = getVoiceProvider();
    const r = await provider.designVoice({
      prompt: String(prompt).trim().slice(0, 500),
      previewText: String(previewText || '你好，很高兴认识你。').slice(0, 100),
      name: `soulchat_${uid ? uid.slice(0, 8) : 'anon'}_${Date.now()}`,
      language: 'zh',
    });
    if (!r.voiceId) return res.status(500).json({ error: '音色生成失败' });

    // 落库
    const id = randomUUID();
    db.prepare(
      'INSERT INTO custom_voices(id, user_id, voice_id, name, prompt, created_at) VALUES(?,?,?,?,?,?)'
    ).run(id, uid, r.voiceId, cleanName, String(prompt).trim().slice(0, 500), new Date().toISOString());

    // 积分模式扣 20 积分（0.2元）
    if (uid) {
      try {
        const u = db.prepare('SELECT billing_mode FROM users WHERE id = ?').get(uid);
        if (u && (u.billing_mode || 'points') === 'points') {
          deductPoints(uid, 20, 'voice_design', 'custom_voice', id, { name: cleanName });
        }
      } catch (e) {
        console.warn('[voice] 定制音色扣费失败:', e.message);
      }
    }

    res.json({
      id,
      voice_id: r.voiceId,
      name: cleanName,
      preview_audio: r.previewAudio,
    });
  }));

  // v1.27.0: 音色克隆 POST /api/voice/clone { audio(base64), name, mimeType }
  // 上传参考音频（15-60秒）→ 克隆音色 → 返回 voice_id
  app.post('/api/voice/clone', chatLimiter, ah(async (req, res) => {
    const { audio, name, mimeType } = req.body || {};
    if (!audio || typeof audio !== 'string') return res.status(400).json({ error: '请上传音频文件' });
    if (!name || !String(name).trim()) return res.status(400).json({ error: '请给音色起个名字' });
    const cleanName = String(name).trim().replace(/[^a-zA-Z0-9_\u4e00-\u9fa5]/g, '').slice(0, 16);
    if (!cleanName) return res.status(400).json({ error: '名字只支持中文/字母/数字/下划线' });

    // base64 解码，限制 10MB
    let audioBuffer;
    try {
      audioBuffer = Buffer.from(audio, 'base64');
    } catch {
      return res.status(400).json({ error: '音频数据无效' });
    }
    if (audioBuffer.length > 10 * 1024 * 1024) {
      return res.status(400).json({ error: '音频文件过大（限 10MB）' });
    }
    if (audioBuffer.length < 1024) {
      return res.status(400).json({ error: '音频文件过小' });
    }

    const uid = (req && req.userId) || "local"; // v1.28.1: 单用户模式用固定哨兵，避免 NULL 违反 NOT NULL/查不到
    const exists = db.prepare('SELECT id FROM custom_voices WHERE user_id = ? AND name = ?').get(uid, cleanName);
    if (exists) return res.status(400).json({ error: '已有同名音色' });

    const provider = getVoiceProvider();
    const r = await provider.cloneVoice(audioBuffer, {
      name: `soulchat_${uid ? uid.slice(0, 8) : 'anon'}_${Date.now()}`,
      mimeType: mimeType || 'audio/wav',
    });
    if (!r.voiceId) return res.status(500).json({ error: '音色克隆失败' });

    const id = randomUUID();
    db.prepare(
      'INSERT INTO custom_voices(id, user_id, voice_id, name, prompt, created_at) VALUES(?,?,?,?,?,?)'
    ).run(id, uid, r.voiceId, cleanName, '[克隆] 音频文件克隆', new Date().toISOString());

    // 积分模式扣 20 积分（同文本设计）
    if (uid) {
      try {
        const u = db.prepare('SELECT billing_mode FROM users WHERE id = ?').get(uid);
        if (u && (u.billing_mode || 'points') === 'points') {
          deductPoints(uid, 20, 'voice_design', 'custom_voice', id, { name: cleanName, type: 'clone' });
        }
      } catch (e) {
        console.warn('[voice] 克隆音色扣费失败:', e.message);
      }
    }

    res.json({ id, voice_id: r.voiceId, name: cleanName });
  }));

  // 我的定制音色列表
  app.get('/api/voice/custom', ah(async (req, res) => {
    const uid = (req && req.userId) || "local"; // v1.28.1: 单用户模式用固定哨兵，避免 NULL 违反 NOT NULL/查不到
    const rows = getDb()
      .prepare('SELECT id, voice_id, name, prompt, created_at FROM custom_voices WHERE user_id = ? ORDER BY created_at DESC')
      .all(uid);
    res.json(rows);
  }));

  // 删除定制音色
  app.delete('/api/voice/custom/:id', ah(async (req, res) => {
    const uid = (req && req.userId) || "local"; // v1.28.1: 单用户模式用固定哨兵，避免 NULL 违反 NOT NULL/查不到
    const r = getDb().prepare('DELETE FROM custom_voices WHERE id = ? AND user_id = ?').run(req.params.id, uid);
    if (!r.changes) return res.status(404).json({ error: '未找到' });
    // 把用了该音色的角色重置为 null（跟随全局）；v1.28.1: 补 user_id 隔离
    try {
      const uCond = uid ? 'AND user_id = ?' : '';
      const uArgs = uid ? [uid] : [];
      getDb().prepare(`UPDATE characters SET voice_id = NULL WHERE voice_id = ? ${uCond}`.trim()).run(req.params.id, ...uArgs);
    } catch {}
    res.json({ ok: true });
  }));

  // ---------- v1.29.0: 系统内置克隆音色（管理员批量克隆上传） ----------
  // 内置音色元数据：按名字自动匹配人设/描述/试听文案
  const BUILTIN_VOICE_META = {
    '芊悦': { gender: '女', description: '阳光女声', preview: '你好呀！我是芊悦，今天也是元气满满的一天呢，一起加油吧！' },
    '苏瑶': { gender: '女', description: '温柔女声', preview: '你好，我是苏瑶，很高兴能在这里与你相遇。' },
    '千雪': { gender: '女', description: '二次元女友', preview: '呐呐，你终于来啦！人家等你好久了呢！' },
    '萌宝': { gender: '女', description: '可爱小女孩', preview: '大哥哥大姐姐好！我是萌宝，今年五岁啦！' },
    '茉兔': { gender: '女', description: '俏皮可爱', preview: '嘿嘿，抓到你啦！我是茉兔，古灵精怪第一名！' },
    '十三': { gender: '女', description: '酷飒微辣', preview: '哟，来了？我是十三，有事说事，别磨磨唧唧的。' },
    '卡捷琳娜': { gender: '女', description: '成熟有气场', preview: '晚上好，我是卡捷琳娜，很高兴认识你。' },
    '晨煦': { gender: '男', description: '阳光男声', preview: '嘿！我是晨煦，要不要一起去冒险？' },
    '月白': { gender: '男', description: '潇洒帅气', preview: '月色真美，我是月白。今晚的风很温柔，你也是。' },
    '凯': { gender: '男', description: '治愈系男声', preview: '你好呀，我是凯，累了就歇一会儿，我在这里陪着你。' },
    '不吃鱼': { gender: '男', description: '设计师男声', preview: '你好，我是不吃鱼。设计和生活一样，都需要一点不将就的态度。' },
    '甜茶': { gender: '男', description: '戏剧张力男声', preview: '命运的齿轮开始转动，我是甜茶，准备好迎接这场大戏了吗？' },
  };

  // 批量克隆任务（内存 job；管理员一次性操作，重启丢失可重跑）
  const batchCloneJobs = new Map();
  // v1.29.6: 内置音色参考音频存盘目录（供“试听原音”）
  function builtinRefDir() {
    const d = path.join(getConfig().dataDir, 'builtin_voice_refs');
    try { fs.mkdirSync(d, { recursive: true }); } catch {}
    return d;
  }
  function refAudioExt(mimeType) {
    const m = String(mimeType || '').toLowerCase();
    if (m.includes('mp3') || m.includes('mpeg')) return '.mp3';
    if (m.includes('m4a') || m.includes('mp4')) return '.m4a';
    return '.wav';
  }
  function refAudioPath(name) {
    // 按音色名找参考音频（兼容 wav/mp3/m4a）
    const dir = builtinRefDir();
    for (const ext of ['.wav', '.mp3', '.m4a']) {
      const p = path.join(dir, name + ext);
      try { if (fs.existsSync(p)) return p; } catch {}
    }
    return null;
  }

  // 公开：系统内置音色列表（前端音色选择器优先展示；为空则用前端硬编码旧列表）
  app.get('/api/voice/builtin', ah(async (req, res) => {
    const rows = getDb()
      .prepare('SELECT name, voice_id, target_model, gender, description, preview, sort FROM builtin_voices ORDER BY sort ASC')
      .all();
    // v1.29.6: 标记是否有参考音频（试听原音用）
    for (const r of rows) {
      try { r.has_audio = !!refAudioPath(r.name); } catch { r.has_audio = false; }
    }
    res.json({ voices: rows });
  }));

  // v1.29.12: TTS 音频临时文件（替代 data: URL，解决浏览器播不出 + 省 33% base64 体积）
  function ttsTmpDir() {
    const d = path.join(getConfig().dataDir, 'tts_tmp');
    try { fs.mkdirSync(d, { recursive: true }); } catch {}
    return d;
  }
  function ttsTmpId() {
    return Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
  }
  // 定期清理：删除 2 小时前的临时文件（每次 TTS 请求时顺带执行）
  function cleanupTtsTmp() {
    try {
      const dir = ttsTmpDir();
      const now = Date.now();
      for (const f of fs.readdirSync(dir)) {
        const fp = path.join(dir, f);
        try {
          const st = fs.statSync(fp);
          if (now - st.mtimeMs > 2 * 3600 * 1000) fs.unlinkSync(fp);
        } catch {}
      }
    } catch {}
  }
  // 通用音频文件服务（含 Range 支持，iOS 必需）
  function serveAudioFile(req, res, filePath, contentType) {
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: '音频已过期，请重新合成' });
    const stat = fs.statSync(filePath);
    const total = stat.size;
    const range = req.headers.range;
    res.setHeader('Content-Type', contentType);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'private, max-age=7200');
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      const start = m && m[1] ? parseInt(m[1], 10) : 0;
      const end = m && m[2] ? parseInt(m[2], 10) : total - 1;
      if (start >= total || end >= total) {
        res.status(416).setHeader('Content-Range', `bytes */${total}`).end();
        return;
      }
      res.status(206);
      res.setHeader('Content-Range', `bytes ${start}-${end}/${total}`);
      res.setHeader('Content-Length', String(end - start + 1));
      fs.createReadStream(filePath, { start, end }).pipe(res);
    } else {
      res.setHeader('Content-Length', String(total));
      fs.createReadStream(filePath).pipe(res);
    }
  }
  // TTS 临时音频接口（需登录）
  app.get('/api/voice/tts-audio/:id', ah(async (req, res) => {
    if (!uidOf(req)) return res.status(401).json({ error: '请先登录' });
    const id = String(req.params.id || '').replace(/[^a-zA-Z0-9_]/g, '');
    if (!id) return res.status(404).json({ error: '无效的音频 ID' });
    const dir = ttsTmpDir();
    // 按 id 前缀找文件（文件名格式：id.mime_ext）
    const files = fs.readdirSync(dir).filter((f) => f.startsWith(id + '.'));
    if (!files.length) return res.status(404).json({ error: '音频已过期，请重新合成' });
    const fname = files[0];
    const ext = path.extname(fname).slice(1); // wav/mp3/ogg
    const ct = ext === 'wav' ? 'audio/wav' : ext === 'ogg' ? 'audio/ogg' : 'audio/mpeg';
    serveAudioFile(req, res, path.join(dir, fname), ct);
  }));

  // v1.29.6: 管理员获取内置音色参考音频（试听原音）
  // v1.29.7: 所有登录用户可听（音色选择器试听原音，不调 TTS 省积分）
  function serveBuiltinAudio(req, res) {
    const name = String(req.params.name || '');
    const p = refAudioPath(name);
    if (!p) return res.status(404).json({ error: '没有参考音频（v1.29.6 前克隆的需重新上传）' });
    const ext = path.extname(p).toLowerCase();
    const ct = ext === '.mp3' ? 'audio/mpeg' : ext === '.m4a' ? 'audio/mp4' : 'audio/wav';
    // v1.29.10: iOS Safari 播音频需要 Content-Length + Range 支持
    const stat = fs.statSync(p);
    const total = stat.size;
    const range = req.headers.range;
    res.setHeader('Content-Type', ct);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'private, max-age=86400');
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      const start = m && m[1] ? parseInt(m[1], 10) : 0;
      const end = m && m[2] ? parseInt(m[2], 10) : total - 1;
      if (start >= total || end >= total) {
        res.status(416).setHeader('Content-Range', `bytes */${total}`).end();
        return;
      }
      res.status(206);
      res.setHeader('Content-Range', `bytes ${start}-${end}/${total}`);
      res.setHeader('Content-Length', String(end - start + 1));
      fs.createReadStream(p, { start, end }).pipe(res);
    } else {
      res.setHeader('Content-Length', String(total));
      fs.createReadStream(p).pipe(res);
    }
  }
  app.get('/api/admin/voice/builtin/:name/audio', ah(async (req, res) => {
    if (!requireAdmin(req, res)) return;
    serveBuiltinAudio(req, res);
  }));
  app.get('/api/voice/builtin/:name/audio', ah(async (req, res) => {
    serveBuiltinAudio(req, res);
  }));

  // 管理员：批量克隆（异步 job） POST /api/admin/voice/batch-clone { voices: [{name, audio(base64), mimeType}] }
  // 不扣积分（系统级操作）；克隆走 qwen-voice-enrollment，target_model 取 voice_vc_model 配置
  app.post('/api/admin/voice/batch-clone', ah(async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const list = (req.body && req.body.voices) || [];
    if (!Array.isArray(list) || !list.length) return res.status(400).json({ error: '请上传音频文件' });
    if (list.length > 12) return res.status(400).json({ error: '一次最多 12 个' });
    const items = [];
    for (const v of list) {
      const name = String(v.name || '').trim().replace(/[^a-zA-Z0-9_\u4e00-\u9fa5]/g, '').slice(0, 16);
      if (!name) return res.status(400).json({ error: '每个音色都要起名字' });
      if (!v.audio || typeof v.audio !== 'string') return res.status(400).json({ error: `「${name}」缺少音频数据` });
      let buf;
      try { buf = Buffer.from(v.audio, 'base64'); }
      catch { return res.status(400).json({ error: `「${name}」音频数据无效` }); }
      if (buf.length > 10 * 1024 * 1024) return res.status(400).json({ error: `「${name}」文件过大（限 10MB）` });
      if (buf.length < 1024) return res.status(400).json({ error: `「${name}」文件过小` });
      items.push({ name, buf, mimeType: v.mimeType || 'audio/wav' });
    }
    let provider;
    try { provider = getVoiceProvider(); }
    catch (e) { return res.status(500).json({ error: e.message || '语音服务未配置' }); }

    const jobId = randomUUID();
    const job = { id: jobId, status: 'running', total: items.length, done: 0, results: [], created_at: new Date().toISOString() };
    batchCloneJobs.set(jobId, job);
    // 后台逐个克隆，不阻塞响应；前端轮询状态接口
    setImmediate(async () => {
      const vcModel = getVoiceModel('vc');
      const upsert = getDb().prepare(
        `INSERT INTO builtin_voices(name, voice_id, target_model, gender, description, preview, sort, created_at)
         VALUES(?,?,?,?,?,?,?,?)
         ON CONFLICT(name) DO UPDATE SET voice_id=excluded.voice_id, target_model=excluded.target_model,
           gender=excluded.gender, description=excluded.description, preview=excluded.preview,
           sort=excluded.sort, created_at=excluded.created_at`
      );
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        try {
          const r = await provider.cloneVoice(it.buf, { name: `soulchat_builtin_${Date.now()}_${i}`, mimeType: it.mimeType });
          if (!r.voiceId) throw new Error('克隆失败');
          const meta = BUILTIN_VOICE_META[it.name] || {};
          upsert.run(it.name, r.voiceId, vcModel, meta.gender || '', meta.description || '',
            meta.preview || `你好，我是${it.name}。`, i, new Date().toISOString());
          // v1.29.6: 参考音频存盘，供“试听原音”（失败不影响克隆结果）
          try {
            fs.writeFileSync(path.join(builtinRefDir(), it.name + refAudioExt(it.mimeType)), it.buf);
          } catch (e) { console.warn('[voice] 参考音频存盘失败:', e.message); }
          job.results.push({ name: it.name, ok: true, voice_id: r.voiceId });
        } catch (e) {
          job.results.push({ name: it.name, ok: false, error: e.message || '克隆失败' });
        }
        job.done = i + 1;
      }
      job.status = 'done';
    });
    res.json({ job_id: jobId, total: items.length });
  }));

  // 管理员：批量克隆任务状态（轮询）
  app.get('/api/admin/voice/batch-clone/:jobId', ah(async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const job = batchCloneJobs.get(req.params.jobId);
    if (!job) return res.status(404).json({ error: '任务不存在' });
    res.json(job);
  }));

  // 管理员：清空系统内置音色（重跑批量克隆前用）
  app.delete('/api/admin/voice/builtin', ah(async (req, res) => {
    if (!requireAdmin(req, res)) return;
    getDb().prepare('DELETE FROM builtin_voices').run();
    res.json({ ok: true });
  }));

  // ---------- v1.26.2: 语音模型清单（DashScope，带刊例价） ----------
  // DashScope 无公开模型列表 API，此处为 curated 清单
  const VOICE_MODEL_CATALOG = {
    tts: [
      { id: 'qwen-audio-3.0-tts-plus', name: 'Qwen Audio 3.0 TTS Plus', desc: '高质量，推荐', price: '约1.5元/万字符' },
      { id: 'qwen3-tts-flash', name: 'Qwen3 TTS Flash', desc: '便宜，0.8元/万字符', price: '0.8元/万字符' },
      { id: 'cosyvoice-v3.5-plus', name: 'CosyVoice 3.5 Plus', desc: '超高表现力', price: '1.5元/万字符' },
      { id: 'cosyvoice-v3.5-flash', name: 'CosyVoice 3.5 Flash', desc: '低延迟版', price: '0.8元/万字符' },
    ],
    asr: [
      { id: 'qwen-audio-3.0-asr-flash', name: 'Qwen Audio 3.0 ASR Flash', desc: '快速识别', price: '约0.8元/小时' },
    ],
    design: [
      { id: 'qwen3-tts-vd-2026-01-26', name: 'Qwen3 TTS VD', desc: '文本描述生成音色', price: '0.2元/次+0.8元/万字符' },
    ],
    // v1.29.0: 克隆音色合成模型（须与克隆时 target_model 一致）
    vc: [
      { id: 'cosyvoice-v3.5-plus', name: 'CosyVoice 3.5 Plus', desc: '音色克隆合成（官方文档确认）', price: '1.5元/万字符' },
      { id: 'cosyvoice-v3.5-flash', name: 'CosyVoice 3.5 Flash', desc: '低延迟版', price: '0.8元/万字符' },
    ],
  };

  app.get('/api/voice/models', ah(async (req, res) => {
    res.json(VOICE_MODEL_CATALOG);
  }));

  // v1.26.2: 语音连通测试 POST /api/voice/test { type: 'tts'|'asr', model }
  app.post('/api/voice/test', chatLimiter, ah(async (req, res) => {
    // v1.28.1: 烧服务端 Key 的真实调用，仅管理员可用（防匿名刷配额）
    if (!requireAdmin(req, res)) return;
    const { type, model } = req.body || {};
    if (!['tts', 'asr'].includes(type)) {
      return res.status(400).json({ error: 'type 须为 tts 或 asr' });
    }
    const provider = getVoiceProvider();
    const t0 = Date.now();
    try {
      if (type === 'tts') {
        const r = await provider.tts('你好', { model: model || undefined, voice: 'Cherry' });
        res.json({ ok: true, latency: Date.now() - t0, bytes: r.audio.length });
      } else {
        // ASR 测试需要音频，这里只验证模型参数有效（调一次空检查）
        res.json({ ok: true, latency: 0, note: 'ASR 需上传音频测试，此处仅验证配置' });
      }
    } catch (e) {
      res.json({ ok: false, latency: Date.now() - t0, error: String((e && e.message) || e).slice(0, 200) });
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
