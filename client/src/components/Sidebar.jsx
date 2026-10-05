import { useEffect, useRef, useState } from 'react';
import { api, formatTime, getApiConfig } from '../api.js';
import { useAuth } from '../auth.jsx';
import Icon from './icons.jsx';
import ProfilePanel from './ProfilePanel.jsx';

export default function Sidebar({
  characters,
  config,
  view,
  convRefresh,
  theme,
  onToggleTheme,
  onSelectConversation,
  onOpenSettings,
  onCharacterCreated,
  onConversationDeleted,
  onConversationsChanged,
  onOpenSettingsModal,
  onToggleSidebar,
  showToast,
}) {
  const [apiCfg, setApiCfg] = useState(() => getApiConfig());
  const [expanded, setExpanded] = useState({});
  const [convs, setConvs] = useState({});
  const [modalOpen, setModalOpen] = useState(false);
  const [form, setForm] = useState({ name: '', avatar: '', temperature: '' });
  const [creating, setCreating] = useState(false);
  // 多用户模式：当前用户
  const { multiUser, user, logout } = useAuth();
  // 用户卡片：积分余额 + 管理员标识 + 菜单
  const [menuOpen, setMenuOpen] = useState(false);
  const [pointsInfo, setPointsInfo] = useState(null);
  const menuRef = useRef(null);
  // 群聊
  const [groups, setGroups] = useState([]);
  const [groupModalOpen, setGroupModalOpen] = useState(false);
  const [groupForm, setGroupForm] = useState({ name: '', memberIds: [] });
  const [creatingGroup, setCreatingGroup] = useState(false);

  const loadConvs = async (charId) => {
    const list = await api.listConversations(charId);
    setConvs((c) => ({ ...c, [charId]: list }));
  };

  const loadGroups = async () => {
    try {
      setGroups(await api.listGroups());
    } catch {
      /* 忽略 */
    }
  };

  // 对话列表变化（新建/改名/删除）时刷新所有展开角色的对话 + 群聊列表
  useEffect(() => {
    Object.keys(expanded)
      .filter((id) => expanded[id])
      .forEach((id) => {
        loadConvs(id).catch(() => {});
      });
    loadGroups();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [convRefresh]);

  useEffect(() => {
    loadGroups();
  }, []);

  // API 配置变化时刷新底部状态
  useEffect(() => {
    const onApiChanged = () => setApiCfg(getApiConfig());
    window.addEventListener('soulchat-api-changed', onApiChanged);
    return () => window.removeEventListener('soulchat-api-changed', onApiChanged);
  }, []);

  // 多用户模式：读取积分余额与管理员标识（聊天扣费后通过事件刷新）
  useEffect(() => {
    if (!multiUser) return;
    let cancelled = false;
    const load = () => {
      api
        .getPoints()
        .then((d) => {
          if (!cancelled) setPointsInfo(d);
        })
        .catch(() => {});
    };
    load();
    const onPts = () => load();
    window.addEventListener('soulchat-points-changed', onPts);
    return () => {
      cancelled = true;
      window.removeEventListener('soulchat-points-changed', onPts);
    };
  }, [multiUser]);

  // 用户菜单：点击外部关闭
  useEffect(() => {
    if (!menuOpen) return;
    const onDocDown = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', onDocDown);
    return () => document.removeEventListener('mousedown', onDocDown);
  }, [menuOpen]);

  const handleLogout = async () => {
    try {
      await logout();
    } catch {
      /* 忽略，本地状态已清 */
    }
  };

  const toggleExpand = (charId) => {
    setExpanded((e) => {
      const next = !e[charId];
      if (next) loadConvs(charId).catch(() => {});
      return { ...e, [charId]: next };
    });
  };

  const handleNewConversation = async (charId) => {
    try {
      const conv = await api.createConversation(charId);
      await loadConvs(charId);
      setExpanded((e) => ({ ...e, [charId]: true }));
      onSelectConversation(charId, conv.id);
    } catch (err) {
      showToast(err.message || '新建对话失败');
    }
  };

  const toggleGroupMember = (charId) => {
    setGroupForm((f) => ({
      ...f,
      memberIds: f.memberIds.includes(charId)
        ? f.memberIds.filter((id) => id !== charId)
        : [...f.memberIds, charId],
    }));
  };

  const handleCreateGroup = async () => {
    if (groupForm.memberIds.length < 2) {
      showToast('群聊至少选择 2 个角色');
      return;
    }
    setCreatingGroup(true);
    try {
      const g = await api.createGroup({ name: groupForm.name.trim(), member_ids: groupForm.memberIds });
      setGroupModalOpen(false);
      setGroupForm({ name: '', memberIds: [] });
      await loadGroups();
      onSelectConversation(null, g.id, true);
    } catch (err) {
      showToast(err.message || '建群失败');
    } finally {
      setCreatingGroup(false);
    }
  };

  const handleDeleteGroup = async (e, groupId) => {
    e.stopPropagation();
    if (!window.confirm('确定解散这个群聊吗？聊天记录会一起删除。')) return;
    try {
      await api.deleteConversation(groupId);
      await loadGroups();
      onConversationDeleted(null, groupId);
    } catch (err) {
      showToast(err.message || '删除失败');
    }
  };

  const handleDeleteConversation = async (e, charId, convId) => {
    e.stopPropagation();
    if (!window.confirm('确定删除这段对话吗？')) return;
    try {
      await api.deleteConversation(convId);
      await loadConvs(charId);
      onConversationDeleted(charId, convId);
    } catch (err) {
      showToast(err.message || '删除失败');
    }
  };

  const handleCreateCharacter = async () => {
    if (!form.name.trim()) {
      showToast('请填写角色名字');
      return;
    }
    setCreating(true);
    try {
      const payload = { name: form.name.trim() };
      if (form.avatar.trim()) payload.avatar = form.avatar.trim();
      if (form.temperature !== '' && !Number.isNaN(Number(form.temperature))) {
        payload.temperature = Number(form.temperature);
      }
      const char = await api.createCharacter(payload);
      setModalOpen(false);
      setForm({ name: '', avatar: '', temperature: '' });
      onCharacterCreated(char);
    } catch (err) {
      showToast(err.message || '创建失败');
    } finally {
      setCreating(false);
    }
  };

  const setField = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  return (
    <aside className="sidebar">
      <div className="sidebar-top">
        <span className="brand">SoulChat</span>
        <button className="collapse-btn" title="收起侧边栏" onClick={onToggleSidebar}>
          ‹
        </button>
      </div>

      <button className="nav-row" onClick={() => setModalOpen(true)}>
        <Icon name="plus" size={18} /> 新建角色
      </button>
      <button className="nav-row" onClick={() => setGroupModalOpen(true)}>
        <Icon name="users" size={18} /> 新建群聊
      </button>

      <div className="char-list">
        {characters.length === 0 && (
          <div className="sidebar-hint">还没有角色，点击上方「新建角色」创建第一个角色吧。</div>
        )}
        {characters.map((c) => {
          const isOpen = !!expanded[c.id];
          const list = convs[c.id] || [];
          const activeConv = view.type === 'chat' && view.characterId === c.id ? view.conversationId : null;
          return (
            <div key={c.id} className="char-block">
              <div
                className={`char-row ${view.characterId === c.id ? 'active' : ''}`}
                onClick={() => toggleExpand(c.id)}
              >
                <span className={`triangle ${isOpen ? 'open' : ''}`}>▸</span>
                <span className="char-avatar">{c.avatar || '✨'}</span>
                <span className="char-name">{c.name}</span>
                <span className="conv-badge" title="对话数">
                  {c.conversation_count || 0}
                </span>
                <button
                  className="gear-btn"
                  title="角色设置"
                  onClick={(e) => {
                    e.stopPropagation();
                    onOpenSettings(c.id);
                  }}
                >
                  <Icon name="gear" size={16} />
                </button>
              </div>
              {isOpen && (
                <div className="conv-list">
                  {list.map((conv) => (
                    <div
                      key={conv.id}
                      className={`conv-item ${activeConv === conv.id ? 'active' : ''}`}
                      onClick={() => onSelectConversation(c.id, conv.id)}
                      title={formatTime(conv.updated_at)}
                    >
                      <span className="conv-title">{conv.title || '未命名对话'}</span>
                      <button
                        className="conv-del"
                        title="删除对话"
                        onClick={(e) => handleDeleteConversation(e, c.id, conv.id)}
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                  <button className="new-conv-btn" onClick={() => handleNewConversation(c.id)}>
                    ＋ 新对话
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {groups.length > 0 && (
        <div className="group-section">
          <div className="group-section-head">
            <span>👥 群聊</span>
            <span className="conv-badge">{groups.length}</span>
          </div>
          {groups.map((g) => (
            <div
              key={g.id}
              className={`conv-item ${view && view.conversationId === g.id ? 'active' : ''}`}
              onClick={() => onSelectConversation(null, g.id, true)}
              title={formatTime(g.updated_at)}
            >
              <span className="conv-title">{g.title || '未命名群聊'}</span>
              <span className="conv-badge">{g.member_count}</span>
              <button
                className="conv-del"
                title="解散群聊"
                onClick={(e) => handleDeleteGroup(e, g.id)}
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="sidebar-footer">
      {multiUser && user ? (
        <div className="user-card-wrap" ref={menuRef}>
          <button className="user-row" onClick={() => setMenuOpen((o) => !o)} title="账户">
            <span className="profile-avatar sm">{(user.username || '?').slice(0, 1).toUpperCase()}</span>
            <span className="user-meta">
              <span className="user-name" title={user.username}>
                {user.username}
              </span>
              {pointsInfo && (
                <span className="user-points">{pointsInfo.balance} 积分</span>
              )}
            </span>
          </button>
          {menuOpen && (
            <ProfilePanel
              user={user}
              pointsInfo={pointsInfo}
              theme={theme}
              onSelect={(tab) => {
                setMenuOpen(false);
                onOpenSettingsModal(tab);
              }}
              onToggleTheme={onToggleTheme}
              onLogout={handleLogout}
            />
          )}
        </div>
      ) : (
        !multiUser && (
          <>
            <span className="key-status">
              {apiCfg.key
                ? '● 个人 Key'
                : config
                  ? config.has_key
                    ? '● 已连接'
                    : '○ 未配置 key'
                  : '…'}
            </span>
            <div className="footer-actions">
              <button
                className="icon-btn"
                title={theme === 'black' ? '切换到白色主题' : '切换到黑色主题'}
                onClick={onToggleTheme}
              >
                <Icon name={theme === 'black' ? 'sun' : 'moon'} size={18} />
              </button>
            </div>
          </>
        )
      )}
      </div>

      {groupModalOpen && (
        <div className="modal-overlay" onClick={() => setGroupModalOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h3>新建群聊</h3>
              <button className="modal-close" title="关闭" onClick={() => setGroupModalOpen(false)}>
                ✕
              </button>
            </div>
            <label>
              群名
              <input
                value={groupForm.name}
                onChange={(e) => setGroupForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="留空用成员名自动生成"
              />
            </label>
            <div className="member-picker">
              <div className="member-picker-title">选择成员（至少 2 个）</div>
              {characters.length === 0 && <div className="versions-empty">还没有角色，先去新建角色</div>}
              {characters.map((c) => (
                <label key={c.id} className="member-option">
                  <input
                    type="checkbox"
                    checked={groupForm.memberIds.includes(c.id)}
                    onChange={() => toggleGroupMember(c.id)}
                  />
                  <span className="member-avatar">{c.avatar || '✨'}</span>
                  <span>{c.name}</span>
                </label>
              ))}
            </div>
            <div className="modal-actions">
              <button className="btn secondary" onClick={() => setGroupModalOpen(false)}>
                取消
              </button>
              <button className="btn primary" onClick={handleCreateGroup} disabled={creatingGroup}>
                {creatingGroup ? '建群中…' : `建群（${groupForm.memberIds.length} 人）`}
              </button>
            </div>
          </div>
        </div>
      )}

      {modalOpen && (
        <div className="modal-overlay" onClick={() => setModalOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h3>新建角色</h3>
              <button className="modal-close" title="关闭" onClick={() => setModalOpen(false)}>
                ✕
              </button>
            </div>
            <label>
              名字 <span className="req">*</span>
              <input value={form.name} onChange={setField('name')} placeholder="例如：小狐狸阿璃" />
            </label>
            <label>
              头像 emoji
              <input value={form.avatar} onChange={setField('avatar')} placeholder="🦊（可选）" />
            </label>
            <label>
              温度（0~1）
              <input
                value={form.temperature}
                onChange={setField('temperature')}
                placeholder="留空用默认"
                inputMode="decimal"
              />
            </label>
            <div className="modal-actions">
              <button className="btn secondary" onClick={() => setModalOpen(false)}>
                取消
              </button>
              <button className="btn primary" onClick={handleCreateCharacter} disabled={creating}>
                {creating ? '创建中…' : '创建'}
              </button>
            </div>
          </div>
        </div>
      )}
    </aside>
  );
}
