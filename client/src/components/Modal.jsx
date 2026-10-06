// v1.16.0: 统一弹窗基础组件
// 所有弹窗共用：统一遮罩/圆角/标题栏/尺寸/手机端底部上滑
// 用法：<Modal title="标题" size="m" onClose={fn}>内容</Modal>
// size: s=340px（确认框） m=480px（新建角色/用户资料） l=640px（设置/角色设置）
// v1.16.1: 用 Portal 渲染到 body，避免被侧边栏 backdrop-filter 锁住 fixed 定位
import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import Icon from './icons.jsx';

export default function Modal({
  title,
  size = 'm',
  onClose,
  children,
  footer = null,
  headerExtra = null,
  closeOnOverlay = true,
  className = '',
}) {
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape' && onClose) onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return createPortal(
    <div
      className="modal-overlay"
      onClick={() => {
        if (closeOnOverlay && onClose) onClose();
      }}
    >
      <div
        className={`modal modal-${size} ${className}`.trim()}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={typeof title === 'string' ? title : '弹窗'}
      >
        <div className="modal-head">
          <h3>{title}</h3>
          {onClose && (
            <button className="modal-close" title="关闭" onClick={onClose}>
              <Icon name="x" size={16} />
            </button>
          )}
        </div>
        {headerExtra}
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>,
    document.body
  );
}
