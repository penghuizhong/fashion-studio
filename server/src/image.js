// v0.1.0: 生图统一入口。provider: dashscope | openai_compatible
// 按次扣积分；prompt 由 DNA 确定性渲染，不经过 LLM 自由发挥。
import { getConfig } from './config.js';
import { getProviderCreds, listImageModelsCompat } from './registry.js';
import { deductPoints, getBalance } from './points.js';
import sharp from 'sharp';
import fs from 'node:fs';
import path from 'node:path';

// ---------- 图片模型管理（v0.2.0: 改读统一注册表；增删改走 /api/admin/models） ----------
export function listImageModels(activeOnly = true) {
  return listImageModelsCompat(activeOnly);
}

export function getImageModel(id) {
  return listImageModelsCompat(false).find((x) => x.id === id || x.model_id === id) || null;
}

// ---------- DNA → prompt 确定性渲染 ----------
const DNA_FIELD_ORDER = [
  ['category', ''],
  ['silhouette', 'silhouette'],
  ['collar', ''],
  ['sleeve', ''],
  ['skirt', ''],
  ['fabric', 'fabric'],
  ['primary_color', 'color'],
  ['secondary_color', 'accent color'],
  ['style', 'style'],
  ['scene', ''],
];
const PROMPT_SUFFIX = 'high fashion photography, studio lighting, ultra detailed';

export function renderDnaPrompt(dna) {
  const v = (k) => (dna && dna[k] && dna[k].value) || '';
  const parts = [];
  for (const [key, suffix] of DNA_FIELD_ORDER) {
    const val = String(v(key) || '').replace(/_/g, ' ').trim();
    if (val && val !== 'null') parts.push(suffix ? `${val} ${suffix}` : val);
  }
  const det = v('details');
  if (Array.isArray(det)) {
    for (const d of det) {
      const s = String(d || '').replace(/_/g, ' ').trim();
      if (s) parts.push(s);
    }
  }
  parts.push(PROMPT_SUFFIX);
  return parts.filter(Boolean).join(', ');
}

// 换色/改细节：在渲染好的 prompt 基础上只替换目标字段（调用方先改 DNA 再渲染）
export function renderDnaPromptWithOverrides(dna, overrides) {
  const merged = JSON.parse(JSON.stringify(dna || {}));
  for (const [k, val] of Object.entries(overrides || {})) {
    merged[k] = { value: val, confidence: 1 };
  }
  return renderDnaPrompt(merged);
}

// ---------- adapter：dashscope（文生图，task 异步轮询） ----------
async function dashscopeText2Image({ baseUrl, apiKey, model, prompt, size, seed }) {
  const dsSize = String(size || '1024*1024').replace('x', '*');
  const submitRes = await fetch(`${baseUrl}/api/v1/services/aigc/text2image/image-synthesis`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      input: { prompt },
      parameters: { size: dsSize, n: 1, seed, prompt_extend: false, watermark: false },
    }),
    signal: AbortSignal.timeout(30000),
  });
  const submitJson = await submitRes.json().catch(() => null);
  if (!submitRes.ok) throw new Error(`DashScope 提交失败 HTTP ${submitRes.status}`);
  const taskId = submitJson && submitJson.output && submitJson.output.task_id;
  if (!taskId) throw new Error('DashScope 未返回 task_id');
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000));
    const stRes = await fetch(`${baseUrl}/api/v1/tasks/${taskId}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(15000),
    });
    const stJson = await stRes.json().catch(() => null);
    const out = stJson && stJson.output;
    const status = out && out.task_status;
    if (status === 'SUCCEEDED') {
      const url = out.results && out.results[0] && out.results[0].url;
      if (!url) throw new Error('DashScope 任务成功但无图片 URL');
      return { imageUrl: url, seed };
    }
    if (status === 'FAILED' || status === 'CANCELED') {
      throw new Error(`DashScope 生图失败: ${status}`);
    }
  }
  throw new Error('DashScope 生图超时（180s）');
}

// ---------- adapter：openai_compatible ----------
async function openaiText2Image({ baseUrl, apiKey, model, prompt, size, seed }) {
  const body = { model, prompt, size: String(size || '1024x1024').replace('*', 'x'), n: 1, response_format: 'b64_json' };
  if (seed != null) body.seed = seed;
  const res = await fetch(`${baseUrl}/v1/images/generations`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(180000),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`生图失败 HTTP ${res.status}`);
  const b64 = json && json.data && json.data[0] && json.data[0].b64_json;
  if (!b64) throw new Error('上游未返回图片数据');
  return { imageBase64: b64, seed };
}

async function openaiEditImage({ baseUrl, apiKey, model, prompt, size, imageBase64 }) {
  const buf = Buffer.from(imageBase64, 'base64');
  const form = new FormData();
  form.append('image', new Blob([buf], { type: 'image/png' }), 'source.png');
  form.append('model', model);
  form.append('prompt', prompt);
  form.append('size', String(size || '1024x1024').replace('*', 'x'));
  form.append('response_format', 'b64_json');
  const res = await fetch(`${baseUrl}/v1/images/edits`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
    signal: AbortSignal.timeout(180000),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`图生图失败 HTTP ${res.status}`);
  const b64 = json && json.data && json.data[0] && json.data[0].b64_json;
  if (!b64) throw new Error('上游未返回图片数据');
  return { imageBase64: b64 };
}

async function downloadToBase64(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error(`图片下载失败 HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return buf.toString('base64');
}

// ---------- 统一入口 ----------
// 先验余额 → 生图 → 成功后按次扣积分；失败不扣
// P4 回归用 1x1 占位 PNG（base64）
const MOCK_PLACEHOLDER_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

export async function generateImage({ userId, modelId, prompt, size, seed, sourceImageBase64 = null }) {
  const m = listImageModelsCompat(true).find((x) => x.id === modelId || x.model_id === modelId);
  if (!m) throw new Error('图片模型不存在或已停用');
  // P4: mock 模式——保留模型存在性校验，跳过上游网络调用，不扣费（供回归）
  if (getConfig().mockLlm) {
    return { imageBase64: MOCK_PLACEHOLDER_PNG, seed: seed != null ? seed : 1, model: m.model_id, size, price: 0 };
  }
  const creds = getProviderCreds(m.provider_id);
  const apiKey = creds && creds.apiKey;
  if (!apiKey) throw new Error('该图片模型未配置 Key');
  const baseUrl = String((creds && creds.baseUrl) || '').replace(/\/+$/, '');
  if (!baseUrl) throw new Error('该图片模型未配置 Base URL');
  const price = m.price_per_call | 0;
  if (price > 0 && userId) {
    const bal = getBalance(userId);
    if (bal < price) throw new Error('积分不足，请充值或切换模型');
  }
  const useSeed = seed != null ? seed : Math.floor(Math.random() * 2147483647);
  let result;
  if (m.provider === 'dashscope') {
    if (sourceImageBase64) throw new Error('DashScope 适配器暂不支持图生图，请选用 openai_compatible 供应商');
    result = await dashscopeText2Image({ baseUrl, apiKey, model: m.model_id, prompt, size, seed: useSeed });
    result.imageBase64 = await downloadToBase64(result.imageUrl);
    delete result.imageUrl;
  } else {
    result = sourceImageBase64
      ? await openaiEditImage({ baseUrl, apiKey, model: m.model_id, prompt, size, imageBase64: sourceImageBase64 })
      : await openaiText2Image({ baseUrl, apiKey, model: m.model_id, prompt, size, seed: useSeed });
    result.seed = useSeed;
  }
  if (price > 0 && userId) {
    deductPoints(userId, price, 'studio_image', 'models', m.id, { model: m.model_id, size });
  }
  return { imageBase64: result.imageBase64, seed: result.seed != null ? result.seed : useSeed, model: m.model_id, size, price };
}

// ---------- 落盘：原图 + sharp 缩略图，返回相对路径 ----------
export async function saveStudioImage(imageBase64, filename) {
  const cfg = getConfig();
  const dataDir = cfg.dataDir || path.join(process.cwd(), 'data');
  const dir = path.join(dataDir, 'uploads', 'studio');
  const thumbDir = path.join(dir, 'thumbs');
  fs.mkdirSync(thumbDir, { recursive: true });
  const buf = Buffer.from(imageBase64, 'base64');
  const rel = path.posix.join('uploads', 'studio', filename);
  const thumbRel = path.posix.join('uploads', 'studio', 'thumbs', filename);
  fs.writeFileSync(path.join(dir, filename), buf);
  await sharp(buf).resize({ width: 600, withoutEnlargement: true }).jpeg({ quality: 82 }).toFile(path.join(thumbDir, filename));
  return { image_path: rel, thumb_path: thumbRel };
}
