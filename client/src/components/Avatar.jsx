// v1.16.0: 通用头像组件
// v1.25.5: 默认头像改用 SVG 图标，不再用 emoji
// avatar 为图片路径（/avatars/... 或 http）时渲染 <img>，否则渲染 SVG 默认头像
import Icon from './icons.jsx';

export default function Avatar({ src, size = 40, className = '', alt = '' }) {
  const isImage = typeof src === 'string' && (/^https?:\/\//.test(src) || src.startsWith('/'));
  if (isImage) {
    return (
      <img
        src={src}
        alt={alt || '头像'}
        className={`avatar-img ${className}`.trim()}
        style={{ width: size, height: size, borderRadius: '50%', objectFit: 'cover', flexShrink: 0 }}
        loading="lazy"
      />
    );
  }
  return (
    <span
      className={`avatar-svg ${className}`.trim()}
      style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: size, height: size, borderRadius: '50%', background: 'var(--bg-tertiary)', color: 'var(--text-secondary)', flexShrink: 0 }}
    >
      <Icon name="user" size={size * 0.55} />
    </span>
  );
}
