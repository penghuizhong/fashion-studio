// 登录 / 注册 / 忘记密码页（仅多用户模式）：延续 Apple 极简黑白双主题风格。
import { useEffect, useState } from 'react';
import { useAuth } from '../auth.jsx';
import { api } from '../api.js';
import Icon from './icons.jsx';

const USERNAME_RE = /^[A-Za-z0-9\u4e00-\u9fa5_-]{3,20}$/;

// 带小眼睛的密码输入框
function PasswordInput({ value, onChange, placeholder, autoComplete }) {
  const [show, setShow] = useState(false);
  return (
    <span className="pwd-wrap">
      <input
        type={show ? 'text' : 'password'}
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        autoComplete={autoComplete}
        className="pwd-input"
      />
      <button
        type="button"
        className="pwd-eye"
        title={show ? '隐藏密码' : '显示密码'}
        onClick={() => setShow((s) => !s)}
        tabIndex={-1}
      >
        <Icon name={show ? 'eyeOff' : 'eye'} size={18} />
      </button>
    </span>
  );
}

export default function AuthPage({ theme, onToggleTheme }) {
  const { login, register } = useAuth();
  const [mode, setMode] = useState('login'); // 'login' | 'register' | 'forgot'
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [recoveryCodeInput, setRecoveryCodeInput] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  // 注册成功后展示一次的密码重置码
  const [justRegistered, setJustRegistered] = useState(null);
  const [forgotDone, setForgotDone] = useState(false);

  // 邀请链接：?invite=CODE → 自动切到注册并带上邀请码
  useEffect(() => {
    try {
      const code = new URLSearchParams(window.location.search).get('invite');
      if (code && code.trim()) {
        setInviteCode(code.trim().toUpperCase());
        setMode('register');
      }
    } catch {
      /* 忽略 */
    }
  }, []);

  const switchMode = (m) => {
    setMode(m);
    setError('');
    setForgotDone(false);
  };

  const checkPassword = (pwd, cfm) => {
    if (pwd.length < 8) return '密码至少 8 位';
    if (pwd !== cfm) return '两次输入的密码不一致';
    return '';
  };

  const submit = async (e) => {
    e.preventDefault();
    const u = username.trim();
    if (!USERNAME_RE.test(u)) {
      setError('用户名需为 3–20 位字母、数字、中文、_ 或 -');
      return;
    }
    if (mode === 'forgot') {
      const perr = checkPassword(password, confirm);
      if (perr) {
        setError(perr);
        return;
      }
      if (!recoveryCodeInput.trim()) {
        setError('请填写密码重置码');
        return;
      }
      setError('');
      setBusy(true);
      try {
        const ret = await api.resetPassword({
          username: u,
          recovery_code: recoveryCodeInput.trim(),
          new_password: password,
        });
        setForgotDone((ret && ret.recovery_code) || true);
      } catch (err) {
        setError((err && err.message) || '重置失败，请稍后再试');
      } finally {
        setBusy(false);
      }
      return;
    }
    if (mode === 'register') {
      const perr = checkPassword(password, confirm);
      if (perr) {
        setError(perr);
        return;
      }
    } else if (password.length < 8) {
      setError('密码至少 8 位');
      return;
    }
    setError('');
    setBusy(true);
    try {
      if (mode === 'login') {
        await login(u, password);
      } else {
        const ret = await register(u, password, inviteCode || undefined);
        // 注册成功：展示密码重置码（仅一次），点"进入"后进主界面
        setJustRegistered({ username: u, recoveryCode: (ret && ret.recoveryCode) || '' });
      }
      // 登录成功：AuthProvider 的 user 状态更新，App 守卫自动放行进主界面
    } catch (err) {
      setError((err && err.message) || '请求失败，请稍后再试');
    } finally {
      setBusy(false);
    }
  };

  const copyRecovery = async () => {
    if (!justRegistered || !justRegistered.recoveryCode) return;
    try {
      await navigator.clipboard.writeText(justRegistered.recoveryCode);
    } catch {
      /* 忽略，码已显示可手动抄 */
    }
  };

  // 注册成功：重置码展示页
  if (justRegistered) {
    return (
      <div className="auth-page">
        <div className="auth-card">
          <div className="auth-logo"><Icon name="chat" size={40} /></div>
          <h1 className="auth-title">注册成功</h1>
          <p className="auth-sub">欢迎，{justRegistered.username}！请保存好你的密码重置码</p>
          <div className="recovery-show">
            <code>{justRegistered.recoveryCode}</code>
            <button type="button" className="btn secondary small" onClick={copyRecovery}>
              复制
            </button>
          </div>
          <p className="auth-tip">忘记密码时，凭用户名 + 该重置码可自助重置。请截图或抄下保存。</p>
          <button
            type="button"
            className="btn primary auth-submit"
            onClick={() => setJustRegistered(null)}
          >
            进入 Fashion Studio
          </button>
        </div>
      </div>
    );
  }

  const isForgot = mode === 'forgot';

  return (
    <div className="auth-page">
      <button
        className="theme-btn auth-theme-btn"
        title={theme === 'black' ? '切换到白色主题' : '切换到黑色主题'}
        onClick={onToggleTheme}
      >
        {theme === 'black' ? <Icon name="sun" size={20} /> : <Icon name="moon" size={20} />}
      </button>
      <div className="auth-card">
        <div className="auth-logo"><Icon name="chat" size={40} /></div>
        <h1 className="auth-title">Fashion Studio</h1>
        <p className="auth-sub">
          {mode === 'login' ? '欢迎回来' : mode === 'register' ? '创建你的账号，开始聊天' : '凭重置码自助找回密码'}
        </p>
        {!isForgot && (
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
        )}
        {forgotDone ? (
          <>
            <p className="auth-tip" style={{ margin: '8px 0 6px' }}>密码已重置，旧重置码已作废，请保存新的重置码：</p>
            {typeof forgotDone === 'string' && (
              <div className="recovery-show">
                <code>{forgotDone}</code>
              </div>
            )}
            <button type="button" className="btn primary auth-submit" onClick={() => switchMode('login')}>
              去登录
            </button>
          </>
        ) : (
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
            {isForgot && (
              <label>
                密码重置码
                <input
                  value={recoveryCodeInput}
                  onChange={(e) => setRecoveryCodeInput(e.target.value.toUpperCase())}
                  placeholder="注册时发放的 12 位重置码"
                  spellCheck={false}
                  autoComplete="off"
                  maxLength={12}
                  style={{ textTransform: 'uppercase' }}
                />
              </label>
            )}
            <label>
              {isForgot ? '新密码' : '密码'}
              <PasswordInput
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={isForgot || mode === 'register' ? '至少 8 位' : '请输入密码'}
                autoComplete={isForgot || mode === 'register' ? 'new-password' : 'current-password'}
              />
            </label>
            {mode !== 'login' && (
              <label>
                确认{isForgot ? '新' : ''}密码
                <PasswordInput
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  placeholder="再输入一次"
                  autoComplete="new-password"
                />
              </label>
            )}
            {error && <div className="auth-error">{error}</div>}
            <button type="submit" className="btn primary auth-submit" disabled={busy}>
              {busy ? '请稍候…' : isForgot ? '重置密码' : mode === 'login' ? '登录' : '注册'}
            </button>
          </form>
        )}
        {!forgotDone && (
          <p className="auth-tip">
            {mode === 'login' && (
              <button type="button" className="link-btn" onClick={() => switchMode('forgot')}>
                忘记密码？
              </button>
            )}
            {isForgot && (
              <button type="button" className="link-btn" onClick={() => switchMode('login')}>
                ← 返回登录
              </button>
            )}
            {mode === 'register' && (
              <>
                注册成功后自动登录。
                {inviteCode && <> <Icon name="gift" size={16} /> 通过邀请链接注册，额外获赠积分。</>}
              </>
            )}
          </p>
        )}
      </div>
    </div>
  );
}
