import { getConfig} from './config.js';
import { ProxyAgent } from 'undici';

// 代理支持：Node 的 fetch 默认不走系统代理（如 Clash 的系统代理模式），
// 中国大陆用户如需让 LLM 请求走代理，在 .env 里设置：
//   HTTPS_PROXY=http://127.0.0.1:7890
// （Clash Verge 默认 7890；ClashX/V2RayN 请看各自的 HTTP 端口）
// 不设置则直连，不影响其他用户。
function buildDispatcher() {
const proxyUrl =
process.env.HTTPS_PROXY || process.env.https_proxy ||
process.env.HTTP_PROXY || process.env.http_proxy;
if (!proxyUrl) return undefined;
try {
return new ProxyAgent(proxyUrl);
} catch {
console.warn('[llm] 代理地址无效，已忽略:', proxyUrl);
return undefined;
}
}
// 供 app.js 复用：带代理设置的 fetch（模型列表等透传请求用）
export function llmFetch(url, init) {
return fetch(url, { ...(dispatcher ? { dispatcher } : {}), ...init});
}

const dispatcher = buildDispatcher();
if (dispatcher) console.log('[llm] 已启用 HTTP 代理');

const EXTRACT_SYSTEM = `你是记忆整理助手。根据当前 user.md、memory.md 和最近对话，输出两个文件的全文重写版本。
要求：
1. 只返回 JSON：{"user_md":"...","memory_md":"..."}，不要输出其他任何文字
2. user_md：关于用户的稳定事实（称呼、偏好、重要事项），条列，简洁
3. memory_md：对话中出现的关键事件、约定、偏好变化，每条标注日期（今天是 {today}，格式 YYYY-MM-DD）
4. 去重合并，删除被新事实推翻的旧条目
5. 没有新信息时原样返回`;

// 无可用 Key 时的统一提示（app.js 做上游 401 拦截时复用）
export const NO_KEY_MESSAGE = '未配置 API Key：请在侧边栏底部「API 设置」中填写你的 Key（或由管理员在服务器 .env 中配置 OPENROUTER_API_KEY）';

async function postCompletions({ model, messages, temperature, stream, onToken, apiKey, baseUrl }) {
const cfg = getConfig();
// BYOK：优先用调用方传入的个人 Key（请求头 X-OpenRouter-Key），否则用服务器 .env
const key = (apiKey || '').trim() || cfg.apiKey;
// API 地址：用户自定（请求头 X-Api-Base-Url）> 服务器 .env
const base = (baseUrl || '').trim().replace(/\/+$/, '') || cfg.baseUrl;
if (!key && !cfg.mockLlm) throw new Error(NO_KEY_MESSAGE);
const res = await fetch(`${base}/chat/completions`, {
method: 'POST',
headers: {
Authorization: `Bearer ${key}`,
'Content-Type': 'application/json',
'HTTP-Referer': 'https://soulchat.local',
'X-Title': 'SoulChat MVP',
},
body: JSON.stringify({ model, messages, temperature, stream}),
...(dispatcher ? { dispatcher } : {}),
});
if (!res.ok) {
const text = await res.text().catch(() => '');
throw new Error(`LLM 请求失败 HTTP ${res.status}: ${text.slice(0, 200)}`);
}
return res;
}

// 流式聊天：每收到 delta 就调 onToken，最后返回完整文本
export async function chatStream({ messages, model, temperature, onToken, apiKey, baseUrl }) {
const cfg = getConfig();
if (cfg.mockLlm) return mockChatStream({ messages, onToken});

const res = await postCompletions({ model, messages, temperature, stream: true, onToken, apiKey, baseUrl });
const reader = res.body.getReader();
const decoder = new TextDecoder();
let buf = '';
let full = '';
const handleLine = (line) => {
const t = line.trim();
if (!t.startsWith('data:')) return;
const data = t.slice(5).trim();
if (!data || data === '[DONE]') return;
try {
const json = JSON.parse(data);
const delta = json.choices && json.choices[0] && json.choices[0].delta && json.choices[0].delta.content;
if (delta) {
full += delta;
onToken(delta);
}
} catch {
/* 忽略坏块 */
}
};
for (;;) {
const { done, value} = await reader.read();
if (done) break;
buf += decoder.decode(value, { stream: true});
const lines = buf.split('\n');
buf = lines.pop();
for (const l of lines) handleLine(l);
}
if (buf.trim()) handleLine(buf);
return full;
}

async function mockChatStream({ messages, onToken}) {
const reversed = [...messages].reverse();
const lastUser = reversed.find((m) => m.role === 'user');
const snippet = (lastUser? lastUser.content: '').slice(0, 60);
const full = `收到：${snippet}（mock 回复）`;
for (let i = 0; i < full.length; i += 6) {
onToken(full.slice(i, i + 6));
await new Promise((r) => setTimeout(r, 5));
}
return full;
}

const DIRECTOR_SYSTEM = `你是群聊导演。根据群成员人设和最近对话，决定接下来谁最可能/最应该发言。
只返回 JSON 数组，最多 3 个，按发言顺序排：[{"id":"角色id","why":"一句话理由"}]
规则：
1. 有人提问时，懂的人回；有人讲笑话时，爱起哄的回；冷场时，话多的暖场
2. 除非多人确实都有话说，否则只选 1-2 个，不要每次都让所有人回；都没话说就返回 []
3. 注意轮换：优先让最近没怎么说话的成员发言；除非用户点名或追问某人，避免连续两轮由同一人先发言
4. 只返回 JSON，不要其他文字`;

// 群聊导演：决定发言顺序（角色 id 数组）。失败返回 null，调用方用确定性 fallback
export async function decideSpeakers({ members, history, model, apiKey, baseUrl, lastSpeakerId }) {
const cfg = getConfig();
if (cfg.mockLlm) {
// mock：轮换，避免每次固定
const idx = Math.floor(Math.random() * members.length);
return [members[idx].id, members[(idx + 1) % members.length].id];
}
// 打乱成员顺序，避免大模型的位置偏好导致总选第一个
const shuffled = [...members].sort(() => Math.random() - 0.5);
const memberDesc = shuffled
.map((m) => {
const tag = m.id === lastSpeakerId ? '【上轮由TA先发言，注意轮换】' : '';
return `- ${m.name}（id:${m.id}）${tag}：${String(m.soul_md || '').slice(0, 160).replace(/\n/g, ' ')}`;
})
.join('\n');
const histText = history.map((h) => `${h.speaker}: ${h.content}`).join('\n').slice(-3000);
try {
const res = await postCompletions({
model: model || cfg.extractModel,
temperature: 0.5,
stream: false,
apiKey,
baseUrl,
messages: [
{ role: 'system', content: DIRECTOR_SYSTEM },
{ role: 'user', content: `群成员：\n${memberDesc}\n\n最近对话：\n${histText}\n\n谁接下来发言？` },
],
});
const json = await res.json();
const text = (json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content) || '';
const arr = JSON.parse(stripFences(text));
if (!Array.isArray(arr)) return null;
const validIds = new Set(members.map((m) => m.id));
const ids = arr.map((x) => x && x.id).filter((id) => validIds.has(id)).slice(0, 3);
return ids;
} catch {
return null;
}
}

function stripFences(text) {
return String(text)
.replace(/^```(?:json)?\s*/i, '')
.replace(/\s*```\s*$/, '')
.trim();
}

// 记忆提取：返回 {user_md, memory_md} 全文；失败返回 null
export async function extractJson({ userMd, memoryMd, rounds, model, apiKey, baseUrl }) {
const cfg = getConfig();
const today = new Date().toISOString().slice(0, 10);
if (cfg.mockLlm) {
return {
user_md: `${userMd || ''}\n- [mock 提取] 用户偏好测试 ${today}`,
memory_md: `${memoryMd || ''}\n- [mock 提取] 对话事件测试 ${today}`,
};
}
const roundText = rounds.map((m) => `${m.role}: ${m.content}`).join('\n');
const res = await postCompletions({
model,
temperature: 0.2,
stream: false,
apiKey,
baseUrl,
messages: [
{ role: 'system', content: EXTRACT_SYSTEM.replace('{today}', today)},
{
role: 'user',
content: `\n${userMd || ''}\n\n\n${memoryMd || ''}\n\n\n${roundText}`,
},
],
});
const json = await res.json();
const text = (json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content) || '';
try {
const parsed = JSON.parse(stripFences(text));
if (typeof parsed.user_md === 'string' && typeof parsed.memory_md === 'string') return parsed;
return null;
} catch {
return null;
}
}

// 对话摘要：返回摘要字符串
export async function summarizeText({ text, model, apiKey, baseUrl }) {
const cfg = getConfig();
if (cfg.mockLlm) return '摘要（mock）：' + String(text).slice(0, 40);
const res = await postCompletions({
model,
temperature: 0.3,
stream: false,
apiKey,
baseUrl,
messages: [
{ role: 'system', content: '用 100 字以内中文总结这段对话的关键事实，只输出摘要正文，不要多余文字。'},
{ role: 'user', content: text},
],
});
const json = await res.json();
return (json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content || '').trim();
}
