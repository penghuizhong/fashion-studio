import { inspectImageRates } from '../../shared/imagePricing.js';
import { modelSignature, imageOptions } from './imageCapabilities.js';
// v0.2.0: 统一模型注册表——供应商（providers）→ 模型（models）两层
// 替代：.env 直读（聊天 key/address）、points_models（聊天模型定价）、image_models（图片模型）
// 密钥 AES-256-GCM 只写不读；对外一律掩码。
import { randomUUID } from 'node:crypto';
import { getDb, getSetting, setSetting } from './db.js';
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
  const r = getDb().prepare('SELECT models_cache_json, models_cached_at FROM providers WHERE id=? AND deleted_at IS NULL').get(id);
  if (!r) return null;
  let models = [];
  try { const arr = JSON.parse(r.models_cache_json || '[]'); models = Array.isArray(arr) ? arr : []; } catch {}
  return { models, cached_at: r.models_cached_at || 0 };
}

export function listProviders(activeOnly = true) {
  const rows = activeOnly
    ? getDb().prepare('SELECT * FROM providers WHERE is_active=1 AND deleted_at IS NULL ORDER BY sort_order, id').all()
    : getDb().prepare('SELECT * FROM providers WHERE deleted_at IS NULL ORDER BY sort_order, id').all();
  return rows.map(stripProvider);
}

export function getProviderRow(id) {
  return stripProvider(getDb().prepare('SELECT * FROM providers WHERE id=? AND deleted_at IS NULL').get(id));
}

// 解密后的凭证（仅服务端内部用，绝不直接返回给前端）
export function getProviderCreds(id) {
  const r = getDb().prepare('SELECT * FROM providers WHERE id=? AND deleted_at IS NULL').get(id);
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
  let r = db.prepare("SELECT * FROM providers WHERE is_default=1 AND is_active=1 AND deleted_at IS NULL AND kind IN ('llm','both') LIMIT 1").get();
  if (!r) r = db.prepare("SELECT * FROM providers WHERE is_active=1 AND deleted_at IS NULL AND kind IN ('llm','both') ORDER BY sort_order, id LIMIT 1").get();
  if (!r) return null;
  return getProviderCreds(r.id);
}

export function createProvider({ name, preset, kind, base_url, api_key, is_default, is_active = true, sort_order }) {
  const nm = String(name || '').trim();
  if (!nm) throw new Error('供应商名称不能为空');
  const pr = String(preset || 'custom').trim();
  if (!getPreset(pr)) throw new Error('未知的协议预设: ' + pr);
  const kd = String(kind || 'both').trim();
  if (!['llm', 'image', 'both'].includes(kd)) throw new Error('kind 须为 llm/image/both');
  if (is_default && (!is_active || kd === 'image')) throw registryError('只有已启用的聊天供应商可以设为默认');
  const id = 'prov_' + randomUUID().replace(/-/g, '').slice(0, 12);
  const cfg = getConfig();
  const enc = api_key ? encryptSecret(cfg.masterKey, String(api_key)) : null;
  const db = getDb();
  db.prepare(
    'INSERT INTO providers(id,name,preset,kind,base_url,api_key_encrypted,is_default,is_active,sort_order,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)'
  ).run(id, nm, pr, kd, String(base_url || '').trim().replace(/\/+$/, ''), enc, 0, is_active ? 1 : 0, Math.floor(Number(sort_order)) || 0, now());
  if (is_default) setDefaultProvider(id);
  return getProviderRow(id);
}

export function updateProvider(id, patch = {}) {
  const db = getDb();
  return db.transaction(() => {
    const cur = db.prepare('SELECT * FROM providers WHERE id=? AND deleted_at IS NULL').get(id);
    if (!cur) throw registryError('供应商不存在或已删除', 404);
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
    if (upd.kind && db.prepare("SELECT 1 FROM models WHERE provider_id=? AND deleted_at IS NULL AND kind!=? LIMIT 1").get(id, upd.kind === 'llm' ? 'chat' : upd.kind === 'image' ? 'image' : '') && upd.kind !== 'both') {
      throw registryError('供应商下存在不兼容类型的模型，请先迁移或删除这些模型');
    }
    if (upd.is_active === 0 || upd.kind === 'image') upd.is_default = 0;
    if (patch.is_default && (upd.is_active ?? cur.is_active) === 0) throw registryError('请先启用供应商再设为默认');
    const keys = Object.keys(upd);
    if (keys.length) db.prepare(`UPDATE providers SET ${keys.map((k) => `${k}=?`).join(', ')} WHERE id=?`).run(...keys.map((k) => upd[k]), id);
    if (patch.is_default) setDefaultProvider(id);
    if (patch.is_active !== undefined) pruneModelSettings();
    return getProviderRow(id);
  })();
}

export function setDefaultProvider(id) {
  const db = getDb();
  const cur = db.prepare('SELECT * FROM providers WHERE id=? AND deleted_at IS NULL').get(id);
  if (!cur) throw registryError('供应商不存在或已删除', 404);
  if (!cur.is_active || !['llm', 'both'].includes(cur.kind)) throw registryError('只有已启用的聊天供应商可以设为默认');
  db.transaction(() => {
    db.prepare('UPDATE providers SET is_default=0').run();
    db.prepare('UPDATE providers SET is_default=1 WHERE id=?').run(id);
  })();
}

export function deleteProvider(id) {
  const db = getDb();
  return db.transaction(() => {
    const cur = db.prepare('SELECT * FROM providers WHERE id=?').get(id);
    if (!cur) throw registryError('供应商不存在', 404);
    if (cur.deleted_at) return { ok: true, deletedModels: 0 };
    const deletedAt = now();
    const result = db.prepare('UPDATE models SET is_active=0,deleted_at=? WHERE provider_id=? AND deleted_at IS NULL').run(deletedAt, id);
    db.prepare("UPDATE providers SET is_active=0,is_default=0,api_key_encrypted='',models_cache_json=NULL,models_cached_at=NULL,deleted_at=? WHERE id=?").run(deletedAt, id);
    pruneModelSettings();
    return { ok: true, deletedModels: result.changes };
  })();
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
  const signature = modelSignature({provider_id:r.provider_id,model_id:r.model_id,kind:r.kind,extra:parseJson(r.extra_json,{})},getDb().prepare('SELECT * FROM providers WHERE id=?').get(r.provider_id));
  const checks = getDb().prepare('SELECT task,signature,status,message,created_at,preview_path FROM model_capability_checks WHERE model_id=?').all(r.id).map(c=>({task:c.task,status:c.signature===signature?c.status:'stale',message:c.signature===signature?c.message:'配置已变化，请重新测试',created_at:c.created_at,preview:c.preview_path?`/api/admin/models/${r.id}/test-preview?task=${c.task}`:null}));
  return {
    checks,
    id: r.id,
    provider_id: r.provider_id,
    provider_name: r.provider_name || '',
    provider_preset: r.provider_preset || '',
    provider_active: !!r.provider_active,
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

const MODEL_JOIN = `SELECT m.*, p.name AS provider_name, p.preset AS provider_preset, p.is_active AS provider_active FROM models m LEFT JOIN providers p ON p.id=m.provider_id`;

export function listModels({ kind, activeOnly = true } = {}) {
  const cond = ['m.deleted_at IS NULL', 'p.deleted_at IS NULL'];
  if (kind) cond.push(`m.kind='${kind === 'chat' ? 'chat' : 'image'}'`);
  if (activeOnly) cond.push('m.is_active=1 AND p.is_active=1');
  const where = cond.length ? 'WHERE ' + cond.join(' AND ') : '';
  return getDb().prepare(`${MODEL_JOIN} ${where} ORDER BY m.sort_order, m.id`).all().map(shapeModel);
}

export function getModel(id) {
  return shapeModel(getDb().prepare(`${MODEL_JOIN} WHERE m.id=? AND m.deleted_at IS NULL AND p.deleted_at IS NULL`).get(id));
}

function registryError(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

function validateProvider(providerId, kind, requireActive) {
  const provider = getDb().prepare('SELECT * FROM providers WHERE id=? AND deleted_at IS NULL').get(providerId);
  if (!provider) throw registryError('供应商不存在或已删除', 404);
  if (provider.kind !== 'both' && provider.kind !== (kind === 'chat' ? 'llm' : 'image')) {
    throw registryError('供应商类型与模型不匹配');
  }
  if (requireActive && !provider.is_active) throw registryError('供应商已停用，请先启用供应商');
}

function assertModelNameAvailable(providerId, modelId, excludeId = '') {
  const duplicate = getDb().prepare('SELECT is_active FROM models WHERE provider_id=? AND model_id=? AND deleted_at IS NULL AND id!=?').get(providerId, modelId, excludeId);
  if (duplicate) throw registryError(duplicate.is_active
    ? '该供应商下模型 ID 已存在，请编辑现有模型，或删除后重新添加'
    : '该供应商下存在同 ID 的已下架模型，请重新上架，或删除后重新添加', 409);
}

// Model configuration stores upstream names for legacy chat callers. Preserve a name
// while another available registration still supplies it, otherwise remove stale defaults.
function pruneModelSettings() {
  const ids = new Set(getDb().prepare(`SELECT m.model_id FROM models m JOIN providers p ON p.id=m.provider_id
    WHERE m.kind='chat' AND m.is_active=1 AND m.deleted_at IS NULL AND p.is_active=1 AND p.deleted_at IS NULL`).all().map(r => r.model_id));
  for (const key of ['worker_model', 'chat_default_model']) {
    const value = getSetting(key, '');
    if (value && !ids.has(value)) setSetting(key, '');
  }
  const raw = getSetting('filter_fallback_models', '');
  if (raw) {
    try {
      const values = JSON.parse(raw);
      if (Array.isArray(values)) {
        const clean = [...new Set(values.filter(id => ids.has(id)))];
        if (JSON.stringify(values) !== JSON.stringify(clean)) setSetting('filter_fallback_models', JSON.stringify(clean));
      }
    } catch { /* Preserve unrecognized legacy settings for explicit administrator repair. */ }
  }
}

export function createModel({ provider_id, kind, model_id, name, pricing, extra, is_active = true, sort_order }) {
  const db = getDb();
  return db.transaction(() => {
    const kd = String(kind || '').trim();
    if (!['chat', 'image'].includes(kd)) throw registryError('kind 须为 chat/image');
    validateProvider(provider_id, kd, true);
    const mid = String(model_id || '').trim();
    if (!mid) throw registryError('模型 ID 不能为空');
    assertModelNameAvailable(provider_id, mid);
    validateImageConfig(extra, pricing);
    const id = 'model_' + randomUUID().replace(/-/g, '').slice(0, 12);
    db.prepare(
      'INSERT INTO models(id,provider_id,kind,model_id,name,pricing_json,extra_json,is_active,sort_order,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)'
    ).run(id, provider_id, kd, mid, String(name || '').trim() || mid,
      JSON.stringify(pricing && typeof pricing === 'object' ? pricing : {}),
      JSON.stringify(extra && typeof extra === 'object' ? extra : {}),
      is_active ? 1 : 0, Math.floor(Number(sort_order)) || 0, now());
    if (kd === 'image') syncImageDefaults(id, extra);
    return getModel(id);
  })();
}

export function updateModel(id, patch = {}) {
  const db = getDb();
  return db.transaction(() => {
    const cur = db.prepare('SELECT * FROM models WHERE id=? AND deleted_at IS NULL').get(id);
    if (!cur) throw registryError('模型不存在或已删除', 404);
    if (patch.kind !== undefined && patch.kind !== cur.kind) throw registryError('模型类型不可更改，请新建对应类型模型');
    const providerId = patch.provider_id ?? cur.provider_id;
    validateProvider(providerId, cur.kind, !!patch.is_active || providerId !== cur.provider_id);
    const mid = patch.model_id === undefined ? cur.model_id : String(patch.model_id || '').trim();
    if (!mid) throw registryError('模型 ID 不能为空');
    assertModelNameAvailable(providerId, mid, id);
    validateImageConfig(patch.extra ?? parseJson(cur.extra_json, {}), patch.pricing ?? parseJson(cur.pricing_json, {}));
    const upd = {};
    if (patch.provider_id !== undefined) upd.provider_id = providerId;
    if (patch.model_id !== undefined) upd.model_id = mid;
    if (patch.name !== undefined) upd.name = String(patch.name || '').trim() || mid;
    if (patch.pricing !== undefined && patch.pricing && typeof patch.pricing === 'object') upd.pricing_json = JSON.stringify(patch.pricing);
    if (patch.extra !== undefined && patch.extra && typeof patch.extra === 'object') upd.extra_json = JSON.stringify(patch.extra);
    if (patch.is_active !== undefined) upd.is_active = patch.is_active ? 1 : 0;
    if (patch.sort_order !== undefined) upd.sort_order = Math.floor(Number(patch.sort_order)) || 0;
    const keys = Object.keys(upd);
    if (keys.length) db.prepare(`UPDATE models SET ${keys.map(k => `${k}=?`).join(', ')} WHERE id=?`).run(...keys.map(k => upd[k]), id);
    if (patch.extra && cur.kind === 'image') syncImageDefaults(id, patch.extra);
    if (patch.is_active !== undefined || providerId !== cur.provider_id || mid !== cur.model_id) pruneModelSettings();
    return getModel(id);
  })();
}

export function deleteModel(id) {
  const db = getDb();
  return db.transaction(() => {
    const cur = db.prepare('SELECT deleted_at FROM models WHERE id=?').get(id);
    if (!cur) throw registryError('模型不存在', 404);
    if (!cur.deleted_at) db.prepare('UPDATE models SET is_active=0,deleted_at=? WHERE id=?').run(now(), id);
    pruneModelSettings();
    return { ok: true };
  })();
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
     WHERE m.kind='image' AND m.deleted_at IS NULL AND p.deleted_at IS NULL ${activeOnly ? 'AND m.is_active=1 AND p.is_active=1' : ''}
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
      capabilities: imageOptions(extra,r.provider_preset),
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

function validateImageConfig(extra={},pricing={}) {
  if(pricing.per_call!==undefined&&(!Number.isSafeInteger(pricing.per_call)||pricing.per_call<0||pricing.per_call>1e9))throw new Error('图片单价须为非负整数，免费请明确填写 0');
  if(pricing.image_rates!==undefined){
    const report=inspectImageRates(imageOptions(extra),pricing.image_rates);
    if(report.errors.length)throw new Error(report.errors.join('；'));
  }
  const c=extra.image_config;if(!c)return;
  if(!['openai_images','dashscope','dashscope_multimodal'].includes(c.protocol))throw new Error('请选择已实现的图片协议');
  for(const key of ['generation_path','edit_path'])if(c[key]&&(!/^\/[A-Za-z0-9_./-]+$/.test(c[key])||c[key].includes('..')))throw new Error('图片接口路径须为安全相对路径');
  if(c.response_format&&!['omit','b64_json','url'].includes(c.response_format))throw new Error('图片返回格式无效');
  if(c.max_images!==undefined&&(!Number.isInteger(c.max_images)||c.max_images<1||c.max_images>16))throw new Error('参考图上限须为1–16');
  if(c.qualities!==undefined&&(!Array.isArray(c.qualities)||c.qualities.length>8||c.qualities.some(q=>!q||!/^[-\w]{1,32}$/.test(q.value)||typeof q.label!=='string')||new Set(c.qualities.map(q=>q.value)).size!==c.qualities.length))throw new Error('质量档位格式无效');
  const z=c.custom_size;if(z?.enabled&&(![z.min,z.max,z.step,z.max_pixels].every(Number.isInteger)||z.min<64||z.max>8192||z.max<z.min||z.step<1||z.max_pixels<z.min*z.min||z.max_pixels>16777216))throw new Error('自定义尺寸约束无效');
}

function syncImageDefaults(id,extra){
 const tasks=extra?.image_config?.default_for;if(!Array.isArray(tasks)||!tasks.length)return;
 const db=getDb();db.transaction(()=>{
  for(const row of db.prepare("SELECT id,extra_json FROM models WHERE kind='image' AND deleted_at IS NULL AND id!=?").all(id)){
   const config=parseJson(row.extra_json,{});const old=config.image_config?.default_for;
   if(Array.isArray(old)&&old.some(t=>tasks.includes(t))){config.image_config.default_for=old.filter(t=>!tasks.includes(t));db.prepare('UPDATE models SET extra_json=? WHERE id=?').run(JSON.stringify(config),row.id);}
  }
 })();
}
