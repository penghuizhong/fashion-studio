// v0.2.0: 统一模型注册表——供应商（providers）→ 模型（models）两层
// 替代：.env 直读（聊天 key/address）、points_models（聊天模型定价）、image_models（图片模型）
// 密钥 AES-256-GCM 只写不读；对外一律掩码。
import { randomUUID } from 'node:crypto';
import { getDb } from './db.js';
import { getConfig } from './config.js';
import { encryptSecret, decryptSecret, maskSecret } from './secrets.js';
import { getProvider as getPreset } from './providers.js';

const now = () => new Date().toISOString();

// ---------- providers ----------

function stripProvider(r) {
  if (!r) return null;
  const { api_key_encrypted, models_cache_json, ...rest } = r;
  let models_count = 0;
  try { const arr = JSON.parse(models_cache_json || '[]'); models_count = Array.isArray(arr) ? arr.length : 0; } catch {}
  return { ...rest, has_key: !!api_key_encrypted, api_key_mask: maskSecret(api_key_encrypted), models_count };
}

// v0.2.1: 拉取上游可用模型列表（OpenAI 兼容 GET /models），成功即证明 key+地址正确
export async function fetchUpstreamModels({ baseUrl, apiKey, timeoutMs = 20000 }) {
  const url = String(baseUrl || '').replace(/\/+$/, '') + '/models';
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${apiKey}` },
      signal: ctrl.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      let msg = text.slice(0, 160);
      try { const j = JSON.parse(text); msg = (j.error && (j.error.message || j.error.code)) || msg; } catch {}
      const e = new Error(`拉取模型列表失败 HTTP ${res.status}: ${msg}`);
      e.status = res.status;
      throw e;
    }
    const j = JSON.parse(text);
    const arr = Array.isArray(j.data) ? j.data : (Array.isArray(j.models) ? j.models : []);
    return arr
      .map((m) => ({ id: String(m.id || m.name || ''), name: String(m.name || m.id || '') }))
      .filter((m) => m.id)
      .slice(0, 500);
  } finally {
    clearTimeout(t);
  }
}

// v0.2.1: 拉取并缓存某供应商的模型列表
export async function refreshProviderModels(id) {
  const c = getProviderCreds(id);
  if (!c) { const e = new Error('供应商不存在'); e.status = 404; throw e; }
  if (!c.apiKey) { const e = new Error('该供应商未配置 Key'); e.status = 400; throw e; }
  if (!c.baseUrl) { const e = new Error('该供应商未配置地址'); e.status = 400; throw e; }
  const t0 = Date.now();
  const models = await fetchUpstreamModels({ baseUrl: c.baseUrl, apiKey: c.apiKey });
  getDb().prepare('UPDATE providers SET models_cache_json=?, models_cached_at=? WHERE id=?')
    .run(JSON.stringify(models), Date.now(), id);
  return { count: models.length, latency: Date.now() - t0 };
}

// v0.2.1: 读缓存的模型列表（给前端上架模型时自动补全）
export function getCachedModels(id) {
  const r = getDb().prepare('SELECT models_cache_json, models_cached_at FROM providers WHERE id=?').get(id);
  if (!r) return null;
  let models = [];
  try { const arr = JSON.parse(r.models_cache_json || '[]'); models = Array.isArray(arr) ? arr : []; } catch {}
  return { models, cached_at: r.models_cached_at || 0 };
}

export function listProviders(activeOnly = true) {
  const rows = activeOnly
    ? getDb().prepare('SELECT * FROM providers WHERE is_active=1 ORDER BY sort_order, id').all()
    : getDb().prepare('SELECT * FROM providers ORDER BY sort_order, id').all();
  return rows.map(stripProvider);
}

export function getProviderRow(id) {
  return stripProvider(getDb().prepare('SELECT * FROM providers WHERE id=?').get(id));
}

// 解密后的凭证（仅服务端内部用，绝不直接返回给前端）
export function getProviderCreds(id) {
  const r = getDb().prepare('SELECT * FROM providers WHERE id=?').get(id);
  if (!r) return null;
  const cfg = getConfig();
  return {
    id: r.id,
    name: r.name,
    preset: r.preset,
    kind: r.kind,
    baseUrl: (r.base_url || '').trim(),
    apiKey: decryptSecret(cfg.masterKey, r.api_key_encrypted || ''),
  };
}

// 默认聊天供应商（is_default=1 优先，否则第一个 active 的 llm/both）
export function getDefaultProvider() {
  const db = getDb();
  let r = db.prepare("SELECT * FROM providers WHERE is_default=1 AND is_active=1 AND kind IN ('llm','both') LIMIT 1").get();
  if (!r) r = db.prepare("SELECT * FROM providers WHERE is_active=1 AND kind IN ('llm','both') ORDER BY sort_order, id LIMIT 1").get();
  if (!r) return null;
  return getProviderCreds(r.id);
}

export function createProvider({ name, preset, kind, base_url, api_key, is_default, sort_order }) {
  const nm = String(name || '').trim();
  if (!nm) throw new Error('供应商名称不能为空');
  const pr = String(preset || 'custom').trim();
  if (!getPreset(pr)) throw new Error('未知的协议预设: ' + pr);
  const kd = String(kind || 'both').trim();
  if (!['llm', 'image', 'both'].includes(kd)) throw new Error('kind 须为 llm/image/both');
  const id = 'prov_' + randomUUID().replace(/-/g, '').slice(0, 12);
  const cfg = getConfig();
  const enc = api_key ? encryptSecret(cfg.masterKey, String(api_key)) : null;
  const db = getDb();
  db.prepare(
    'INSERT INTO providers(id,name,preset,kind,base_url,api_key_encrypted,is_default,is_active,sort_order,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)'
  ).run(id, nm, pr, kd, String(base_url || '').trim().replace(/\/+$/, ''), enc, 0, 1, Math.floor(Number(sort_order)) || 0, now());
  if (is_default) setDefaultProvider(id);
  return getProviderRow(id);
}

export function updateProvider(id, patch = {}) {
  const db = getDb();
  const cur = db.prepare('SELECT * FROM providers WHERE id=?').get(id);
  if (!cur) throw new Error('供应商不存在');
  const cfg = getConfig();
  const upd = {};
  if (patch.name !== undefined) {
    const nm = String(patch.name || '').trim();
    if (!nm) throw new Error('供应商名称不能为空');
    upd.name = nm;
  }
  if (patch.preset !== undefined) {
    const pr = String(patch.preset || 'custom').trim();
    if (!getPreset(pr)) throw new Error('未知的协议预设: ' + pr);
    upd.preset = pr;
  }
  if (patch.kind !== undefined) {
    const kd = String(patch.kind || '').trim();
    if (!['llm', 'image', 'both'].includes(kd)) throw new Error('kind 须为 llm/image/both');
    upd.kind = kd;
  }
  if (patch.base_url !== undefined) upd.base_url = String(patch.base_url || '').trim().replace(/\/+$/, '');
  if (patch.api_key !== undefined && String(patch.api_key || '') !== '') {
    upd.api_key_encrypted = encryptSecret(cfg.masterKey, String(patch.api_key));
  }
  if (patch.is_active !== undefined) upd.is_active = patch.is_active ? 1 : 0;
  if (patch.sort_order !== undefined) upd.sort_order = Math.floor(Number(patch.sort_order)) || 0;
  const keys = Object.keys(upd);
  if (keys.length) db.prepare(`UPDATE providers SET ${keys.map((k) => `${k}=?`).join(', ')} WHERE id=?`).run(...keys.map((k) => upd[k]), id);
  if (patch.is_default) setDefaultProvider(id);
  return getProviderRow(id);
}

export function setDefaultProvider(id) {
  const db = getDb();
  const cur = db.prepare('SELECT * FROM providers WHERE id=?').get(id);
  if (!cur) throw new Error('供应商不存在');
  db.prepare('UPDATE providers SET is_default=0').run();
  db.prepare('UPDATE providers SET is_default=1 WHERE id=?').run(id);
}

export function deleteProvider(id) {
  const db = getDb();
  const cur = db.prepare('SELECT * FROM providers WHERE id=?').get(id);
  if (!cur) throw new Error('供应商不存在');
  const n = db.prepare('SELECT COUNT(*) c FROM models WHERE provider_id=? AND is_active=1').get(id).c;
  // 级联下架其模型（不硬删，防历史计费断链），再删供应商
  db.prepare('UPDATE models SET is_active=0 WHERE provider_id=?').run(id);
  db.prepare('DELETE FROM providers WHERE id=?').run(id);
  return { ok: true, deactivatedModels: n };
}

// ---------- models ----------

function parseJson(s, fb) {
  try {
    const v = JSON.parse(s || '');
    return v && typeof v === 'object' ? v : fb;
  } catch {
    return fb;
  }
}

function shapeModel(r) {
  if (!r) return null;
  return {
    id: r.id,
    provider_id: r.provider_id,
    provider_name: r.provider_name || '',
    provider_preset: r.provider_preset || '',
    kind: r.kind,
    model_id: r.model_id,
    name: r.name,
    pricing: parseJson(r.pricing_json, {}),
    extra: parseJson(r.extra_json, {}),
    is_active: !!r.is_active,
    sort_order: r.sort_order,
    created_at: r.created_at,
  };
}

const MODEL_JOIN = `SELECT m.*, p.name AS provider_name, p.preset AS provider_preset FROM models m LEFT JOIN providers p ON p.id=m.provider_id`;

export function listModels({ kind, activeOnly = true } = {}) {
  const cond = [];
  if (kind) cond.push(`m.kind='${kind === 'chat' ? 'chat' : 'image'}'`);
  if (activeOnly) cond.push('m.is_active=1');
  const where = cond.length ? 'WHERE ' + cond.join(' AND ') : '';
  return getDb().prepare(`${MODEL_JOIN} ${where} ORDER BY m.sort_order, m.id`).all().map(shapeModel);
}

export function getModel(id) {
  return shapeModel(getDb().prepare(`${MODEL_JOIN} WHERE m.id=?`).get(id));
}

export function createModel({ provider_id, kind, model_id, name, pricing, extra, sort_order }) {
  const db = getDb();
  const pv = db.prepare('SELECT id FROM providers WHERE id=?').get(provider_id);
  if (!pv) throw new Error('供应商不存在');
  const kd = String(kind || '').trim();
  if (!['chat', 'image'].includes(kd)) throw new Error('kind 须为 chat/image');
  const mid = String(model_id || '').trim();
  if (!mid) throw new Error('模型 ID 不能为空');
  const dup = db.prepare('SELECT 1 FROM models WHERE provider_id=? AND model_id=?').get(provider_id, mid);
  if (dup) throw new Error('该供应商下模型 ID 已存在');
  const id = 'model_' + randomUUID().replace(/-/g, '').slice(0, 12);
  db.prepare(
    'INSERT INTO models(id,provider_id,kind,model_id,name,pricing_json,extra_json,is_active,sort_order,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)'
  ).run(id, provider_id, kd, mid, String(name || '').trim() || mid,
    JSON.stringify(pricing && typeof pricing === 'object' ? pricing : {}),
    JSON.stringify(extra && typeof extra === 'object' ? extra : {}),
    1, Math.floor(Number(sort_order)) || 0, now());
  return getModel(id);
}

export function updateModel(id, patch = {}) {
  const db = getDb();
  const cur = db.prepare('SELECT * FROM models WHERE id=?').get(id);
  if (!cur) throw new Error('模型不存在');
  const upd = {};
  if (patch.provider_id !== undefined) {
    const pv = db.prepare('SELECT id FROM providers WHERE id=?').get(patch.provider_id);
    if (!pv) throw new Error('供应商不存在');
    upd.provider_id = patch.provider_id;
  }
  if (patch.model_id !== undefined) {
    const mid = String(patch.model_id || '').trim();
    if (!mid) throw new Error('模型 ID 不能为空');
    upd.model_id = mid;
  }
  if (patch.name !== undefined) upd.name = String(patch.name || '').trim();
  if (patch.pricing !== undefined && patch.pricing && typeof patch.pricing === 'object') upd.pricing_json = JSON.stringify(patch.pricing);
  if (patch.extra !== undefined && patch.extra && typeof patch.extra === 'object') upd.extra_json = JSON.stringify(patch.extra);
  if (patch.is_active !== undefined) upd.is_active = patch.is_active ? 1 : 0;
  if (patch.sort_order !== undefined) upd.sort_order = Math.floor(Number(patch.sort_order)) || 0;
  const keys = Object.keys(upd);
  if (keys.length) db.prepare(`UPDATE models SET ${keys.map((k) => `${k}=?`).join(', ')} WHERE id=?`).run(...keys.map((k) => upd[k]), id);
  return getModel(id);
}

export function deleteModel(id) {
  const r = getDb().prepare('DELETE FROM models WHERE id=?').run(id);
  if (!r.changes) throw new Error('模型不存在');
  return { ok: true };
}

// ---------- 兼容层（供 points.js / app.js 老调用方） ----------

// 返回旧 points_models 行形状：{id, model_id, name, input_per_1m, output_per_1m, is_active, sort_order}
export function listChatModelsCompat(activeOnly = true) {
  return listModels({ kind: 'chat', activeOnly }).map((m) => ({
    id: m.id,
    model_id: m.model_id,
    name: m.name,
    description: '',
    input_per_1m: Math.floor(Number(m.pricing.input_per_1m)) || 0,
    output_per_1m: Math.floor(Number(m.pricing.output_per_1m)) || 0,
    is_active: m.is_active ? 1 : 0,
    sort_order: m.sort_order,
  }));
}

// 图片模型兼容层（供 image.js）：{id, model_id, name, provider, base_url, price_per_call, sizes, is_active, sort_order}
export function listImageModelsCompat(activeOnly = true) {
  const db = getDb();
  const rows = db.prepare(
    `SELECT m.*, p.preset AS provider_preset, p.base_url AS provider_base_url
     FROM models m LEFT JOIN providers p ON p.id=m.provider_id
     ${activeOnly ? "WHERE m.is_active=1 AND m.kind='image'" : "WHERE m.kind='image'"}
     ORDER BY m.sort_order, m.id`
  ).all();
  return rows.map((r) => {
    const pricing = parseJson(r.pricing_json, {});
    const extra = parseJson(r.extra_json, {});
    return {
      id: r.id,
      model_id: r.model_id,
      name: r.name,
      provider: r.provider_preset === 'dashscope' ? 'dashscope' : 'openai_compatible',
      provider_id: r.provider_id,
      base_url: r.provider_base_url || '',
      price_per_call: Math.floor(Number(pricing.per_call)) || 0,
      sizes: Array.isArray(extra.sizes) ? extra.sizes : [],
      prompt_extend: extra.prompt_extend !== false,
      is_active: !!r.is_active,
      sort_order: r.sort_order,
    };
  });
}
