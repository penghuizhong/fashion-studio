import { DESIGN_STANDARD_MAX_LENGTH } from '../../../shared/exploreDesign.js';
// Only restore fields supported by the current server schema. No credentials or images.
export function sanitizeExploreDraft(saved, presets, models) {
  const warnings = [];
  const preset = presets.find(p => p.id === saved.presetId) || presets[0];
  if (!preset) return { draft: saved, warnings: ['暂无可用类目，请重新加载配置'] };
  if (preset.id !== saved.presetId) warnings.push('草稿类目已失效，已切换可用类目，请重新选择变化与保留条件');
  const keys = new Set(preset.fields.map(f => f.key));
  const locked = Object.fromEntries(Object.entries(saved.locked || {}).filter(([key]) => keys.has(key)).map(([key,value]) => [key, Array.isArray(value) ? value.join('、') : String(value)]));
  const axes = (Array.isArray(saved.axes) ? saved.axes : []).filter(key => keys.has(key) && !locked[key]?.trim());
  if (axes.length !== saved.axes?.length || Object.keys(locked).length !== Object.keys(saved.locked || {}).length) warnings.push('草稿中的失效字段已移除，请检查设计条件');
  const model = models.find(m => m.id === saved.expandId) || models[0];
  if (model?.id !== saved.expandId) warnings.push('草稿发散模型已不可用，请确认当前模型后提交');
  const count = Number.isInteger(saved.count) && saved.count >= 1 && saved.count <= 16 ? saved.count : 6;
  if (count !== saved.count) warnings.push('草稿方案数量已恢复为 6，请确认');
  const designStandard = typeof saved.designStandard === 'string' ? saved.designStandard.slice(0, DESIGN_STANDARD_MAX_LENGTH) : '';
  return { draft: {...saved,designStandard,presetId:preset.id,axes,locked,expandId:model?.id || '',count}, warnings };
}
