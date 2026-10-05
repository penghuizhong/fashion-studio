// 账户页：积分与 API（替代原来的 API 设置弹窗）
// 分区：计费方式 / 我的积分 / 邀请好友 / 自带 Key 配置 / 管理员
import { useEffect, useRef, useState } from 'react';
import { api, fetchModels, DEFAULT_BASE_URL } from '../api.js';

// 复用 ApiSettingsModal 的自研下拉（iOS Safari 不支持原生 datalist）
function ModelPicker({ value, onChange, models, placeholder, openSignal }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (openSignal && models.length > 0) setOpen(true);
  }, [openSignal, models.length]);

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
        (m) => m.id.toLowerCase().includes(q) || (m.name && m.name.toLowerCase().includes(q))
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
                e.preventDefault();
                onChange(m.id);
                setOpen(false);
              }}
            >
              <span className="model-id">{m.id}</span>
              {m.name && m.name !== m.id && <span className="model-name">{m.name}</span>}
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

export default function AccountView({ onOpenSidebar, showToast }) {
  const [form, setForm] = useState({ baseUrl: '', key: '', model: '', workerModel: '' });
  const [models, setModels] = useState([]);
  const [loading, setLoading] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [version, setVersion] = useState('');
  const [hasServerKey, setHasServerKey] = useState(false);
  const [pullSeq, setPullSeq] = useState(0);
  // 积分
  const [billingMode, setBillingMode] = useState('points');
  const [pointsInfo, setPointsInfo] = useState(null);
  const [ledger, setLedger] = useState([]);
  // 邀请
  const [invite, setInvite] = useState(null);
  // 管理员
  const [grantUser, setGrantUser] = useState('');
  const [grantAmount, setGrantAmount] = useState('');
  const [granting, setGranting] = useState(false);

  useEffect(() => {
    api.getConfig().then((c) => setVersion((c && c.version) || '')).catch(() => {});
    let cancelled = false;
    (async () => {
      try {
        const [k, p, inv] = await Promise.all([
          api.getUserApiKey(),
          api.getPoints(),
          api.getInvite().catch(() => null),
        ]);
        if (cancelled) return;
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
          const wl = (p.models || []).map((m) => m.id);
          if (wl.length && !wl.includes((k && k.chatModel) || '')) {
            setForm((f) => ({ ...f, model: wl[0] }));
          }
        }
        if (inv) setInvite(inv);
      } catch {
        showToast('读取配置失败，请检查网络后重试', 2600);
      }
    })();
    const onPts = (e) => {
      const b = e && e.detail && e.detail.balance;
      if (typeof b === 'number') {
        setPointsInfo((pi) => (pi ? { ...pi, balance: b } : pi));
      }
    };
    window.addEventListener('soulchat-points-changed', onPts);
    return () => {
      cancelled = true;
      window.removeEventListener('soulchat-points-changed', onPts);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
      setLedger((await api.getPointsLedger(30)) || []);
    } catch (e) {
      showToast((e && e.message) || '读取明细失败', 2000);
    }
  };

  useEffect(() => {
    loadLedger();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pullModels = async () => {
    const key = form.key.trim();
    if (!key && !hasServerKey) {
      showToast('请先填写并保存 API Key', 2000);
      return;
    }
    setLoading(true);
    try {
      const list = await fetchModels(form.baseUrl.trim(), key);
      setModels(list);
      setPullSeq((s) => s + 1);
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
    setLoading(true);
    try {
      await api.setBillingMode(billingMode);
      if (billingMode === 'points') {
        const wl = ((pointsInfo && pointsInfo.models) || []).map((m) => m.id);
        const model = wl.includes(form.model.trim()) ? form.model.trim() : wl[0] || '';
        await api.saveUserApiKey({ chatModel: model });
        showToast('已切换为平台积分模式', 2200);
      } else {
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
        if (key) payload.key = key;
        const d = await api.saveUserApiKey(payload);
        setHasServerKey(!!(d && d.hasKey));
        setForm((f) => ({ ...f, key: '' }));
        window.dispatchEvent(new Event('soulchat-server-key-changed'));
        showToast('API 配置已保存到服务器，换设备也生效', 2200);
      }
    } catch (e) {
      showToast((e && e.message) || '保存失败', 2600);
    } finally {
      setLoading(false);
    }
  };

  const clearServer = async () => {
    if (!window.confirm('确定清除服务器上保存的 API 配置吗？\nKey 也会被删除，之后聊天需要重新填写。')) {
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

  const copyInviteLink = async () => {
    if (!invite || !invite.code) return;
    const link = `${window.location.origin}/?invite=${invite.code}`;
    try {
      await navigator.clipboard.writeText(link);
      showToast('邀请链接已复制', 2000);
    } catch {
      showToast(link, 4000);
    }
  };

  const inPointsMode = billingMode === 'points';
  const wlModels = ((pointsInfo && pointsInfo.models) || []).map((m) => ({
    id: m.id,
    name: `${m.name} · ${m.desc}`,
  }));

  return (
    <div className="page account-page">
      <div className="page-head">
        <button className="menu-btn" onClick={onOpenSidebar} title="菜单">
          ☰
        </button>
        <h2>积分与 API</h2>
      </div>

      <div className="page-body">
        {/* 计费方式 */}
        <section className="card">
          <div className="card-title">计费方式</div>
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
          <p className="key-desc small">
            平台积分：无需 Key，开箱即用，按 token 扣积分。
            自带 Key：用你自己的 OpenRouter Key，不花积分，模型随便选。
          </p>
        </section>

        {inPointsMode ? (
          <>
            {/* 余额 */}
            <section className="card">
              <div className="card-title">我的积分</div>
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
              <div className="save-row">
                <button className="btn primary" onClick={save} disabled={loading}>
                  {loading ? '保存中…' : '保存设置'}
                </button>
              </div>
            </section>

            {/* 消费明细 */}
            <section className="card">
              <div className="card-title">消费明细</div>
              {ledger.length ? (
                <ul className="ledger-list full">
                  {ledger.map((r) => (
                    <li key={r.id}>
                      <span className="ledger-reason">{r.reason_label || r.reason}</span>
                      <span className={r.delta < 0 ? 'ledger-neg' : 'ledger-pos'}>
                        {r.delta > 0 ? `+${r.delta}` : r.delta}
                      </span>
                      <span className="ledger-time">{formatLedgerTime(r.created_at)}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="key-desc small">暂无记录</p>
              )}
            </section>

            {/* 邀请好友 */}
            <section className="card">
              <div className="card-title">邀请好友</div>
              {invite ? (
                <>
                  <div className="invite-code-row">
                    <code className="invite-code">{invite.code}</code>
                    <button className="btn secondary" onClick={copyInviteLink}>
                      复制链接
                    </button>
                  </div>
                  <p className="key-desc small">
                    好友用你的链接注册：你得 {invite.inviterReward} 积分（对方聊满 {invite.chatThreshold}{' '}
                    条后发放），对方多得 {invite.inviteeBonus} 积分。
                  </p>
                  <p className="key-desc small">
                    已邀请 {invite.invitedCount} 人 · 已奖励 {invite.rewardedCount} 人
                  </p>
                </>
              ) : (
                <p className="key-desc small">加载中…</p>
              )}
            </section>

            {/* 充值说明 */}
            <section className="card">
              <div className="card-title">充值</div>
              <p className="key-desc small">
                目前为手动充值：微信 / 支付宝转账给站长后，管理员会在后台为你发放积分。
                自动充值（扫码即时到账）即将上线。
              </p>
            </section>
          </>
        ) : (
          /* 自带 Key 配置 */
          <section className="card">
            <div className="card-title">自带 Key 配置</div>
            <p className="key-desc">
              配置保存在<b>服务器</b>（Key 加密存储，永不回显），随账号走，换设备也生效。
            </p>
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
            <div className="key-status-row">
              <span className="key-status-label">API Key</span>
              {hasServerKey ? <span className="key-ok">已保存 ●</span> : <span className="key-none">未保存</span>}
            </div>
            <label>
              API Key
              <div className="key-input-row">
                <input
                  type={showKey ? 'text' : 'password'}
                  value={form.key}
                  onChange={setField('key')}
                  placeholder={hasServerKey ? '留空则保持已保存的 Key，填写则替换' : 'sk-or-v1-…'}
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
            </p>
            <div className="save-row">
              <button className="btn secondary" onClick={clearServer} disabled={loading}>
                清除
              </button>
              <button className="btn primary" onClick={save} disabled={loading}>
                {loading ? '保存中…' : '保存设置'}
              </button>
            </div>
          </section>
        )}

        {/* 管理员 */}
        {pointsInfo && pointsInfo.is_admin && (
          <section className="card">
            <div className="card-title">管理员 · 发放积分</div>
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
          </section>
        )}

        {version && <p className="key-desc small version-line">SoulChat v{version}</p>}
      </div>
    </div>
  );
}
