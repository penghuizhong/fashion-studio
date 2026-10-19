// v1.20.0: API 提供商预设——协议（关思考参数/模型 ID 格式）与地址解耦。
// 同一家提供商可能有多个地址（北京/国际版/按量计费/workspace 专属），但协议相同；
// 因此"提供商选择"决定协议参数，地址框保持手填可编辑。

export const API_PROVIDERS = [
  {
    id: 'openrouter',
    name: 'OpenRouter',
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
    modelHint: '如 qwen/qwen3.5-plus、deepseek/deepseek-chat（带厂商前缀）',
    thinkingOff: { reasoning: { enabled: false } },
    note: '',
  },
  {
    id: 'dashscope',
    name: '千问 DashScope',
    defaultBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    modelHint: '如 qwen-plus、qwen3-max（不带 qwen/ 前缀）',
    thinkingOff: { enable_thinking: false },
    note: '',
  },
  {
    id: 'deepseek',
    name: 'DeepSeek 官方',
    defaultBaseUrl: 'https://api.deepseek.com/v1',
    modelHint: 'deepseek-chat（无思考）/ deepseek-reasoner（思考不可关）',
    thinkingOff: null,
    note: '只有 deepseek-reasoner（R1）的思考关不掉；chat/v3/v4 系列本身无思考或可关。走千问或 OpenRouter 调 deepseek-v4/v3 时，关思考按所选提供商的协议自动处理。',
  },
  {
    id: 'zhipu',
    name: '智谱 GLM',
    defaultBaseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    modelHint: '如 glm-4.6、glm-4.5',
    thinkingOff: { thinking: { type: 'disabled' } },
    note: '',
  },
  {
    id: 'custom',
    name: '自定义',
    defaultBaseUrl: '',
    modelHint: '按你的服务商文档填写模型 ID',
    thinkingOff: { reasoning: { enabled: false } },
    note: '',
  },
];

export function getProvider(id) {
  return API_PROVIDERS.find((p) => p.id === id) || API_PROVIDERS.find((p) => p.id === 'custom');
}

// 按 baseUrl 主机名模糊识别（老数据无 provider 字段时的回退；显式选择优先）
export function detectProvider(baseUrl) {
  const h = String(baseUrl || '').toLowerCase();
  if (h.includes('dashscope') || h.includes('aliyuncs.com')) return 'dashscope';
  if (h.includes('deepseek.com')) return 'deepseek';
  if (h.includes('bigmodel.cn')) return 'zhipu';
  if (h.includes('openrouter.ai')) return 'openrouter';
  return 'custom';
}

// 关思考参数：按提供商取预设；deepseek-reasoner 不可关；custom 回退保留 v1.19.1 的 qwen 模型名猜测
export function thinkingParams(providerId, model, enabled) {
  if(enabled !== undefined){
    if(thinkingControl(providerId,model)==='forced_on')return {};
    if(providerId==='deepseek')return {};
    if(providerId==='dashscope')return {enable_thinking:!!enabled};
    if(providerId==='zhipu')return {thinking:{type:enabled?'enabled':'disabled'}};
    if(providerId==='custom'&&/qwen/i.test(model||''))return {enable_thinking:!!enabled};
    return {reasoning:{enabled:!!enabled}};
  }
  const prov = getProvider(providerId);
  if (prov.id === 'deepseek') return {};
  if (prov.id === 'custom') {
    return {
      reasoning: { enabled: false },
      ...(/qwen/i.test(model || '') ? { enable_thinking: false } : {}),
    };
  }
  return prov.thinkingOff || { reasoning: { enabled: false } };
}

export function thinkingControl(providerId, model) {
  if (/reasoner|deepseek[/-]r1(?:$|[-/:])/i.test(model || '')) return 'forced_on';
  if (providerId === 'deepseek') return 'unsupported';
  return ['openrouter','dashscope','zhipu'].includes(providerId) ? 'toggle' : 'best_effort';
}
