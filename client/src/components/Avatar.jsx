// v1.16.0: 通用头像组件
// avatar 为图片路径（/avatars/... 或 http）时渲染 <img>，否则按 emoji/文字渲染
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
      className={`avatar-emoji ${className}`.trim()}
      style={{ fontSize: size * 0.72, lineHeight: 1, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: size, height: size, flexShrink: 0 }}
    >
      {src || '🤖'}
    </span>
  );
}
