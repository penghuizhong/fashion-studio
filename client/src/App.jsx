import { useCallback, useEffect, useRef, useState } from 'react';
import Sidebar from './components/Sidebar.jsx';
import ChatView from './components/ChatView.jsx';
import DiscoverView from './components/DiscoverView.jsx';
import HomeEmpty from './components/HomeEmpty.jsx';
import CharacterSettingsModal from './components/CharacterSettingsModal.jsx';
import SettingsModal from './components/SettingsModal.jsx';
import AuthPage from './components/AuthPage.jsx';
import { useAuth } from './auth.jsx';
import { api } from './api.js';

// view = { type: 'empty' } | { type: 'chat', characterId, conversationId } | { type: 'discover' }

export default function App() {
  const { multiUser, user, authReady, logout } = useAuth();
  const [config, setConfig] = useState(null);
  const [characters, setCharacters] = useState([]);
  // v1.20.4: 刷新后回到上次的聊天（只记 chat；切到首页/发现页则清除）
  const [view, setView] = useState(() => {
    try {
      const raw = localStorage.getItem('soulchat-last-view');
      if (raw) {
        const v = JSON.parse(raw);
        if (v && v.type === 'chat' && v.conversationId) return v;
      }
    } catch {}
    return { type: 'empty' };
  });
  useEffect(() => {
    try {
      if (view.type === 'chat' && view.conversationId) {
        localStorage.setItem('soulchat-last-view', JSON.stringify(view));
      } else {
        localStorage.removeItem('soulchat-last-view');
      }
    } catch {}
  }, [view]);
  const [toast, setToast] = useState(null);
  const [convRefresh, setConvRefresh] = useState(0);
  // 设置弹窗：{ open, tab }
  const [settingsModal, setSettingsModal] = useState({ open: false, tab: 'points' });
  // 角色设置弹窗：{ open, characterId }
  const [charSettingsModal, setCharSettingsModal] = useState({ open: false, characterId: null });
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

  // 登出后回到游客发现页（而非直接登录页）
  const lastUserRef = useRef(user);
  useEffect(() => {
    if (lastUserRef.current && !user) setForceAuth(false);
    lastUserRef.current = user;
  }, [user]);

  // 退出登录后清理，避免残留上一个用户的数据
  useEffect(() => {
    if (authReady && multiUser && !user) {
      setCharacters([]);
      setView({ type: 'empty' });
    }
  }, [authReady, multiUser, user]);

  // 401 会话过期：后端 401 时 api.js 广播事件，这里登出并回登录页（仅已登录态才响应，避免启动探测触发）
  // （挂在 showToast 定义之后，避免 TDZ）
  const userRef = useRef(user);
  userRef.current = user;
  const unauthorizedHandlerInstalled = useRef(false);

  const showToast = useCallback((text, ms = 2500) => {
    setToast({ text, id: Date.now() });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), ms);
  }, []);

  // 401 会话过期监听（挂在 showToast 定义之后）
  useEffect(() => {
    if (unauthorizedHandlerInstalled.current) return;
    unauthorizedHandlerInstalled.current = true;
    const onUnauthorized = () => {
      if (!userRef.current) return;
      logout().catch(() => {});
      showToast('登录已过期，请重新登录', 2600);
    };
    window.addEventListener('soulchat-unauthorized', onUnauthorized);
    return () => window.removeEventListener('soulchat-unauthorized', onUnauthorized);
  }, [logout, showToast]);

  const bumpConversations = useCallback(() => setConvRefresh((k) => k + 1), []);

  const handleSelectConversation = useCallback((characterId, conversationId, isGroup = false) => {
    setView({ type: 'chat', characterId, conversationId, isGroup });
    // 移动端抽屉：选中对话后自动收起
    if (window.innerWidth <= 768) setSidebarOpen(false);
  }, []);

  const handleOpenDiscover = useCallback(() => {
    setView({ type: 'discover' });
    if (window.innerWidth <= 768) setSidebarOpen(false);
  }, []);

  const handleAdopted = useCallback(
    (characterId, conversationId) => {
      refreshCharacters().catch(() => {});
      handleSelectConversation(characterId, conversationId);
      bumpConversations();
    },
    [refreshCharacters, handleSelectConversation, bumpConversations]
  );

  const handleOpenSettings = useCallback((characterId) => {
    setCharSettingsModal({ open: true, characterId });
    if (window.innerWidth <= 768) setSidebarOpen(false);
  }, []);

  // v1.16.1: 创建角色后直接进入聊天，不再弹角色设置
  const handleCharacterCreated = useCallback(
    async (char) => {
      await refreshCharacters();
      try {
        const conv = await api.createConversation(char.id, {});
        handleSelectConversation(char.id, conv.id, false);
      } catch (e) {
        // 建会话失败则回退到空状态
        setView({ type: 'empty' });
      }
      showToast('角色已创建');
    },
    [refreshCharacters, showToast, handleSelectConversation]
  );

  const handleCharacterDeleted = useCallback(
    async (characterId) => {
      await refreshCharacters();
      bumpConversations();
      setCharSettingsModal({ open: false, characterId: null });
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

  // 游客模式：多用户未登录时可浏览发现页，领养/聊天时再引导登录
  const [forceAuth, setForceAuth] = useState(false);
  const [afterLoginDiscover, setAfterLoginDiscover] = useState(false);
  const guestMode = authReady && multiUser && !user;

  // 游客去登录并回来后，自动打开发现页
  useEffect(() => {
    if (user && afterLoginDiscover) {
      setAfterLoginDiscover(false);
      setView({ type: 'discover' });
    }
  }, [user, afterLoginDiscover]);

  const handleRequireLogin = useCallback(() => {
    setAfterLoginDiscover(true);
    setForceAuth(true);
  }, []);

  // 多用户模式：启动检查完成前显示中性加载页；未登录且未点登录则进游客发现页。
  // 单用户模式直接渲染主界面（一个字都不变）。
  if (!authReady && multiUser) {
    return (
      <div className="auth-splash">
        <span>加载中…</span>
      </div>
    );
  }
  if (guestMode && forceAuth) {
    return <AuthPage theme={theme} onToggleTheme={toggleTheme} />;
  }
  if (guestMode) {
    return (
      <div className={`app guest${sidebarOpen ? ' sidebar-open' : ''}`}>
        <Sidebar
          guest
          characters={[]}
          config={config}
          view={{ type: 'discover' }}
          convRefresh={0}
          theme={theme}
          onToggleTheme={toggleTheme}
          onOpenDiscover={() => {
            if (window.innerWidth <= 768) setSidebarOpen(false);
          }}
          onLogin={handleRequireLogin}
          onSelectConversation={() => {}}
          onOpenSettings={() => {}}
          onCharacterCreated={() => {}}
          onConversationDeleted={() => {}}
          onConversationsChanged={() => {}}
          onOpenSettingsModal={() => {}}
          onToggleSidebar={toggleSidebar}
          onGoHome={() => setView({ type: 'empty' })}
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
          <DiscoverView
            user={null}
            config={config}
            onAdopted={() => {}}
            onRequireLogin={handleRequireLogin}
            onExit={null}
            onOpenSidebar={() => setSidebarOpen(true)}
            showToast={showToast}
          />
        </main>
        {toast && (
          <div className="toast" key={toast.id}>
            {toast.text}
          </div>
        )}
      </div>
    );
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
        onOpenDiscover={handleOpenDiscover}
        onLogin={() => {}}
        onToggleSidebar={toggleSidebar}
        onGoHome={() => setView({ type: 'empty' })}
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
            config={config}
          />
        )}
      {charSettingsModal.open && (
        <CharacterSettingsModal
          key={charSettingsModal.characterId}
          characterId={charSettingsModal.characterId}
          onClose={() => setCharSettingsModal((s) => ({ ...s, open: false }))}
          onCharacterUpdated={refreshCharacters}
          onCharacterDeleted={handleCharacterDeleted}
          showToast={showToast}
          config={config}
        />
      )}
        {view.type === 'discover' && (
          <DiscoverView
            user={user}
            config={config}
            onAdopted={handleAdopted}
            onRequireLogin={handleRequireLogin}
            onExit={() => setView({ type: 'empty' })}
            onOpenSidebar={() => setSidebarOpen(true)}
            showToast={showToast}
          />
        )}
        {view.type === 'empty' && (
          <HomeEmpty
            user={user}
            config={config}
            characters={characters}
            onOpenSidebar={() => setSidebarOpen(true)}
            onOpenDiscover={handleOpenDiscover}
            onAdopted={handleAdopted}
            onGroupCreated={(g) => handleSelectConversation(null, g.id, true)}
            onRequireLogin={handleRequireLogin}
            showToast={showToast}
          />
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
