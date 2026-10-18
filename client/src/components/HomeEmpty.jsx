// v0.3.1 首页改版：工作台式布局（数据概览+快捷入口+员工助手+最近作品）
// 不再是角色墙选妃模式
import { useEffect, useState } from 'react';
import { api, isMultiUserMode } from '../api.js';
import Icon from './icons.jsx';
import Avatar from './Avatar.jsx';

function imgUrl(p) {
  if (!p) return '';
  if (/^https?:\/\//.test(p)) return p;
  return p.startsWith('/') ? p : `/${p}`;
}

export default function HomeEmpty({
  user,
  config,
  onOpenSidebar,
  onOpenStudio,
  onOpenAssets,
  onAdopted,
  onRequireLogin,
  showToast,
}) {
  const loggedIn = !isMultiUserMode() || !!user;
  const [staff, setStaff] = useState([]);
  const [adoptingId, setAdoptingId] = useState(null);
  // 数据概览
  const [tplTotal, setTplTotal] = useState(null);
  const [tplGrowing, setTplGrowing] = useState(0);
  const [assetTotal, setAssetTotal] = useState(null);
  const [recentAssets, setRecentAssets] = useState([]);
  const [points, setPoints] = useState(null);

  useEffect(() => {
    api.getPresetCards().then((d) => setStaff((d && d.cards) || [])).catch(() => {});
    // 款式卡
    api.studio.listTemplates().then((r) => {
      const t = r.templates || [];
      setTplTotal(t.length);
      setTplGrowing(t.filter((x) => x.status !== 'final').length);
    }).catch(() => setTplTotal(0));
    // 资产库总数 + 最近 4 张
    api.studio.assets({ limit: 4 }).then((r) => {
      setAssetTotal(r.total || 0);
      setRecentAssets(r.assets || []);
    }).catch(() => setAssetTotal(0));
    // 积分（多用户模式）
    if (isMultiUserMode() && loggedIn) {
      api.getPoints().then((r) => setPoints(r.balance ?? r.points ?? null)).catch(() => {});
    }
  }, []);

  const adopt = async (card, presetId) => {
    if (!loggedIn) {
      onRequireLogin();
      return;
    }
    if (adoptingId) return;
    setAdoptingId(presetId);
    try {
      const r = await api.adoptCharacterCard({ preset_id: presetId });
      showToast(`已添加 ${r.character.name} 到通讯录`);
      onAdopted(r.character.id, r.conversation.id);
    } catch (e) {
      showToast((e && e.message) || '添加失败');
    } finally {
      setAdoptingId(null);
    }
  };

  const today = new Date();
  const dateStr = `${today.getMonth() + 1}月${today.getDate()}日`;
  const weekday = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][today.getDay()];

  return (
    <div className="home-empty">
      <header className="home-topbar">
        <button className="menu-btn icon-btn menu-btn-lg" title="打开侧边栏" onClick={onOpenSidebar}>
          <Icon name="menu" size={22} />
        </button>
        <span className="home-logo">Fashion Studio</span>
      </header>

      <div className="home-body work-body">
        <div className="work-greet">
          <h1 className="home-title">{dateStr} {weekday}，今天做什么？</h1>
        </div>

        {/* 数据概览 */}
        <div className="work-stats">
          <div className="work-stat" onClick={onOpenStudio}>
            <span className="work-stat-num">{tplTotal === null ? '–' : tplTotal}</span>
            <span className="work-stat-label">款式卡</span>
            {tplTotal > 0 && <span className="work-stat-sub">{tplGrowing} 培育中</span>}
          </div>
          <div className="work-stat" onClick={onOpenAssets}>
            <span className="work-stat-num">{assetTotal === null ? '–' : assetTotal}</span>
            <span className="work-stat-label">资产图片</span>
          </div>
          {points !== null && (
            <div className="work-stat">
              <span className="work-stat-num">{points}</span>
              <span className="work-stat-label">积分余额</span>
            </div>
          )}
        </div>

        {/* 快捷入口 */}
        <div className="work-actions">
          <button className="work-action primary" onClick={onOpenStudio}>
            <Icon name="sparkles" size={20} />
            <span>解析款式</span>
          </button>
          <button className="work-action" onClick={onOpenAssets}>
            <Icon name="image" size={20} />
            <span>资产库</span>
          </button>
        </div>

        {/* 员工助手 */}
        {staff.length > 0 && (
          <div className="work-section">
            <h3 className="work-section-title">员工助手</h3>
            <div className="work-staff">
              {staff.map((c) => (
                <button
                  key={c.id}
                  className="work-staff-card"
                  onClick={() => adopt(c, c.id)}
                  disabled={!!adoptingId}
                >
                  <Avatar src={c.avatar} size={48} />
                  <span className="work-staff-name">{c.name}</span>
                  <span className="work-staff-tag">{c.tagline}</span>
                  {adoptingId === c.id && <span className="orbit-loading">…</span>}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* 最近作品 */}
        {recentAssets.length > 0 && (
          <div className="work-section">
            <h3 className="work-section-title">最近作品</h3>
            <div className="work-recent">
              {recentAssets.map((a) => (
                <button key={a.id} className="work-recent-item" onClick={onOpenAssets}>
                  {(a.thumb_path || a.image_path) ? (
                    <img src={imgUrl(a.thumb_path || a.image_path)} alt="" loading="lazy" />
                  ) : (
                    <span className="dim">已删</span>
                  )}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
