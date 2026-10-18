import { getConfig} from './config.js';
import { getDefaultProvider } from './registry.js';
import { oneLineDesc } from './memory.js';
import { ProxyAgent } from 'undici';
import { isIP } from 'node:net';
import { thinkingParams, detectProvider } from './providers.js';

// 校验用户自填的 API 地址：仅允许 https 公网地址，防 SSRF（内网探测 / 云元数据）。
// 管理员 .env 中的服务器默认地址不受此限（管理员可信）。
export function assertPublicHttpsUrl(url) {
  const bad = (msg) => {
    const e = new Error(msg);
    e.statusCode = 400;
    throw e;
  };
  let u;
  try {
    u = new URL(String(url || '').trim());
  } catch {
    bad('API 地址格式不正确');
  }
  if (u.protocol !== 'https:') bad('API 地址必须使用 https');
  if (u.username || u.password) bad('API 地址不能携带用户名或密码');
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host || host === 'localhost' || host.endsWith('.localhost')) bad('API 地址不能指向内网地址');
  if (isIP(host)) {
    if (isPrivateIp(host)) bad('API 地址不能指向内网地址');
  } else if (/(^|\.)(internal|intranet|local|lan|corp|home)$/.test(host)) {
    bad('API 地址不能指向内网地址');
  }
  return (u.origin + u.pathname).replace(/\/+$/, '');
}

function isPrivateIp(host) {
  // IPv4 映射的 IPv6（如 ::ffff:127.0.0.1，会被 URL 规范化为 ::ffff:7f00:1）：先还原成 v4 再判断
  if (host.startsWith('::ffff:')) {
    const tail = host.slice('::ffff:'.length);
    const v4 = tail.includes('.') ? tail : mappedHexToV4(tail);
    if (v4) return isPrivateIp(v4);
  }
  // IPv4 私有 / 回环 / 链路本地 / 保留段
  const v4 = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) {
    const [, a, b] = v4.map(Number);
    return (
      a === 10 || a === 127 || a === 0 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) ||
      (a === 100 && b >= 64 && b <= 127) ||
      a >= 224
    );
  }
  // IPv6：回环 / 链路本地 / 唯一本地 / 未指定（hostname 可能带 [] 括号）
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  return (
    h === '::1' || h === '::' ||
    h.startsWith('fe80:') || h.startsWith('fec0:') ||
    h.startsWith('fc') || h.startsWith('fd')
  );
}

// ::ffff:7f00:1 这类 hex 形式还原成点分十进制 IPv4
function mappedHexToV4(tail) {
  const parts = tail.split(':').filter(Boolean);
  if (parts.length < 2) return null;
  const last = parts.slice(-2).map((p) => parseInt(p, 16));
  if (last.some((n) => Number.isNaN(n) || n < 0 || n > 0xffff)) return null;
  const n = (last[0] << 16) | last[1];
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
}

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
const d = getDispatcher();
return fetch(url, { ...(d ? { dispatcher: d } : {}), ...init});
}

// v1.17.3: dispatcher 懒初始化（import 时不再立即构建），测试可调 resetDispatcher() 重建
let _dispatcher = null;
let _dispatcherInit = false;
function getDispatcher() {
if (!_dispatcherInit) {
_dispatcherInit = true;
_dispatcher = buildDispatcher();
if (_dispatcher) console.log('[llm] 已启用 HTTP 代理');
}
return _dispatcher;
}
export function resetDispatcher() {
_dispatcher = null;
_dispatcherInit = false;
}

const EXTRACT_SYSTEM = `你是记忆整理助手。根据当前 user.md、memory.md 和最近对话，输出两个文件的全文重写版本。
要求：
1. 只返回 JSON：{"user_md":"...","memory_md":"..."}，不要输出其他任何文字
2. user_md：关于用户的稳定事实（称呼、偏好、重要事项），条列，简洁
3. memory_md：对话中出现的关键事件、约定、偏好变化，每条标注日期（今天是 {today}，格式 YYYY-MM-DD）
4. 去重合并，删除被新事实推翻的旧条目
5. 没有新信息时原样返回`;

// 无可用 Key 时的统一提示（app.js 做上游 401 拦截时复用）
export const NO_KEY_MESSAGE = '未配置 API Key：请在侧边栏底部「API 设置」中填写你的 Key（或由管理员在「设置 → 模型管理」中配置供应商）';

async function postCompletions({ model, messages, temperature, stream, onToken, apiKey, baseUrl, signal, provider, maxTokens }) {
const cfg = getConfig();
// v0.2.0: 平台默认 key/address 改读统一注册表（默认供应商）；env 做最终保底（老部署不断）
// 优先级：调用方个人 Key（BYOK）> 默认供应商 > 服务器 .env
let platformKey = cfg.apiKey, platformBase = cfg.baseUrl;
try {
  const dp = getDefaultProvider();
  if (dp) {
    if (dp.apiKey) platformKey = dp.apiKey;
    if (dp.baseUrl) platformBase = dp.baseUrl;
  }
} catch {}
const key = (apiKey || '').trim() || platformKey;
const base = (baseUrl || '').trim().replace(/\/+$/, '') || platformBase;
if (!key && !cfg.mockLlm) throw new Error(NO_KEY_MESSAGE);
// 上游请求最多 120s；调用方传了 signal（客户端断开）时一起联动取消
const timeoutSignal = AbortSignal.timeout(120000);
const combined = signal ? AbortSignal.any([timeoutSignal, signal]) : timeoutSignal;
const res = await fetch(`${base}/chat/completions`, {
signal: combined,
method: 'POST',
headers: {
Authorization: `Bearer ${key}`,
'Content-Type': 'application/json',
'HTTP-Referer': 'https://soulchat.local',
'X-Title': 'Fashion Studio',
},
body: JSON.stringify({
  model,
  messages,
  temperature,
  stream,
  // v1.20.0: 按提供商发对应的关思考参数（providers.js）；custom 回退保留 qwen 猜测
  ...thinkingParams(provider, model),
  // v1.20.0: 连通性测试用（max_tokens: 1，最小开销）
  ...(maxTokens ? { max_tokens: maxTokens } : {}),
  // 流式时让 OpenRouter 在最后一个 chunk 返回真实用量（计费用）
  ...(stream ? { stream_options: { include_usage: true } } : {}),
}),
...(getDispatcher() ? { dispatcher: getDispatcher() } : {}),
});
if (!res.ok) {
const text = await res.text().catch(() => '');
const err = new Error(`LLM 请求失败 HTTP ${res.status}: ${text.slice(0, 200)}`);
err.status = res.status;
err.model = model; // v1.19.2: 404 时带上模型 ID，方便排查是哪个 ID 写错了
throw err;
}
return res;
}

// v1.17.2: 上游错误转用户友好文案，不把原始 JSON 甩给用户看
export function friendlyLlmError(e) {
const status = e && (e.status || e.statusCode);
if (status === 429) return '上游限流了，休息几秒再试一次';
if (status === 402) return '积分不足，请充值或切换模型';
if (status === 401 || status === 403) return 'API 授权失败，请检查 Key 配置';
if (status === 404) {
  const m = e && e.model ? `（${e.model}）` : '';
  return `模型${m}不存在或已下架，检查 API 设置里的模型 ID 是否正确`;
}
if (status >= 500) return '上游服务暂时不可用，稍后再试';
return '生成失败，换句话试试';
}
// v1.17.2: 429 自动重试（指数退避），瞬时限流对用户透明
export async function withRetry(fn, { retries = 2, baseMs = 2000 } = {}) {
let last;
for (let i = 0; i <= retries; i++) {
try {
return await fn();
} catch (e) {
last = e;
const status = e && (e.status || e.statusCode);
if (status === 429 && i < retries) {
await new Promise((r) => setTimeout(r, baseMs * (i + 1)));
continue;
}
throw e;
}
}
throw last;
}

// 非流式调用的便捷封装：返回 { json, usage }（usage 可能为 null）
export async function postJson(opts) {
const res = await postCompletions({ ...opts, stream: false });
const json = await res.json().catch(() => null);
const usage = json && json.usage
? { input: json.usage.prompt_tokens || 0, output: json.usage.completion_tokens || 0 }
: null;
if (opts.onUsage && usage) {
try { opts.onUsage(usage); } catch { /* 计费回调异常不影响主流程 */ }
}
return { json, usage };
}

// v1.18.0: AI 生成对话标题（首轮结束后调用，走最便宜的 worker 模型；不计费，系统开销）
export async function genTitle({ userText, asstText, model, apiKey, baseUrl, provider, signal }) {
const cfg = getConfig();
if (cfg.mockLlm) return '';
const { json } = await postJson({
model,
temperature: 0.3,
apiKey,
baseUrl,
provider,
signal,
// onUsage 不传：标题生成不向用户计费
messages: [
{ role: 'system', content: '你是一个对话标题生成器。根据用户和AI的首轮对话，生成一个10字以内的中文标题，只输出标题本身，不要引号、不要标点、不要解释。' },
{ role: 'user', content: `用户：${String(userText || '').slice(0, 300)}\nAI：${String(asstText || '').slice(0, 300)}` },
],
});
const ch = json && json.choices && json.choices[0] && json.choices[0].message;
const t = String((ch && (ch.content || '')) || '').trim().replace(/^["「『【\s]+|["」』】\s]+$/g, '');
return t.slice(0, 14);
}

// 流式聊天：每收到 delta 就调 onToken；返回 { text, usage }（usage 为真实用量，可能为 null）
export async function chatStream({ messages, model, temperature, onToken, apiKey, baseUrl, provider, signal }) {
const cfg = getConfig();
if (cfg.mockLlm) return { text: await mockChatStream({ messages, onToken }), usage: null };

const res = await postCompletions({ model, messages, temperature, stream: true, onToken, apiKey, baseUrl, provider, signal });
const reader = res.body.getReader();
const decoder = new TextDecoder();
let buf = '';
let full = '';
let usage = null;
// v1.17.1: 捕获 finish_reason，识别上游内容过滤（content_filter）导致的半截输出
let finishReason = null;
// v1.25.6: 流停滞标记——上游 25s 无数据时置 true，调用方按截断处理
let stalled = false;
const handleLine = (line) => {
const t = line.trim();
if (!t.startsWith('data:')) return;
const data = t.slice(5).trim();
if (!data || data === '[DONE]') return;
try {
const json = JSON.parse(data);
// OpenRouter 在最后一个 chunk 返回用量（需 stream_options.include_usage）
if (json.usage) {
usage = {
input: json.usage.prompt_tokens || 0,
output: json.usage.completion_tokens || 0,
};
}
const choice = json.choices && json.choices[0];
if (choice && choice.finish_reason) finishReason = choice.finish_reason;
const delta = choice && choice.delta && choice.delta.content;
if (delta) {
full += delta;
onToken(delta);
}
} catch {
/* 忽略坏块 */
}
};
for (;;) {
if (signal && signal.aborted) { reader.cancel().catch(() => {}); break; }
// v1.25.6: 流停滞检测——25 秒收不到任何数据则主动断开，避免上游假死导致前后端一起卡住
// （根因：此前只有 120s 整请求超时，卡住时用户要盯着冻住的半截文本等 2 分钟）
let readResult;
try {
  readResult = await Promise.race([
    reader.read(),
    new Promise((_, reject) => setTimeout(() => reject(new Error('STREAM_STALLED')), 25000)),
  ]);
} catch (e) {
  if (e && e.message === 'STREAM_STALLED') {
    reader.cancel().catch(() => {});
    stalled = true;
    break;
  }
  throw e;
}
const { done, value } = readResult;
if (done) break;
buf += decoder.decode(value, { stream: true});
const lines = buf.split('\n');
buf = lines.pop();
for (const l of lines) handleLine(l);
}
if (buf.trim()) handleLine(buf);
return { text: full, usage, finishReason, stalled };
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
export async function decideSpeakers({ members, history, model, apiKey, baseUrl, provider, lastSpeakerId, onUsage, signal }) {
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
return `- ${m.name}（id:${m.id}）${tag}：${oneLineDesc(m.soul_md) || '（暂无介绍）'}`;
})
.join('\n');
const histText = history.map((h) => `${h.speaker}: ${h.content}`).join('\n').slice(-3000);
try {
const { json } = await postJson({
model: model || cfg.extractModel,
temperature: 0.5,
apiKey,
baseUrl,
provider,
signal,
onUsage,
messages: [
{ role: 'system', content: DIRECTOR_SYSTEM },
{ role: 'user', content: `群成员：\n${memberDesc}\n\n最近对话：\n${histText}\n\n谁接下来发言？` },
],
});
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

export function stripFences(text) {
return String(text)
.replace(/^```(?:json)?\s*/i, '')
.replace(/\s*```\s*$/, '')
.trim();
}

// v1.10 意图识别 + 是否值得记忆：单次轻量调用
// 返回 { soul_update: {proposed, confidence} | null, worth: bool }；失败返回 null
const CLASSIFY_SYSTEM = `你是意图识别助手。只看用户的最新一句话，判断两件事：
1. soul_update：用户是否想修改角色的设定/人设（性格、外貌、背景、说话方式、喜好、能力等）。是则给出整理后的一句话设定描述 proposed 和置信度 confidence(0-1)。
   注意区分：用户让角色"记住某件事"（如"我明天要开会"）是记事实，不是改设定 → soul_update 为 null。
2. worth：这句话及上下文是否有值得长期记住的新信息（关于用户的稳定事实、重要事件、约定、偏好变化）。闲聊、打招呼、重复已有信息 → false。
只返回 JSON：{"soul_update": {"proposed": "...", "confidence": 0.85} 或 null, "worth": true/false}，不要输出其他文字。`;
export async function classifyTurn({ userText, prevAsstText, model, apiKey, baseUrl, provider, onUsage, signal }) {
const cfg = getConfig();
if (cfg.mockLlm) {
const t = String(userText || '');
const m = t.match(/设定[：:]\s*(.+)|让她(.+)|记住设定[：:]\s*(.+)/);
if (m) return { soul_update: { proposed: (m[1] || m[2] || m[3] || '').trim(), confidence: 0.9 }, worth: true };
if (/记住|别忘/.test(t)) return { soul_update: null, worth: true };
return { soul_update: null, worth: false };
}
const { json } = await postJson({
model,
temperature: 0.1,
apiKey,
baseUrl,
provider,
signal,
onUsage,
messages: [
{ role: 'system', content: CLASSIFY_SYSTEM },
{ role: 'user', content: `上一句AI：${String(prevAsstText || '').slice(0, 300)}\n用户最新：${String(userText || '').slice(0, 500)}` },
],
});
const text = (json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content) || '';
try {
const parsed = JSON.parse(stripFences(text));
if (typeof parsed.worth !== 'boolean') return null;
let su = null;
if (parsed.soul_update && typeof parsed.soul_update.proposed === 'string' && parsed.soul_update.proposed.trim()) {
su = { proposed: parsed.soul_update.proposed.trim().slice(0, 200), confidence: Number(parsed.soul_update.confidence) || 0 };
}
return { soul_update: su, worth: parsed.worth };
} catch {
return null;
}
}

// v1.10 条目级记忆提取：返回 { user_md: 全文或null(无变化), facts: [{op, text, importance, supersedes_id}] }
// existingFacts: [{id, fact}] 已有相关事实，供 LLM 做 ADD/SUPERSEDE/NOOP 判断
export const FACTS_SYSTEM = `你是记忆整理助手。根据当前 user_md、已有相关记忆事实和最近对话，输出 JSON。
只返回 JSON：{"user_md": "全文（无变化则为 null）", "facts": [{"op": "ADD/SUPERSEDE/NOOP", "text": "事实描述", "importance": 1-5, "supersedes_id": 数字或null}]}，不要输出其他文字。
要求：
1. user_md：关于用户的长期稳定画像（称呼、身份、长期偏好、特点），条列简洁，不带时间；无新信息时返回 null，不要重写。
2. facts：本轮新出现的具体事件、约定或变化，每条一句话，带日期时间（现在是 {now}，格式如 10月5日 19:30）。
3. 互斥：同一条信息只记录在一处。长期画像只进 user_md，具体事件只进 facts；已在 user_md 里的画像不要再写成 facts，避免两边重复。
4. 对照已有事实去重：语义重复 → NOOP；新事实推翻旧事实 → SUPERSEDE 并给出 supersedes_id（旧事实 id）；否则 ADD。
5. 没有值得记的新事实时 facts 为空数组。`;
export async function extractFacts({ userMd, existingFacts, rounds, model, apiKey, baseUrl, provider, onUsage, signal }) {
const cfg = getConfig();
const today = new Date().toISOString().slice(0, 10);
// 北京时间 "10月5日 19:30" 格式，供 prompt 里的时间标注
const nowStr = new Intl.DateTimeFormat('zh-CN', {
timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric',
hour: '2-digit', minute: '2-digit', hour12: false,
}).format(new Date()).replace(/\//g, '月').replace(' ', '日 ') + '';
if (cfg.mockLlm) {
const hasDup = (existingFacts || []).length > 0;
return {
user_md: `${userMd || ''}\n- [mock] 用户偏好 ${today}`,
facts: hasDup
? [{ op: 'NOOP', text: (existingFacts[0] && existingFacts[0].fact) || '', importance: 3, supersedes_id: null }]
: [{ op: 'ADD', text: `[mock] 对话事实 ${today}`, importance: 3, supersedes_id: null }],
};
}
const roundText = rounds.map((m) => `${m.role}: ${m.content}`).join('\n');
const existText = (existingFacts || []).map((f) => `[id:${f.id}] ${f.fact}`).join('\n') || '（无）';
const { json } = await postJson({
model,
temperature: 0.2,
apiKey,
baseUrl,
provider,
signal,
onUsage,
messages: [
{ role: 'system', content: FACTS_SYSTEM.replace('{now}', nowStr) },
{ role: 'user', content: `当前 user_md：\n${userMd || ''}\n\n已有相关记忆事实：\n${existText}\n\n最近对话：\n${roundText}` },
],
});
const text = (json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content) || '';
try {
const parsed = JSON.parse(stripFences(text));
if (!Array.isArray(parsed.facts)) return null;
const facts = parsed.facts
.filter((f) => f && typeof f.text === 'string' && f.text.trim())
.slice(0, 10)
.map((f) => ({
op: ['ADD', 'SUPERSEDE', 'NOOP'].includes(f.op) ? f.op : 'ADD',
text: f.text.trim().slice(0, 300),
importance: Math.min(5, Math.max(1, parseInt(f.importance, 10) || 3)),
supersedes_id: f.supersedes_id != null ? parseInt(f.supersedes_id, 10) : null,
}));
const user_md = typeof parsed.user_md === 'string' && parsed.user_md.trim() ? parsed.user_md.trim().slice(0, 4000) : null;
return { user_md, facts };
} catch {
return null;
}
}

// 记忆提取：返回 {user_md, memory_md} 全文；失败返回 null
export async function extractJson({ userMd, memoryMd, rounds, model, apiKey, baseUrl, provider, onUsage, signal }) {
const cfg = getConfig();
const today = new Date().toISOString().slice(0, 10);
if (cfg.mockLlm) {
return {
user_md: `${userMd || ''}\n- [mock 提取] 用户偏好测试 ${today}`,
memory_md: `${memoryMd || ''}\n- [mock 提取] 对话事件测试 ${today}`,
};
}
const roundText = rounds.map((m) => `${m.role}: ${m.content}`).join('\n');
const { json } = await postJson({
model,
temperature: 0.2,
apiKey,
baseUrl,
provider,
signal,
onUsage,
messages: [
{ role: 'system', content: EXTRACT_SYSTEM.replace('{today}', today)},
{
role: 'user',
content: `\n${userMd || ''}\n\n\n${memoryMd || ''}\n\n\n${roundText}`,
},
],
});
const text = (json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content) || '';
try {
const parsed = JSON.parse(stripFences(text));
if (typeof parsed.user_md === 'string' && typeof parsed.memory_md === 'string') return parsed;
return null;
} catch {
return null;
}
}

// v0.1.0: 多模态（图+文）调用——款式 DNA 提取用。复用 postCompletions 的 provider 协议处理。
export async function llmVision({ model, imageBase64, mimeType, prompt, temperature, apiKey, baseUrl, provider, onUsage, signal, maxTokens }) {
const mime = mimeType || 'image/jpeg';
const { json } = await postJson({
model,
temperature: temperature == null ? 0.2 : temperature,
apiKey,
baseUrl,
provider,
signal,
onUsage,
maxTokens,
messages: [
{
role: 'user',
content: [
{ type: 'text', text: prompt },
{ type: 'image_url', image_url: { url: 'data:' + mime + ';base64,' + imageBase64 } },
],
},
],
});
return json;
}

const DNA_SYSTEM = `你是服装款式分析师。仔细看图，提取款式 DNA，只返回 JSON，不要输出其他任何文字。
每个字段都是 {"value": 识别值, "confidence": 0~1 置信度}；看不清/不确定的字段 value 填 null 并给低置信度；面料成分看不出来时 fabric 只填大类。
Schema（value 建议值）：
{"category":{"value":"evening_dress|mens_suit|...","confidence":0},"silhouette":{"value":"mermaid|A_line|slim|...","confidence":0},"collar":{"value":"sweetheart|...","confidence":0},"sleeve":{"value":"spaghetti_strap|...","confidence":0},"skirt":{"value":"floor_length|...","confidence":0},"fabric":{"value":"satin|chiffon|...","confidence":0},"primary_color":{"value":"颜色名","confidence":0},"secondary_color":{"value":"颜色名或null","confidence":0},"style":{"value":"minimalist|...","confidence":0},"details":{"value":["beading",...],"confidence":0},"scene":{"value":"white_bg|street_snap|...","confidence":0}}`;

// v0.1.0: 趋势图 → 款式 DNA JSON（含置信度）；失败返回 null（调用方标人工填写）
export async function extractDna({ imageBase64, mimeType, model, apiKey, baseUrl, provider, onUsage, signal }) {
const cfg = getConfig();
if (cfg.mockLlm) {
return { category: { value: 'evening_dress', confidence: 0.99 }, silhouette: { value: 'mermaid', confidence: 0.9 }, collar: { value: null, confidence: 0.3 }, sleeve: { value: 'spaghetti_strap', confidence: 0.85 }, skirt: { value: 'floor_length', confidence: 0.9 }, fabric: { value: 'satin', confidence: 0.6 }, primary_color: { value: 'champagne', confidence: 0.88 }, secondary_color: { value: null, confidence: 0.5 }, style: { value: 'minimalist', confidence: 0.7 }, details: { value: [], confidence: 0.5 }, scene: { value: 'street_snap', confidence: 0.8 } };
}
const json = await llmVision({
model,
imageBase64,
mimeType,
prompt: DNA_SYSTEM,
apiKey,
baseUrl,
provider,
onUsage,
signal,
});
const ch = json && json.choices && json.choices[0] && json.choices[0].message;
const text = (ch && ch.content) || '';
try {
const parsed = JSON.parse(stripFences(text));
if (parsed && typeof parsed === 'object' && parsed.category) return parsed;
return null;
} catch {
return null;
}
}

// 对话摘要：返回摘要字符串
export async function summarizeText({ text, model, apiKey, baseUrl, provider, onUsage, signal }) {
const cfg = getConfig();
if (cfg.mockLlm) return '摘要（mock）：' + String(text).slice(0, 40);
const { json } = await postJson({
model,
temperature: 0.3,
apiKey,
baseUrl,
provider,
signal,
onUsage,
messages: [
{ role: 'system', content: '用 100 字以内中文总结这段对话的关键事实，只输出摘要正文，不要多余文字。'},
{ role: 'user', content: text},
],
});
return (json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content || '').trim();
}

// AI 生成角色卡：返回 { card, usage }；mock 模式返回固定示例卡
// v1.16.0: 只生成 soul_md（新建角色弹窗的 AI 生成灵魂用，比整卡生成省 token）
export async function generateSoulMd({ desc, model, apiKey, baseUrl, provider, signal }) {
  const cfg = getConfig();
  if (cfg.mockLlm) {
    return {
      soul_md:
        '## 身份\n' + desc + '\n## 性格\n温柔耐心，善解人意。\n## 说话风格\n自然亲切，句子简短。\n## 关系\n初次见面，保持友好，慢慢熟悉。',
      usage: null,
    };
  }
  const messages = [
    {
      role: 'system',
      content:
        '你是角色设定助手。根据用户的一句话描述，生成一段角色"灵魂设定"（soul_md），用 markdown 写，包含 ## 身份 / ## 性格 / ## 说话风格 / ## 关系 四个小节，每节 2-4 条，简洁具体，只输出设定正文。',
    },
    { role: 'user', content: desc },
  ];
  const { json, usage } = await postJson({ model, temperature: 0.9, apiKey, baseUrl, provider, signal, messages });
  const text =
    (json && json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content) || '';
  const soul = String(text).trim();
  if (!soul) throw new Error('生成结果为空');
  return { soul_md: soul, usage };
}

export async function generateCardJson({ desc, model, apiKey, baseUrl, provider, signal }) {
  const cfg = getConfig();
  if (cfg.mockLlm) {
    const { parseGeneratedCard } = await import('./characterCards.js');
    const mock = {
      name: '测试猫娘',
      avatar: '🐱',
      tagline: '傲娇猫耳少女，深夜陪聊',
      category: 'anime',
      tags: ['猫耳', '傲娇'],
      description: '一只住在旧书店阁楼的猫耳少女，白天睡觉，晚上出来陪你聊天。',
      greeting: '（深夜，你推开旧书店的门，阁楼上传来一声慵懒的猫叫）喵……都这个点了还不睡？算了，反正我也睡不着，陪你说会儿话吧。先说好，不许摸耳朵！',
      soul_md: '## 身份\n旧书店阁楼的猫耳少女，白天睡觉晚上活动。\n## 性格\n傲娇，嘴硬心软，喜欢被夸但不承认。\n## 说话风格\n慵懒，带点猫叫口癖，句子短。\n## 关系\n初次见面，保持距离，慢慢升温。',
      example_dialogues: [
        { user: '你好呀', assistant: '喵……你好。都这么晚了，找我有什么事？' },
        { user: '睡不着', assistant: '哼，我就知道。那坐下吧，我给你讲个阁楼上的故事。' },
      ],
    };
    return { card: parseGeneratedCard(JSON.stringify(mock)), usage: null };
  }
  const { buildGenerateMessages, parseGeneratedCard } = await import('./characterCards.js');
  const messages = buildGenerateMessages(desc);
  let lastErr = null;
  // 解析失败自动重试一次（换 temperature），成功才计费
  for (const temperature of [0.9, 0.7]) {
    const { json, usage } = await postJson({ model, temperature, apiKey, baseUrl, provider, signal, messages });
    const text =
      (json && json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content) || '';
    try {
      return { card: parseGeneratedCard(text), usage };
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(`角色卡生成失败：${(lastErr && lastErr.message) || '未知错误'}`);
}

// v1.24.0: 轻量提及检测——整轮结束后查最后一个发言者的输出是否裸名提及他人（没用@的情况）
// 返回被提及的成员 id 数组；mock/失败返回 []
export async function detectMentions({ text, members, excludeIds, model, apiKey, baseUrl, provider, onUsage, signal }) {
  const cfg = getConfig();
  if (cfg.mockLlm) return [];
  const t = String(text || '').trim();
  if (!t) return [];
  const ex = new Set(excludeIds || []);
  const candidates = (members || []).filter((m) => m && m.id && m.name && !ex.has(m.id));
  if (!candidates.length) return [];
  const names = candidates.map((m) => m.name).join('、');
  try {
    const { json } = await postJson({
      model: model || cfg.extractModel,
      temperature: 0.2,
      apiKey,
      baseUrl,
      provider,
      signal,
      onUsage,
      messages: [
        {
          role: 'system',
          content:
            '你是提及检测助手。判断下面这段群聊发言是否在点名、喊话或回应某位成员（即使没用@符号，直接叫名字也算）。只返回被提及成员的名字，多个用逗号分隔；如果没有提及任何人，返回空。不要输出其他文字。',
        },
        { role: 'user', content: `成员：${names}\n\n发言：${t.slice(0, 1000)}` },
      ],
    });
    const out = String(
      (json && json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content) || ''
    ).trim();
    if (!out) return [];
    return candidates.filter((m) => out.includes(m.name)).map((m) => m.id);
  } catch {
    return [];
  }
}
