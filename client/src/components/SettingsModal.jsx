// 设置弹窗（ChatGPT 式）：横向滑动二级导航 + 内容区
// tab: points(积分) / api(API) / invite(邀请) / stats(用量统计·管理员)
import React, { useEffect, useRef, useState } from 'react';
import { api, fetchModels, DEFAULT_BASE_URL } from '../api.js';
import Icon from './icons.jsx';

// 自研模型下拉（iOS Safari 不支持原生 datalist）
function ModelPicker({ value, onChange, models, placeholder, openSignal }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const safeModels = Array.isArray(models) ? models : [];
  const safeValue = value == null ? '' : String(value);

  useEffect(() => {
    if (openSignal && safeModels.length > 0) setOpen(true);
  }, [openSignal, safeModels.length]);

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

  const q = safeValue.trim().toLowerCase();
  const filtered = q
    ? safeModels.filter(
        (m) => m && String(m.id || '').toLowerCase().includes(q) || (m && m.name && String(m.name).toLowerCase().includes(q))
      )
    : safeModels;
  const shown = filtered.slice(0, 120);

  return (
    <div className="model-picker" ref={ref}>
      <input
        value={safeValue}
        onChange={(e) => {
          onChange(e.target.value);
          if (safeModels.length > 0) setOpen(true);
        }}
        onFocus={() => {
          if (safeModels.length > 0) setOpen(true);
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
      {open && safeModels.length > 0 && shown.length === 0 && (
        <ul className="model-dropdown">
          <li className="model-empty" onMouseDown={(e) => e.preventDefault()}>
            无匹配模型，可直接手动输入
          </li>
        </ul>
      )}
    </div>
  );
}

// 错误边界：渲染崩溃时显示错误信息而不是黑屏
class SettingsErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidCatch(error, info) {
    try {
      console.error('[SettingsModal] render crash:', error, info);
    } catch {}
  }
  render() {
    if (this.state.error) {
      return (
        <div className="modal-overlay settings-overlay">
          <div className="settings-modal" role="dialog" aria-label="设置">
            <div className="settings-head">
              <h3>设置</h3>
              <button className="icon-btn" onClick={this.props.onClose}>
                <Icon name="x" size={20} />
              </button>
            </div>
            <div className="settings-body">
              <p className="key-desc">页面加载出错了，请重试。</p>
              <p className="key-desc small" style={{ opacity: 0.7 }}>
                {String((this.state.error && this.state.error.message) || this.state.error)}
              </p>
              <div className="save-row">
                <button
                  className="btn primary"
                  onClick={() => this.setState({ error: null })}
                >
                  重试
                </button>
              </div>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

function TrendChart({ data }) {
  const W = 640;
  const H = 200;
  const P = 30;
  if (!data.length) return <p className="key-desc small">暂无数据</p>;
  const max = Math.max(1, ...data.map((d) => d.consumed));
  const n = data.length;
  const xs = (i) => P + (n === 1 ? 0 : (i / (n - 1)) * (W - 2 * P));
  const ys = (v) => H - P - (v / max) * (H - 2 * P);
  const line = data.map((d, i) => `${i ? 'L' : 'M'}${xs(i).toFixed(1)},${ys(d.consumed).toFixed(1)}`).join(' ');
  const area = `${line} L${xs(n - 1).toFixed(1)},${H - P} L${xs(0).toFixed(1)},${H - P} Z`;
  // x 轴日期标签：最多 6 个
  const step = Math.max(1, Math.floor(n / 6));
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="trend-chart" role="img">
      {[0.25, 0.5, 0.75, 1].map((f) => (
        <line
          key={f}
          x1={P}
          x2={W - P}
          y1={ys(max * f)}
          y2={ys(max * f)}
          stroke="var(--border)"
          strokeWidth="1"
        />
      ))}
      <path d={area} fill="#5b8def" opacity="0.15" />
      <path d={line} fill="none" stroke="#5b8def" strokeWidth="2.5" strokeLinejoin="round" />
      {data.map((d, i) =>
        i % step === 0 ? (
          <text
            key={d.day}
            x={xs(i)}
            y={H - 8}
            fontSize="11"
            fill="var(--text-secondary)"
            textAnchor="middle"
          >
            {d.day.slice(5)}
          </text>
        ) : null
      )}
      <text x={P} y={18} fontSize="11" fill="var(--text-secondary)">
        max {max}
      </text>
    </svg>
  );
}

function formatLedgerTime(ts) {
  try {
    return new Date(ts).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

export default function SettingsModal({ initialTab = 'points', onClose, showToast }) {
  const [tab, setTab] = useState(initialTab);
  const [form, setForm] = useState({ baseUrl: '', key: '', model: '', workerModel: '' });
  const [models, setModels] = useState([]);
  const [loading, setLoading] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [version, setVersion] = useState('');
  const [hasServerKey, setHasServerKey] = useState(false);
  const [pullSeq, setPullSeq] = useState(0);
  const [billingMode, setBillingMode] = useState('points');
  // v1.16.8: 积分模式的模型选择框用独立 state，不再与 API tab 的 form.model 共用
  const [pointsModel, setPointsModel] = useState('');
  const [pointsInfo, setPointsInfo] = useState(null);
  const [ledger, setLedger] = useState([]);
  const [invite, setInvite] = useState(null);
  const [grantUser, setGrantUser] = useState('');
  const [grantAmount, setGrantAmount] = useState('');
  const [granting, setGranting] = useState(false);
  // 密码重置码
  const [recoveryCode, setRecoveryCode] = useState('');
  const [regenBusy, setRegenBusy] = useState(false);
  // 积分模型管理
  const [pmModels, setPmModels] = useState([]);
  const [pmForm, setPmForm] = useState({ model_id: '', name: '', description: '', input_per_1m: '', output_per_1m: '' });
  const [pmAdding, setPmAdding] = useState(false);
  const [pmEditing, setPmEditing] = useState(null); // 正在编辑的行 id
  const [pmEditForm, setPmEditForm] = useState({});
  // v1.12 模型配置（管理员）：后台模型 / 聊天默认模型
  const [modelCfg, setModelCfg] = useState({ worker_model: '', chat_default_model: '', filter_fallback_models: null });
  const [modelCfgSaving, setModelCfgSaving] = useState(false);
  const loadModelCfg = async () => {
    try {
      const s = await api.adminGetSettings();
      setModelCfg({
        worker_model: (s && s.worker_model) || '',
        chat_default_model: (s && s.chat_default_model) || '',
        filter_fallback_models: (s && Array.isArray(s.filter_fallback_models)) ? s.filter_fallback_models : null,
      });
    } catch {
      /* 非管理员或加载失败就保持默认 */
    }
  };
  const saveModelCfg = async () => {
    setModelCfgSaving(true);
    try {
      const body = { ...modelCfg };
      if (body.filter_fallback_models == null) delete body.filter_fallback_models;
      await api.adminUpdateSettings(body);
      showToast('模型配置已保存');
    } catch (e) {
      showToast((e && e.message) || '保存失败');
    } finally {
      setModelCfgSaving(false);
    }
  };
  // 统计
  const [stats, setStats] = useState(null);
  const [statsLoading, setStatsLoading] = useState(false);
  // 投稿审核（管理员）
  const [reviewList, setReviewList] = useState([]);
  const [reviewStatus, setReviewStatus] = useState('pending');
  const [reviewLoading, setReviewLoading] = useState(false);
  const [rejectInputs, setRejectInputs] = useState({});
  const loadReview = async (status) => {
    setReviewLoading(true);
    try {
      setReviewList(await api.adminSharedCards(status));
    } catch {
      setReviewList([]);
    } finally {
      setReviewLoading(false);
    }
  };
  const tabsRef = useRef(null);

  const isAdmin = !!(pointsInfo && pointsInfo.is_admin);
  const TABS = [
    { id: 'points', icon: 'coins', label: '积分' },
    { id: 'api', icon: 'plug', label: 'API' },
    { id: 'invite', icon: 'gift', label: '邀请' },
  ];
  if (isAdmin) TABS.push({ id: 'stats', icon: 'chart', label: '统计' });
  if (isAdmin) TABS.push({ id: 'review', icon: 'shield', label: '审核' });

  useEffect(() => {
    if (tab === 'review' && isAdmin) loadReview(reviewStatus);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, reviewStatus, isAdmin]);
  const doReview = async (id, approve) => {
    const reason = (rejectInputs[id] || '').trim();
    if (!approve && !reason) {
      showToast('打回请填写理由');
      return;
    }
    try {
      await api.adminReviewSharedCard(id, approve, reason);
      showToast(approve ? '已上架' : '已打回');
      loadReview(reviewStatus);
    } catch (e) {
      showToast((e && e.message) || '操作失败');
    }
  };

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
          setPointsModel(wl.includes((k && k.chatModel) || '') ? k.chatModel : wl[0] || '');
        }
        if (inv) setInvite(inv);
        setLedger((await api.getPointsLedger(30).catch(() => [])) || []);
        const rc = await api.getRecoveryCode().catch(() => null);
        if (!cancelled && rc && rc.recovery_code) setRecoveryCode(rc.recovery_code);
      } catch {
        showToast('读取配置失败，请检查网络后重试', 2600);
      }
    })();
    const onPts = (e) => {
      const b = e && e.detail && e.detail.balance;
      if (typeof b === 'number') setPointsInfo((pi) => (pi ? { ...pi, balance: b } : pi));
    };
    window.addEventListener('soulchat-points-changed', onPts);
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      cancelled = true;
      window.removeEventListener('soulchat-points-changed', onPts);
      document.removeEventListener('keydown', onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 统计 tab 懒加载
  useEffect(() => {
    if (tab !== 'stats' || stats || statsLoading) return;
    let cancelled = false;
    setStatsLoading(true);
    (async () => {
      try {
        const [ov, da, mo, tu] = await Promise.all([
          api.adminStatsOverview(),
          api.adminStatsDaily(30),
          api.adminStatsModels(),
          api.adminStatsTopUsers(10),
        ]);
        if (!cancelled) setStats({ ov, da: da || [], mo: mo || [], tu: tu || [] });
        const pm = await api.adminPointsModels().catch(() => []);
        if (!cancelled) setPmModels(Array.isArray(pm) ? pm : []);
        if (!cancelled) await loadModelCfg();
      } catch (e) {
        showToast((e && e.message) || '读取统计失败', 2600);
      } finally {
        if (!cancelled) setStatsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab ]);

  // 切换 tab 时滚动到可见
  const selectTab = (id, el) => {
    setTab(id);
    if (el && el.scrollIntoView) {
      el.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
    }
  };

  const setField = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const refreshPoints = async () => {
    try {
      const p = await api.getPoints();
      setPointsInfo(p);
      const rc = await api.getRecoveryCode().catch(() => null);
      if (rc && rc.recovery_code) setRecoveryCode(rc.recovery_code);
    } catch (e) {
      showToast((e && e.message) || '刷新失败', 2000);
    }
  };

  const regenRecovery = async () => {
    if (!window.confirm('确定重新生成密码重置码吗？旧码将立即失效。')) return;
    setRegenBusy(true);
    try {
      const rc = await api.regenerateRecoveryCode();
      setRecoveryCode((rc && rc.recovery_code) || '');
      showToast('已重新生成，请保存新码', 2200);
    } catch (e) {
      showToast((e && e.message) || '生成失败', 2200);
    } finally {
      setRegenBusy(false);
    }
  };

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
      showToast(list.length ? `已拉取 ${list.length} 个可用模型` : '拉取成功，但列表为空（可手动输入模型名）', 2200);
    } catch (e) {
      showToast((e && e.message) || '拉取失败', 2600);
    } finally {
      setLoading(false);
    }
  };

  // v1.16.8: mode 显式传入，避免 setBillingMode 后立刻 save 读到过期 state
  const save = async (mode) => {
    const m = mode || billingMode;
    setLoading(true);
    try {
      await api.setBillingMode(m);
      if (m === 'points') {
        const wl = ((pointsInfo && pointsInfo.models) || []).map((mi) => mi.id);
        const model = wl.includes(pointsModel.trim()) ? pointsModel.trim() : wl[0] || '';
        await api.saveUserApiKey({ chatModel: model });
        showToast('已切换为平台积分模式', 2200);
      } else {
        const key = form.key.trim();
        if (!key && !hasServerKey) {
          showToast('请填写 API Key', 2000);
          return;
        }
        const payload = { baseUrl: form.baseUrl.trim(), chatModel: form.model.trim(), workerModel: form.workerModel.trim() };
        if (key) payload.key = key;
        const d = await api.saveUserApiKey(payload);
        setHasServerKey(!!(d && d.hasKey));
        setForm((f) => ({ ...f, key: '' }));
        showToast('API 配置已保存到服务器，换设备也生效', 2200);
      }
    } catch (e) {
      showToast((e && e.message) || '保存失败', 2600);
    } finally {
      setLoading(false);
    }
  };

  const clearServer = async () => {
    if (!window.confirm('确定清除服务器上保存的 API 配置吗？\nKey 也会被删除，之后聊天需要重新填写。')) return;
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

  // ---- 积分模型管理 ----
  const refreshPmModels = async () => {
    try {
      const pm = await api.adminPointsModels();
      setPmModels(Array.isArray(pm) ? pm : []);
    } catch (e) {
      showToast((e && e.message) || '读取模型列表失败', 2200);
    }
  };

  const pmAdd = async () => {
    const f = pmForm;
    if (!f.model_id.trim()) {
      showToast('请填写模型 ID', 2000);
      return;
    }
    setPmAdding(true);
    try {
      await api.adminAddPointsModel({
        model_id: f.model_id.trim(),
        name: f.name.trim() || f.model_id.trim(),
        description: f.description.trim(),
        input_per_1m: Math.floor(Number(f.input_per_1m)),
        output_per_1m: Math.floor(Number(f.output_per_1m)),
      });
      setPmForm({ model_id: '', name: '', description: '', input_per_1m: '', output_per_1m: '' });
      await refreshPmModels();
      await refreshPoints();
      showToast('已上架', 2000);
    } catch (e) {
      showToast((e && e.message) || '添加失败', 2600);
    } finally {
      setPmAdding(false);
    }
  };

  const pmToggle = async (m) => {
    try {
      await api.adminUpdatePointsModel(m.id, { is_active: !m.is_active });
      await refreshPmModels();
      await refreshPoints();
      showToast(m.is_active ? '已下架' : '已上架', 1800);
    } catch (e) {
      showToast((e && e.message) || '操作失败', 2200);
    }
  };

  const pmStartEdit = (m) => {
    setPmEditing(m.id);
    setPmEditForm({
      name: m.name || '',
      description: m.description || '',
      input_per_1m: String(m.input_per_1m || ''),
      output_per_1m: String(m.output_per_1m || ''),
    });
  };

  const pmSaveEdit = async (id) => {
    try {
      await api.adminUpdatePointsModel(id, {
        name: pmEditForm.name.trim(),
        description: pmEditForm.description.trim(),
        input_per_1m: Math.floor(Number(pmEditForm.input_per_1m)),
        output_per_1m: Math.floor(Number(pmEditForm.output_per_1m)),
      });
      setPmEditing(null);
      await refreshPmModels();
      await refreshPoints();
      showToast('已保存', 1800);
    } catch (e) {
      showToast((e && e.message) || '保存失败', 2600);
    }
  };

  const pmDelete = async (m) => {
    if (!window.confirm(`确定删除模型「${m.name}」(${m.model_id})吗？`)) return;
    try {
      await api.adminDeletePointsModel(m.id);
      await refreshPmModels();
      await refreshPoints();
      showToast('已删除', 1800);
    } catch (e) {
      showToast((e && e.message) || '删除失败', 2200);
    }
  };

  const inPointsMode = billingMode === 'points';
  const wlModels = ((pointsInfo && pointsInfo.models) || []).map((m) => ({ id: m.id, name: `${m.name} · ${m.desc}` }));
  const maxModelPts = stats ? Math.max(1, ...stats.mo.map((m) => m.points)) : 1;

  return (
    <SettingsErrorBoundary onClose={onClose}>
    <div className="modal-overlay settings-overlay" onClick={onClose}>
      <div className="settings-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="设置">
        <div className="settings-head">
          <h3>设置</h3>
          <button className="icon-btn" title="关闭" onClick={onClose}>
            <Icon name="x" size={20} />
          </button>
        </div>
        <div className="settings-tabs" ref={tabsRef}>
          {TABS.map((t) => (
            <button
              key={t.id}
              className={`settings-tab${tab === t.id ? ' active' : ''}`}
              onClick={(e) => selectTab(t.id, e.currentTarget)}
            >
              <Icon name={t.icon} size={18} />
              <span>{t.label}</span>
            </button>
          ))}
        </div>
        <div className="settings-body">
          {tab === 'points' && (
            <>
              <div className="billing-toggle">
                <button className={billingMode === 'points' ? 'active' : ''} onClick={() => setBillingMode('points')}>
                  平台积分
                </button>
                <button className={billingMode === 'byok' ? 'active' : ''} onClick={() => setBillingMode('byok')}>
                  自带 Key
                </button>
              </div>
              <p className="key-desc small">平台积分：无需 Key，开箱即用，按 token 扣积分。自带 Key：用你自己的 OpenRouter Key，不花积分。</p>
              {inPointsMode ? (
                <>
                  <div className="points-balance-card">
                    <div>
                      <div className="points-balance-num">
                        {pointsInfo ? pointsInfo.balance : '…'} <span>积分</span>
                      </div>
                      <div className="key-desc small">1 元 = 100 积分 · 首次聊天后赠送 {pointsInfo ? pointsInfo.signup_bonus : 500} 积分（防刷号）</div>
                    </div>
                    <button className="btn secondary" onClick={refreshPoints} disabled={loading}>刷新</button>
                  </div>
                  {pointsInfo && !pointsInfo.platform_ready && (
                    <p className="key-desc small" style={{ color: 'var(--danger, #e5484d)' }}>
                      平台模型服务暂未开通，积分模式不可用，请联系管理员。
                    </p>
                  )}
                  <label>
                    聊天模型
                    <ModelPicker value={pointsModel} onChange={setPointsModel} models={wlModels} placeholder="选择模型" />
                  </label>
                  <div className="save-row">
                    <button className="btn primary" onClick={() => save('points')} disabled={loading}>
                      {loading ? '保存中…' : '保存设置'}
                    </button>
                  </div>
                  <div className="card-title" style={{ marginTop: 4 }}>消费明细</div>
                  {ledger.length ? (
                    <ul className="ledger-list full">
                      {ledger.map((r) => (
                        <li key={r.id}>
                          <span className="ledger-reason">{r.reason_label || r.reason}</span>
                          <span className={r.delta < 0 ? 'ledger-neg' : 'ledger-pos'}>{r.delta > 0 ? `+${r.delta}` : r.delta}</span>
                          <span className="ledger-time">{formatLedgerTime(r.created_at)}</span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="key-desc small">暂无记录</p>
                  )}
                  <div className="card-title" style={{ marginTop: 4 }}>充值</div>
                  <p className="key-desc small">目前为手动充值：微信 / 支付宝转账给站长后，管理员会在后台为你发放积分。</p>
                  <div className="card-title" style={{ marginTop: 4 }}>账户安全</div>
                  <div className="key-input-row">
                    <input value={recoveryCode} readOnly placeholder="加载中…" spellCheck={false} autoComplete="off" style={{ fontFamily: 'ui-monospace, monospace', letterSpacing: 2 }} />
                    <button className="btn secondary" onClick={regenRecovery} disabled={regenBusy}>{regenBusy ? '生成中…' : '重新生成'}</button>
                  </div>
                  <p className="key-desc small">密码重置码：忘记密码时凭它自助找回，请妥善保存。重新生成后旧码立即失效。</p>
                </>
              ) : (
                <p className="key-desc small">自带 Key 模式请到「API」tab 配置你的 OpenRouter Key。</p>
              )}
            </>
          )}

          {tab === 'api' && (
            <>
              <p className="key-desc">配置保存在<b>服务器</b>（Key 加密存储，永不回显），随账号走，换设备也生效。</p>
              <label>
                API 地址
                <input value={form.baseUrl} onChange={setField('baseUrl')} placeholder={DEFAULT_BASE_URL} spellCheck={false} autoComplete="off" />
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
                  <button className="btn secondary" onClick={() => setShowKey((s) => !s)}>{showKey ? '隐藏' : '显示'}</button>
                </div>
              </label>
              <label>
                聊天模型
                <div className="key-input-row">
                  <ModelPicker value={form.model} onChange={(v) => setForm((f) => ({ ...f, model: v }))} models={models} placeholder="先拉取模型列表，或手动输入" openSignal={pullSeq} />
                  <button className="btn secondary" onClick={pullModels} disabled={loading}>{loading ? '拉取中…' : '拉取模型'}</button>
                </div>
              </label>
              {models.length > 0 && <p className="key-desc small">共 {models.length} 个可用模型，可在输入框中搜索选择。</p>}
              <label>
                后台模型
                <ModelPicker value={form.workerModel || ''} onChange={(v) => setForm((f) => ({ ...f, workerModel: v }))} models={models} placeholder="留空用默认便宜模型" />
              </label>
              <p className="key-desc small">后台模型负责群聊导演调度、记忆提取、对话摘要——用户看不到，用便宜的就行。</p>
              <div className="save-row">
                <button className="btn secondary" onClick={clearServer} disabled={loading}>清除</button>
                <button className="btn primary" onClick={() => { setBillingMode('byok'); save('byok'); }} disabled={loading}>
                  {loading ? '保存中…' : '保存设置'}
                </button>
              </div>
            </>
          )}

          {tab === 'invite' && (
            <>
              {invite ? (
                <>
                  <div className="invite-code-row">
                    <code className="invite-code">{invite.code}</code>
                    <button className="btn secondary" onClick={copyInviteLink}>
                      <Icon name="copy" size={16} /> 复制链接
                    </button>
                  </div>
                  <p className="key-desc small">
                    好友用你的链接注册：你得 {invite.inviterReward} 积分（对方聊满 {invite.chatThreshold} 条后发放），对方多得 {invite.inviteeBonus} 积分。
                  </p>
                  <p className="key-desc small">已邀请 {invite.invitedCount} 人 · 已奖励 {invite.rewardedCount} 人</p>
                </>
              ) : (
                <p className="key-desc small">加载中…</p>
              )}
            </>
          )}

          {tab === 'stats' && isAdmin && (
            <>
              {statsLoading ? (
                <p className="key-desc">加载中…</p>
              ) : stats ? (
                <>
                  <div className="stat-cards">
                    <div className="stat-card"><div className="stat-num">{stats.ov.totalUsers}</div><div className="stat-label">总用户</div></div>
                    <div className="stat-card"><div className="stat-num">{stats.ov.totalConsumed}</div><div className="stat-label">累计消耗</div></div>
                    <div className="stat-card"><div className="stat-num">{stats.ov.totalBalance}</div><div className="stat-label">剩余积分</div></div>
                    <div className="stat-card"><div className="stat-num">${stats.ov.estCostUsd}</div><div className="stat-label">平台花费估算</div></div>
                    <div className="stat-card"><div className="stat-num">{stats.ov.todayConsumed}</div><div className="stat-label">今日消耗</div></div>
                    <div className="stat-card"><div className="stat-num">{stats.ov.todayActiveUsers}</div><div className="stat-label">今日活跃</div></div>
                  </div>
                  <div className="card-title" style={{ marginTop: 4 }}>30 天消耗趋势</div>
                  <TrendChart data={stats.da} />
                  <div className="card-title" style={{ marginTop: 4 }}>模型分布</div>
                  {stats.mo.length ? (
                    <div className="model-bars">
                      {stats.mo.map((m) => (
                        <div className="model-bar-row" key={m.model}>
                          <span className="model-bar-name" title={m.model}>{m.model}</span>
                          <div className="model-bar-track">
                            <div className="model-bar-fill" style={{ width: `${Math.max(2, (m.points / maxModelPts) * 100)}%` }} />
                          </div>
                          <span className="model-bar-val">{m.points} 积分 · {m.calls} 次</span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="key-desc small">暂无数据</p>
                  )}
                  <div className="card-title" style={{ marginTop: 4 }}>消费 Top 10</div>
                  {stats.tu.length ? (
                    <table className="stat-table">
                      <thead><tr><th>用户</th><th>消耗</th><th>获赠</th><th>余额</th></tr></thead>
                      <tbody>
                        {stats.tu.map((u) => (
                          <tr key={u.username}><td>{u.username}</td><td>{u.consumed}</td><td>{u.granted}</td><td>{u.balance}</td></tr>
                        ))}
                      </tbody>
                    </table>
                  ) : (
                    <p className="key-desc small">暂无数据</p>
                  )}
                  <div className="card-title" style={{ marginTop: 4 }}>发放积分</div>
                  <div className="key-input-row">
                    <input value={grantUser} onChange={(e) => setGrantUser(e.target.value)} placeholder="用户名" spellCheck={false} autoComplete="off" />
                    <input value={grantAmount} onChange={(e) => setGrantAmount(e.target.value)} placeholder="数量" inputMode="numeric" autoComplete="off" style={{ maxWidth: 96 }} />
                    <button className="btn secondary" onClick={grant} disabled={granting}>{granting ? '发放中…' : '发放'}</button>
                  </div>
                  <p className="key-desc small">手动充值：用户付款后，按用户名发放积分。</p>
                  <div className="card-title" style={{ marginTop: 4 }}>积分可用模型</div>
                  <p className="key-desc small">上架后用户可在「积分」tab 选用；单价单位：积分 / 1M tokens；后台任务用的模型在下方「模型配置」里指定（不选则自动用最便宜的）。</p>
                  <div className="pm-list">
                      {pmModels.map((m) => (
                        <div key={m.id} className={`pm-row${m.is_active ? '' : ' off'}`}>
                          {pmEditing === m.id ? (
                            <div className="pm-edit">
                              <div className="key-input-row">
                                <input value={pmEditForm.name} onChange={(e) => setPmEditForm((f) => ({ ...f, name: e.target.value }))} placeholder="显示名" />
                              </div>
                              <div className="key-input-row" style={{ marginTop: 8 }}>
                                <input value={pmEditForm.description} onChange={(e) => setPmEditForm((f) => ({ ...f, description: e.target.value }))} placeholder="描述（可选）" />
                              </div>
                              <div className="key-input-row" style={{ marginTop: 8 }}>
                                <input value={pmEditForm.input_per_1m} onChange={(e) => setPmEditForm((f) => ({ ...f, input_per_1m: e.target.value }))} placeholder="输入单价" inputMode="numeric" />
                                <input value={pmEditForm.output_per_1m} onChange={(e) => setPmEditForm((f) => ({ ...f, output_per_1m: e.target.value }))} placeholder="输出单价" inputMode="numeric" />
                              </div>
                              <div className="key-input-row" style={{ marginTop: 8 }}>
                                <button className="btn primary small" onClick={() => pmSaveEdit(m.id)}>保存</button>
                                <button className="btn secondary small" onClick={() => setPmEditing(null)}>取消</button>
                              </div>
                            </div>
                          ) : (
                            <>
                              <div className="pm-info">
                                <div className="pm-name">{m.name}{!m.is_active && <span className="pm-off-tag">已下架</span>}</div>
                                <div className="pm-id">{m.model_id}</div>
                                <div className="pm-price">输入 {m.input_per_1m} / 输出 {m.output_per_1m}</div>
                              </div>
                              <div className="pm-actions">
                                <button className="btn secondary small" onClick={() => pmToggle(m)}>{m.is_active ? '下架' : '上架'}</button>
                                <button className="btn secondary small" onClick={() => pmStartEdit(m)}>改价</button>
                                <button className="btn danger small" onClick={() => pmDelete(m)}>删除</button>
                              </div>
                            </>
                          )}
                        </div>
                      ))}
                      {pmModels.length === 0 && <p className="key-desc small">暂无模型，请添加。</p>}
                    </div>
                  <div className="card-title" style={{ marginTop: 4 }}>模型配置</div>
                  <p className="key-desc small">后台模型负责群聊导演调度、记忆提取、对话摘要（共用一个）；聊天默认模型用于新用户默认和异常回退。不选 = 自动用最便宜的启用模型。</p>
                  <label>
                    后台模型
                    <select
                      value={modelCfg.worker_model}
                      onChange={(e) => setModelCfg((f) => ({ ...f, worker_model: e.target.value }))}
                    >
                      <option value="">自动（最便宜）</option>
                      {pmModels.filter((m) => m.is_active).map((m) => (
                        <option key={m.model_id} value={m.model_id}>{m.name}（{m.model_id}）</option>
                      ))}
                    </select>
                  </label>
                  <label>
                    聊天默认模型
                    <select
                      value={modelCfg.chat_default_model}
                      onChange={(e) => setModelCfg((f) => ({ ...f, chat_default_model: e.target.value }))}
                    >
                      <option value="">自动（最便宜）</option>
                      {pmModels.filter((m) => m.is_active).map((m) => (
                        <option key={m.model_id} value={m.model_id}>{m.name}（{m.model_id}）</option>
                      ))}
                    </select>
                  </label>
                  <label>
                    过滤回退模型 1（优先）
                    <select
                      value={(modelCfg.filter_fallback_models && modelCfg.filter_fallback_models[0]) || ''}
                      onChange={(e) => {
                        const v = e.target.value;
                        setModelCfg((f) => {
                          const arr = [...(f.filter_fallback_models || [])];
                          if (v) arr[0] = v; else arr.splice(0, 1);
                          return { ...f, filter_fallback_models: arr.filter(Boolean) };
                        });
                      }}
                    >
                      <option value="">不设置</option>
                      {pmModels.filter((m) => m.is_active).map((m) => (
                        <option key={m.model_id} value={m.model_id}>{m.name}（{m.model_id}）</option>
                      ))}
                    </select>
                  </label>
                  <label>
                    过滤回退模型 2
                    <select
                      value={(modelCfg.filter_fallback_models && modelCfg.filter_fallback_models[1]) || ''}
                      onChange={(e) => {
                        const v = e.target.value;
                        setModelCfg((f) => {
                          const arr = [...(f.filter_fallback_models || [])];
                          if (v) arr[1] = v; else arr.splice(1, 1);
                          return { ...f, filter_fallback_models: arr.filter(Boolean) };
                        });
                      }}
                    >
                      <option value="">不设置</option>
                      {pmModels.filter((m) => m.is_active).map((m) => (
                        <option key={m.model_id} value={m.model_id}>{m.name}（{m.model_id}）</option>
                      ))}
                    </select>
                  </label>
                  <p className="key-desc small">上游内容过滤拦截时，按顺序自动换模型重试一次；两个都选「不设置」并保存 = 关闭回退；不碰这里 = 默认 Euryale → Cydonia。</p>
                  <div className="key-input-row" style={{ marginTop: 8 }}>
                    <button className="btn primary" onClick={saveModelCfg} disabled={modelCfgSaving}>
                      {modelCfgSaving ? '保存中…' : '保存模型配置'}
                    </button>
                  </div>
                  <div className="card-title" style={{ marginTop: 4 }}>上架新模型</div>
                  <label>
                    模型 ID（须与 OpenRouter 一致）
                    <input value={pmForm.model_id} onChange={(e) => setPmForm((f) => ({ ...f, model_id: e.target.value }))} placeholder="如 openai/gpt-7-mini" spellCheck={false} autoComplete="off" />
                  </label>
                  <label>
                    显示名
                    <input value={pmForm.name} onChange={(e) => setPmForm((f) => ({ ...f, name: e.target.value }))} placeholder="留空则用模型 ID" spellCheck={false} autoComplete="off" />
                  </label>
                  <label>
                    描述（可选）
                    <input value={pmForm.description} onChange={(e) => setPmForm((f) => ({ ...f, description: e.target.value }))} placeholder="如：快速便宜，日常聊天首选" spellCheck={false} autoComplete="off" />
                  </label>
                  <div className="key-input-row">
                    <input value={pmForm.input_per_1m} onChange={(e) => setPmForm((f) => ({ ...f, input_per_1m: e.target.value }))} placeholder="输入单价 /1M" inputMode="numeric" autoComplete="off" />
                    <input value={pmForm.output_per_1m} onChange={(e) => setPmForm((f) => ({ ...f, output_per_1m: e.target.value }))} placeholder="输出单价 /1M" inputMode="numeric" autoComplete="off" />
                    <button className="btn primary" onClick={pmAdd} disabled={pmAdding}>{pmAdding ? '上架中…' : '上架'}</button>
                  </div>
                </>
              ) : (
                <p className="key-desc small">暂无数据</p>
              )}
            </>
          )}
          {tab === 'review' && isAdmin && (
            <>
              <div className="review-filter">
                {['pending', 'approved', 'rejected'].map((s) => (
                  <button
                    key={s}
                    className={reviewStatus === s ? 'cat-tab active' : 'cat-tab'}
                    onClick={() => setReviewStatus(s)}
                  >
                    {s === 'pending' ? '待审核' : s === 'approved' ? '已上架' : '已打回'}
                  </button>
                ))}
                <button className="btn secondary small" onClick={() => loadReview(reviewStatus)}>
                  刷新
                </button>
              </div>
              {reviewLoading ? (
                <p className="key-desc">加载中…</p>
              ) : reviewList.length === 0 ? (
                <p className="key-desc">没有投稿</p>
              ) : (
                <div className="review-list">
                  {reviewList.map((item) => (
                    <div key={item.id} className="review-card">
                      <div className="review-head">
                        <span className="preset-avatar">{item.card.avatar || '🤖'}</span>
                        <div className="review-meta">
                          <div className="review-name">{item.card.name}</div>
                          <div className="review-sub">
                            by {item.author_name} · {item.card.tagline}
                            {item.report_count > 0 && (
                              <span className="report-flag"> ⚠被举报 {item.report_count} 次</span>
                            )}
                          </div>
                        </div>
                        <span className={`status-badge ${item.status}`}>
                          {item.status === 'pending' ? '待审核' : item.status === 'approved' ? '已上架' : '已打回'}
                        </span>
                      </div>
                      {item.card.description && <p className="card-desc">{item.card.description}</p>}
                      <div className="greeting-box small">{item.card.greeting}</div>
                      {item.status === 'pending' && (
                        <div className="review-actions">
                          <button className="btn primary small" onClick={() => doReview(item.id, true)}>
                            通过上架
                          </button>
                          <input
                            value={rejectInputs[item.id] || ''}
                            onChange={(e) => setRejectInputs((m) => ({ ...m, [item.id]: e.target.value }))}
                            placeholder="打回理由（必填）"
                            maxLength={200}
                          />
                          <button className="btn danger small" onClick={() => doReview(item.id, false)}>
                            打回
                          </button>
                        </div>
                      )}
                      {item.status === 'rejected' && item.reject_reason && (
                        <div className="my-pub-reject">打回原因：{item.reject_reason}</div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
        {version && <div className="settings-foot">SoulChat v{version}</div>}
      </div>
    </div>
    </SettingsErrorBoundary>
  );
}
