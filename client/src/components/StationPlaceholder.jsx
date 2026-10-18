// v0.2.0: 工作站占位页（样衣台 / 制版台，功能待定）
import Icon from './icons.jsx';

export default function StationPlaceholder({ icon, title, desc, onOpenSidebar }) {
  return (
    <div className="studio-view">
      {onOpenSidebar && (
        <button className="menu-btn icon-btn menu-btn-lg station-topbar-btn" title="打开侧边栏" onClick={onOpenSidebar}>
          <Icon name="menu" size={22} />
        </button>
      )}
      <div className="studio-empty">
        <Icon name={icon} size={40} />
        <p>{title}</p>
        <p className="dim">{desc || '即将上线，敬请期待'}</p>
      </div>
    </div>
  );
}
