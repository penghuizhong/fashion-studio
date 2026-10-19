import { useState } from 'react';

function Preview({ paths, alt, ...props }) {
  const [index, setIndex] = useState(0);
  if (!paths[index]) return <div className="studio-card-nocover" role="status"><span className="dim">图片文件缺失</span></div>;
  return <img {...props} src={`/${paths[index]}`} alt={alt || ''} onError={() => setIndex(i => i + 1)} />;
}

// A failed thumbnail falls back to the original. Never leave an empty card.
export default function StudioImage({ thumbnail, original, ...props }) {
  const paths = [...new Set([thumbnail, original].filter(Boolean))];
  return <Preview key={JSON.stringify(paths)} paths={paths} {...props} />;
}
