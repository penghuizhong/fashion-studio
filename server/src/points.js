// 积分系统：平台 Key 计费（多用户模式）
// 汇率：1 元 = 100 积分（POINTS_PER_YUAN）
// 单价单位：积分 / 1M tokens。以下为默认值，请对照 OpenRouter 账单定期核对调整。
import { getDb } from './db.js';

export const POINTS_PER_YUAN = 100;
export const SIGNUP_BONUS = 500;

// ---- 邀请奖励 ----
export const INVITE_REWARD_INVITER = 200; // 邀请人奖励
export const INVITE_REWARD_INVITEE = 100; // 被邀请人额外奖励（500 基础上）
export const INVITE_CHAT_THRESHOLD = 10; // 被邀请人聊满 N 条后给邀请人发奖励（防刷）

// 生成 8 位邀请码（大写字母数字，去掉易混淆字符）
export function genInviteCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 8; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

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
// extra: { tokensInput, tokensOutput, model }（用量统计用，可选）
export function addLedger(userId, delta, reason, refType = null, refId = null, extra = {}) {
  const db = getDb();
  return db.transaction(() => {
    const row = db.prepare('SELECT points_balance FROM users WHERE id = ?').get(userId);
    if (!row) throw new Error('用户不存在');
    const after = row.points_balance + delta;
    db.prepare('UPDATE users SET points_balance = ? WHERE id = ?').run(after, userId);
    db.prepare(
      'INSERT INTO points_ledger(user_id, delta, balance_after, reason, ref_type, ref_id, tokens_input, tokens_output, model, created_at) VALUES(?,?,?,?,?,?,?,?,?,?)'
    ).run(
      userId,
      delta,
      after,
      reason,
      refType,
      refId,
      extra.tokensInput != null ? Math.round(extra.tokensInput) : null,
      extra.tokensOutput != null ? Math.round(extra.tokensOutput) : null,
      extra.model || null,
      new Date().toISOString()
    );
    return after;
  })();
}

// 扣费：预检由调用方做（余额不足直接 402 拒绝）；这里允许余额变负（并发竞态的极端情况），
// 流水如实记录，下一次预检会拦截。
export function deductPoints(userId, points, reason, refType = null, refId = null, extra = {}) {
  if (!points || points <= 0) return getBalance(userId);
  return addLedger(userId, -points, reason, refType, refId, extra);
}

export function grantPoints(userId, points, reason = 'admin_grant', refId = null) {
  if (!points || points <= 0) throw new Error('发放数量必须大于 0');
  return addLedger(userId, Math.floor(points), reason, null, refId);
}

export function getLedger(userId, limit = 20) {
  return getDb()
    .prepare('SELECT id, delta, balance_after, reason, ref_type, ref_id, tokens_input, tokens_output, model, created_at FROM points_ledger WHERE user_id = ? ORDER BY id DESC LIMIT ?')
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
  invite_bonus: '邀请奖励（被邀）',
  invite_reward: '邀请奖励',
};

// 邀请奖励触发：被邀请人 assistant 消息数达标后，给邀请人发奖励（幂等）
// 返回发放的积分（未达标/已发放返回 0）
export function maybeInviteReward(inviteeId) {
  const db = getDb();
  const u = db.prepare('SELECT invited_by FROM users WHERE id = ?').get(inviteeId);
  if (!u || !u.invited_by) return 0;
  // 已发放过则跳过（幂等）
  const paid = db
    .prepare("SELECT id FROM points_ledger WHERE user_id = ? AND reason = 'invite_reward' AND ref_id = ? LIMIT 1")
    .get(u.invited_by, inviteeId);
  if (paid) return 0;
  // 被邀请人的 assistant 消息数（含群聊）
  const n = db
    .prepare(
      `SELECT COUNT(*) AS n FROM messages m
       JOIN conversations c ON c.id = m.conversation_id
       WHERE c.user_id = ? AND m.role = 'assistant'`
    )
    .get(inviteeId).n;
  if (n < INVITE_CHAT_THRESHOLD) return 0;
  addLedger(u.invited_by, INVITE_REWARD_INVITER, 'invite_reward', 'user', inviteeId);
  return INVITE_REWARD_INVITER;
}
