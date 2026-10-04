// 登录 / 注册页（仅多用户模式）：延续 Apple 极简黑白双主题风格。
import { useState } from 'react';
import { useAuth } from '../auth.jsx';

const USERNAME_RE = /^[A-Za-z0-9\u4e00-\u9fa5_-]{3,20}$/;

export default function AuthPage({ theme, onToggleTheme }) {
  const { login, register } = useAuth();
  const [mode, setMode] = useState('login'); // 'login' | 'register'
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const switchMode = (m) => {
    setMode(m);
    setError('');
  };

  const submit = async (e) => {
    e.preventDefault();
    const u = username.trim();
    if (!USERNAME_RE.test(u)) {
      setError('用户名需为 3–20 位字母、数字、中文、_ 或 -');
      return;
    }
    if (password.length < 8) {
      setError('密码至少 8 位');
      return;
    }
    setError('');
    setBusy(true);
    try {
      if (mode === 'login') await login(u, password);
      else await register(u, password);
      // 成功：AuthProvider 的 user 状态更新，App 守卫自动放行进主界面
    } catch (err) {
      setError((err && err.message) || '请求失败，请稍后再试');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-page">
      <button
        className="theme-btn auth-theme-btn"
        title={theme === 'black' ? '切换到白色主题' : '切换到黑色主题'}
        onClick={onToggleTheme}
      >
        {theme === 'black' ? '☀️' : '🌙'}
      </button>
      <div className="auth-card">
        <div className="auth-logo">💬</div>
        <h1 className="auth-title">SoulChat</h1>
        <p className="auth-sub">{mode === 'login' ? '欢迎回来' : '创建你的账号，开始聊天'}</p>
        <div className="auth-tabs">
          <button
            type="button"
            className={mode === 'login' ? 'active' : ''}
            onClick={() => switchMode('login')}
          >
            登录
          </button>
          <button
            type="button"
            className={mode === 'register' ? 'active' : ''}
            onClick={() => switchMode('register')}
          >
            注册
          </button>
        </div>
        <form onSubmit={submit}>
          <label>
            用户名
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="3–20 位字母 / 数字 / 中文 / _ / -"
              spellCheck={false}
              autoComplete="username"
              maxLength={20}
            />
          </label>
          <label>
            密码
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={mode === 'login' ? '请输入密码' : '至少 8 位'}
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            />
          </label>
          {error && <div className="auth-error">{error}</div>}
          <button type="submit" className="btn primary auth-submit" disabled={busy}>
            {busy ? '请稍候…' : mode === 'login' ? '登录' : '注册'}
          </button>
        </form>
        {mode === 'register' && <p className="auth-tip">注册成功后自动登录。</p>}
      </div>
    </div>
  );
}
