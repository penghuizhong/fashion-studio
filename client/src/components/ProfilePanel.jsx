// 用户浮层卡片（ChatGPT 式）：头像 + 用户名 + 积分，菜单项打开设置弹窗对应 tab
import Icon from './icons.jsx';

export default function ProfilePanel({ user, pointsInfo, theme, onSelect, onToggleTheme, onLogout }) {
  const initial = (user.username || '?').slice(0, 1).toUpperCase();
  const items = [
    { id: 'points', icon: 'coins', label: '积分' },
    { id: 'api', icon: 'plug', label: 'API 设置' },
    { id: 'invite', icon: 'gift', label: '邀请好友' },
  ];
  if (pointsInfo && pointsInfo.is_admin) {
    items.push({ id: 'stats', icon: 'chart', label: '用量统计' });
  }

  return (
    <div className="profile-panel" role="menu">
      <div className="profile-head">
        <span className="profile-avatar">{initial}</span>
        <span className="profile-meta">
          <span className="profile-name" title={user.username}>
            {user.username}
          </span>
          <span className="profile-sub">
            {pointsInfo ? `${pointsInfo.balance} 积分` : '…'}
          </span>
        </span>
      </div>
      <div className="profile-divider" />
      {items.map((it) => (
        <button key={it.id} className="profile-item" onClick={() => onSelect(it.id)}>
          <Icon name={it.icon} size={19} />
          <span>{it.label}</span>
        </button>
      ))}
      <div className="profile-divider" />
      <button className="profile-item" onClick={onToggleTheme}>
        <Icon name={theme === 'black' ? 'sun' : 'moon'} size={19} />
        <span>{theme === 'black' ? '浅色主题' : '深色主题'}</span>
      </button>
      <button className="profile-item danger" onClick={onLogout}>
        <Icon name="logout" size={19} />
        <span>退出登录</span>
      </button>
    </div>
  );
}
