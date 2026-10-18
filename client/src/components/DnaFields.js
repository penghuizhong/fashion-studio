// P4 发散创建：DNA 字段定义（key 对齐后端 DNA schema）
export const DNA_FIELDS = [
  { key: 'category', label: '品类' },
  { key: 'silhouette', label: '版型' },
  { key: 'collar', label: '领型' },
  { key: 'sleeve', label: '袖型' },
  { key: 'skirt', label: '裙摆' },
  { key: 'fabric', label: '面料' },
  { key: 'primary_color', label: '主色' },
  { key: 'secondary_color', label: '辅色' },
  { key: 'style', label: '风格' },
  { key: 'details', label: '细节元素' },
  { key: 'scene', label: '场景' },
];

// 默认发散轴：风格相关 5 轴
export const DEFAULT_AXES = ['silhouette', 'fabric', 'style', 'details', 'scene'];

// DNA 字段值格式化（value 可能是数组）
export function fmtDnaValue(v) {
  if (v == null || v === '') return '—';
  if (Array.isArray(v)) return v.length ? v.join('、') : '—';
  return String(v);
}
