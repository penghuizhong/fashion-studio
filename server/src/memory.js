import { getConfig} from './config.js';
import { getDb} from './db.js';
import { extractJson, summarizeText} from './llm.js';

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

由 AI 每 5 轮对话自动整理更新，也可以手动编辑。 -->
`;

export const DEFAULT_MEMORY_MD = `<!-- 记忆：记录对话中的关键事件、约定和偏好变化。
格式：每条一行，标注日期，例如：
- 2026-10-03：用户说喜欢仙侠小说
- 2026-10-03：约定周末一起看电影

由 AI 每 5 轮对话自动整理更新，也可以手动编辑。 -->
`;

// 防幻觉系统指令，{name} 会被替换为角色名
export const ANTI_HALLU = `你是 {name}。回答时只依据以及本次对话中的事实。
规则：
1. 不确定的事情主动向用户提问确认，绝不编造人物、事件、时间、数字等细节。
2. 与本次对话出现冲突时，以中的最新记录为准；若冲突明显，主动向用户指出并确认。
3. 严格保持角色的身份、性格与说话风格，不得随意偏离。
`;

// 组装发给 LLM 的 messages：系统块（含角色名）→ 摘要 → 最近 20 轮原文
// 超预算时优先从最早的原文轮开始丢，摘要与三文件保留
export function buildContext(character, conversationId) {
const cfg = getConfig();
const budget = cfg.contextBudget;
const db = getDb();

const sysParts = [
ANTI_HALLU.replaceAll('{name}', character.name || ''),
`# 角色设定\n${character.soul_md || ''}`,
`# 关于用户\n${character.user_md || ''}`,
`# 记忆\n${character.memory_md || ''}`,
];
const summaries = db
.prepare('SELECT summary FROM conversation_summaries WHERE conversation_id =? ORDER BY id ASC')
.all(conversationId);
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
// 返回 buildFor(character) 按角色拼出完整 apiMessages（各角色 soul/user/memory 不同）
export function buildGroupContext(members, conversationId) {
const cfg = getConfig();
const budget = cfg.contextBudget;
const db = getDb();

const summaries = db
.prepare('SELECT summary FROM conversation_summaries WHERE conversation_id = ? ORDER BY id ASC')
.all(conversationId);
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
`# 角色设定\n${character.soul_md || ''}`,
`# 关于用户\n${character.user_md || ''}`,
`# 记忆\n${character.memory_md || ''}`,
];
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
});
if (!summary) return false;
db.prepare(
'INSERT INTO conversation_summaries(conversation_id, summary, message_upto, created_at) VALUES(?,?,?,?)'
).run(conversationId, summary, batch[batch.length - 1].id, new Date().toISOString());
return true;
}

// 记忆提取：最近 10 轮 → extractJson → 更新 user_md/memory_md + 写版本
export async function extractMemory(character, conversationId, opts = {}) {
const db = getDb();
const cfg = getConfig();
const rounds = db
.prepare('SELECT role, content FROM messages WHERE conversation_id =? ORDER BY id DESC LIMIT 20')
.all(conversationId)
.reverse();
if (!rounds.length) return [];
const result = await extractJson({
userMd: character.user_md || '',
memoryMd: character.memory_md || '',
rounds,
model: opts.model || cfg.extractModel,
apiKey: opts.apiKey,
baseUrl: opts.baseUrl,
});
if (!result) return [];
const changed = [];
const now = new Date().toISOString();
if (typeof result.user_md === 'string' && result.user_md!== (character.user_md || '')) {
db.prepare('UPDATE characters SET user_md =?, updated_at =? WHERE id =?').run(
result.user_md,
now,
character.id
);
db.prepare('INSERT INTO file_versions(character_id, file, content, created_at) VALUES(?,?,?,?)').run(
character.id,
'user',
result.user_md,
now
);
changed.push('user');
}
if (typeof result.memory_md === 'string' && result.memory_md!== (character.memory_md || '')) {
db.prepare('UPDATE characters SET memory_md =?, updated_at =? WHERE id =?').run(
result.memory_md,
now,
character.id
);
db.prepare('INSERT INTO file_versions(character_id, file, content, created_at) VALUES(?,?,?,?)').run(
character.id,
'memory',
result.memory_md,
now
);
changed.push('memory');
}
return changed;
}
