import { getConfig} from './config.js';
import { getDb} from './db.js';
import { summarizeText, classifyTurn, extractFacts } from './llm.js';

// v1.13.4: 当前北京时间（拼进 system prompt，模型知道今天几号）
// 用 Intl 按 Asia/Shanghai 算，不依赖服务器系统时区
export function nowBeijingStr() {
  try {
    const fmt = new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      weekday: 'long',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    return fmt.format(new Date()) + '（北京时间）';
  } catch {
    return new Date().toLocaleString('zh-CN');
  }
}

// v1.15.0: 扮演模式内置模板（小说式角色扮演格式指令）
// 用户未自定义时用此模板；前端有一份相同文本用于展示/编辑/恢复默认
export const ROLEPLAY_TEMPLATE = `## 回复格式：小说式角色扮演

1. 场景头：每次回复第一行用 [日期 世界·地点] 标注当前场景，日期用当天真实日期，地点跟着剧情走。
2. 旁白：小说笔法，多感官细节＋心理活动，短句有节奏；每个旁白段落段首加 丨。
3. 台词：角色说出口的话用 **加粗** 独立成段，不混在旁白里；多人时带名字前缀。
4. 不用括号备注动作神态，全部写进旁白。
5. 正文结束后另起 markdown 代码块，写角色没说出口的真实内心独白；独白可与说出口的话矛盾。
6. 每轮 200～500 字（不含独白块），信息密度高，不水文、不重复。`;

// 取角色生效的扮演提示词：开且自定义非空用自定义，开且空用内置，关则返回空
export function roleplayPromptOf(character) {
  if (!character || !character.roleplay_mode) return '';
  const custom = String(character.roleplay_prompt || '').trim();
  return custom || ROLEPLAY_TEMPLATE;
}

// 粗略 token 估算：CJK 字符 1.5 字符/token，其余 4 字符/token
export function estimateTokens(text) {
const s = String(text?? '');
const cjk = (s.match(/[\u3040-\u9fff\uf900-\ufaff\uff00-\uffef]/g) || []).length;
const other = s.length - cjk;
return Math.ceil(cjk / 1.5 + other / 4);
}

export const DEFAULT_SOUL = `# 身份
- 名字：（创建角色时填写）
- 身份：一名温柔耐心的 AI 伙伴，陪伴用户聊天、解闷、出主意。

# 性格
- 温柔、耐心、细心，情绪稳定。
- 对用户真诚，不敷衍；不知道的事情就直说。

# 说话风格
- 中文口语，自然亲切，像朋友一样聊天。
- 回复简洁，不啰嗦；用户想多聊时再展开。

# 边界
- 不编造不确定的事实，不确定的先问用户。
- 不涉及违法、危险内容；不做医疗诊断等超出能力范围的事，必要时建议咨询专业人士。

# 目标
- 成为用户信赖的聊天伙伴，记住重要的事，越聊越懂用户。
`;

export const DEFAULT_USER_MD = `<!-- 关于用户：记录用户的基本信息、称呼、偏好等。
格式：每条一行，以 "- " 开头，例如：
- 称呼：小明
- 偏好：喜欢简洁直接的回答
- 重要事项：每周三晚上有空

由 AI 在聊天中自动识别并更新（有值得记住的新信息时），也可以手动编辑。 -->
`;

export const DEFAULT_MEMORY_MD = `<!-- 记忆：v1.10 起已升级为 AI 自动条目（有重要事件/约定时自动记录，按需检索注入聊天）。
此文本框保留做兼容：手动填写的内容不会被 AI 读取，如需补充记忆请直接在聊天中告诉 AI（例如"记住：我下周三要出差"）。
-->`;


// 防幻觉系统指令，{name} 会被替换为角色名
export const ANTI_HALLU = `你是 {name}。回答时只依据以及本次对话中的事实。
规则：
1. 不确定的事情主动向用户提问确认，绝不编造人物、事件、时间、数字等细节。
2. 与本次对话出现冲突时，以中的最新记录为准；若冲突明显，主动向用户指出并确认。
3. 严格保持角色的身份、性格与说话风格，不得随意偏离。
`;

// 组装发给 LLM 的 messages：系统块（含角色名）→ 摘要 → 最近 20 轮原文
// 超预算时优先从最早的原文轮开始丢，摘要与三文件保留
// query：本轮用户消息，用于检索相关记忆事实；不传则取本轮最新用户消息
export function buildContext(character, conversationId, query) {
const cfg = getConfig();
const budget = cfg.contextBudget;
const db = getDb();

const sysParts = [
ANTI_HALLU.replaceAll('{name}', character.name || ''),
`# 当前时间\n${nowBeijingStr()}`,
`# 角色设定\n${character.soul_md || ''}`,
`# 关于用户\n${character.user_md || ''}`,
];
const rpSingle = roleplayPromptOf(character);
if (rpSingle) sysParts.push(`# 回复格式要求\n${rpSingle}`);
// v1.10：memory_md 不再全文注入（已迁移为 facts 条目），改为按需检索
const facts = retrieveFacts(character.id, conversationId, query, 8);
if (facts.length) sysParts.push(`# 相关记忆\n${facts.map((f) => `- ${f.fact}`).join('\n')}`);
const summaries = db
.prepare('SELECT summary FROM conversation_summaries WHERE conversation_id =? ORDER BY id DESC LIMIT 5')
.all(conversationId)
.reverse();
for (const s of summaries) {
sysParts.push(`# 更早对话摘要（按时间从旧到新）\n${s.summary}`);
}
const systemContent = sysParts.join('\n\n');

const raw = db
.prepare('SELECT role, content FROM messages WHERE conversation_id =? ORDER BY id DESC LIMIT 40')
.all(conversationId)
.reverse();

const tokensOf = (m) => estimateTokens(m.content) + 4; // +4 预留 role 等开销
let msgs = [...raw];
let used = estimateTokens(systemContent) + msgs.reduce((a, m) => a + tokensOf(m), 0);
while (used > budget && msgs.length > 2) {
// 从最早的原文轮开始丢（每次丢一轮，最多 2 条）
const dropped = msgs.splice(0, Math.min(2, msgs.length));
used -= dropped.reduce((a, m) => a + tokensOf(m), 0);
}

const apiMessages = [{ role: 'system', content: systemContent}];
for (const m of msgs) apiMessages.push({ role: m.role, content: m.content});
return { apiMessages, usedTokens: used, budget};
}

// 带说话人标签的最近消息（导演决策 / 群聊历史共用）
export function getLabeledHistory(conversationId, limit = 12) {
const db = getDb();
const rows = db
.prepare(
`SELECT m.role, m.content, m.character_id, ch.name AS character_name
 FROM messages m LEFT JOIN characters ch ON ch.id = m.character_id
 WHERE m.conversation_id = ? ORDER BY m.id DESC LIMIT ?`
)
.all(conversationId, limit)
.reverse();
return rows.map((r) => ({
speaker: r.role === 'user' ? '用户' : r.character_name || '某人',
content: r.content,
}));
}

// 群聊上下文：共享历史（带说话人标签）只组装一次；
// 返回 buildFor(character) 按角色拼出完整 apiMessages（各角色 soul/user/检索记忆不同）
// query：本轮用户消息，用于检索相关记忆事实；不传则取本轮最新用户消息
export function buildGroupContext(members, conversationId, query) {
const cfg = getConfig();
const budget = cfg.contextBudget;
const db = getDb();

const summaries = db
.prepare('SELECT summary FROM conversation_summaries WHERE conversation_id = ? ORDER BY id DESC LIMIT 5')
.all(conversationId)
.reverse();
const summaryText = summaries.map((s) => `# 更早对话摘要（按时间从旧到新）\n${s.summary}`).join('\n\n');

const rows = db
.prepare(
`SELECT m.role, m.content, m.character_id, ch.name AS character_name
 FROM messages m LEFT JOIN characters ch ON ch.id = m.character_id
 WHERE m.conversation_id = ? ORDER BY m.id DESC LIMIT 40`
)
.all(conversationId)
.reverse();
const byId = {};
for (const m of members) byId[m.id] = m;
let history = rows.map((r) => ({
role: 'user',
content: `${r.role === 'user' ? '用户' : r.character_name || (byId[r.character_id] && byId[r.character_id].name) || '某人'}：${r.content}`,
}));

// token 预算：历史只裁一次，预留 2000 给各角色 system
const tokensOf = (m) => estimateTokens(m.content) + 4;
let usedHist = history.reduce((a, m) => a + tokensOf(m), 0);
while (usedHist > budget - 2000 && history.length > 2) {
const dropped = history.splice(0, Math.min(2, history.length));
usedHist -= dropped.reduce((a, m) => a + tokensOf(m), 0);
}

const buildFor = (character) => {
const sysParts = [
ANTI_HALLU.replaceAll('{name}', character.name || ''),
`# 你正在一个群聊里。下面是你的角色设定，群聊消息格式为「说话人：内容」。只以${character.name || '你'}的身份发言，不要冒充别人。`,
`# 当前时间\n${nowBeijingStr()}`,
`# 角色设定\n${character.soul_md || ''}`,
`# 关于用户\n${character.user_md || ''}`,
];
const rpGroup = roleplayPromptOf(character);
if (rpGroup) sysParts.push(`# 回复格式要求\n${rpGroup}`);
const gfacts = retrieveFacts(character.id, conversationId, query, 8);
if (gfacts.length) sysParts.push(`# 相关记忆\n${gfacts.map((f) => `- ${f.fact}`).join('\n')}`);
if (summaryText) sysParts.push(summaryText);
const systemContent = sysParts.join('\n\n');
const apiMessages = [{ role: 'system', content: systemContent }];
for (const m of history) apiMessages.push({ role: m.role, content: m.content });
return { apiMessages, usedTokens: estimateTokens(systemContent) + usedHist, budget };
};

return { buildFor, usedTokens: usedHist, budget };
}

// 摘要旧消息：未摘要消息 ≥20 条时，取最早 20 条生成一条摘要
export async function summarizeOld(character, conversationId, opts = {}) {
const db = getDb();
const cfg = getConfig();
const row = db
.prepare('SELECT MAX(message_upto) AS upto FROM conversation_summaries WHERE conversation_id =?')
.get(conversationId);
const upto = row && row.upto? row.upto: 0;
const batch = db
.prepare(
'SELECT id, role, content FROM messages WHERE conversation_id =? AND id >? ORDER BY id ASC LIMIT 20'
)
.all(conversationId, upto);
if (batch.length < 20) return false;
const text = batch.map((m) => `${m.role}: ${m.content}`).join('\n');
const summary = await summarizeText({
text,
model: opts.model || cfg.extractModel,
apiKey: opts.apiKey,
baseUrl: opts.baseUrl,
onUsage: opts.onUsage,
});
if (!summary) return false;
db.prepare(
'INSERT INTO conversation_summaries(conversation_id, summary, message_upto, created_at) VALUES(?,?,?,?)'
).run(conversationId, summary, batch[batch.length - 1].id, new Date().toISOString());
return true;
}

// v1.10：取本轮最新一条用户消息（检索 query 用）
export function lastUserText(conversationId) {
const db = getDb();
const r = db
.prepare(`SELECT content FROM messages WHERE conversation_id = ? AND role = 'user' ORDER BY id DESC LIMIT 1`)
.get(conversationId);
return r ? r.content : '';
}

// FTS5 查询清洗：trigram 分词器会自动切分中英文，只需去掉特殊语法字符
function ftsQuery(text) {
const q = String(text || '')
.replace(/["*:()^~[\]{}]|-(?=\S)/g, ' ')
.replace(/\s+/g, ' ')
.trim()
.slice(0, 200);
return q.length >= 2 ? q : null;
}

// v1.10：按需检索相关记忆事实（替代全文注入）。只返回未被替代的。
// 混合策略：FTS5 trigram（英文/3字以上+bm25排序）+ 中文二字 LIKE 补充（trigram 查不到 2 字词）
export function retrieveFacts(characterId, conversationId, query, limit = 8) {
const db = getDb();
const text = String(query || lastUserText(conversationId) || '').trim();
if (text.length < 2) return [];
const seen = new Set();
const out = [];
const pushRows = (rows) => {
for (const r of rows) {
if (!seen.has(r.id) && out.length < limit) {
seen.add(r.id);
out.push(r);
}
}
};
// 1) FTS5
const q = ftsQuery(text);
if (q) {
try {
pushRows(
db
.prepare(
`SELECT f.id, f.fact, f.importance FROM memory_facts_fts ft
 JOIN memory_facts f ON f.id = ft.rowid
 WHERE ft.fact MATCH ? AND f.character_id = ? AND f.superseded_by IS NULL
 ORDER BY bm25(ft) ASC, f.importance DESC LIMIT ?`
)
.all(q, characterId, limit)
);
} catch {
/* 查询语法问题时降级走 LIKE */
}
}
// 2) 中文二字滑动窗口 LIKE（补 FTS 查不到的短词）
const bigrams = [];
for (let i = 0; i < text.length - 1 && bigrams.length < 12; i++) {
const a = text[i];
const b = text[i + 1];
if (/[\u4e00-\u9fa5]/.test(a) && /[\u4e00-\u9fa5]/.test(b)) {
const bg = a + b;
if (!bigrams.includes(bg)) bigrams.push(bg);
}
}
if (bigrams.length && out.length < limit) {
const conds = bigrams.map(() => 'f.fact LIKE ?').join(' OR ');
pushRows(
db
.prepare(
`SELECT f.id, f.fact, f.importance FROM memory_facts f
 WHERE f.character_id = ? AND f.superseded_by IS NULL AND (${conds})
 ORDER BY f.importance DESC, f.id DESC LIMIT ?`
)
.all(characterId, ...bigrams.map((x) => `%${x}%`), limit)
);
}
return out;
}

// v1.10 统一记忆流水线（事件驱动，替代固定 5 轮全量重写）：
// 意图识别 → soul 修改建议 → 是否值得记 → 条目级提取 → ADD/SUPERSEDE/NOOP 落库
// 返回 { suggestion, factsAdded, userMdChanged }
export async function runMemoryPipeline(character, conversationId, userText, opts = {}) {
const db = getDb();
const cfg = getConfig();
const changes = { suggestion: null, factsAdded: 0, userMdChanged: false };
const prevAsst = db
.prepare(`SELECT content FROM messages WHERE conversation_id = ? AND role = 'assistant' ORDER BY id DESC LIMIT 1`)
.get(conversationId);
const cls = await classifyTurn({
userText,
prevAsstText: prevAsst ? prevAsst.content : '',
model: opts.model || cfg.extractModel,
apiKey: opts.apiKey,
baseUrl: opts.baseUrl,
onUsage: opts.onUsage,
signal: opts.signal,
});
if (!cls) return changes;
// soul 修改意图：写入待确认建议（不自动改 soul）
if (cls.soul_update && cls.soul_update.confidence >= 0.7 && cls.soul_update.proposed) {
const info = db
.prepare(
'INSERT INTO intent_suggestions(character_id, conversation_id, user_id, proposed, status, created_at) VALUES(?,?,?,?,?,?)'
)
.run(character.id, conversationId, opts.userId || null, cls.soul_update.proposed, 'pending', new Date().toISOString());
changes.suggestion = { id: Number(info.lastInsertRowid), proposed: cls.soul_update.proposed };
}
if (!cls.worth) return changes;
// 条目级提取
const rounds = db
.prepare('SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT 20')
.all(conversationId)
.reverse();
if (!rounds.length) return changes;
const existing = retrieveFacts(character.id, conversationId, userText, 20).map((f) => ({ id: f.id, fact: f.fact }));
const ext = await extractFacts({
userMd: character.user_md || '',
existingFacts: existing,
rounds,
model: opts.model || cfg.extractModel,
apiKey: opts.apiKey,
baseUrl: opts.baseUrl,
onUsage: opts.onUsage,
signal: opts.signal,
});
if (!ext) return changes;
const now = new Date().toISOString();
if (ext.user_md && ext.user_md !== (character.user_md || '')) {
db.prepare('UPDATE characters SET user_md = ?, updated_at = ? WHERE id = ?').run(ext.user_md, now, character.id);
db.prepare('INSERT INTO file_versions(character_id, file, content, created_at) VALUES(?,?,?,?)').run(
character.id,
'user',
ext.user_md,
now
);
changes.userMdChanged = true;
character.user_md = ext.user_md;
}
const insFact = db.prepare(
'INSERT INTO memory_facts(character_id, fact, importance, created_at, source) VALUES(?,?,?,?,?)'
);
for (const f of ext.facts || []) {
if (f.op === 'NOOP') continue;
if (f.op === 'SUPERSEDE' && f.supersedes_id) {
const target = db
.prepare('SELECT id FROM memory_facts WHERE id = ? AND character_id = ? AND superseded_by IS NULL')
.get(f.supersedes_id, character.id);
if (target) {
const r = insFact.run(character.id, f.text, f.importance, now, 'chat');
db.prepare('UPDATE memory_facts SET superseded_by = ? WHERE id = ?').run(Number(r.lastInsertRowid), target.id);
changes.factsAdded++;
continue;
}
// supersedes_id 无效 → 降级为 ADD
}
insFact.run(character.id, f.text, f.importance, now, 'chat');
changes.factsAdded++;
}
// v1.12：有实际写入时记一条事件，前端轮询做"记住了"轻提示
if (changes.factsAdded > 0 || changes.userMdChanged) {
db.prepare(
'INSERT INTO memory_events(conversation_id, character_id, created_at, facts_added, user_md_changed) VALUES(?,?,?,?,?)'
).run(conversationId, character.id, now, changes.factsAdded, changes.userMdChanged ? 1 : 0);
}
return changes;
}
