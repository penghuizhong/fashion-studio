import { useEffect, useRef, useState } from 'react';
import OriginalImageLink from './OriginalImageLink.jsx';
export default function OriginalImageViewer({ image, onClose, onProperties }) {
  const ref = useRef(null);
  const [actual, setActual] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const dialog = ref.current;
    dialog.showModal();
    return () => dialog.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className="original-image-viewer"
      aria-label={`${image.name} 原图`}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <header>
        <strong>{image.name}</strong>
        <div className="original-image-actions">
          <button
            className="btn secondary small"
            onClick={() => setActual((x) => !x)}
          >
            {actual ? '适应窗口' : '实际尺寸'}
          </button>
          <OriginalImageLink path={image.path} />
          <button className="btn secondary small" onClick={onProperties}>
            款式属性
          </button>
          <button className="icon-btn" aria-label="关闭原图" onClick={onClose}>
            ×
          </button>
        </div>
      </header>
      <div className={`original-image-content${actual ? ' actual-size' : ''}`}>
        {!loaded && !failed && <p role="status">正在加载原图…</p>}
        {failed && <p role="alert">原图加载失败，可关闭后重试。</p>}
        <img
          src={`/${image.path}`}
          alt={image.name}
          onLoad={() => setLoaded(true)}
          onError={() => setFailed(true)}
        />
      </div>
    </dialog>
  );
}
