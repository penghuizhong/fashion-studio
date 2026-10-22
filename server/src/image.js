import { writeStudioPreview } from './studioPreview.js';
import { imageOptions } from './imageCapabilities.js';
import { photographyPrompt } from '../../shared/photography.js';
// v0.1.0: 生图统一入口。provider: dashscope | openai_compatible
// 按次扣积分；prompt 由 DNA 确定性渲染，不经过 LLM 自由发挥。
import { dnaRenderProfiles, categorySubjects, mappedDnaValue } from './dnaRenderProfiles.js';
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
  return listImageModelsCompat(false).find((x) => x.id === id) || null;
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

export function renderDnaPrompt(input) {
  // Backwards compatible with template generation that passes bare DNA.
  const context = input && Object.hasOwn(input, 'dna') ? input : { dna: input };
  const { dna, presetId = '', intentText = '', camera } = context;
  const v = (k) => (dna && dna[k] && dna[k].value) || '';
  const parts = [camera?.scope === 'set' && presetId === 'suit' ? "men's coordinated suit, complete jacket and matching trousers" : dnaRenderProfiles[presetId]?.subject || categorySubjects[presetId] || 'fashion garment'];
  const seen = new Set();
  for (const [key, suffix] of DNA_FIELD_ORDER) {
    const val = mappedDnaValue(presetId, key, v(key) || '');
    if (val && val !== 'null') parts.push(suffix ? `${val} ${suffix}` : val);
    seen.add(key);
  }
  // P5: 预设新字段（lapel/buttons/waist/rise 等）不在旧顺序表里，按 dna 自身顺序追加
  if (dna && typeof dna === 'object') {
    for (const key of Object.keys(dna)) {
      if (seen.has(key) || key === 'details') continue;
      const val = v(key);
      const s = Array.isArray(val) ? val.join(', ') : String(val || '');
      const clean = mappedDnaValue(presetId, key, s);
      if (clean && clean !== 'null') parts.push(clean);
    }
  }
  const det = v('details');
  if (Array.isArray(det)) {
    for (const d of det) {
      const s = mappedDnaValue(presetId,'details',d);
      if (s) parts.push(s);
    }
  }
  if (String(intentText || '').trim()) parts.push(`Design requirements from client: ${String(intentText).slice(0, 500).trim()}`);
  parts.push(PROMPT_SUFFIX);
  if (camera) parts.push(photographyPrompt(camera, presetId));
  return [...new Set(parts.filter(Boolean))].join(', ');
}

// 换色/改细节：在渲染好的 prompt 基础上只替换目标字段（调用方先改 DNA 再渲染）
export function renderDnaPromptWithOverrides(dna, overrides) {
  const merged = JSON.parse(JSON.stringify(dna || {}));
  for (const [k, val] of Object.entries(overrides || {})) {
    merged[k] = { value: val, confidence: 1 };
  }
  return renderDnaPrompt(merged);
}

// ---------- adapter：dashscope（qwen-image 系列，新 multimodal-generation 同步接口） ----------
// 官方文档：POST {baseUrl}/api/v1/services/aigc/multimodal-generation/generation
// qwen-image-3.0 / 2.1-pro 均支持同步调用；旧 text2image/image-synthesis 仅适用 wan2.x
// 注意：baseUrl 若配的是 compatible-mode/v1（OpenAI 兼容地址），需剥掉后缀再拼原生路径
export async function dashscopeText2Image({ baseUrl, apiKey, model, prompt, size, seed, promptExtend = true }) {
  const nativeBase = String(baseUrl || '').replace(/\/+$/, '').replace(/\/compatible-mode\/v1$/, '');
  const dsSize = String(size || '1024*1024').replace('x', '*');
  const params = { size: dsSize, n: 1, prompt_extend: !!promptExtend, watermark: false };
  // 官方文档：enable_thinking 默认 true 且要求 prompt_extend=true；显式声明避免 prompt_extend=false 时 400
  params.enable_thinking = !!promptExtend;
  if (seed != null) params.seed = seed;
  const res = await fetch(`${nativeBase}/api/v1/services/aigc/multimodal-generation/generation`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      input: { messages: [{ role: 'user', content: [{ text: prompt }] }] },
      parameters: params,
    }),
    signal: AbortSignal.timeout(180000),
  });
  const json = await res.json().catch(() => null);
  // 注意：同步接口成功响应体只有 {output, usage, request_id}，没有 status_code 字段
  // （status_code 是 DashScope SDK 的封装概念）；仅以 HTTP 状态 + 响应体是否可解析判定
  if (!res.ok || !json) {
    const msg = (json && (json.message || json.code)) || `HTTP ${res.status}`;
    throw Object.assign(new Error('DashScope 生图失败'),{status:res.status});
  }
  const content = json.output && json.output.choices && json.output.choices[0] &&
    json.output.choices[0].message && json.output.choices[0].message.content;
  const url = Array.isArray(content) && content[0] && content[0].image;
  if (!url) throw new Error('DashScope 未返回图片 URL');
  return { imageUrl: url, seed };
}

// ---------- adapter：openai_compatible ----------
export function imageApiUrl(baseUrl, endpoint) {
  const base=String(baseUrl).replace(/\/+$/, '');
  const pathPart=new URL(base).pathname;
  return `${base}${pathPart==='/'?'/v1':''}/images/${endpoint}`;
}

async function openaiText2Image({ baseUrl, apiKey, model, prompt, size, seed, quality, options }) {
  const body = { model, prompt, size: String(size || '1024x1024').replace('*', 'x'), n: 1 };
  if(options.response_format!=='omit')body.response_format=options.response_format;
  if (options.seed && seed != null) body.seed = seed;
  if (quality) body.quality = quality;
  const requestUrl=options.generation_path?baseUrl.replace(/\/$/,'')+options.generation_path:imageApiUrl(baseUrl,'generations');
  const res = await fetch(requestUrl, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(180000),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw Object.assign(new Error('生图失败'),{status:res.status});
  const b64 = json?.data?.[0]?.b64_json || (json?.data?.[0]?.url ? await downloadToBase64(json.data[0].url) : null);
  if (!b64) throw new Error('上游未返回图片数据');
  return { imageBase64: b64, seed, request_transport:{operation:'text_to_image',protocol:'openai_images',endpoint:new URL(requestUrl).pathname,image_count:0,output_count:1} };
}

async function openaiEditImage({ baseUrl, apiKey, model, prompt, size, imageBase64, referenceImages = [], quality, options }) {
  const buf = Buffer.from(imageBase64, 'base64');
  const form = new FormData();
  const images=[buf,...referenceImages.map(b=>Buffer.from(b,'base64'))];
  for(const [index,bytes] of images.entries()){const metadata=await sharp(bytes).metadata();const ext=metadata.format==='jpeg'?'jpg':metadata.format;form.append(images.length>1?'image[]':'image',new Blob([bytes],{type:`image/${metadata.format==='jpg'?'jpeg':metadata.format}`}),`source_${index}.${ext}`);}
  if(quality) form.append('quality',quality);
  form.append('n', '1');
  form.append('model', model);
  form.append('prompt', prompt);
  form.append('size', String(size || '1024x1024').replace('*', 'x'));
  if(options.response_format!=='omit')form.append('response_format', options.response_format);
  const requestUrl=options.edit_path?baseUrl.replace(/\/$/,'')+options.edit_path:imageApiUrl(baseUrl,'edits');
  const res = await fetch(requestUrl, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
    signal: AbortSignal.timeout(180000),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw Object.assign(new Error('图生图失败'),{status:res.status});
  const b64 = json?.data?.[0]?.b64_json || (json?.data?.[0]?.url ? await downloadToBase64(json.data[0].url) : null);
  if (!b64) throw new Error('上游未返回图片数据');
  return { imageBase64: b64, request_transport:{operation:'image_edit',protocol:'openai_images',endpoint:new URL(requestUrl).pathname,image_count:images.length,output_count:1} };
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

export async function generateImage({ userId, modelId, prompt, size, seed, quality = '', sourceImageBase64 = null, referenceImages = [], executionModel = null, deferBilling = false }) {
  const m = executionModel || listImageModelsCompat(true).find((x) => x.id === modelId);
  if (!m) throw new Error('图片模型不存在或已停用');
  // P4: mock 模式——保留模型存在性校验，跳过上游网络调用，不扣费（供回归）
  if (getConfig().mockLlm) {
    return { imageBase64: MOCK_PLACEHOLDER_PNG, seed: seed != null ? seed : 1, model: m.model_id, size, price: 0, request_transport:{operation:'mock',image_count:(sourceImageBase64?1:0)+referenceImages.length,output_count:1} };
  }
  const creds = executionModel || getProviderCreds(m.provider_id);
  const apiKey = creds && creds.apiKey;
  if (!apiKey) throw new Error('该图片模型未配置 Key');
  const baseUrl = String((creds && creds.baseUrl) || '').replace(/\/+$/, '');
  if (!baseUrl) throw new Error('该图片模型未配置 Base URL');
  const price = m.price_per_call;
  if (!deferBilling && price > 0 && userId) {
    const bal = getBalance(userId);
    if (bal < price) throw new Error('积分不足，请充值或切换模型');
  }
  const useSeed = seed != null ? seed : Math.floor(Math.random() * 2147483647);
  let result;
  const options = m.capabilities || imageOptions(m.extra,creds.preset);
  if(sourceImageBase64 && (!options.image_edit || referenceImages.length+1>options.max_images))throw new Error('所选模型不支持此参考图数量');
  if(!sourceImageBase64 && !options.text)throw new Error('所选模型不支持无图生成');
  if(options.protocol === 'dashscope_multimodal') {
    const content = await Promise.all([sourceImageBase64,...referenceImages].filter(Boolean).map(async data=>{const meta=await sharp(Buffer.from(data,'base64')).metadata();return {image:`data:image/${meta.format==='jpg'?'jpeg':meta.format};base64,${data}`};}));
    content.push({text:prompt});
    const url = baseUrl.replace(/\/(compatible-mode\/v1|api\/v1|v1)\/?$/, '') + '/api/v1/services/aigc/multimodal-generation/generation';
    const response = await fetch(url,{method:'POST',headers:{Authorization:`Bearer ${apiKey}`,'Content-Type':'application/json'},body:JSON.stringify({model:m.model_id,input:{messages:[{role:'user',content}]},parameters:{size:String(size).replace('x','*'),n:1,watermark:false,prompt_extend:false}}),signal:AbortSignal.timeout(180000)});
    const json=await response.json();
    if(!response.ok)throw Object.assign(new Error('图像请求失败'),{status:response.status});
    const output=json.output?.choices?.[0]?.message?.content?.find(x=>x.image)?.image;
    if(!output)throw new Error('上游未返回图片');
    result={imageBase64:output.startsWith('data:')?output.split(',')[1]:await downloadToBase64(output),seed:useSeed,request_transport:{operation:sourceImageBase64?'image_edit':'text_to_image',protocol:options.protocol,endpoint:new URL(url).pathname,image_count:content.filter(c=>c.image).length,output_count:1}};
  } else if (options.protocol === 'dashscope') {
    if (sourceImageBase64) throw new Error('DashScope 适配器暂不支持图生图，请选用 openai_compatible 供应商');
    result = await dashscopeText2Image({ baseUrl, apiKey, model: m.model_id, prompt, size, seed: useSeed, promptExtend: m.prompt_extend });
    result.imageBase64 = await downloadToBase64(result.imageUrl);
    delete result.imageUrl;
    result.request_transport={operation:'text_to_image',protocol:options.protocol,endpoint:'/api/v1/services/aigc/multimodal-generation/generation',image_count:0,output_count:1};
  } else if(options.protocol === 'openai_images') {
    result = sourceImageBase64
      ? await openaiEditImage({ baseUrl, apiKey, model: m.model_id, prompt, size, imageBase64: sourceImageBase64, referenceImages, quality, options })
      : await openaiText2Image({ baseUrl, apiKey, model: m.model_id, prompt, size, seed: useSeed, quality, options });
    result.seed = useSeed;
  }
  if(!result)throw new Error('未配置可用图片协议');
  if (!deferBilling && price > 0 && userId) {
    deductPoints(userId, price, 'studio_image', 'models', m.id, { model: m.model_id, size });
  }
  return { imageBase64: result.imageBase64, seed: result.seed != null ? result.seed : useSeed, model: m.model_id, size, price, request_transport: result.request_transport };
}

// ---------- 落盘：原图 + sharp 缩略图，返回相对路径 ----------
export async function saveStudioImage(imageBase64, filename) {
  const cfg = getConfig();
  const dataDir = cfg.dataDir || path.join(process.cwd(), 'data');
  const dir = path.join(dataDir, 'uploads', 'studio');
  const thumbDir = path.join(dir, 'thumbs');
  fs.mkdirSync(thumbDir, { recursive: true });
  const buf = Buffer.from(imageBase64, 'base64');
  const metadata=await sharp(buf).metadata();
  if(!['png','jpeg','webp','avif','heif','gif','tiff'].includes(metadata.format)||!metadata.width||!metadata.height||metadata.width*metadata.height>40000000)throw Object.assign(new Error('仅支持不超过 4000 万像素的位图'),{code:'INVALID_IMAGE',statusCode:400,publicMessage:'仅支持不超过 4000 万像素的 PNG、JPEG、WebP 等位图'});
  const extension=metadata.format==='jpeg'?'jpg':metadata.format;
  const stem=path.parse(path.basename(filename)).name;
  filename=`${stem}.${extension}`;
  const thumbFilename=`${stem}.jpg`;
  const rel = path.posix.join('uploads', 'studio', filename);
  const thumbRel = path.posix.join('uploads', 'studio', 'thumbs', thumbFilename);
  const original=path.join(dir,filename), thumb=path.join(thumbDir,thumbFilename);
  const token=`.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(original+token,buf);
    await sharp(buf).resize({width:600,height:600,fit:'inside',withoutEnlargement:true}).jpeg({quality:82}).toFile(thumb+token);
    fs.renameSync(original+token,original);fs.renameSync(thumb+token,thumb);
    // A derivative failure must not discard a successfully saved original.
    await writeStudioPreview(buf, rel).catch(()=>{});
  } catch(e) {
    for(const f of [original+token,thumb+token])try{fs.unlinkSync(f);}catch{}
    throw e;
  }
  return { image_path: rel, thumb_path: thumbRel };
}
