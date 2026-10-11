// v1.26.0: 语音功能——DashScope ASR/TTS 客户端 + VoiceProvider 抽象
// v1.26.1: 模型改为从 sys_settings 读取（管理员可在模型管理 tab 配置）
import { getConfig } from './config.js';
import { getSetting } from './db.js';

const DASHSCOPE_BASE = (process.env.DASHSCOPE_BASE_URL || 'https://dashscope.aliyuncs.com').replace(/\/+$/, '');
// v1.26.4: 支持自定义 DashScope API 地址（千问 token-plan 等），默认官方地址保底

// 语音模型配置（默认值；管理员可在模型管理 tab 覆盖）
export const VOICE_MODELS = {
  asr: {
    flash: 'qwen-audio-3.0-asr-flash',
  },
  tts: {
    flash: 'qwen3-tts-flash',
    plus: 'qwen-audio-3.0-tts-plus',
  },
  design: 'qwen3-tts-vd-2026-01-26',
  // v1.29.0: 克隆音色合成模型（须与克隆时 target_model 一致）
  vc: 'qwen3-tts-vc-2026-01-22',
};

// 获取实际使用的模型（配置优先，其次默认）
export function getVoiceModel(type) {
  // type: 'tts' | 'asr' | 'design' | 'vc'
  const key = `voice_${type}_model`;
  try {
    const v = getSetting(key, '');
    if (v && v.trim()) return v.trim();
  } catch {}
  if (type === 'tts') return VOICE_MODELS.tts.plus;
  if (type === 'asr') return VOICE_MODELS.asr.flash;
  if (type === 'design') return VOICE_MODELS.design;
  if (type === 'vc') return VOICE_MODELS.vc;
  return '';
}

// VoiceProvider 抽象：主供应商 DashScope，预留降级接口
class DashScopeVoiceProvider {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.name = 'dashscope';
  }

  // ASR: 音频 Buffer → 文字
  // audioBuffer: Buffer, mimeType: 如 'audio/webm'
  async asr(audioBuffer, { model = null, language = 'zh' } = {}) {
    // v1.26.1: 模型从配置读取
    const useModel = model || getVoiceModel('asr');
    const cfg = getConfig();
    if (cfg.mockLlm) return { text: '（mock 语音识别）', duration: 0 };

    // DashScope 录音文件识别：先上传音频获取 URL，或用 base64
    // 使用兼容模式的 transcription 接口
    const res = await fetch(`${DASHSCOPE_BASE}/compatible-mode/v1/audio/transcriptions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: this._buildFormData(audioBuffer, useModel, language),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new Error(`ASR 失败 (${res.status}): ${t.slice(0, 200)}`);
    }
    const json = await res.json();
    return {
      text: json.text || '',
      duration: json.duration || 0,
    };
  }

  _buildFormData(audioBuffer, model, language) {
    const form = new FormData();
    const blob = new Blob([audioBuffer], { type: 'audio/webm' });
    form.append('file', blob, 'audio.webm');
    form.append('model', model);
    if (language) form.append('language', language);
    return form;
  }

  // TTS: 文字 → 音频 Buffer (mp3)
  // 返回 { audio: Buffer, chars: 计费字符数 }
  async tts(text, { model = null, voice = 'Cherry', speed = 1.0 } = {}) {
    // v1.26.1: 模型从配置读取
    const useModel = model || getVoiceModel('tts');
    const cfg = getConfig();
    if (cfg.mockLlm) return { audio: Buffer.from('mock'), chars: text.length };

    const res = await fetch(`${DASHSCOPE_BASE}/compatible-mode/v1/audio/speech`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: useModel,
        input: text,
        voice,
        speed,
        response_format: 'mp3',
      }),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new Error(`TTS 失败 (${res.status}): ${t.slice(0, 200)}`);
    }
    const audio = Buffer.from(await res.arrayBuffer());
    // 计费字符数：汉字按 2 字符计（百炼口径）
    const chars = [...text].reduce((n, ch) => n + (ch.codePointAt(0) > 0xff ? 2 : 1), 0);
    return { audio, chars };
  }

  // ============ v1.27.0: 音色克隆（音频文件 → 定制音色） ============
  // audioBuffer: 参考音频（15-60秒，清晰人声，无背景音乐）
  // 返回 { voiceId, name }
  async cloneVoice(audioBuffer, { name, mimeType = 'audio/wav' } = {}) {
    const cfg = getConfig();
    if (cfg.mockLlm) {
      return { voiceId: `mock_clone_${Date.now()}`, name: name || 'mock' };
    }
    // 构建 multipart/form-data
    const boundary = `----soulchat${Date.now()}`;
    const parts = [];
    const enc = new TextEncoder();
    // 文件部分
    parts.push(enc.encode(`--${boundary}\r\n`));
    parts.push(enc.encode(`Content-Disposition: form-data; name="file"; filename="voice_sample.wav"\r\n`));
    parts.push(enc.encode(`Content-Type: ${mimeType}\r\n\r\n`));
    parts.push(audioBuffer);
    parts.push(enc.encode(`\r\n`));
    // 参数部分
    const fields = {
      model: 'qwen-voice-enrollment',
      target_model: 'qwen3-tts-vc-2026-01-22',
      action: 'create',
      preferred_name: name,
    };
    for (const [k, v] of Object.entries(fields)) {
      parts.push(enc.encode(`--${boundary}\r\n`));
      parts.push(enc.encode(`Content-Disposition: form-data; name="${k}"\r\n\r\n`));
      parts.push(enc.encode(`${v}\r\n`));
    }
    parts.push(enc.encode(`--${boundary}--\r\n`));
    // 合并
    const totalLen = parts.reduce((s, p) => s + p.length, 0);
    const body = new Uint8Array(totalLen);
    let off = 0;
    for (const p of parts) { body.set(p, off); off += p.length; }

    const res = await fetch(`${DASHSCOPE_BASE}/api/v1/services/audio/tts/customization`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
      },
      body,
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new Error(`音色克隆失败 (${res.status}): ${t.slice(0, 200)}`);
    }
    const json = await res.json();
    const voiceId = json?.output?.voice || json?.output?.voice_id;
    if (!voiceId) throw new Error('音色克隆失败：未返回 voice_id');
    return { voiceId, name };
  }

  // ============ v1.26.0: 声音设计（文本描述 → 定制音色） ============
  // prompt: 音色描述（如"温柔的年轻女性声音，略带沙哑"）
  // 返回 { voiceId, previewAudio(base64), name }
  async designVoice({ prompt, previewText = '你好，很高兴认识你。', name, language = 'zh' }) {
    const cfg = getConfig();
    if (cfg.mockLlm) {
      return { voiceId: `mock_voice_${Date.now()}`, previewAudio: null, name: name || 'mock' };
    }
    const res = await fetch(`${DASHSCOPE_BASE}/api/v1/services/audio/tts/customization`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'qwen-voice-design',
        target_model: getVoiceModel('design'), // v1.26.1: 从配置读取
        action: 'create',
        voice_prompt: prompt,
        preview_text: previewText,
        preferred_name: name,
        language,
      }),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new Error(`声音设计失败 (${res.status}): ${t.slice(0, 200)}`);
    }
    const json = await res.json();
    const out = json.output || json;
    return {
      voiceId: out.voice?.name || out.voice_id || out.name,
      previewAudio: out.audio?.data || out.preview_audio || null,
      name: name,
    };
  }
}

// Provider 单例（懒初始化）
let _provider = null;
export function getVoiceProvider() {
  if (_provider) return _provider;
  const cfg = getConfig();
  const key = (process.env.DASHSCOPE_API_KEY || '').trim();
  if (!key && !cfg.mockLlm) throw new Error('未配置 DASHSCOPE_API_KEY');
  _provider = new DashScopeVoiceProvider(key);
  return _provider;
}

// ============ v1.26.0: 语音积分定价 ============
// 1元 = 100积分
// ASR: 成本 ~0.022积分/秒 → 收 1积分/10秒（向上取整，最少1）
// TTS: 成本 ~0.015积分/字符(汉字×2) → 收 1积分/30字符（向上取整，最少1）
export const VOICE_PRICING = {
  asrPer10s: 1,
  ttsPer30Chars: 1,
  // 余额低于此值时 TTS 自动降级 flash
  downgradeThreshold: 50,
};

export function calcAsrPoints(durationSec) {
  const units = Math.max(1, Math.ceil((durationSec || 0) / 10));
  return units * VOICE_PRICING.asrPer10s;
}

export function calcTtsPoints(chars) {
  const units = Math.max(1, Math.ceil((chars || 0) / 30));
  return units * VOICE_PRICING.ttsPer30Chars;
}

// ============ v1.26.0: 音频缓存（7天） ============
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

function voiceCacheDir() {
  const cfg = getConfig();
  const dir = path.join(cfg.dataDir, 'voice_cache');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function cacheKey(text, voice, speed, model, userId) {
  // v1.28.1: 缓存键带用户隔离，防跨用户免扣费蹭缓存
  return crypto.createHash('sha256').update(`${userId || 'local'}|${text}|${voice}|${speed}|${model}`).digest('hex');
}

export function getCachedAudio(text, voice, speed, model, userId) {
  try {
    const key = cacheKey(text, voice, speed, model, userId);
    const fp = path.join(voiceCacheDir(), `${key}.mp3`);
    if (!fs.existsSync(fp)) return null;
    const stat = fs.statSync(fp);
    // 7天过期
    if (Date.now() - stat.mtimeMs > 7 * 24 * 3600 * 1000) {
      fs.unlinkSync(fp);
      return null;
    }
    return fs.readFileSync(fp);
  } catch {
    return null;
  }
}

export function setCachedAudio(text, voice, speed, model, audioBuffer, userId) {
  try {
    const key = cacheKey(text, voice, speed, model, userId);
    const fp = path.join(voiceCacheDir(), `${key}.mp3`);
    fs.writeFileSync(fp, audioBuffer);
  } catch (e) {
    console.warn('[voice] 缓存写入失败:', e.message);
  }
}

// 供测试重置
export function resetVoiceProvider() {
  _provider = null;
}

// ============ v1.26.0: 对白提取（三层启发式） ============

// 清理 markdown，不适合朗读的符号
export function cleanForTts(text) {
  if (!text) return '';
  return (
    String(text)
      // 代码块
      .replace(/```[\s\S]*?```/g, '')
      // 行内代码
      .replace(/`([^`]*)`/g, '$1')
      // 加粗/斜体
      .replace(/(\*\*|__)(.*?)\1/g, '$2')
      .replace(/(\*|_)(.*?)\1/g, '$2')
      // 标题
      .replace(/^#{1,6}\s+/gm, '')
      // 链接 [text](url) → text
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      // 图片 ![alt](url)
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      // 多余空行
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  );
}

// 第一层：引号提取 「」『』""
function extractQuoted(text) {
  const re = /「([^」]*)」|『([^』]*)』|"([^"]*)"|"([^"]*)"/g;
  const out = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    const s = (m[1] || m[2] || m[3] || m[4] || '').trim();
    if (s) out.push(s);
  }
  return out;
}

// 第二层：冒号/破折号行内对话
function extractLined(text) {
  const out = [];
  for (const line of String(text).split('\n')) {
    const t = line.trim();
    // "名字：对白" 或 "- 对白"
    let m = t.match(/^(?:[^：:]{1,12}[：:])\s*(.+)$/);
    if (m && m[1].trim()) {
      out.push(m[1].trim());
      continue;
    }
    m = t.match(/^[-–—]\s*(.+)$/);
    if (m && m[1].trim()) out.push(m[1].trim());
  }
  return out;
}

// 主入口：返回对白数组；都没命中返回 null（调用方决定兜底）
export function extractDialogue(text) {
  const clean = cleanForTts(text);
  if (!clean) return null;
  const q = extractQuoted(clean);
  if (q.length) return q;
  const l = extractLined(clean);
  if (l.length) return l;
  return null;
}

// ============ 句子切分 ============
// 按 。！？\n 切，超长句按 ，二次切
export function splitSentences(text, maxLen = 50) {
  if (!text) return [];
  const parts = String(text)
    .split(/(?<=[。！？\n])/)
    .map((s) => s.trim())
    .filter(Boolean);
  const out = [];
  for (const p of parts) {
    if ([...p].length <= maxLen || !p.includes('，')) {
      out.push(p);
    } else {
      // 长句按逗号切
      const subs = p.split(/(?<=，)/).map((s) => s.trim()).filter(Boolean);
      out.push(...subs);
    }
  }
  return out;
}
