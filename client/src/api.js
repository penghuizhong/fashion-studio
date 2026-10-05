// SoulChat 前端 API 层：全部走相对路径 /api（开发走 vite proxy，生产由后端同源托管）
// 用户级 API 配置（API 地址 / Key / 聊天模型 / 后台模型）：
// - 单用户模式：只存本浏览器 localStorage，每次请求经请求头透传
//   （X-Api-Base-Url / X-OpenRouter-Key / X-Chat-Model / X-Worker-Model），后端不存储、不记日志。
// - 多用户模式：配置存服务器（key 加密，随账号走，换设备不丢）；前端不发任何配置头，
//   会话 cookie 即身份。「拉取模型」预览时可显式传本次输入的 key/地址（不存储）。

const API_BASE_URL_KEY = 'soulchat-api-base-url';
const API_KEY_KEY = 'soulchat-openrouter-key';
const API_MODEL_KEY = 'soulchat-chat-model';
const API_WORKER_MODEL_KEY = 'soulchat-worker-model';

export const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';

// 多用户模式：后端靠 HttpOnly cookie 会话识别用户，X-OpenRouter-Key 头会被忽略，
// 因此多用户模式下不再发送该头。由 AuthProvider 在 /api/config 返回后设置。
let multiUserMode = false;
export function setMultiUserMode(v) {
  multiUserMode = !!v;
}
export function isMultiUserMode() {
  return multiUserMode;
}

export function getApiConfig() {
  try {
    return {
      baseUrl: (localStorage.getItem(API_BASE_URL_KEY) || '').trim(),
      key: (localStorage.getItem(API_KEY_KEY) || '').trim(),
      model: (localStorage.getItem(API_MODEL_KEY) || '').trim(),
      workerModel: (localStorage.getItem(API_WORKER_MODEL_KEY) || '').trim(),
    };
  } catch {
    return { baseUrl: '', key: '', model: '', workerModel: '' };
  }
}

export function setApiConfig({ baseUrl, key, model, workerModel }) {
  try {
    if (baseUrl) localStorage.setItem(API_BASE_URL_KEY, baseUrl);
    else localStorage.removeItem(API_BASE_URL_KEY);
    if (key) localStorage.setItem(API_KEY_KEY, key);
    else localStorage.removeItem(API_KEY_KEY);
    if (model) localStorage.setItem(API_MODEL_KEY, model);
    else localStorage.removeItem(API_MODEL_KEY);
    if (workerModel) localStorage.setItem(API_WORKER_MODEL_KEY, workerModel);
    else localStorage.removeItem(API_WORKER_MODEL_KEY);
  } catch {
    /* 忽略存储失败 */
  }
  window.dispatchEvent(new CustomEvent('soulchat-api-changed'));
}

export function clearApiConfig() {
  setApiConfig({ baseUrl: '', key: '', model: '', workerModel: '' });
}

function authHeaders() {
  // 多用户模式：配置以服务器上该用户保存的为准（会话即身份），前端不透传任何配置头，
  // 避免本浏览器 localStorage 里的陈旧值悄悄覆盖服务器配置（"保存了但没生效"）。
  // 单用户模式：走 localStorage + 请求头透传（原有行为）。
  if (isMultiUserMode()) return {};
  const h = {};
  const { baseUrl, key, model, workerModel } = getApiConfig();
  if (key) h['X-OpenRouter-Key'] = key;
  if (baseUrl) h['X-Api-Base-Url'] = baseUrl;
  if (model) h['X-Chat-Model'] = model;
  if (workerModel) h['X-Worker-Model'] = workerModel;
  return h;
}

// 用给定的 key / 地址动态拉取可用模型列表（OpenAI 兼容的 /models 接口）
// 多用户模式下 key 可留空：不发 key 头，后端用该用户服务器端保存的 key。
export async function fetchModels(baseUrl, key) {
  const headers = {};
  if (key) headers['X-OpenRouter-Key'] = key;
  if (baseUrl) headers['X-Api-Base-Url'] = baseUrl;
  const res = await fetch('/api/models', { headers, credentials: 'same-origin' });
  if (!res.ok) {
    let msg = `拉取失败 (${res.status})`;
    try {
      const data = await res.json();
      if (data && data.error) msg = data.error;
    } catch {
      /* 忽略 */
    }
    throw new Error(msg);
  }
  const data = await res.json();
  return Array.isArray(data.models) ? data.models : [];
}

async function request(method, path, body) {
  const opts = { method, headers: authHeaders(), credentials: 'same-origin' };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(path, opts);
  if (!res.ok) {
    let msg = `请求失败 (${res.status})`;
    try {
      const data = await res.json();
      if (data && data.message) msg = data.message;
      else if (data && data.error) msg = data.error;
    } catch {
      /* 忽略解析错误 */
    }
    throw new Error(msg);
  }
  if (res.status === 204) return null;
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

const get = (path) => request('GET', path);
const post = (path, body) => request('POST', path, body);
const put = (path, body) => request('PUT', path, body);
const del = (path) => request('DELETE', path);

// 密码重置（无需登录）
const resetPassword = (data) => post('/api/auth/reset-password', data);
// 查看 / 重生自己的密码重置码（需登录）
const getRecoveryCode = () => get('/api/auth/recovery-code');
const regenerateRecoveryCode = () => post('/api/auth/recovery-code/regenerate');

/**
 * 发送聊天消息（SSE，fetch + reader 手工解析）。
 * onEvent(event, data)：event ∈ context | token | memory_updated | done | error
 * SSE 块格式：按 \n\n 分块，首行 `event: X`，次行 `data: {...单行JSON...}`
 */
export async function sendMessage(conversationId, content, onEvent, signal) {
  const res = await fetch(`/api/conversations/${conversationId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    credentials: 'same-origin',
    body: JSON.stringify({ content }),
    signal,
  });
  if (!res.ok) {
    let msg = `发送失败 (${res.status})`;
    try {
      const data = await res.json();
      if (data && data.message) msg = data.message;
      else if (data && data.error) msg = data.error;
    } catch {
      /* 忽略 */
    }
    throw new Error(msg);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const lines = block.split('\n');
      const evLine = lines.find((l) => l.startsWith('event:'));
      const dataLine = lines.find((l) => l.startsWith('data:'));
      if (!evLine || !dataLine) continue;
      const ev = evLine.slice('event:'.length).trim();
      let data = null;
      try {
        data = JSON.parse(dataLine.slice('data:'.length).trim());
      } catch {
        continue;
      }
      onEvent(ev, data);
    }
  }
}

export function formatTime(ts) {
  if (!ts) return '';
  const d = new Date(String(ts).replace(' ', 'T'));
  if (Number.isNaN(d.getTime())) return String(ts);
  return d.toLocaleString('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function formatFullTime(ts) {
  if (!ts) return '';
  const d = new Date(String(ts).replace(' ', 'T'));
  if (Number.isNaN(d.getTime())) return String(ts);
  return d.toLocaleString('zh-CN');
}

export const api = {
  getConfig: () => get('/api/config'),

  listCharacters: () => get('/api/characters'),
  createCharacter: (data) => post('/api/characters', data),
  getCharacter: (id) => get(`/api/characters/${id}`),
  updateCharacter: (id, data) => put(`/api/characters/${id}`, data),
  deleteCharacter: (id) => del(`/api/characters/${id}`),

  getFiles: (id) => get(`/api/characters/${id}/files`),
  updateFiles: (id, data) => put(`/api/characters/${id}/files`, data),
  getFileVersions: (id, file, limit = 20) =>
    get(`/api/characters/${id}/file-versions?file=${encodeURIComponent(file)}&limit=${limit}`),

  listConversations: (characterId) => get(`/api/characters/${characterId}/conversations`),
  createConversation: (characterId, data = {}) => post(`/api/characters/${characterId}/conversations`, data),
  renameConversation: (id, title) => put(`/api/conversations/${id}`, { title }),
  deleteConversation: (id) => del(`/api/conversations/${id}`),

  listMessages: (id, limit = 200) => get(`/api/conversations/${id}/messages?limit=${limit}`),
  sendMessage,

  // 群聊
  createGroup: (data) => post('/api/groups', data),
  listGroups: () => get('/api/groups'),
  getGroup: (id) => get(`/api/groups/${id}`),
  renameGroup: (id, name) => put(`/api/groups/${id}`, { name }),
  updateGroupMembers: (id, member_ids) => put(`/api/groups/${id}/members`, { member_ids }),

  // 多用户模式：当前用户的 API 配置（key 存服务器加密，前端永远拿不到明文）
  getUserApiKey: () => get('/api/user/api-key'),
  saveUserApiKey: (data) => put('/api/user/api-key', data),

  // 密码重置（无需登录）/ 重置码管理（需登录）
  resetPassword,
  getRecoveryCode,
  regenerateRecoveryCode,
  // 积分系统（多用户模式）
  getPoints: () => get('/api/points'),
  setBillingMode: (mode) => put('/api/points/mode', { mode }),
  getPointsLedger: (limit = 20) => get(`/api/points/ledger?limit=${limit}`),
  adminGrantPoints: (data) => post('/api/admin/points/grant', data),
  adminListUsers: (q = '') => get(`/api/admin/users?q=${encodeURIComponent(q)}`),
  // 积分可用模型管理（管理员）
  adminPointsModels: () => get('/api/admin/points/models'),
  adminAddPointsModel: (data) => post('/api/admin/points/models', data),
  adminUpdatePointsModel: (id, data) => put(`/api/admin/points/models/${id}`, data),
  adminDeletePointsModel: (id) => del(`/api/admin/points/models/${id}`),
  // 邀请
  getInvite: () => get('/api/invite'),
  // 用量统计（管理员）
  adminStatsOverview: () => get('/api/admin/stats/overview'),
  adminStatsDaily: (days = 30) => get(`/api/admin/stats/daily?days=${days}`),
  adminStatsModels: () => get('/api/admin/stats/models'),
  adminStatsTopUsers: (limit = 10) => get(`/api/admin/stats/top-users?limit=${limit}`),
};
