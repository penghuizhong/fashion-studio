import { useCallback, useEffect, useRef, useState } from 'react';
import Sidebar from './components/Sidebar.jsx';
import ChatView from './components/ChatView.jsx';
import SettingsView from './components/SettingsView.jsx';
import SettingsModal from './components/SettingsModal.jsx';
import AuthPage from './components/AuthPage.jsx';
import { useAuth } from './auth.jsx';
import { api } from './api.js';

// view = { type: 'empty' } | { type: 'chat', characterId, conversationId } | { type: 'settings', characterId }

export default function App() {
  const { multiUser, user, authReady } = useAuth();
  const [config, setConfig] = useState(null);
  const [characters, setCharacters] = useState([]);
  const [view, setView] = useState({ type: 'empty' });
  const [toast, setToast] = useState(null);
  const [convRefresh, setConvRefresh] = useState(0);
  // 设置弹窗：{ open, tab }
  const [settingsModal, setSettingsModal] = useState({ open: false, tab: 'points' });
  const toastTimer = useRef(null);

  // 侧边栏显隐：桌面端默认展开并记忆偏好；移动端默认收起为抽屉
  const [sidebarOpen, setSidebarOpen] = useState(() => {
    if (typeof window !== 'undefined' && window.innerWidth <= 768) return false;
    try {
      return localStorage.getItem('soulchat-sidebar') !== '0';
    } catch {
      return true;
    }
  });
  const toggleSidebar = useCallback(() => {
    setSidebarOpen((o) => {
      const next = !o;
      if (window.innerWidth > 768) {
        try {
          localStorage.setItem('soulchat-sidebar', next ? '1' : '0');
        } catch {
          /* 忽略 */
        }
      }
      return next;
    });
  }, []);

  // 主题：纯白 / 纯黑，localStorage 记忆，首次跟随系统
  const [theme, setTheme] = useState(() => {
    try {
      const saved = localStorage.getItem('soulchat-theme');
      if (saved === 'black' || saved === 'white') return saved;
    } catch {
      /* 忽略 */
    }
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches
      ? 'black'
      : 'white';
  });
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem('soulchat-theme', theme);
    } catch {
      /* 忽略 */
    }
  }, [theme]);

  const refreshCharacters = useCallback(async () => {
    const list = await api.listCharacters();
    setCharacters(list);
  }, []);

  useEffect(() => {
    api.getConfig().then(setConfig).catch(() => setConfig({ has_key: false }));
  }, []);

  // 路由守卫：多用户模式下必须登录后才能进主界面、拉取角色；
  // 单用户模式 authReady 后即拉取（行为与原来一致，守卫不触发）。
  const canEnter = authReady && (!multiUser || !!user);
  useEffect(() => {
    if (!canEnter) return;
    refreshCharacters().catch(() => {});
  }, [canEnter, refreshCharacters]);

  // 退出登录后清理，避免残留上一个用户的数据
  useEffect(() => {
    if (authReady && multiUser && !user) {
      setCharacters([]);
      setView({ type: 'empty' });
    }
  }, [authReady, multiUser, user]);

  const showToast = useCallback((text, ms = 2500) => {
    setToast({ text, id: Date.now() });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), ms);
  }, []);

  const bumpConversations = useCallback(() => setConvRefresh((k) => k + 1), []);

  const handleSelectConversation = useCallback((characterId, conversationId, isGroup = false) => {
    setView({ type: 'chat', characterId, conversationId, isGroup });
    // 移动端抽屉：选中对话后自动收起
    if (window.innerWidth <= 768) setSidebarOpen(false);
  }, []);

  const handleOpenSettings = useCallback((characterId) => {
    setView({ type: 'settings', characterId });
  }, []);

  const handleCharacterCreated = useCallback(
    async (char) => {
      await refreshCharacters();
      setView({ type: 'settings', characterId: char.id });
      showToast('角色已创建 🎉');
    },
    [refreshCharacters, showToast]
  );

  const handleCharacterDeleted = useCallback(
    async (characterId) => {
      await refreshCharacters();
      bumpConversations();
      setView({ type: 'empty' });
      showToast('角色已删除');
    },
    [refreshCharacters, bumpConversations, showToast]
  );

  const handleConversationDeleted = useCallback(
    (characterId, conversationId) => {
      bumpConversations();
      setView((v) => {
        if (v.type === 'chat' && v.conversationId === conversationId) {
          return { type: 'empty' };
        }
        return v;
      });
    },
    [bumpConversations]
  );

  const toggleTheme = useCallback(
    () => setTheme((t) => (t === 'black' ? 'white' : 'black')),
    []
  );

  // 多用户模式：启动检查完成前显示中性加载页；未登录则全屏登录/注册页。
  // 单用户模式直接渲染主界面（一个字都不变）。
  if (!authReady && multiUser) {
    return (
      <div className="auth-splash">
        <span>加载中…</span>
      </div>
    );
  }
  if (authReady && multiUser && !user) {
    return <AuthPage theme={theme} onToggleTheme={toggleTheme} />;
  }

  return (
    <div className={`app${sidebarOpen ? ' sidebar-open' : ''}`}>
      <Sidebar
        characters={characters}
        config={config}
        view={view}
        convRefresh={convRefresh}
        theme={theme}
        onToggleTheme={toggleTheme}
        onOpenSettingsModal={(tab) => {
          setSettingsModal({ open: true, tab: tab || 'points' });
          if (window.innerWidth <= 768) setSidebarOpen(false);
        }}
        onSelectConversation={handleSelectConversation}
        onOpenSettings={handleOpenSettings}
        onCharacterCreated={handleCharacterCreated}
        onConversationDeleted={handleConversationDeleted}
        onConversationsChanged={bumpConversations}
        onToggleSidebar={toggleSidebar}
        showToast={showToast}
      />
      <div className="backdrop" onClick={() => setSidebarOpen(false)} />
      <button
        className="sidebar-expand-btn"
        title="展开侧边栏"
        onClick={toggleSidebar}
      >
        ›
      </button>
      <main className="main">
        {view.type === 'chat' && (
          <ChatView
            key={view.conversationId}
            characterId={view.characterId}
            conversationId={view.conversationId}
            isGroup={!!view.isGroup}
            onConversationsChanged={bumpConversations}
            onOpenSidebar={() => setSidebarOpen(true)}
            showToast={showToast}
          />
        )}
        {view.type === 'settings' && (
          <SettingsView
            key={view.characterId}
            characterId={view.characterId}
            onCharacterUpdated={refreshCharacters}
            onCharacterDeleted={handleCharacterDeleted}
            onOpenSidebar={() => setSidebarOpen(true)}
            showToast={showToast}
          />
        )}
        {view.type === 'empty' && (
          <div className="empty-state">
            <button className="menu-btn icon-btn" title="打开侧边栏" onClick={() => setSidebarOpen(true)}>
              ☰
            </button>
            <div className="empty-logo">💬</div>
            <h2>SoulChat</h2>
            <p>从左侧选择角色或群聊开始，也可以新建角色、发起群聊。</p>
          </div>
        )}
      </main>
      {settingsModal.open && (
        <SettingsModal
          initialTab={settingsModal.tab}
          onClose={() => setSettingsModal((s) => ({ ...s, open: false }))}
          showToast={showToast}
        />
      )}
      {toast && (
        <div className="toast" key={toast.id}>
          {toast.text}
        </div>
      )}
    </div>
  );
}
