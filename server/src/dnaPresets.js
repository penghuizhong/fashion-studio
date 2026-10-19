// DNA 类目预设：读取 / 提示词组装 / 中英 key 映射
import { getDb } from './db.js';

function parsePreset(row) {
  if (!row) return null;
  let fields = [];
  try { fields = JSON.parse(row.fields_json || '[]'); } catch { fields = []; }
  return {
    id: row.id,
    name: row.name,
    fields: Array.isArray(fields) ? fields.filter((f) => f && f.key && f.label) : [],
    prompt: row.prompt || '',
    expand_prompt: row.expand_prompt || '',
    sort_order: row.sort_order || 0,
    is_active: !!row.is_active,
  };
}

export function getPreset(id) {
  if (!id) return null;
  const db = getDb();
  return parsePreset(db.prepare('SELECT * FROM dna_presets WHERE id=?').get(String(id)));
}

export function listPresets(activeOnly = true) {
  const db = getDb();
  const rows = activeOnly
    ? db.prepare('SELECT * FROM dna_presets WHERE is_active=1 ORDER BY sort_order, id').all()
    : db.prepare('SELECT * FROM dna_presets ORDER BY sort_order, id').all();
  return rows.map(parsePreset).filter(Boolean);
}

// 组装发给模型的完整提示词：指引正文 + 按 fields 自动生成的中文 Schema
// （前端显示中文、传给模型也是中文；key 存库时再映射回英文）
export function buildExtractPrompt(preset) {
  const fields = preset.fields || [];
  const schemaObj = {};
  for (const f of fields) {
    const hint = String(f.hint || '').trim();
    schemaObj[f.label] = { value: hint || '识别值', confidence: 0 };
  }
  const schemaJson = JSON.stringify(schemaObj);
  const base = String(preset.prompt || '').trim();
  return `${base}\nSchema（value 建议值）：\n${schemaJson}`;
}

// 模型返回的中文 key JSON → 英文 key DNA（按 label→key 映射；对不上的 key 原样保留）
export function mapCnToEn(preset, cnDna) {
  const labelToKey = {};
  for (const f of (preset.fields || [])) labelToKey[f.label] = f.key;
  const dna = {};
  // 先按预设字段顺序建空架子，保证字段齐全
  for (const f of (preset.fields || [])) {
    dna[f.key] = { value: null, confidence: 0 };
  }
  if (cnDna && typeof cnDna === 'object') {
    for (const [k, v] of Object.entries(cnDna)) {
      const key = labelToKey[k] || k;
      if (v && typeof v === 'object' && 'value' in v) {
        dna[key] = { value: v.value == null ? null : v.value, confidence: Number(v.confidence) || 0 };
      } else if (v != null && typeof v !== 'object') {
        dna[key] = { value: v, confidence: 0.5 };
      }
    }
  }
  return dna;
}

// label 查 key（前端/后端共用逻辑）
export function labelOf(preset, key) {
  const f = (preset.fields || []).find((x) => x.key === key);
  return (f && f.label) || key;
}
