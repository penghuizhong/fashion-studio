import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { randomInt, randomUUID } from 'node:crypto';
import { getConfig } from './config.js';
import { encryptSecret } from './secrets.js';
import { detectProvider } from './providers.js';

// 安全随机码：crypto 强随机（邀请码 8 位公开分享，重置码 12 位绝不公开）
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export function genSecureCode(len) {
  let s = '';
  for (let i = 0; i < len; i++) s += CODE_CHARS[randomInt(CODE_CHARS.length)];
  return s;
}
export const genInviteCode = () => genSecureCode(8);
export const genRecoveryCode = () => genSecureCode(12);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS characters(
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  avatar TEXT DEFAULT '🤖',
  soul_md TEXT DEFAULT '',
  user_md TEXT DEFAULT '',
  memory_md TEXT DEFAULT '',
  model TEXT DEFAULT '',
  temperature REAL DEFAULT 0.8,
  created_at TEXT,
  updated_at TEXT
);
-- v0.1.0: 语音功能已移除，升级时删表（历史包袱清理）
DROP TABLE IF EXISTS custom_voices;
DROP TABLE IF EXISTS builtin_voices;
CREATE TABLE IF NOT EXISTS conversations(
  id TEXT PRIMARY KEY,
  character_id TEXT NOT NULL,
  title TEXT DEFAULT '',
  created_at TEXT,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS messages(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  tokens INTEGER DEFAULT 0,
  created_at TEXT
);
CREATE TABLE IF NOT EXISTS file_versions(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  character_id TEXT NOT NULL,
  file TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT
);
CREATE TABLE IF NOT EXISTS conversation_summaries(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL,
  summary TEXT NOT NULL,
  message_upto INTEGER NOT NULL,
  created_at TEXT
);
CREATE TABLE IF NOT EXISTS group_members(
  conversation_id TEXT NOT NULL,
  character_id TEXT NOT NULL,
  joined_at TEXT,
  PRIMARY KEY (conversation_id, character_id)
);
-- v1.21.0: 群聊每角色已读水位（增量历史注入）
CREATE TABLE IF NOT EXISTS group_read_marks(
  conversation_id TEXT NOT NULL,
  character_id TEXT NOT NULL,
  upto_message_id INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (conversation_id, character_id)
);
CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, id);
CREATE INDEX IF NOT EXISTS idx_conv_char ON conversations(character_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_group_members_conv ON group_members(conversation_id);
-- ---- 多用户模式新增表 ----
CREATE TABLE IF NOT EXISTS users(
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT
);
CREATE TABLE IF NOT EXISTS sessions(
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS user_api_keys(
  user_id TEXT PRIMARY KEY,
  enc_key TEXT,
  enc_base_url TEXT,
  enc_chat_model TEXT,
  enc_worker_model TEXT,
  updated_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
-- ---- 积分系统 ----
CREATE TABLE IF NOT EXISTS points_ledger(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  delta INTEGER NOT NULL,
  balance_after INTEGER NOT NULL,
  reason TEXT NOT NULL,
  ref_type TEXT,
  ref_id TEXT,
  created_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_ledger_user ON points_ledger(user_id, id);
-- ---- v1.19.0: 自带 Key（BYOK）调用统计（不扣费，只记录用量） ----
CREATE TABLE IF NOT EXISTS api_usage(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT,
  model TEXT NOT NULL,
  reason TEXT NOT NULL,
  tokens_input INTEGER DEFAULT 0,
  tokens_output INTEGER DEFAULT 0,
  created_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_api_usage_day ON api_usage(created_at);
CREATE INDEX IF NOT EXISTS idx_api_usage_user ON api_usage(user_id);
-- v0.2.0: points_models 已并入统一注册表 models(kind='chat')，老库由 migrateToUnifiedRegistry() 迁移后 DROP --
-- ---- 邀请系统 ----
-- users.invite_code / users.invited_by 在迁移块中按需添加（老库兼容）
-- ---- 角色广场 UGC ----
CREATE TABLE IF NOT EXISTS shared_cards(
  id TEXT PRIMARY KEY,
  author_id TEXT NOT NULL,
  card_json TEXT NOT NULL,
  status TEXT DEFAULT 'pending',
  reject_reason TEXT DEFAULT '',
  adopt_count INTEGER DEFAULT 0,
  like_count INTEGER DEFAULT 0,
  report_count INTEGER DEFAULT 0,
  created_at TEXT,
  reviewed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_shared_status ON shared_cards(status, created_at);
CREATE TABLE IF NOT EXISTS card_likes(
  user_id TEXT NOT NULL,
  shared_card_id TEXT NOT NULL,
  created_at TEXT,
  PRIMARY KEY(user_id, shared_card_id)
);
-- v1.28.1: 举报去重（同一用户对同一卡片只能举报一次，防单人连点下架）
CREATE TABLE IF NOT EXISTS card_reports(
  user_id TEXT NOT NULL,
  shared_card_id TEXT NOT NULL,
  reason TEXT DEFAULT '',
  created_at TEXT,
  PRIMARY KEY(user_id, shared_card_id)
);
-- ---- 集卡图鉴 ----
CREATE TABLE IF NOT EXISTS user_collection(
  user_id TEXT NOT NULL,
  card_key TEXT NOT NULL,
  adopted_at TEXT,
  PRIMARY KEY(user_id, card_key)
);
-- ---- 记忆事实条目（v1.10：替代 memory_md 大文本，按需检索注入） ----
CREATE TABLE IF NOT EXISTS memory_facts(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  character_id TEXT NOT NULL,
  fact TEXT NOT NULL,
  importance INTEGER DEFAULT 3,
  created_at TEXT,
  superseded_by INTEGER DEFAULT NULL,
  source TEXT DEFAULT 'chat'
);
CREATE INDEX IF NOT EXISTS idx_facts_char ON memory_facts(character_id, id);
CREATE VIRTUAL TABLE IF NOT EXISTS memory_facts_fts USING fts5(fact, content='memory_facts', content_rowid='id', tokenize='trigram');
CREATE TRIGGER IF NOT EXISTS trg_facts_ai AFTER INSERT ON memory_facts BEGIN
  INSERT INTO memory_facts_fts(rowid, fact) VALUES (new.id, new.fact);
END;
CREATE TRIGGER IF NOT EXISTS trg_facts_ad AFTER DELETE ON memory_facts BEGIN
  INSERT INTO memory_facts_fts(memory_facts_fts, rowid, fact) VALUES('delete', old.id, old.fact);
END;
CREATE TRIGGER IF NOT EXISTS trg_facts_au AFTER UPDATE ON memory_facts BEGIN
  INSERT INTO memory_facts_fts(memory_facts_fts, rowid, fact) VALUES('delete', old.id, old.fact);
  INSERT INTO memory_facts_fts(rowid, fact) VALUES (new.id, new.fact);
END;
-- ---- 意图识别：待确认的灵魂修改建议 ----
CREATE TABLE IF NOT EXISTS intent_suggestions(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  character_id TEXT NOT NULL,
  conversation_id TEXT,
  user_id TEXT,
  proposed TEXT NOT NULL,
  status TEXT DEFAULT 'pending',
  created_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_sugg_char ON intent_suggestions(character_id, status, id);
-- ---- 记忆写入事件（v1.12：流水线有实际写入时记一条，前端轮询做"记住了"轻提示） ----
CREATE TABLE IF NOT EXISTS memory_events(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL,
  character_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  facts_added INTEGER DEFAULT 0,
  user_md_changed INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_memev_conv ON memory_events(conversation_id, id);
-- ---- 系统设置（v1.12：管理员可配置项，如后台模型） ----
CREATE TABLE IF NOT EXISTS sys_settings(
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT '',
  updated_at TEXT
);

-- v1.13: 用户收藏的 AI 生成角色卡（生成时自动保存）
CREATE TABLE IF NOT EXISTS saved_cards(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  card_json TEXT NOT NULL,
  prompt TEXT NOT NULL DEFAULT '',
  adopted INTEGER NOT NULL DEFAULT 0,
  character_id INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_saved_cards_user ON saved_cards(user_id, created_at DESC);
-- ---- 设计台：款式 DNA 模板（v0.1.0） ----
CREATE TABLE IF NOT EXISTS style_dna_templates(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  source_image_path TEXT DEFAULT '',
  category TEXT DEFAULT '',
  dna_json TEXT NOT NULL DEFAULT '{}',
  gen_params_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'draft',
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_dna_templates_user ON style_dna_templates(user_id, updated_at DESC);
CREATE TABLE IF NOT EXISTS dna_generations(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  template_id INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  image_path TEXT NOT NULL,
  thumb_path TEXT DEFAULT '',
  prompt_snapshot TEXT DEFAULT '',
  seed INTEGER,
  model_id TEXT DEFAULT '',
  size TEXT DEFAULT '',
  op TEXT NOT NULL DEFAULT 'create',
  user_rating TEXT DEFAULT '',
  rated_at TEXT DEFAULT '',
  archived INTEGER DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_dna_generations_tpl ON dna_generations(template_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_dna_generations_user ON dna_generations(user_id, created_at DESC);
-- ---- v0.2.1/P4: 发散创建——探索批次（灵感 → 候选 DNA → 渲染 → 收卡） ----
CREATE TABLE IF NOT EXISTS exploration_batches(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  intent_text TEXT NOT NULL DEFAULT '',
  axes_json TEXT NOT NULL DEFAULT '[]',
  count INTEGER NOT NULL DEFAULT 6,
  proposals_json TEXT NOT NULL DEFAULT '[]',
  selected_json TEXT NOT NULL DEFAULT '[]',
  render_model_id TEXT DEFAULT '',
  render_size TEXT DEFAULT '',
  renders_json TEXT NOT NULL DEFAULT '[]',
  cost_estimate INTEGER DEFAULT 0,
  cost_actual INTEGER DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'expanded',
  archived INTEGER DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_explore_user ON exploration_batches(user_id, updated_at DESC);
-- ---- v0.2.0: 统一模型注册表（供应商 → 模型两层；替代 points_models / image_models / env 直读） ----
CREATE TABLE IF NOT EXISTS providers(
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  preset TEXT NOT NULL DEFAULT 'custom',
  kind TEXT NOT NULL DEFAULT 'both',
  base_url TEXT DEFAULT '',
  api_key_encrypted TEXT DEFAULT '',
  is_default INTEGER DEFAULT 0,
  is_active INTEGER DEFAULT 1,
  sort_order INTEGER DEFAULT 0,
  created_at TEXT NOT NULL,
  models_cache_json TEXT,
  models_cached_at INTEGER
);
CREATE TABLE IF NOT EXISTS models(
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  model_id TEXT NOT NULL,
  name TEXT DEFAULT '',
  pricing_json TEXT DEFAULT '{}',
  extra_json TEXT DEFAULT '{}',
  is_active INTEGER DEFAULT 1,
  sort_order INTEGER DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_models_kind ON models(kind, is_active);
`;

let _db = null;

// 懒初始化：check.js 可先设 process.env.DATA_DIR 再调用

// v0.2.0: 统一模型注册表迁移（image_models / points_models / env → providers + models），幂等
function migrateToUnifiedRegistry(db) {
  // v0.2.1: 供应商模型列表缓存（连通测试拉取 /models 后存这里），老库幂等补字段
  try {
    const pcols = db.prepare("PRAGMA table_info(providers)").all().map((c) => c.name);
    if (pcols.length && !pcols.includes('models_cache_json')) db.exec('ALTER TABLE providers ADD COLUMN models_cache_json TEXT');
    if (pcols.length && !pcols.includes('models_cached_at')) db.exec('ALTER TABLE providers ADD COLUMN models_cached_at INTEGER');
  } catch (e) { console.warn('[db] providers 模型缓存字段迁移失败:', e.message); }
  const hasTable = (t) => {
    try { return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t); }
    catch { return false; }
  };
  const t = new Date().toISOString();
  const cfg = getConfig();
  const mk = cfg.masterKey || '';
  const nid = (p) => p + '_' + randomUUID().replace(/-/g, '').slice(0, 12);
  const normBase = (u) => String(u || '').trim().replace(/\/+$/, '');

  // env → 默认供应商（幂等：同 base_url+preset 已存在则复用）
  const ensureEnvProvider = () => {
    const base = normBase(process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1');
    const preset = detectProvider(base);
    const ex = db.prepare('SELECT id FROM providers WHERE base_url=? AND preset=?').get(base, preset);
    if (ex) return ex.id;
    const key = (process.env.OPENROUTER_API_KEY || '').trim();
    const presetName = { openrouter: 'OpenRouter', dashscope: 'DashScope', deepseek: 'DeepSeek', zhipu: '智谱' }[preset] || '自定义';
    const id = nid('prov');
    db.prepare('INSERT INTO providers(id,name,preset,kind,base_url,api_key_encrypted,is_default,is_active,sort_order,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run(id, `${presetName}（env 迁移）`, preset, 'both', base, key ? encryptSecret(mk, key) : null, 1, 1, 0, t);
    return id;
  };

  // 1) image_models → providers(kind=image) + models(kind=image)
  if (hasTable('image_models')) {
    const rows = db.prepare('SELECT * FROM image_models').all();
    const pcache = new Map();
    for (const r of rows) {
      const preset = r.provider === 'dashscope' ? 'dashscope' : 'custom';
      const base = normBase(r.base_url);
      const ck = preset + '|' + base;
      let pid = pcache.get(ck);
      if (!pid) {
        const ex = db.prepare('SELECT id FROM providers WHERE preset=? AND base_url=?').get(preset, base);
        if (ex) pid = ex.id;
        else {
          pid = nid('prov');
          const pname = preset === 'dashscope' ? 'DashScope（迁移）'
            : (base ? base.replace(/^https?:\/\//, '').split('/')[0] + '（迁移）' : '图片供应商（迁移）');
          db.prepare('INSERT INTO providers(id,name,preset,kind,base_url,api_key_encrypted,is_default,is_active,sort_order,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
            .run(pid, pname, preset, 'image', base, r.api_key_encrypted || null, 0, 1, 0, t);
        }
        pcache.set(ck, pid);
      }
      let sizes = [];
      try { const v = JSON.parse(r.sizes_json || '[]'); if (Array.isArray(v)) sizes = v; } catch {}
      db.prepare('INSERT INTO models(id,provider_id,kind,model_id,name,pricing_json,extra_json,is_active,sort_order,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
        .run(nid('model'), pid, 'image', r.model_id, r.name || r.model_id,
          JSON.stringify({ per_call: Math.floor(Number(r.price_per_call)) || 0 }),
          JSON.stringify({ sizes }), r.is_active ? 1 : 0, Math.floor(Number(r.sort_order)) || 0, r.created_at || t);
    }
    db.exec('DROP TABLE image_models');
    console.log(`[db] 迁移 image_models → 统一注册表：${rows.length} 个图片模型`);
  }

  // 2) points_models → models(kind=chat)，挂到 env 供应商下
  if (hasTable('points_models')) {
    const pid = ensureEnvProvider();
    const rows = db.prepare('SELECT * FROM points_models').all();
    for (const r of rows) {
      db.prepare('INSERT INTO models(id,provider_id,kind,model_id,name,pricing_json,extra_json,is_active,sort_order,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
        .run(nid('model'), pid, 'chat', r.model_id, r.name || r.model_id,
          JSON.stringify({ input_per_1m: Math.floor(Number(r.input_per_1m)) || 0, output_per_1m: Math.floor(Number(r.output_per_1m)) || 0 }),
          '{}', r.is_active ? 1 : 0, Math.floor(Number(r.sort_order)) || 0, r.created_at || t);
    }
    db.exec('DROP TABLE points_models');
    console.log(`[db] 迁移 points_models → 统一注册表：${rows.length} 个聊天模型`);
  }

  // 3) 建默认供应商（即使 env 无 key 也建，管理员可在面板里填 key）
  const defaultPid = ensureEnvProvider();
  // 4) 空库预置 3 个聊天模型（与老 points_models seed 一致；老库迁移后 models 非空则跳过）
  if (!db.prepare('SELECT 1 FROM models LIMIT 1').get()) {
    const seed = [
      ['qwen/qwen3.8-flash', 'Qwen3.8 Flash', 200, 600, 0],
      ['google/gemini-3.8-flash', 'Gemini 3.8 Flash', 200, 600, 1],
      ['openai/gpt-6-luna', 'GPT-6 Luna', 2500, 10000, 2],
    ];
    const ins = db.prepare(
      'INSERT INTO models(id,provider_id,kind,model_id,name,pricing_json,extra_json,is_active,sort_order,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)');
    const tx = db.transaction(() => {
      for (const [mid, name, ip, op, so] of seed)
        ins.run(nid('model'), defaultPid, 'chat', mid, name,
          JSON.stringify({ input_per_1m: ip, output_per_1m: op }), '{}', 1, so, t);
    });
    tx();
    console.log('[db] 统一注册表：已预置默认聊天模型');
  }
}

export function getDb() {
  if (_db) return _db;
  const { dataDir } = getConfig();
  fs.mkdirSync(dataDir, { recursive: true });
  _db = new Database(path.join(dataDir, 'fashion-studio.db'));
  _db.pragma('journal_mode = WAL');
  _db.exec(SCHEMA);
  migrateToUnifiedRegistry(_db);
  // ---- 轻量迁移：老库自动加列（新库不受影响） ----
  try {
    const convCols = _db.prepare('PRAGMA table_info(conversations)').all().map((c) => c.name);
    if (!convCols.includes('type')) _db.exec("ALTER TABLE conversations ADD COLUMN type TEXT DEFAULT 'single'");
    const msgCols = _db.prepare('PRAGMA table_info(messages)').all().map((c) => c.name);
    if (!msgCols.includes('character_id')) _db.exec('ALTER TABLE messages ADD COLUMN character_id TEXT DEFAULT NULL');
    // v1.21.0: 群聊整轮 batch_id（老库自动补列）
    if (!msgCols.includes('batch_id')) _db.exec('ALTER TABLE messages ADD COLUMN batch_id TEXT DEFAULT NULL');
    // v1.25.2: facts 来源消息 ID，用于删除消息时级联清理（老库自动补列）
    const factCols = _db.prepare('PRAGMA table_info(memory_facts)').all().map((c) => c.name);
    if (!factCols.includes('source_message_id')) _db.exec('ALTER TABLE memory_facts ADD COLUMN source_message_id INTEGER DEFAULT NULL');
    // 多用户数据隔离：characters / conversations / conversation_summaries 加 user_id（允许 NULL，老数据保持 NULL）
    // group_members 经 conversation 关联，messages/file_versions 经 character/conversation 关联，不加列
    for (const t of ['characters', 'conversations', 'conversation_summaries']) {
      const cols = _db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
      if (!cols.includes('user_id')) _db.exec(`ALTER TABLE ${t} ADD COLUMN user_id TEXT`);
    }
    // 积分系统：users 加列（老库自动补）
    const userCols = _db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
    if (!userCols.includes('points_balance')) _db.exec('ALTER TABLE users ADD COLUMN points_balance INTEGER DEFAULT 0');
    if (!userCols.includes('billing_mode')) _db.exec("ALTER TABLE users ADD COLUMN billing_mode TEXT DEFAULT 'points'");
    if (!userCols.includes('is_admin')) _db.exec('ALTER TABLE users ADD COLUMN is_admin INTEGER DEFAULT 0');
    // v0.2.0: 设计台记忆遗忘——dna_generations 加 archived 列（老库自动补）
    const genCols = _db.prepare('PRAGMA table_info(dna_generations)').all().map((c) => c.name);
    if (!genCols.includes('archived')) _db.exec('ALTER TABLE dna_generations ADD COLUMN archived INTEGER DEFAULT 0');
    // v1.18.1: 破限白名单——只有管理员授权的用户可用破限模式（默认关闭）
    if (!userCols.includes('jailbreak_allowed')) _db.exec('ALTER TABLE users ADD COLUMN jailbreak_allowed INTEGER DEFAULT 0');
    // v1.18.1: 老用户 grandfather——已有角色开着破限的，自动授权，不影响现有体验
    try {
      const charCols = _db.prepare('PRAGMA table_info(characters)').all().map((c) => c.name);
      if (charCols.includes('jailbreak_preset')) {
        _db.exec(`UPDATE users SET jailbreak_allowed = 1 WHERE id IN (SELECT DISTINCT user_id FROM characters WHERE jailbreak_preset IS NOT NULL AND jailbreak_preset != '')`);
      }
    } catch (e) { console.warn('[db] 破限白名单 grandfather 迁移失败:', e.message); }
    // v1.20.0: API 提供商预设（协议与地址解耦；非敏感，明文存）
    try {
      const kCols = _db.prepare('PRAGMA table_info(user_api_keys)').all().map((c) => c.name);
      if (!kCols.includes('provider')) _db.exec("ALTER TABLE user_api_keys ADD COLUMN provider TEXT DEFAULT 'custom'");
    } catch (e) { console.warn('[db] provider 迁移失败:', e.message); }
    // 邀请系统
    if (!userCols.includes('invite_code')) _db.exec('ALTER TABLE users ADD COLUMN invite_code TEXT');
    if (!userCols.includes('invited_by')) _db.exec('ALTER TABLE users ADD COLUMN invited_by TEXT');
    // 账本：记录 token 用量与模型（用量统计用，可空）
    const ledgerCols = _db.prepare('PRAGMA table_info(points_ledger)').all().map((c) => c.name);
    if (!ledgerCols.includes('tokens_input')) _db.exec('ALTER TABLE points_ledger ADD COLUMN tokens_input INTEGER');
    if (!ledgerCols.includes('tokens_output')) _db.exec('ALTER TABLE points_ledger ADD COLUMN tokens_output INTEGER');
    if (!ledgerCols.includes('model')) _db.exec('ALTER TABLE points_ledger ADD COLUMN model TEXT');
    // v1.26.3: 移除硬编码模型种子——所有可用模型必须由管理员经模型管理 tab 上架，不再预置
    // 首个注册用户自动成为管理员（只执行一次）
    const firstUser = _db.prepare('SELECT id FROM users ORDER BY created_at ASC LIMIT 1').get();
    if (firstUser) {
      _db.prepare('UPDATE users SET is_admin = 1 WHERE id = ? AND is_admin = 0').run(firstUser.id);
    }
    // 邀请码唯一索引 + 老用户补发邀请码（8 位大写字母数字，去掉易混淆字符）    _db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_invite_code ON users(invite_code)');
    // 密码重置码：老库加列，老用户补发（与邀请码独立，绝不公开）
    if (!userCols.includes('recovery_code')) _db.exec('ALTER TABLE users ADD COLUMN recovery_code TEXT');
    const noRecovery = _db.prepare("SELECT id FROM users WHERE recovery_code IS NULL OR recovery_code = ''").all();
    if (noRecovery.length) {
      const usedR = new Set(
        _db.prepare('SELECT recovery_code FROM users WHERE recovery_code IS NOT NULL').all().map((r) => r.recovery_code)
      );
      const upd = _db.prepare('UPDATE users SET recovery_code = ? WHERE id = ?');
      _db.transaction((rows) => {
        for (const r of rows) {
          let code = genRecoveryCode();
          while (usedR.has(code)) code = genRecoveryCode();
          usedR.add(code);
          upd.run(code, r.id);
        }
      })(noRecovery);
    }
    const noCode = _db.prepare("SELECT id FROM users WHERE invite_code IS NULL OR invite_code = ''").all();
    if (noCode.length) {
      const used = new Set(
        _db.prepare('SELECT invite_code FROM users WHERE invite_code IS NOT NULL').all().map((r) => r.invite_code)
      );
      const upd = _db.prepare('UPDATE users SET invite_code = ? WHERE id = ?');
      _db.transaction((rows) => {
        for (const r of rows) {
          let code = mk();
          while (used.has(code)) code = mk();
          used.add(code);
          upd.run(code, r.id);
        }
      })(noCode);
    }
    // 老用户一次性迁移：有托管 Key 的保持 byok，否则走积分；统一补 500 注册积分（幂等）
    const needBonus = _db
      .prepare(
        `SELECT u.id FROM users u
         LEFT JOIN user_api_keys k ON k.user_id = u.id
         WHERE u.points_balance = 0
           AND NOT EXISTS (SELECT 1 FROM points_ledger l WHERE l.user_id = u.id AND l.reason = 'signup_bonus')`
      )
      .all();
    if (needBonus.length) {
      const t = new Date().toISOString();
      const grant = _db.transaction((rows) => {
        for (const r of rows) {
          const hasKey = _db.prepare('SELECT enc_key FROM user_api_keys WHERE user_id = ?').get(r.id);
          _db.prepare("UPDATE users SET points_balance = 500, billing_mode = ? WHERE id = ?").run(
            hasKey && hasKey.enc_key ? 'byok' : 'points',
            r.id
          );
          _db.prepare(
            'INSERT INTO points_ledger(user_id, delta, balance_after, reason, created_at) VALUES(?,?,?,?,?)'
          ).run(r.id, 500, 500, 'signup_bonus', t);
        }
      });
      grant(needBonus);
    }
    // v1.10 一次性迁移：memory_md 条目 → memory_facts（只迁还没有 facts 的角色）
    // v1.12.1 修正：先去掉 HTML 注释块（模板说明文字），避免注释被拆成 facts
    const migChars = _db
      .prepare(
        `SELECT id, memory_md FROM characters
         WHERE memory_md IS NOT NULL AND TRIM(memory_md) != ''
         AND NOT EXISTS (SELECT 1 FROM memory_facts WHERE memory_facts.character_id = characters.id)`
      )
      .all();
    if (migChars.length) {
      const nowMig = new Date().toISOString();
      const insFact = _db.prepare(
        'INSERT INTO memory_facts(character_id, fact, importance, created_at, source) VALUES(?,?,?,?,?)'
      );
      _db.transaction((rows) => {
        for (const c of rows) {
          const noComment = String(c.memory_md).replace(/<!--[\s\S]*?-->/g, '');
          const lines = noComment
            .split('\n')
            .map((s) => s.trim())
            .filter((s) => s && !s.startsWith('#'));
          for (const ln of lines) {
            const fact = ln.replace(/^[-*•\d.]\s*/, '').trim();
            if (fact) insFact.run(c.id, fact, 3, nowMig, 'migrate');
          }
        }
      })(migChars);
      console.log(`[db] 记忆迁移：${migChars.length} 个角色的 memory_md 已拆为 facts 条目`);
    }
    // v1.12.1 清理：删除此前迁移误拆模板注释产生的 facts（FTS 触发器自动清理索引）
    // v1.15.0: 扮演模式开关（按角色）：roleplay_mode 开关，roleplay_prompt 自定义提示词（NULL=用内置模板）
    const charCols = _db.prepare('PRAGMA table_info(characters)').all().map((c) => c.name);
    if (!charCols.includes('roleplay_mode')) _db.exec('ALTER TABLE characters ADD COLUMN roleplay_mode INTEGER NOT NULL DEFAULT 0');
    if (!charCols.includes('roleplay_prompt')) _db.exec('ALTER TABLE characters ADD COLUMN roleplay_prompt TEXT');
    // v1.17.0: 破限预设插件化，角色级选用（NULL=关闭）
    if (!charCols.includes('jailbreak_preset')) _db.exec('ALTER TABLE characters ADD COLUMN jailbreak_preset TEXT');
    // v1.15.2 修复：清理之前 bug 误存的字符串 "null"（String(null) 的产物），恢复为 NULL（用内置模板）
    try {
      const fixed = _db.prepare("UPDATE characters SET roleplay_prompt = NULL WHERE roleplay_prompt = 'null'").run();
      if (fixed.changes) console.log(`[db] 清理 roleplay_prompt 误存的 "null" 字符串：${fixed.changes} 条`);
    } catch (e) {
      console.warn('[db] roleplay_prompt 清理失败:', e.message);
    }
    try {
      const del = _db
        .prepare(`DELETE FROM memory_facts WHERE fact LIKE '%此文本框保留做兼容%' OR fact LIKE '<!--%'`)
        .run();
      if (del.changes) console.log(`[db] 清理模板注释 facts：${del.changes} 条`);
    } catch (e) {
      console.warn('[db] 注释 facts 清理失败:', e.message);
    }
  } catch (e) {
    console.warn('[db] 迁移失败:', e.message);
  }
  return _db;
}

export function closeDb() {
  if (_db) {
    _db.close();
    _db = null;
  }
}

// v1.12 系统设置读写
export function getSetting(key, def = '') {
  const r = getDb().prepare('SELECT value FROM sys_settings WHERE key = ?').get(key);
  return r ? r.value : def;
}
export function setSetting(key, value) {
  getDb()
    .prepare(
      'INSERT INTO sys_settings(key, value, updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'
    )
    .run(key, String(value ?? ''), new Date().toISOString());
}
