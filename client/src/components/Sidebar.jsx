import { useEffect, useRef, useState } from 'react';
import { api, formatTime, getApiConfig } from '../api.js';
import { useAuth } from '../auth.jsx';
import Icon from './icons.jsx';
import ProfilePanel from './ProfilePanel.jsx';
import CreateCharacterModal from './CreateCharacterModal.jsx';
import Avatar from './Avatar.jsx';
import Modal from './Modal.jsx';

export default function Sidebar({
  characters,
  config,
  view,
  convRefresh,
  theme,
  guest,
  onToggleTheme,
  onSelectConversation,
  onOpenSettings,
  onCharacterCreated,
  onConversationDeleted,
  onConversationsChanged,
  onOpenSettingsModal,
  onOpenDiscover,
  onLogin,
  onToggleSidebar,
  showToast,
}) {
  const [apiCfg, setApiCfg] = useState(() => getApiConfig());
  const [expanded, setExpanded] = useState({});
  const [convs, setConvs] = useState({});
  const [modalOpen, setModalOpen] = useState(false);
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
  // v1.18.0: 对话长按菜单（改名/删除）
  const [convMenu, setConvMenu] = useState(null); // { charId, conv, x, y }
  const [renamingConv, setRenamingConv] = useState(null); // { charId, convId, value }
  const pressTimer = useRef(null);
  const pressFired = useRef(false);
  const cancelPress = () => {
    if (pressTimer.current) { clearTimeout(pressTimer.current); pressTimer.current = null; }
  };
  const openConvMenu = (x, y, charId, conv) => setConvMenu({ charId, conv, x, y });
  const startPress = (e, charId, conv) => {
    if (e.touches && e.touches.length === 1) {
      const t = e.touches[0];
      pressTimer.current = setTimeout(() => {
        pressFired.current = true; // 长按后抑制随之而来的 click
        openConvMenu(t.clientX, t.clientY, charId, conv);
      }, 550);
    }
  };
  const handleConvClick = (charId, convId) => {
    if (pressFired.current) { pressFired.current = false; return; }
    onSelectConversation(charId, convId);
  };

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

  const doDeleteConv = async (charId, convId) => {
    if (!window.confirm('确定删除这段对话吗？')) return;
    try {
      await api.deleteConversation(convId);
      await loadConvs(charId);
      onConversationDeleted(charId, convId);
    } catch (err) {
      showToast(err.message || '删除失败');
    }
  };
  const handleDeleteConversation = (e, charId, convId) => {
    e.stopPropagation();
    doDeleteConv(charId, convId);
  };
  // v1.18.0: 长按菜单改名
  const saveConvRename = async () => {
    const v = (renamingConv.value || '').trim();
    if (!v) { showToast('名称不能为空'); return; }
    try {
      await api.renameConversation(renamingConv.convId, v);
      const { charId } = renamingConv;
      setRenamingConv(null);
      await loadConvs(charId);
      if (onConversationsChanged) onConversationsChanged();
    } catch (err) {
      showToast(err.message || '改名失败');
    }
  };

  return (
    <aside className="sidebar">
      <div className="sidebar-top">
        <span className="brand">SoulChat</span>
        <button className="collapse-btn" title="收起侧边栏" onClick={onToggleSidebar}>
          ‹
        </button>
      </div>

      {!guest && (
        <>
          <button className="nav-row" onClick={() => setModalOpen(true)}>
            <Icon name="plus" size={18} /> 新建角色
          </button>
          <button className="nav-row" onClick={() => setGroupModalOpen(true)}>
            <Icon name="users" size={18} /> 新建群聊
          </button>
        </>
      )}
      <button
        className={`nav-row${view.type === 'discover' ? ' active' : ''}`}
        onClick={onOpenDiscover}
      >
        <Icon name="compass" size={18} /> 发现角色
      </button>

      {guest ? (
        <div className="char-list">
          <div className="sidebar-hint">登录后开始聊天，领养你喜欢的角色吧。</div>
        </div>
      ) : (
      <>
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
                <Avatar src={c.avatar} size={36} className="char-avatar" />
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
                      onClick={() => handleConvClick(c.id, conv.id)}
                      onTouchStart={(e) => startPress(e, c.id, conv)}
                      onTouchEnd={cancelPress}
                      onTouchMove={cancelPress}
                      onContextMenu={(e) => { e.preventDefault(); openConvMenu(e.clientX, e.clientY, c.id, conv); }}
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
      </>
      )}

      <div className="sidebar-footer">
      {guest ? (
        <button className="btn primary block" onClick={onLogin}>
          登录 / 注册
        </button>
      ) : multiUser && user ? (
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
        <Modal
          title="新建群聊"
          size="s"
          onClose={() => setGroupModalOpen(false)}
          footer={
            <>
              <button className="btn secondary" onClick={() => setGroupModalOpen(false)}>
                取消
              </button>
              <button className="btn primary" onClick={handleCreateGroup} disabled={creatingGroup}>
                {creatingGroup ? '建群中…' : `建群（${groupForm.memberIds.length} 人）`}
              </button>
            </>
          }
        >
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
                <Avatar src={c.avatar} size={28} className="member-avatar" />
                <span>{c.name}</span>
              </label>
            ))}
          </div>
        </Modal>
      )}

      {modalOpen && (
        <CreateCharacterModal
          onClose={() => setModalOpen(false)}
          onCreated={onCharacterCreated}
          showToast={showToast}
        />
      )}

      {/* v1.18.0: 对话长按菜单 */}
      {convMenu && (
        <div
          className="conv-menu-backdrop"
          onClick={() => setConvMenu(null)}
          onContextMenu={(e) => e.preventDefault()}
        >
          <div
            className="conv-menu"
            style={{
              left: Math.min(convMenu.x, window.innerWidth - 150),
              top: Math.min(convMenu.y, window.innerHeight - 130),
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="conv-menu-title">{convMenu.conv.title || '未命名对话'}</div>
            <button
              className="conv-menu-item"
              onClick={() => {
                setRenamingConv({ charId: convMenu.charId, convId: convMenu.conv.id, value: convMenu.conv.title || '' });
                setConvMenu(null);
              }}
            >
              ✏️ 改名
            </button>
            <button
              className="conv-menu-item danger"
              onClick={() => {
                const { charId, conv } = convMenu;
                setConvMenu(null);
                doDeleteConv(charId, conv.id);
              }}
            >
              🗑️ 删除
            </button>
          </div>
        </div>
      )}

      {/* v1.18.0: 对话改名弹窗 */}
      {renamingConv && (
        <Modal title="重命名对话" size="s" onClose={() => setRenamingConv(null)}>
          <input
            className="input"
            value={renamingConv.value}
            autoFocus
            maxLength={30}
            placeholder="输入对话名称"
            onChange={(e) => setRenamingConv({ ...renamingConv, value: e.target.value })}
            onKeyDown={(e) => { if (e.key === 'Enter') saveConvRename(); }}
          />
          <div className="modal-actions">
            <button className="btn" onClick={() => setRenamingConv(null)}>取消</button>
            <button className="btn primary" onClick={saveConvRename}>保存</button>
          </div>
        </Modal>
      )}
    </aside>
  );
}
