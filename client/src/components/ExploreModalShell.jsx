import { useEffect, useRef } from 'react';

// One scroll owner; the header, navigation and footer are siblings of the body.
export default function ExploreModalShell({ onClose, hasViewer, header, navigation, footer, children }) {
  const ref = useRef(null);
  useEffect(() => {
    const opener = document.activeElement;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    ref.current?.focus();
    return () => { document.body.style.overflow = previous; opener?.focus(); };
  }, []);
  const keyDown = e => {
    if (hasViewer) return;
    if (e.key === 'Escape') { e.stopPropagation(); onClose(); }
    if (e.key !== 'Tab') return;
    const nodes = [...ref.current.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, a[href], [tabindex="0"]')].filter(n => n.getClientRects().length);
    const first = nodes[0], last = nodes[nodes.length - 1];
    if (e.shiftKey && (document.activeElement === first || document.activeElement.tabIndex === -1)) {
      e.preventDefault(); last?.focus();
    } else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
  };
  return <div className="modal-overlay explore-overlay">
    <div ref={ref} className="modal-box studio-modal explore-modal" role="dialog" aria-modal="true" aria-label="创意衍生" tabIndex={-1} onKeyDown={keyDown}>
      {header}{navigation}{children}{footer}
    </div>
  </div>;
}
