// Fashion Studio 前端 API 层：全部走相对路径 /api（开发走 vite proxy，生产由后端同源托管）
// 用户级 API 配置（API 地址 / Key / 聊天模型 / 后台模型）：
// - 单用户模式：只存本浏览器 localStorage，每次请求经请求头透传
//   （X-Api-Base-Url / X-OpenRouter-Key / X-Chat-Model / X-Worker-Model），后端不存储、不记日志。
// - 多用户模式：配置存服务器（key 加密，随账号走，换设备不丢）；前端不发任何配置头，
//   会话 cookie 即身份。「拉取模型」预览时可显式传本次输入的 key/地址（不存储）。

const API_BASE_URL_KEY = 'soulchat-api-base-url';
const API_KEY_KEY = 'soulchat-openrouter-key';
const API_MODEL_KEY = 'soulchat-chat-model';
const API_WORKER_MODEL_KEY = 'soulchat-worker-model';
const API_PROVIDER_KEY = 'soulchat-api-provider'; // v1.20.0: 提供商（非敏感，决定协议参数）

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
  // Key 只放内存（防 XSS 持久化窃取，刷新页面后需重新填写）；地址/模型/提供商等非敏感项仍存 localStorage
  try {
    return {
      baseUrl: (localStorage.getItem(API_BASE_URL_KEY) || '').trim(),
      key: memApiKey,
      model: (localStorage.getItem(API_MODEL_KEY) || '').trim(),
      workerModel: (localStorage.getItem(API_WORKER_MODEL_KEY) || '').trim(),
      provider: (localStorage.getItem(API_PROVIDER_KEY) || 'custom').trim() || 'custom',
    };
  } catch {
    return { baseUrl: '', key: memApiKey, model: '', workerModel: '', provider: 'custom' };
  }
}

// Key 仅存内存；兼容老版本：首次加载时把 localStorage 里的旧 Key 迁入内存并删除
let memApiKey = '';
try {
  const legacy = localStorage.getItem(API_KEY_KEY);
  if (legacy) {
    memApiKey = legacy.trim();
    localStorage.removeItem(API_KEY_KEY);
  }
} catch {
  /* 忽略 */
}

export function setApiConfig({ baseUrl, key, model, workerModel, provider }) {
  if (typeof key === 'string') memApiKey = key.trim();
  try {
    if (baseUrl) localStorage.setItem(API_BASE_URL_KEY, baseUrl);
    else localStorage.removeItem(API_BASE_URL_KEY);
    if (model) localStorage.setItem(API_MODEL_KEY, model);
    else localStorage.removeItem(API_MODEL_KEY);
    if (workerModel) localStorage.setItem(API_WORKER_MODEL_KEY, workerModel);
    else localStorage.removeItem(API_WORKER_MODEL_KEY);
    if (provider) localStorage.setItem(API_PROVIDER_KEY, provider);
    else localStorage.removeItem(API_PROVIDER_KEY);
  } catch {
    /* 忽略存储失败 */
  }
  window.dispatchEvent(new CustomEvent('soulchat-api-changed'));
}

export function clearApiConfig() {
  setApiConfig({ baseUrl: '', key: '', model: '', workerModel: '', provider: '' });
}

function authHeaders() {
  // 多用户模式：配置以服务器上该用户保存的为准（会话即身份），前端不透传任何配置头，
  // 避免本浏览器 localStorage 里的陈旧值悄悄覆盖服务器配置（"保存了但没生效"）。
  // 单用户模式：走 localStorage + 请求头透传（原有行为）。
  if (isMultiUserMode()) return {};
  const h = {};
  const { baseUrl, key, model, workerModel, provider } = getApiConfig();
  if (key) h['X-OpenRouter-Key'] = key;
  if (baseUrl) h['X-Api-Base-Url'] = baseUrl;
  if (model) h['X-Chat-Model'] = model;
  if (workerModel) h['X-Worker-Model'] = workerModel;
  if (provider) h['X-Api-Provider'] = provider; // v1.20.0
  return h;
}

// 用给定的 key / 地址动态拉取可用模型列表（OpenAI 兼容的 /models 接口）
// 统一 HTTP 错误：5xx 对外脱敏（不展示后端堆栈/SQL）；错误对象带 .status 供调用方分支
async function httpError(res, fallback) {
  let msg;
  if (res.status >= 500) {
    msg = '服务器开小差了，请稍后再试';
  } else {
    msg = fallback || `请求失败 (${res.status})`;
    try {
      const data = await res.json();
      if (data && data.message) msg = data.message;
      else if (data && data.error) msg = data.error;
    } catch {
      /* 忽略解析错误 */
    }
  }
  const err = new Error(msg);
  err.status = res.status;
  // 401：会话过期/失效，通知 App 跳回登录页（auth 相关接口自身不触发，避免循环）
  if (res.status === 401) {
    try {
      window.dispatchEvent(new CustomEvent('soulchat-unauthorized'));
    } catch {
      /* 忽略 */
    }
  }
  return err;
}

// 用给定的 key / 地址动态拉取可用模型列表（OpenAI 兼容的 /models 接口）
// 多用户模式下 key 可留空：不发 key 头，后端用该用户服务器端保存的 key。
export async function fetchModels(baseUrl, key) {
  const headers = {};
  if (key) headers['X-OpenRouter-Key'] = key;
  if (baseUrl) headers['X-Api-Base-Url'] = baseUrl;
  const res = await fetch('/api/models', { headers, credentials: 'same-origin' });
  if (!res.ok) throw await httpError(res, '拉取失败');
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
  if (!res.ok) throw await httpError(res);
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
export async function sendMessage(conversationId, content, onEvent, signal, opts = {}) {
  const res = await fetch(`/api/conversations/${conversationId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    credentials: 'same-origin',
    // v1.22.0: regenerate=true 时后端复用最后一条用户消息，不重复落库
    // v1.27.1: 总是带上 content，后端按内容比对决定复用还是插入（防失败重试叠加用户消息）
    body: JSON.stringify({ content, regenerate: !!opts.regenerate }),
    signal,
  });
  if (!res.ok) throw await httpError(res, '发送失败');
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

// v1.20.3: 重新生成——删掉最后一条 AI 回复，返回最后一条用户消息内容
export async function regenerateMessage(conversationId) {
  return post(`/api/conversations/${conversationId}/regenerate`, {});
}

// v1.22.0: 群聊单轮重新生成——删掉指定半截回复，只重跑该角色一轮（SSE）
// v1.22.2: locator 为 {message_id} 或 {character_id, batch_id}（断流补的半截无 message_id）
export async function regenerateGroupTurn(conversationId, locator, onEvent, signal) {
  const res = await fetch(`/api/conversations/${conversationId}/regenerate-turn`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    credentials: 'same-origin',
    body: JSON.stringify(locator),
    signal,
  });
  if (!res.ok) throw await httpError(res, '重新生成失败');
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

  // v1.10 意图识别：灵魂修改建议
  getSuggestions: (characterId) => get(`/api/characters/${characterId}/suggestions`),
  applySuggestion: (id) => post(`/api/suggestions/${id}/apply`, {}),
  dismissSuggestion: (id) => post(`/api/suggestions/${id}/dismiss`, {}),

  // v1.11 记忆事实列表
  getFacts: (characterId, all = false) =>
    get(`/api/characters/${characterId}/facts${all ? '?all=1' : ''}`),
  deleteFact: (id) => del(`/api/facts/${id}`),

  // v1.12 记忆写入事件（done 后轮询，做"记住了"轻提示）
  getMemoryEvents: (conversationId, since) =>
    get(`/api/conversations/${conversationId}/memory-events?since=${encodeURIComponent(since)}`),
  // v1.18.2: 刷新当前登录用户信息（含 jailbreak_allowed；管理后台授权后免刷新生效）
  getMe: () => get('/api/auth/me'),

  listConversations: (characterId) => get(`/api/characters/${characterId}/conversations`),
  createConversation: (characterId, data = {}) => post(`/api/characters/${characterId}/conversations`, data),
  renameConversation: (id, title) => put(`/api/conversations/${id}`, { title }),
  deleteConversation: (id) => del(`/api/conversations/${id}`),

  listMessages: (id, limit = 200) => get(`/api/conversations/${id}/messages?limit=${limit}`),
  sendMessage,
  regenerateMessage,
  regenerateGroupTurn,
  // v1.20.5: 消息删除
  clearMessages: (id) => del(`/api/conversations/${id}/messages`),
  deleteMessage: (id) => del(`/api/messages/${id}`),

  // 群聊
  createGroup: (data) => post('/api/groups', data),
  listGroups: () => get('/api/groups'),
  getGroup: (id) => get(`/api/groups/${id}`),
  renameGroup: (id, name) => put(`/api/groups/${id}`, { name }),
  updateGroupMembers: (id, member_ids) => put(`/api/groups/${id}/members`, { member_ids }),

  // 多用户模式：当前用户的 API 配置（key 存服务器加密，前端永远拿不到明文）
  getUserApiKey: () => get('/api/user/api-key'),
  saveUserApiKey: (data) => put('/api/user/api-key', data),
  // v1.20.0: 提供商预设 + 保存前连通性测试
  getProviders: () => get('/api/providers'),
  testApiKey: (data) => post('/api/user/api-key/test', data),

  // 密码重置（无需登录）/ 重置码管理（需登录）
  resetPassword,
  getRecoveryCode,
  regenerateRecoveryCode,
  // 积分系统（多用户模式）
  getPoints: () => get('/api/points'),
  setBillingMode: (mode) => put('/api/points/mode', { mode }),
  getPointsLedger: (limit = 20) => get(`/api/points/ledger?limit=${limit}`),
  adminGrantPoints: (data) => post('/api/admin/points/grant', data),
  // v1.18.1: 管理员直接设用户余额
  adminSetPoints: (username, balance) => post('/api/admin/points/set', { username, balance }),
  adminListUsers: (q = '') => get(`/api/admin/users?q=${encodeURIComponent(q)}`),
  // v0.2.0: 统一模型注册表管理（管理员）：供应商 → 模型
  adminProviders: {
    list: () => get('/api/admin/providers'),
    create: (data) => post('/api/admin/providers', data),
    update: (id, data) => put(`/api/admin/providers/${id}`, data),
    remove: (id) => del(`/api/admin/providers/${id}`),
    setDefault: (id) => post(`/api/admin/providers/${id}/default`, {}),
    test: (id) => post(`/api/admin/providers/${id}/test`, {}),
    models: (id) => get(`/api/admin/providers/${id}/models`),
  },
  adminModels: {
    list: (kind) => get(`/api/admin/models${kind ? `?kind=${kind}` : ''}`),
    create: (data) => post('/api/admin/models', data),
    update: (id, data) => put(`/api/admin/models/${id}`, data),
    remove: (id) => del(`/api/admin/models/${id}`),
  },
  // v1.12 模型配置（管理员）：后台模型 / 聊天默认模型
  adminGetSettings: () => get('/api/admin/settings'),
  adminUpdateSettings: (data) => put('/api/admin/settings', data),
  // 邀请
  getInvite: () => get('/api/invite'),
  // 用量统计（管理员）
  adminStatsOverview: () => get('/api/admin/stats/overview'),
  adminStatsDaily: (days = 30) => get(`/api/admin/stats/daily?days=${days}`),
  adminStatsModels: () => get('/api/admin/stats/models'),
  // v1.19.0: 自带 Key 调用按模型+用途分布
  adminStatsApiModels: () => get('/api/admin/stats/api-models'),
  adminStatsTopUsers: (limit = 10) => get(`/api/admin/stats/top-users?limit=${limit}`),
  // v1.18.1: 管理员授权/撤销用户破限权限
  adminSetJailbreak: (userId, allowed) => put(`/api/admin/users/${userId}/jailbreak`, { allowed }),
  // 角色卡
  getPresetCards: () => get('/api/character-cards/presets'),
  getJailbreakPresets: () => get('/api/jailbreak-presets'),
  // v1.17.7: 生效中的提示词模板（扮演模式一键填入/恢复默认用这个，而非前端硬编码拷贝）
  getPromptTemplates: () => get('/api/prompt-templates'),
  adoptCharacterCard: (data) => post('/api/character-cards/adopt', data),
  generateSoul: (data) => post('/api/soul/generate', data),
  generateCharacterCard: (data) => post('/api/character-cards/generate', data),
  getSavedCards: () => get('/api/saved-cards'),
  deleteSavedCard: (id) => del(`/api/saved-cards/${id}`),
  // 角色广场 UGC
  listSharedCards: (params = {}) => get(`/api/character-cards/shared?${new URLSearchParams(params)}`),
  publishCharacterCard: (data) => post('/api/character-cards/publish', data),
  myPublishedCards: () => get('/api/character-cards/my-published'),
  deleteSharedCard: (id) => del(`/api/character-cards/shared/${id}`),
  adoptSharedCard: (id) => post(`/api/character-cards/shared/${id}/adopt`),
  likeSharedCard: (id) => post(`/api/character-cards/shared/${id}/like`),
  reportSharedCard: (id, reason) => post(`/api/character-cards/shared/${id}/report`, { reason }),
  getCollection: () => get('/api/character-cards/collection'),
  // 广场审核（管理员）
  adminSharedCards: (status = 'pending') => get(`/api/admin/shared-cards?status=${encodeURIComponent(status)}`),
  adminReviewSharedCard: (id, approve, reason) => post(`/api/admin/shared-cards/${id}/review`, { approve, reason }),
  // v1.26.2: 模型连通测试
  testChatModel: (model_id) => post('/api/admin/models/test', { model_id }),

  // v0.1.0: 设计台
  studio: {
    extractDna: (data) => post('/api/studio/dna/extract', data),
    listTemplates: () => get('/api/studio/templates'),
    getTemplate: (id) => get(`/api/studio/templates/${id}`),
    createTemplate: (data) => post('/api/studio/templates', data),
    updateTemplate: (id, data) => put(`/api/studio/templates/${id}`, data),
    finalize: (id) => post(`/api/studio/templates/${id}/finalize`, {}),
    unfinalize: (id) => post(`/api/studio/templates/${id}/unfinalize`, {}),
    generate: (id, data) => post(`/api/studio/templates/${id}/generate`, data),
    variant: (id, data) => post(`/api/studio/templates/${id}/variant`, data),
    history: (id, includeArchived) => get(`/api/studio/templates/${id}/history${includeArchived ? '?include_archived=1' : ''}`),
    rate: (genId, rating) => post(`/api/studio/generations/${genId}/rate`, { rating }),
    // P4 发散创建
    exploreCreate: (data) => post('/api/studio/explore', data),
    exploreGet: (id) => get(`/api/studio/explore/${id}`),
    exploreList: (params = {}) => get(`/api/studio/explore${params.include_archived ? '?include_archived=1' : ''}`),
    exploreSelect: (id, indexes) => post(`/api/studio/explore/${id}/select`, { indexes }),
    exploreRender: (id, confirm) => post(`/api/studio/explore/${id}/render`, { confirm: !!confirm }),
    exploreAdopt: (id, indexes) => post(`/api/studio/explore/${id}/adopt`, { indexes }),
    imageModels: () => get('/api/studio/image-models'),
    assets: (params = {}) => {
      const q = new URLSearchParams();
      for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') q.set(k, v);
      const s = q.toString();
      return get(`/api/studio/assets${s ? `?${s}` : ''}`);
    },
    bulkDelete: (ids) => post('/api/studio/assets/bulk-delete', { ids }),
  },
};
