// 积分系统：平台 Key 计费（多用户模式）
// 汇率：1 元 = 100 积分（POINTS_PER_YUAN）
// 单价单位：积分 / 1M tokens。以下为默认值，请对照 OpenRouter 账单定期核对调整。
import { getDb, getSetting } from './db.js';
import { listChatModelsCompat } from './registry.js';

export const POINTS_PER_YUAN = 100;
export const SIGNUP_BONUS = 500; // 兼容保留：实际以后台配置为准（见 getSignupBonus）

// v1.18.1: 注册奖励改为管理员可配置（sys_settings.signup_bonus，默认 100）
export function getSignupBonus() {
  const v = parseInt(getSetting('signup_bonus', ''), 10);
  return Number.isFinite(v) && v >= 0 ? v : 100;
}

// v1.18.1: 管理员直接设用户余额（输多发错时纠正）；账本记 admin_set
export function setPointsBalance(userId, balance) {
  const target = Math.max(0, Math.floor(Number(balance) || 0));
  const cur = getBalance(userId);
  const delta = target - cur;
  if (delta !== 0) addLedger(userId, delta, 'admin_set');
  return target;
}

// ---- 邀请奖励 ----
export const INVITE_REWARD_INVITER = 200; // 邀请人奖励
export const INVITE_REWARD_INVITEE = 100; // 被邀请人额外奖励（500 基础上）
export const INVITE_CHAT_THRESHOLD = 10; // 被邀请人聊满 N 条后给邀请人发奖励（防刷）

// 生成 8 位邀请码 / 12 位密码重置码（crypto 强随机，见 db.js）
export { genInviteCode, genRecoveryCode } from './db.js';

// 积分模式可用模型：改为数据库动态管理（管理员后台增删改价）
// 行结构：{ id, model_id, name, description, input_per_1m, output_per_1m, is_active, sort_order }
// 对外统一转成 { id, name, desc, inputPer1M, outputPer1M } 形状，保持 API 稳定
function rowToModel(r) {
  return {
    id: r.model_id,
    name: r.name,
    desc: r.description || '',
    inputPer1M: r.input_per_1m,
    outputPer1M: r.output_per_1m,
  };
}

// 列出可用模型（activeOnly=true 只返回启用中的，供用户端/计费校验）
// v0.2.0: 改读统一注册表 models(kind=chat)
export function listPointsModels(activeOnly = true) {
  return listChatModelsCompat(activeOnly).map(rowToModel);
}

// 管理员视角：原始行（含 id/is_active/sort_order）
export function listPointsModelRows() {
  return listChatModelsCompat(false);
}

// 白名单校验：服务端强制，只认启用中的模型
export function getPointsModel(id) {
  if (!id) return null;
  const r = listChatModelsCompat(true).find((x) => x.model_id === id);
  return r ? rowToModel(r) : null;
}

// 后台任务（记忆提取/摘要/导演）用管理员配置的模型；未配置或已下架时回退到最便宜的启用模型
export function getWorkerModel() {
  const configured = getSetting('worker_model', '').trim();
  if (configured) {
    const m = getPointsModel(configured);
    if (m) return m.id;
  }
  const rows = listChatModelsCompat(true)
    .sort((a, b) => (a.input_per_1m + a.output_per_1m) - (b.input_per_1m + b.output_per_1m));
  return rows.length ? rows[0].model_id : null;
}

// v1.12 聊天默认模型（管理员配置；未配置时回退到最便宜的启用模型）
export function getChatDefaultModel() {
  const configured = getSetting('chat_default_model', '').trim();
  if (configured) {
    const m = getPointsModel(configured);
    if (m) return m.id;
  }
  const rows = listChatModelsCompat(true)
    .sort((a, b) => (a.input_per_1m + a.output_per_1m) - (b.input_per_1m + b.output_per_1m));
  return rows.length ? rows[0].model_id : null;
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
    // 防并发超扣：事务内原子检查，余额不足直接回滚（better-sqlite3 事务同步串行，无交错）
    if (delta < 0 && after < 0) throw new Error('积分不足');
    db.prepare('UPDATE users SET points_balance = ? WHERE id = ?').run(after, userId);
    db.prepare(
      'INSERT INTO points_ledger(user_id, delta, balance_after, reason, ref_type, ref_id, tokens_input, tokens_output, model, created_at, accounting_delta) VALUES(?,?,?,?,?,?,?,?,?,?,?)'
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
      new Date().toISOString(),
      extra.accountingDelta ?? (['explore_reserve','explore_release','explore_expand_reserve','explore_expand_release','explore_resolve'].includes(reason) ? 0 : null)
    );
    return after;
  })();
}

// v1.19.0: 记录自带 Key（BYOK）调用（不扣费，只统计用量；单用户模式 userId 可空）
export function recordByokUsage(userId, model, reason, usage) {
  if (!usage) return;
  try {
    getDb()
      .prepare(
        'INSERT INTO api_usage(user_id, model, reason, tokens_input, tokens_output, created_at) VALUES(?,?,?,?,?,?)'
      )
      .run(
        userId || null,
        model || '',
        reason || 'chat',
        Math.round(Number(usage.input) || 0),
        Math.round(Number(usage.output) || 0),
        new Date().toISOString()
      );
  } catch (e) {
    console.warn('[api_usage] 记录失败:', e.message);
  }
}

// 扣费：预检由调用方做（余额不足直接 402 拒绝）；这里允许余额变负（并发竞态的极端情况），
// 流水如实记录，下一次预检会拦截。
export function deductPoints(userId, points, reason, refType = null, refId = null, extra = {}) {
  if (!points || points <= 0) return getBalance(userId);
  return addLedger(userId, -points, reason, refType, refId, extra);
}

// 集卡奖励：集齐官方预设卡一次性 +200，幂等（多用户模式；单用户无账本直接跳过）
// totalPresets 由调用方传入，避免 points ↔ characterCards 循环引用
export const COLLECTION_REWARD = 200;
export function maybeCollectionReward(userId, totalPresets) {
  if (!userId || !totalPresets) return 0;
  const db = getDb();
  const done = db
    .prepare("SELECT id FROM points_ledger WHERE user_id = ? AND reason = 'collection_reward' LIMIT 1")
    .get(userId);
  if (done) return 0;
  const n = db
    .prepare("SELECT COUNT(*) AS n FROM user_collection WHERE user_id = ? AND card_key LIKE 'preset:%'")
    .get(userId).n;
  if (n >= totalPresets) {
    addLedger(userId, COLLECTION_REWARD, 'collection_reward');
    return COLLECTION_REWARD;
  }
  return 0;
}
export function hasSignupBonus(userId) {
  // 是否已领取过注册奖励（ledger 有 signup_bonus 即视为已领取；老用户注册时已发过）
  const db = getDb();
  return !!db
    .prepare("SELECT id FROM points_ledger WHERE user_id = ? AND reason = 'signup_bonus' LIMIT 1")
    .get(userId);
}

// 注册奖励：首次聊天成功（收到第一条 assistant 回复）后发放，防批量注册刷号薅积分。
// 幂等：已发放过（ledger 有 signup_bonus）则跳过；老用户注册时已发过，不会重复。
// v1.18.1: 金额取管理员配置（getSignupBonus），改配置只影响新用户
export function maybeSignupBonus(userId) {
  if (hasSignupBonus(userId)) return 0;
  const db = getDb();
  const u = db.prepare('SELECT invited_by FROM users WHERE id = ?').get(userId);
  if (!u) return 0;
  const bonus = getSignupBonus();
  addLedger(userId, bonus, 'signup_bonus');
  let total = bonus;
  if (u.invited_by) {
    addLedger(userId, INVITE_REWARD_INVITEE, 'invite_bonus', 'user', u.invited_by);
    total += INVITE_REWARD_INVITEE;
  }
  return total;
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
  explore_reserve:'创意生图额度预留', explore_release:'创意生图失败退款', explore_settle:'创意生图完成结算',
  explore_expand_reserve:'创意发散额度预留', explore_expand_settle:'创意发散完成结算', explore_expand_release:'创意发散额度释放', explore_resolve:'创意任务人工核对退款',
  signup_bonus: '注册赠送',
  admin_grant: '管理员发放',
  chat: '聊天消耗',
  group_chat: '群聊消耗',
  memory: '记忆整理',
  summary: '对话摘要',
  director: '群聊导演',
  invite_bonus: '邀请奖励（被邀）',
  invite_reward: '邀请奖励',
  character_generate: 'AI 生成角色',
  collection_reward: '集卡奖励',
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
