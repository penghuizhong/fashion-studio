// v0.2.0: 工作站占位页（样衣台 / 制版台，功能待定）
import Icon from './icons.jsx';

export default function StationPlaceholder({ icon, title, desc }) {
  return (
    <div className="studio-view">
      <div className="studio-empty">
        <Icon name={icon} size={40} />
        <p>{title}</p>
        <p className="dim">{desc || '即将上线，敬请期待'}</p>
      </div>
    </div>
  );
}
