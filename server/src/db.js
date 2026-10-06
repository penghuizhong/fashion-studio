import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { randomInt } from 'node:crypto';
import { getConfig } from './config.js';

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
-- ---- 积分可用模型（管理员动态管理） ----
CREATE TABLE IF NOT EXISTS points_models(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  model_id TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  input_per_1m INTEGER NOT NULL,
  output_per_1m INTEGER NOT NULL,
  is_active INTEGER DEFAULT 1,
  sort_order INTEGER DEFAULT 0,
  created_at TEXT
);
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
`;

let _db = null;

// 懒初始化：check.js 可先设 process.env.DATA_DIR 再调用
export function getDb() {
  if (_db) return _db;
  const { dataDir } = getConfig();
  fs.mkdirSync(dataDir, { recursive: true });
  _db = new Database(path.join(dataDir, 'soulchat.db'));
  _db.pragma('journal_mode = WAL');
  _db.exec(SCHEMA);
  // ---- 轻量迁移：老库自动加列（新库不受影响） ----
  try {
    const convCols = _db.prepare('PRAGMA table_info(conversations)').all().map((c) => c.name);
    if (!convCols.includes('type')) _db.exec("ALTER TABLE conversations ADD COLUMN type TEXT DEFAULT 'single'");
    const msgCols = _db.prepare('PRAGMA table_info(messages)').all().map((c) => c.name);
    if (!msgCols.includes('character_id')) _db.exec('ALTER TABLE messages ADD COLUMN character_id TEXT DEFAULT NULL');
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
    // 邀请系统
    if (!userCols.includes('invite_code')) _db.exec('ALTER TABLE users ADD COLUMN invite_code TEXT');
    if (!userCols.includes('invited_by')) _db.exec('ALTER TABLE users ADD COLUMN invited_by TEXT');
    // 账本：记录 token 用量与模型（用量统计用，可空）
    const ledgerCols = _db.prepare('PRAGMA table_info(points_ledger)').all().map((c) => c.name);
    if (!ledgerCols.includes('tokens_input')) _db.exec('ALTER TABLE points_ledger ADD COLUMN tokens_input INTEGER');
    if (!ledgerCols.includes('tokens_output')) _db.exec('ALTER TABLE points_ledger ADD COLUMN tokens_output INTEGER');
    if (!ledgerCols.includes('model')) _db.exec('ALTER TABLE points_ledger ADD COLUMN model TEXT');
    // 积分可用模型：表为空时写入初始默认数据（仅一次）
    const modelCount = _db.prepare('SELECT COUNT(*) AS n FROM points_models').get().n;
    if (modelCount === 0) {
      const now = new Date().toISOString();
      const seed = [
        ['qwen/qwen3.8-flash', 'Qwen3.8 Flash', '快速便宜，日常聊天首选', 200, 600, 0],
        ['google/gemini-3.8-flash', 'Gemini 3.8 Flash', '快速便宜，日常聊天首选', 200, 600, 1],
        ['openai/gpt-6-luna', 'GPT-6 Luna', '旗舰模型，效果最强，消耗较高', 2500, 10000, 2],
      ];
      const ins = _db.prepare(
        'INSERT INTO points_models(model_id, name, description, input_per_1m, output_per_1m, is_active, sort_order, created_at) VALUES(?,?,?,?,?,?,?,?)'
      );
      const tx = _db.transaction(() => {
        for (const [mid, name, desc, ip, op, so] of seed) ins.run(mid, name, desc, ip, op, 1, so, now);
      });
      tx();
    }
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
