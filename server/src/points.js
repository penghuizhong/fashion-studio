// 积分系统：平台 Key 计费（多用户模式）
// 汇率：1 元 = 100 积分（POINTS_PER_YUAN）
// 单价单位：积分 / 1M tokens。以下为默认值，请对照 OpenRouter 账单定期核对调整。
import { getDb } from './db.js';

export const POINTS_PER_YUAN = 100;
export const SIGNUP_BONUS = 500;

// 积分模式可用模型白名单（服务端强制校验，前端传什么都没用）
// id 必须与 OpenRouter 上的模型 id 一致
export const POINTS_MODELS = [
  {
    id: 'qwen3.8-flash',
    name: 'Qwen3.8 Flash',
    desc: '快速便宜，日常聊天首选',
    inputPer1M: 200,
    outputPer1M: 600,
  },
  {
    id: 'gemini/gemini-3.8-flash',
    name: 'Gemini 3.8 Flash',
    desc: '快速便宜，日常聊天首选',
    inputPer1M: 200,
    outputPer1M: 600,
  },
  {
    id: 'openai/gpt-6-luna',
    name: 'GPT-6 Luna',
    desc: '旗舰模型，效果最强，消耗较高',
    inputPer1M: 2500,
    outputPer1M: 10000,
  },
];

// 后台任务（记忆提取/摘要/导演）固定用最便宜的模型
export const POINTS_WORKER_MODEL = POINTS_MODELS[0].id;

export function getPointsModel(id) {
  return POINTS_MODELS.find((m) => m.id === id) || null;
}

// 按真实用量算积分（至少 1 积分；usage 为空如 mock 模式则返回 0）
export function calcPoints(modelId, usage) {
  const m = getPointsModel(modelId);
  if (!m || !usage) return 0;
  const input = Number(usage.input) || 0;
  const output = Number(usage.output) || 0;
  const pts = (input / 1e6) * m.inputPer1M + (output / 1e6) * m.outputPer1M;
  return Math.max(1, Math.ceil(pts));
}

export function getBalance(userId) {
  const row = getDb().prepare('SELECT points_balance FROM users WHERE id = ?').get(userId);
  return row ? row.points_balance : 0;
}

// 记账（原子事务）：更新余额 + 写流水。delta 可正（发放）可负（扣费）
export function addLedger(userId, delta, reason, refType = null, refId = null) {
  const db = getDb();
  return db.transaction(() => {
    const row = db.prepare('SELECT points_balance FROM users WHERE id = ?').get(userId);
    if (!row) throw new Error('用户不存在');
    const after = row.points_balance + delta;
    db.prepare('UPDATE users SET points_balance = ? WHERE id = ?').run(after, userId);
    db.prepare(
      'INSERT INTO points_ledger(user_id, delta, balance_after, reason, ref_type, ref_id, created_at) VALUES(?,?,?,?,?,?,?)'
    ).run(userId, delta, after, reason, refType, refId, new Date().toISOString());
    return after;
  })();
}

// 扣费：预检由调用方做（余额不足直接 402 拒绝）；这里允许余额变负（并发竞态的极端情况），
// 流水如实记录，下一次预检会拦截。
export function deductPoints(userId, points, reason, refType = null, refId = null) {
  if (!points || points <= 0) return getBalance(userId);
  return addLedger(userId, -points, reason, refType, refId);
}

export function grantPoints(userId, points, reason = 'admin_grant', refId = null) {
  if (!points || points <= 0) throw new Error('发放数量必须大于 0');
  return addLedger(userId, Math.floor(points), reason, null, refId);
}

export function getLedger(userId, limit = 20) {
  return getDb()
    .prepare('SELECT id, delta, balance_after, reason, ref_type, ref_id, created_at FROM points_ledger WHERE user_id = ? ORDER BY id DESC LIMIT ?')
    .all(userId, Math.min(limit, 100));
}

// 账本原因 → 中文展示
export const REASON_LABELS = {
  signup_bonus: '注册赠送',
  admin_grant: '管理员发放',
  chat: '聊天消耗',
  group_chat: '群聊消耗',
  memory: '记忆整理',
  summary: '对话摘要',
  director: '群聊导演',
};
