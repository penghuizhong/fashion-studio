// 角色卡：官方预设卡加载/校验 + AI 生成卡的 prompt 与解析
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 分类 id → 中文名（前后端共用展示）
export const CARD_CATEGORIES = {
  romance: '恋爱',
  comfort: '治愈',
  anime: '二次元',
  xianxia: '仙侠',
  mystery: '悬疑',
  comedy: '搞笑',
  history: '历史',
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PRESET_PATH = path.resolve(__dirname, 'data/preset-cards.json');

let cache = null;
function readPresetFile() {
  try {
    const raw = fs.readFileSync(PRESET_PATH, 'utf8');
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

// 预设卡字段校验（加载期）：缺关键字段的卡直接丢弃并打日志
function isValidPreset(c) {
  return (
    c &&
    typeof c.id === 'string' && c.id.trim() &&
    typeof c.name === 'string' && c.name.trim() &&
    typeof c.greeting === 'string' && c.greeting.trim() &&
    typeof c.soul_md === 'string' && c.soul_md.trim() &&
    CARD_CATEGORIES[c.category]
  );
}

export function getPresetCards() {
  if (!cache) {
    const list = readPresetFile().filter(isValidPreset);
    const seen = new Set();
    cache = list.filter((c) => {
      if (seen.has(c.id)) return false;
      seen.add(c.id);
      return true;
    });
    if (cache.length !== list.length) console.warn('[character-cards] 预设卡有重复 id，已去重');
  }
  return cache;
}

export function getPresetCard(id) {
  return getPresetCards().find((c) => c.id === id) || null;
}

// AI 生成卡输入清洗：只收白名单字段，全部截断，防止脏数据入库
const str = (v, max) => String(v ?? '').trim().slice(0, max);
export function sanitizeCardInput(obj) {
  const o = obj && typeof obj === 'object' ? obj : {};
  const tags = Array.isArray(o.tags) ? o.tags.map((t) => str(t, 10)).filter(Boolean).slice(0, 6) : [];
  const dialogues = Array.isArray(o.example_dialogues)
    ? o.example_dialogues
        .slice(0, 4)
        .map((d) => ({ user: str(d && d.user, 500), assistant: str(d && d.assistant, 1000) }))
        .filter((d) => d.user && d.assistant)
    : [];
  return {
    name: str(o.name, 20),
    avatar: str(o.avatar, 8) || '🤖',
    tagline: str(o.tagline, 40),
    category: CARD_CATEGORIES[o.category] ? o.category : 'comfort',
    tags,
    description: str(o.description, 500),
    greeting: str(o.greeting, 2000),
    soul_md: str(o.soul_md, 8000),
    example_dialogues: dialogues,
  };
}

export function isAdoptableCard(c) {
  return !!(c && c.name && c.greeting && c.soul_md);
}

// ---------- AI 生成 ----------
const GENERATE_SYSTEM = `你是角色卡设计师。根据用户的一句话描述，设计一张中文 AI 聊天角色卡。
只输出 JSON，不要任何其他文字，不要 markdown 代码块。JSON 结构如下：
{
  "name": "角色名（2-6字）",
  "avatar": "单个最贴切的 emoji",
  "tagline": "一句话卖点，不超过20字",
  "category": "从 romance|comfort|anime|xianxia|mystery|comedy|history 中选最贴切的一个",
  "tags": ["标签1", "标签2"],
  "description": "60-120字介绍",
  "greeting": "80-150字场景式开场白：有具体场景、有正在发生的事件、性格鲜明，给用户留选择空间，绝不替用户写行动",
  "soul_md": "300-600字人设，包含：身份背景、性格、外形特征、说话风格、与用户的初始关系、行为禁忌",
  "example_dialogues": [{"user": "...", "assistant": "..."}, {"user": "...", "assistant": "..."}]
}
要求：
- 关系渐进：初次见面不许满好感，不许油腻土味情话
- 语言口语自然，像真人聊天，不要 AI 腔
- 严格禁止：擦边/性暗示、真人明星仿真、医疗诊断建议、自残相关内容`;

export function buildGenerateMessages(desc) {
  return [
    { role: 'system', content: GENERATE_SYSTEM },
    { role: 'user', content: `请为下面这句话描述的角色生成角色卡：\n${desc}` },
  ];
}

function stripFences(text) {
  return String(text || '')
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim();
}

// 解析模型输出为角色卡；失败抛 Error（调用方转 502）
export function parseGeneratedCard(text) {
  let obj;
  try {
    obj = JSON.parse(stripFences(text));
  } catch {
    throw new Error('模型返回的不是合法 JSON');
  }
  const card = sanitizeCardInput(obj);
  if (!isAdoptableCard(card)) throw new Error('模型返回的角色卡缺少关键字段（名字/开场白/人设）');
  if (!CARD_CATEGORIES[card.category]) card.category = 'comfort';
  return card;
}
