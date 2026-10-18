// 图片模型家族 → 尺寸预设（API 原生值）
// 来源：各模型官方文档（OpenAI / DashScope / Civitai 社区常用值）
// 用途：上架图片模型时按家族自动带出尺寸档位，仍可手动修改
export const SIZE_FAMILIES = [
  {
    id: 'generic',
    label: '通用（1024 方图）',
    sizes: ['1024x1024'],
    keywords: [],
  },
  {
    id: 'dalle3',
    label: 'DALL-E 3',
    sizes: ['1024x1024', '1792x1024', '1024x1792'],
    keywords: ['dall-e-3', 'dalle-3', 'dall-e3'],
  },
  {
    id: 'dalle2',
    label: 'DALL-E 2',
    sizes: ['256x256', '512x512', '1024x1024'],
    keywords: ['dall-e-2', 'dalle-2', 'dall-e2'],
  },
  {
    id: 'gptimage',
    label: 'GPT-Image（gpt-image-1/1.5）',
    sizes: ['1024x1024', '1536x1024', '1024x1536', 'auto'],
    keywords: ['gpt-image'],
  },
  {
    id: 'wanx',
    label: '通义万相（wanx）',
    sizes: ['1024*1024', '720*1280', '768*1152', '1152*768', '1280*720'],
    keywords: ['wanx', '万相', 'wan2', 'wan-2'],
  },
  {
    id: 'sd15',
    label: 'SD 1.5 系',
    sizes: ['512x512', '768x512', '512x768', '768x768'],
    keywords: ['sd-1.5', 'sd1.5', 'stable-diffusion-1', 'stable-diffusion-v1'],
  },
  {
    id: 'sdxl',
    label: 'SDXL 系',
    sizes: ['1024x1024', '1216x832', '832x1216', '1344x768', '768x1344'],
    keywords: ['sdxl', 'stable-diffusion-xl'],
  },
  {
    id: 'flux',
    label: 'Flux 系',
    sizes: ['1024x1024', '1344x768', '768x1344'],
    keywords: ['flux'],
  },
];

// 按模型 ID 关键词猜家族；猜不到返回 'generic'
export function guessFamily(modelId) {
  const id = String(modelId || '').toLowerCase();
  if (!id) return 'generic';
  for (const f of SIZE_FAMILIES) {
    if (f.id === 'generic') continue;
    if (f.keywords.some((k) => id.includes(k))) return f.id;
  }
  return 'generic';
}

export function familyById(id) {
  return SIZE_FAMILIES.find((f) => f.id === id) || SIZE_FAMILIES[0];
}
