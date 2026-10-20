import { imageOptions, modelSignature } from './imageCapabilities.js';
import { getConfig } from './config.js';
import { getDb } from './db.js';
import { getModel, listModels, getProviderCreds } from './registry.js';
import { getWorkerModel } from './points.js';
import { getUserApiKeys } from './auth.js';
import { assertPublicHttpsUrl } from './llm.js';
import { thinkingControl } from './providers.js';
import { detectProvider } from './providers.js';
import { problem } from './exploreErrors.js';

export function availableModels(kind) {
  const db = getDb();
  return listModels({ kind })
    .filter(
      (m) =>
        db
          .prepare('SELECT is_active FROM providers WHERE id=?')
          .get(m.provider_id)?.is_active
    )
    .filter((m) => kind !== 'chat' || m.extra.structured_output !== false)
    .map((m) => ({
      id: m.id,
      name: m.name,
      model_id: m.model_id,
      provider_name: m.provider_name,
      vision: !!m.extra.vision,
      thinking_control: thinkingControl(m.provider_preset, m.model_id),
      pricing: m.pricing,
      capabilities: {...imageOptions(m.extra,m.provider_preset),task_status:Object.fromEntries((m.checks||[]).filter(c=>c.status!=='stale').map(c=>[c.task,c.status]))},
      config_signature: modelSignature(m, db.prepare('SELECT * FROM providers WHERE id=?').get(m.provider_id)),
      sizes:
        Array.isArray(m.extra.sizes) &&
        m.extra.sizes.some((s) => typeof s === 'string' && s.trim())
          ? m.extra.sizes.filter((s) => typeof s === 'string' && s.trim())
          : ['1024x1024'],
      variable_pricing:Array.isArray(m.pricing.image_rates)&&m.pricing.image_rates.length>0,
      price_per_call:
        Number.isSafeInteger(m.pricing.per_call) &&
        m.pricing.per_call >= 0 &&
        m.pricing.per_call <= 1000000000
          ? m.pricing.per_call
          : null,
    }));
}
export function resolveExploreModel(req, id, kind) {
  const cfg = getConfig();
  const all = availableModels(kind);
  if (!id && kind === 'chat') {
    const configured = getWorkerModel();
    id = all.find((m) => m.model_id === configured)?.id || all[0]?.id;
  }
  const listed = all.find((m) => m.id === id);
  if (!listed) throw problem('MODEL_UNAVAILABLE', '请选择已启用的模型及供应商');
  const model = getModel(listed.id);
  const user =
    req.userId &&
    getDb()
      .prepare('SELECT billing_mode FROM users WHERE id=?')
      .get(req.userId);
  const byok =
    kind === 'chat' && (!cfg.multiUser || user?.billing_mode === 'byok');
  let creds;
  if (byok) {
    const stored = cfg.multiUser ? getUserApiKeys(req.userId) : null;
    const personal = cfg.multiUser || !!req.headers['x-openrouter-key'];
    if (personal) {
      const apiKey =
        stored?.key || String(req.headers['x-openrouter-key'] || '');
      const rawBase =
        stored?.baseUrl || String(req.headers['x-api-base-url'] || '');
      if (!cfg.mockLlm && (!apiKey || !rawBase))
        throw problem(
          'BYOK_NOT_CONFIGURED',
          '自带 Key 模式需同时配置个人 Key 和 API 地址',
          422
        );
      const baseUrl = rawBase ? assertPublicHttpsUrl(rawBase) : '';
      creds = {
        apiKey,
        baseUrl,
        preset:
          stored?.provider ||
          String(req.headers['x-api-provider'] || '') ||
          detectProvider(baseUrl),
      };
    }
  }
  if (!creds) creds = getProviderCreds(model.provider_id);
  if (!cfg.mockLlm && (!creds?.apiKey || !creds?.baseUrl))
    throw problem(
      'MODEL_NOT_CONFIGURED',
      '所选模型的供应商尚未配置 Key 或地址',
      422
    );
  if (
    kind === 'image' &&
    !listed.capabilities.protocol
  )
    throw problem(
      'UNSUPPORTED_IMAGE_ADAPTER',
      '该供应商协议暂不支持此图片接口，请配置 DashScope 或 OpenAI 兼容供应商',
      422
    );
  if (kind === 'image' && listed.price_per_call === null)
    throw problem(
      'PRICE_NOT_CONFIGURED',
      '图片模型未配置有效积分价格，不能按免费调用',
      422
    );
  const pricing = model.pricing;
  if (
    kind === 'chat' &&
    cfg.multiUser &&
    !byok &&
    !cfg.mockLlm &&
    !['input_per_1m', 'output_per_1m'].every(
      (k) =>
        Number.isFinite(pricing[k]) &&
        pricing[k] >= 0 &&
        pricing[k] <= 1000000000
    )
  )
    throw problem('PRICE_NOT_CONFIGURED', '发散模型尚未配置有效价格', 422);
  return {
    ...listed,
    kind,
    pricing,
    provider_id: model.provider_id,
    provider: creds?.preset || 'custom',
    apiKey: creds?.apiKey || '',
    baseUrl: creds?.baseUrl || '',
    billable: !!(
      cfg.multiUser &&
      req.userId &&
      !cfg.mockLlm &&
      (kind === 'image' || !byok)
    ),
    prompt_extend: model.extra.prompt_extend !== false,
  };
}
export function publicModel(m) {
  const { apiKey, baseUrl, ...safe } = m;
  return safe;
}
