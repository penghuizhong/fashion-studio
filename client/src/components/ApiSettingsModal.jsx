// 全局 API 设置（用户级）。
// 单用户模式：配置只存本浏览器 localStorage，对所有角色生效；后端只透传、不存储。
// 多用户模式：计费方式二选一——
//   平台积分：走平台 Key，按 token 扣积分，模型用平台白名单；余额/明细/管理员发放都在这里。
//   自带 Key：四个字段存服务器（key 加密，永不回显明文），随账号走；保存=合并（key 留空=保持原值）。
import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../auth.jsx';
import {
  api,
  getApiConfig,
  setApiConfig,
  clearApiConfig,
  fetchModels,
  DEFAULT_BASE_URL,
} from '../api.js';

const EMPTY_FORM = { baseUrl: '', key: '', model: '', workerModel: '' };

// 自研模型下拉：原生 <datalist> 在 iOS Safari 上完全不支持，
// 这里用自定义下拉实现，桌面+移动端行为一致，且支持输入过滤。
function ModelPicker({ value, onChange, models, placeholder, openSignal }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  // 拉取成功后由父组件通过 openSignal 触发自动展开
  useEffect(() => {
    if (openSignal && models.length > 0) setOpen(true);
  }, [openSignal, models.length]);

  // 点击外部 / Esc 关闭
  useEffect(() => {
    if (!open) return;
    const onDocDown = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDocDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open ]);

  const q = value.trim().toLowerCase();
  const filtered = q
    ? models.filter(
        (m) =>
          m.id.toLowerCase().includes(q) ||
          (m.name && m.name.toLowerCase().includes(q))
      )
    : models;
  const shown = filtered.slice(0, 120);

  return (
    <div className="model-picker" ref={ref}>
      <input
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          if (models.length > 0) setOpen(true);
        }}
        onFocus={() => {
          if (models.length > 0) setOpen(true);
        }}
        placeholder={placeholder}
        spellCheck={false}
        autoComplete="off"
      />
      {open && shown.length > 0 && (
        <ul className="model-dropdown">
          {shown.map((m) => (
            <li
              key={m.id}
              onMouseDown={(e) => {
                e.preventDefault(); // 先于 blur 触发，避免下拉先关闭导致点选失效
                onChange(m.id);
                setOpen(false);
              }}
            >
              <span className="model-id">{m.id}</span>
              {m.name && m.name !== m.id && (
                <span className="model-name">{m.name}</span>
              )}
            </li>
          ))}
        </ul>
      )}
      {open && models.length > 0 && shown.length === 0 && (
        <ul className="model-dropdown">
          <li className="model-empty" onMouseDown={(e) => e.preventDefault()}>
            无匹配模型，可直接手动输入
          </li>
        </ul>
      )}
    </div>
  );
}

function formatLedgerTime(ts) {
  try {
    return new Date(ts).toLocaleString('zh-CN', {
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return '';
  }
}

export default function ApiSettingsModal({ onClose, showToast }) {
  const { multiUser } = useAuth();
  const [form, setForm] = useState(EMPTY_FORM);
  const [models, setModels] = useState([]);
  const [loading, setLoading] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [version, setVersion] = useState('');
  // 多用户模式：服务器端配置状态
  const [hasServerKey, setHasServerKey] = useState(false);
  const [serverLoading, setServerLoading] = useState(false);
  // 拉取成功后自动展开模型下拉（每次拉取递增）
  const [pullSeq, setPullSeq] = useState(0);
  // ---- 积分系统 ----
  const [billingMode, setBillingMode] = useState('points');
  const [pointsInfo, setPointsInfo] = useState(null);
  const [ledger, setLedger] = useState([]);
  const [showLedger, setShowLedger] = useState(false);
  // 管理员发放
  const [grantUser, setGrantUser] = useState('');
  const [grantAmount, setGrantAmount] = useState('');
  const [granting, setGranting] = useState(false);

  useEffect(() => {
    api.getConfig().then((c) => setVersion((c && c.version) || '')).catch(() => {});
    if (multiUser) {
      setServerLoading(true);
      Promise.all([api.getUserApiKey(), api.getPoints()])
        .then(([k, p]) => {
          setForm({
            baseUrl: (k && k.baseUrl) || '',
            key: '',
            model: (k && k.chatModel) || '',
            workerModel: (k && k.workerModel) || '',
          });
          setHasServerKey(!!(k && k.hasKey));
          if (p) {
            setPointsInfo(p);
            setBillingMode((p && p.billing_mode) || 'points');
            // 积分模式且当前模型不在白名单时，默认选中第一个
            const wl = (p.models || []).map((m) => m.id);
            if (wl.length && !wl.includes((k && k.chatModel) || '')) {
              setForm((f) => ({ ...f, model: wl[0] }));
            }
          }
        })
        .catch(() => {
          showToast('读取服务器配置失败，请检查网络后重试', 2600);
        })
        .finally(() => setServerLoading(false));
      // 聊天扣费后广播余额变化
      const onPts = (e) => {
        const b = e && e.detail && e.detail.balance;
        if (typeof b === 'number') {
          setPointsInfo((pi) => (pi ? { ...pi, balance: b } : pi));
        }
      };
      window.addEventListener('soulchat-points-changed', onPts);
      return () => window.removeEventListener('soulchat-points-changed', onPts);
    } else {
      setForm(getApiConfig());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [multiUser]);

  const setField = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const refreshPoints = async () => {
    try {
      const p = await api.getPoints();
      setPointsInfo(p);
    } catch (e) {
      showToast((e && e.message) || '刷新失败', 2000);
    }
  };

  const loadLedger = async () => {
    try {
      const rows = await api.getPointsLedger(20);
      setLedger(rows || []);
    } catch (e) {
      showToast((e && e.message) || '读取明细失败', 2000);
    }
  };

  // 用当前输入的 key / 地址动态拉取可用模型（自带 Key 模式）
  const pullModels = async () => {
    const key = form.key.trim();
    if (!key && !multiUser) {
      showToast('请先填写 API Key', 2000);
      return;
    }
    if (!key && multiUser && !hasServerKey) {
      showToast('请先填写并保存 API Key', 2000);
      return;
    }
    setLoading(true);
    try {
      const base = multiUser ? form.baseUrl.trim() : form.baseUrl.trim() || DEFAULT_BASE_URL;
      const list = await fetchModels(base, key);
      setModels(list);
      setPullSeq((s) => s + 1); // 拉取成功后自动展开下拉
      showToast(
        list.length ? `已拉取 ${list.length} 个可用模型` : '拉取成功，但列表为空（可手动输入模型名）',
        2200
      );
    } catch (e) {
      showToast((e && e.message) || '拉取失败', 2600);
    } finally {
      setLoading(false);
    }
  };

  const save = async () => {
    if (multiUser) {
      setLoading(true);
      try {
        await api.setBillingMode(billingMode);
        if (billingMode === 'points') {
          // 积分模式：只保存白名单内的聊天模型
          const wl = ((pointsInfo && pointsInfo.models) || []).map((m) => m.id);
          const model = wl.includes(form.model.trim()) ? form.model.trim() : wl[0] || '';
          await api.saveUserApiKey({ chatModel: model });
          showToast('已切换为平台积分模式', 2200);
        } else {
          // 自带 Key 模式：原有合并语义（key 留空=保持原值）
          const key = form.key.trim();
          if (!key && !hasServerKey) {
            showToast('请填写 API Key', 2000);
            return;
          }
          const payload = {
            baseUrl: form.baseUrl.trim(),
            chatModel: form.model.trim(),
            workerModel: form.workerModel.trim(),
          };
          if (key) payload.key = key; // 留空则不传，后端保持原值
          const d = await api.saveUserApiKey(payload);
          setHasServerKey(!!(d && d.hasKey)); // 以服务器返回为准
          setForm((f) => ({ ...f, key: '' }));
          window.dispatchEvent(new Event('soulchat-server-key-changed'));
          showToast('API 配置已保存到服务器，换设备也生效', 2200);
        }
        onClose();
      } catch (e) {
        showToast((e && e.message) || '保存失败', 2600);
      } finally {
        setLoading(false);
      }
      return;
    }
    // 单用户模式：原有 localStorage 逻辑不变
    if (!form.key.trim()) {
      showToast('请填写 API Key', 2000);
      return;
    }
    setApiConfig({
      baseUrl: form.baseUrl.trim(),
      key: form.key.trim(),
      model: form.model.trim(),
      workerModel: form.workerModel.trim(),
    });
    showToast('API 配置已保存到本浏览器', 2200);
    onClose();
  };

  const clear = () => {
    clearApiConfig();
    setForm({ baseUrl: '', key: '', model: '', workerModel: '' });
    setModels([]);
    showToast('已清除本浏览器的 API 配置', 2000);
  };

  // 多用户模式：清除服务器上保存的全部配置（含 Key），需二次确认
  const clearServer = async () => {
    if (
      !window.confirm('确定清除服务器上保存的 API 配置吗？\nKey 也会被删除，之后聊天需要重新填写。')
    ) {
      return;
    }
    setLoading(true);
    try {
      await api.saveUserApiKey({ key: '', baseUrl: '', chatModel: '', workerModel: '' });
      setForm({ baseUrl: '', key: '', model: '', workerModel: '' });
      setHasServerKey(false);
      setModels([]);
      showToast('服务器配置已清除', 2000);
    } catch (e) {
      showToast((e && e.message) || '清除失败', 2600);
    } finally {
      setLoading(false);
    }
  };

  // 管理员发放积分
  const grant = async () => {
    const username = grantUser.trim();
    const amount = Math.floor(Number(grantAmount));
    if (!username) {
      showToast('请填写用户名', 2000);
      return;
    }
    if (!amount || amount <= 0) {
      showToast('请填写发放数量', 2000);
      return;
    }
    setGranting(true);
    try {
      const d = await api.adminGrantPoints({ username, points: amount });
      showToast(`已向 ${d.username} 发放 ${d.granted} 积分（余额 ${d.balance}）`, 2600);
      setGrantUser('');
      setGrantAmount('');
    } catch (e) {
      showToast((e && e.message) || '发放失败', 2600);
    } finally {
      setGranting(false);
    }
  };

  const inPointsMode = multiUser && billingMode === 'points';
  const wlModels = ((pointsInfo && pointsInfo.models) || []).map((m) => ({
    id: m.id,
    name: `${m.name} · ${m.desc}`,
  }));

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>API 设置</h3>
          <button className="modal-close" title="关闭" onClick={onClose}>
            ✕
          </button>
        </div>

        {/* 计费方式切换（多用户模式） */}
        {multiUser && (
          <div className="billing-toggle">
            <button
              className={billingMode === 'points' ? 'active' : ''}
              onClick={() => setBillingMode('points')}
            >
              平台积分
            </button>
            <button
              className={billingMode === 'byok' ? 'active' : ''}
              onClick={() => setBillingMode('byok')}
            >
              自带 Key
            </button>
          </div>
        )}

        {inPointsMode ? (
          <>
            <div className="points-balance-card">
              <div>
                <div className="points-balance-num">
                  {pointsInfo ? pointsInfo.balance : '…'} <span>积分</span>
                </div>
                <div className="key-desc small">
                  1 元 = 100 积分 · 注册赠送 {pointsInfo ? pointsInfo.signup_bonus : 500} 积分
                </div>
              </div>
              <button className="btn secondary" onClick={refreshPoints} disabled={loading}>
                刷新
              </button>
            </div>
            {pointsInfo && !pointsInfo.platform_ready && (
              <p className="key-desc small" style={{ color: 'var(--danger, #e5484d)' }}>
                平台模型服务暂未开通，积分模式不可用，请联系管理员。
              </p>
            )}
            <label>
              聊天模型
              <ModelPicker
                value={form.model}
                onChange={(v) => setForm((f) => ({ ...f, model: v }))}
                models={wlModels}
                placeholder="选择模型"
              />
            </label>
            <p className="key-desc small">
              按实际 token 用量扣积分。后台任务（记忆整理、对话摘要、群聊导演）自动使用最便宜的模型。
            </p>
            <button
              className="link-btn"
              onClick={() => {
                setShowLedger((s) => !s);
                if (!showLedger && ledger.length === 0) loadLedger();
              }}
            >
              {showLedger ? '收起消费明细 ▴' : '查看消费明细 ▾'}
            </button>
            {showLedger && (
              <ul className="ledger-list">
                {ledger.length ? (
                  ledger.map((r) => (
                    <li key={r.id}>
                      <span className="ledger-reason">{r.reason_label || r.reason}</span>
                      <span className={r.delta < 0 ? 'ledger-neg' : 'ledger-pos'}>
                        {r.delta > 0 ? `+${r.delta}` : r.delta}
                      </span>
                      <span className="ledger-time">{formatLedgerTime(r.created_at)}</span>
                    </li>
                  ))
                ) : (
                  <li className="key-desc small">暂无记录</li>
                )}
              </ul>
            )}
          </>
        ) : (
          <>
            {multiUser ? (
              <p className="key-desc">
                用户级配置，保存在<b>服务器</b>（Key 加密存储，永不回显），随账号走，换设备也生效。
              </p>
            ) : (
              <p className="key-desc">
                用户级配置，保存在<b>本浏览器</b>，对所有角色生效。后端只透传、不存储、不记日志。
              </p>
            )}
            <label>
              API 地址
              <input
                value={form.baseUrl}
                onChange={setField('baseUrl')}
                placeholder={DEFAULT_BASE_URL}
                spellCheck={false}
                autoComplete="off"
              />
            </label>
            {multiUser && (
              <div className="key-status-row">
                <span className="key-status-label">API Key</span>
                {serverLoading ? (
                  <span className="key-none">读取中…</span>
                ) : hasServerKey ? (
                  <span className="key-ok">已保存 ●</span>
                ) : (
                  <span className="key-none">未保存</span>
                )}
              </div>
            )}
            <label>
              API Key
              <div className="key-input-row">
                <input
                  type={showKey ? 'text' : 'password'}
                  value={form.key}
                  onChange={setField('key')}
                  placeholder={multiUser && hasServerKey ? '留空则保持已保存的 Key，填写则替换' : 'sk-or-v1-…'}
                  spellCheck={false}
                  autoComplete="off"
                />
                <button className="btn secondary" onClick={() => setShowKey((s) => !s)}>
                  {showKey ? '隐藏' : '显示'}
                </button>
              </div>
            </label>
            <label>
              聊天模型
              <div className="key-input-row">
                <ModelPicker
                  value={form.model}
                  onChange={(v) => setForm((f) => ({ ...f, model: v }))}
                  models={models}
                  placeholder="先拉取模型列表，或手动输入"
                  openSignal={pullSeq}
                />
                <button className="btn secondary" onClick={pullModels} disabled={loading}>
                  {loading ? '拉取中…' : '拉取模型'}
                </button>
              </div>
            </label>
            {models.length > 0 && (
              <p className="key-desc small">共 {models.length} 个可用模型，可在输入框中搜索选择。</p>
            )}
            <label>
              后台模型
              <ModelPicker
                value={form.workerModel || ''}
                onChange={(v) => setForm((f) => ({ ...f, workerModel: v }))}
                models={models}
                placeholder="留空用默认便宜模型"
              />
            </label>
            <p className="key-desc small">
              后台模型负责群聊导演调度、记忆提取、对话摘要——用户看不到，用便宜的就行。
              留空则用服务器默认（DeepSeek）。
            </p>
            <p className="key-desc small">
              兼容 OpenAI 格式的接口都可填（如 OpenRouter）。Key 在 openrouter.ai 的 Keys 页面创建，
              不要发给任何人。
            </p>
          </>
        )}

        {/* 管理员：手动发放积分 */}
        {multiUser && pointsInfo && pointsInfo.is_admin && (
          <div className="admin-box">
            <div className="admin-title">管理员 · 发放积分</div>
            <div className="key-input-row">
              <input
                value={grantUser}
                onChange={(e) => setGrantUser(e.target.value)}
                placeholder="用户名"
                spellCheck={false}
                autoComplete="off"
              />
              <input
                value={grantAmount}
                onChange={(e) => setGrantAmount(e.target.value)}
                placeholder="数量"
                inputMode="numeric"
                autoComplete="off"
                style={{ maxWidth: 96 }}
              />
              <button className="btn secondary" onClick={grant} disabled={granting}>
                {granting ? '发放中…' : '发放'}
              </button>
            </div>
            <p className="key-desc small">手动充值：用户付款后，按用户名发放积分。</p>
          </div>
        )}

        {version && <p className="key-desc small version-line">Fashion Studio v{version}</p>}
        <div className="modal-actions">
          {multiUser ? (
            !inPointsMode && (
              <button className="btn secondary" onClick={clearServer} disabled={loading}>
                清除
              </button>
            )
          ) : (
            <button className="btn secondary" onClick={clear}>
              清除
            </button>
          )}
          <button className="btn primary" onClick={save} disabled={loading}>
            {loading ? '保存中…' : '保存'}
          </button>
        </div>
      </div>
    </div>
  );
}
