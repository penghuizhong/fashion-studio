// 多用户模式的登录/注册会话：会话靠后端 HttpOnly cookie，前端只持有 user 状态。
// 启动时先读 /api/config：multi_user 为 true 才走 /api/auth/me 检查登录态。
import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { setMultiUserMode, clearApiConfig } from './api.js';

const AuthContext = createContext(null);

async function authPost(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res;
}

async function serverMessage(res) {
  try {
    const d = await res.json();
    if (d && (d.message || d.error)) return d.message || d.error;
  } catch {
    /* 忽略 */
  }
  return null;
}

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [multiUser, setMultiUser] = useState(false);
  const [authReady, setAuthReady] = useState(false);

  // 启动检查：先拿 config（顺带设置多用户模式），多用户才查 /api/auth/me
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        let mu = false;
        try {
          const cfgRes = await fetch('/api/config', { credentials: 'same-origin' });
          const cfg = await cfgRes.json();
          mu = !!(cfg && cfg.multi_user);
        } catch {
          mu = false;
        }
        if (cancelled) return;
        setMultiUser(mu);
        setMultiUserMode(mu);
        if (mu) {
          try {
            const meRes = await fetch('/api/auth/me', { credentials: 'include' });
            if (cancelled) return;
            if (meRes.ok) {
              const data = await meRes.json().catch(() => null);
              setUser(data && data.user ? data.user : null);
            } else {
              setUser(null);
            }
          } catch {
            if (!cancelled) setUser(null);
          }
        }
      } finally {
        if (!cancelled) setAuthReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const login = useCallback(async (username, password) => {
    const res = await authPost('/api/auth/login', { username, password });
    if (!res.ok) {
      let msg = '用户名或密码错误';
      if (res.status !== 401) msg = (await serverMessage(res)) || `登录失败 (${res.status})`;
      throw new Error(msg);
    }
    const data = await res.json().catch(() => null);
    const u = data && data.user ? data.user : { username };
    setUser(u);
    return u;
  }, []);

  const register = useCallback(async (username, password, inviteCode) => {
    const res = await authPost('/api/auth/register', { username, password, inviteCode });
    if (!res.ok) {
      let msg;
      if (res.status === 409) {
        msg = '用户名已存在';
      } else {
        msg = (await serverMessage(res)) || `注册失败 (${res.status})`;
      }
      throw new Error(msg);
    }
    const data = await res.json().catch(() => null);
    const u = data && data.user ? data.user : { username };
    setUser(u);
    return u;
  }, []);

  const logout = useCallback(async () => {
    try { Object.keys(sessionStorage).filter(k => k.startsWith('explore-draft-')).forEach(k => sessionStorage.removeItem(k)); } catch {}
    try {
      await authPost('/api/auth/logout');
    } catch {
      /* 忽略登出失败，本地照样清状态 */
    }
    // 登出清掉内存中的 Key 与本地 API 配置残留，防下一个使用者沿用
    try {
      clearApiConfig();
    } catch {
      /* 忽略 */
    }
    setUser(null);
  }, []);

  return (
    <AuthContext.Provider value={{ user, multiUser, authReady, login, register, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth 必须在 AuthProvider 内使用');
  return ctx;
}
