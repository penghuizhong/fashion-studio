// 设置弹窗（ChatGPT 式）：横向滑动二级导航 + 内容区
// tab: points(积分) / api(API) / invite(邀请) / stats(用量统计·管理员)
import React, { useEffect, useRef, useState } from 'react';
import { api, fetchModels, DEFAULT_BASE_URL } from '../api.js';
import Icon from './icons.jsx';
import Avatar from './Avatar.jsx';
import ModelsTab from './ModelsTab.jsx';
import DnaPresetsTab from './DnaPresetsTab.jsx';
import ModelPicker from './ModelPicker.jsx';

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
  // v1.19.0: 自带 Key 调用次数（独立刻度）
  const maxApi = Math.max(1, ...data.map((d) => d.apiCalls || 0));
  const n = data.length;
  const xs = (i) => P + (n === 1 ? 0 : (i / (n - 1)) * (W - 2 * P));
  const ys = (v) => H - P - (v / max) * (H - 2 * P);
  const ysApi = (v) => H - P - (v / maxApi) * (H - 2 * P);
  const line = data.map((d, i) => `${i ? 'L' : 'M'}${xs(i).toFixed(1)},${ys(d.consumed).toFixed(1)}`).join(' ');
  const area = `${line} L${xs(n - 1).toFixed(1)},${H - P} L${xs(0).toFixed(1)},${H - P} Z`;
  const lineApi = data.map((d, i) => `${i ? 'L' : 'M'}${xs(i).toFixed(1)},${ysApi(d.apiCalls || 0).toFixed(1)}`).join(' ');
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
      <path d={lineApi} fill="none" stroke="#34c77b" strokeWidth="2" strokeDasharray="5 3" strokeLinejoin="round" />
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
      {/* 图例 */}
      <circle cx={P + 4} cy={34} r="4" fill="#5b8def" />
      <text x={P + 12} y={38} fontSize="11" fill="var(--text-secondary)">积分消耗</text>
      <circle cx={P + 90} cy={34} r="4" fill="#34c77b" />
      <text x={P + 98} y={38} fontSize="11" fill="var(--text-secondary)">API 调用{maxApi > 1 ? `（max ${maxApi}）` : ''}</text>
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
  const [form, setForm] = useState({ baseUrl: '', key: '', model: '', workerModel: '', provider: 'custom' });
  const [models, setModels] = useState([]);
  const [providers, setProviders] = useState([]); // v1.20.0: API 提供商预设
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
  // v1.18.1: 注册送积分（管理员可配）+ 按用户直接设余额
  const [signupBonus, setSignupBonus] = useState('');
  const [signupBonusSaving, setSignupBonusSaving] = useState(false);
  const [adjustUser, setAdjustUser] = useState(null); // { username, balance }
  // 密码重置码
  const [recoveryCode, setRecoveryCode] = useState('');
  const [regenBusy, setRegenBusy] = useState(false);
  // v1.18.1: 注册送积分（管理员可配）——随积分 tab 懒加载
  const loadSignupBonus = async () => {
    try {
      const s = await api.adminGetSettings();
      if (s && typeof s.signup_bonus === 'number') setSignupBonus(String(s.signup_bonus));
    } catch {
      /* 非管理员或加载失败就保持默认 */
    }
  };

  // 系统提示词模板（管理员）
  const [promptCfg, setPromptCfg] = useState(null);
  const [promptLoading, setPromptLoading] = useState(false);
  const [promptSaving, setPromptSaving] = useState(false);
  const loadPromptCfg = async () => {
    setPromptLoading(true);
    try {
      const s = await api.adminGetSettings();
      const jb = {};
      for (const p of (s && s.jailbreak_presets) || []) jb[p.key] = p.prompt || '';
      setPromptCfg({
        roleplay_template: (s && s.roleplay_template) || '',
        roleplay_template_custom: !!(s && s.roleplay_template_custom),
        jailbreak_presets: (s && s.jailbreak_presets) || [],
        jailbreak: jb,
      });
    } catch (e) {
      showToast((e && e.message) || '读取提示词模板失败', 2600);
    } finally {
      setPromptLoading(false);
    }
  };
  const savePromptCfg = async () => {
    if (!promptCfg) return;
    setPromptSaving(true);
    try {
      await api.adminUpdateSettings({
        roleplay_template: promptCfg.roleplay_template,
        jailbreak_presets: promptCfg.jailbreak,
      });
      showToast('提示词模板已保存');
      loadPromptCfg();
    } catch (e) {
      showToast((e && e.message) || '保存失败');
    } finally {
      setPromptSaving(false);
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
  if (isAdmin) TABS.push({ id: 'models', icon: 'cpu', label: '模型管理' });
  if (isAdmin) TABS.push({ id: 'dna-presets', icon: 'book', label: '类目预设' });
  if (isAdmin) TABS.push({ id: 'prompts', icon: 'chat', label: '提示词' });
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
          provider: (k && k.provider) || 'custom',
        });
        setHasServerKey(!!(k && k.hasKey));
        // v1.20.0: 提供商预设（失败则只留自定义，不挡主流程）
        api.getProviders().then((ps) => { if (!cancelled && Array.isArray(ps)) setProviders(ps); }).catch(() => {
          if (!cancelled) setProviders([{ id: 'custom', name: '自定义', defaultBaseUrl: '', modelHint: '', thinkingOff: null, note: '' }]);
        });
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

  // 提示词 tab 懒加载
  useEffect(() => {
    if (tab !== 'prompts' || promptCfg || promptLoading) return;
    loadPromptCfg();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

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
        // v1.19.0: 自带 Key 模型分布（失败不影响主统计）
        const am = await api.adminStatsApiModels().catch(() => []);
        if (!cancelled) setStats({ ov, da: da || [], mo: mo || [], tu: tu || [], am: am || [] });
        if (!cancelled) await loadSignupBonus();
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

  // 积分 tab 懒加载：注册送积分
  useEffect(() => {
    if (tab !== 'points' || !isAdmin || signupBonus !== '') return;
    loadSignupBonus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

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
      // v1.20.0: 部分提供商（如千问 DashScope 兼容接口）没有 /models 端点，引导手动输入
      showToast(`${(e && e.message) || '拉取失败'}（该地址可能不支持拉取，可手动输入模型 ID）`, 3000);
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
      // v1.25.1: 广播计费模式变更，聊天页即时刷新下方提示，无需等下次聊天
      window.dispatchEvent(new CustomEvent('soulchat-billing-changed', { detail: { mode: m === 'points' ? 'points' : 'api' } }));
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
        const provider = form.provider || 'custom';
        const testPayload = { provider, baseUrl: form.baseUrl.trim(), model: form.model.trim() };
        if (key) testPayload.key = key;
        // v1.20.0: 保存前连通性测试（Key+地址+模型），不通不让切，拦在配置阶段
        showToast('正在测试连接…', 1500);
        let t;
        try {
          t = await api.testApiKey(testPayload);
        } catch (e) {
          showToast((e && e.message) || '连接测试失败', 2600);
          return;
        }
        if (!t || !t.ok) {
          showToast(`连接失败：${(t && t.error) || '未知错误'}，请检查配置`, 3200);
          return;
        }
        const payload = { baseUrl: form.baseUrl.trim(), chatModel: form.model.trim(), workerModel: form.workerModel.trim(), provider };
        if (key) payload.key = key;
        const d = await api.saveUserApiKey(payload);
        setHasServerKey(!!(d && d.hasKey));
        setForm((f) => ({ ...f, key: '' }));
        showToast('连接正常，API 配置已保存到服务器，换设备也生效', 2200);
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
      setForm({ baseUrl: '', key: '', model: '', workerModel: '', provider: 'custom' });
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

  // v1.18.1: 注册送积分（管理员可配）
  const saveSignupBonus = async () => {
    const v = Math.floor(Number(signupBonus));
    if (!Number.isFinite(v) || v < 0 || v > 100000) { showToast('请输入 0~100000 的整数', 2000); return; }
    setSignupBonusSaving(true);
    try {
      await api.adminUpdateSettings({ signup_bonus: v });
      setSignupBonus(String(v));
      showToast(`注册送积分已设为 ${v}（只影响新用户）`, 2200);
    } catch (e) {
      showToast((e && e.message) || '保存失败', 2600);
    } finally {
      setSignupBonusSaving(false);
    }
  };

  // v1.18.1: 按用户直接设余额（发放输错时纠正）
  const saveAdjustPoints = async () => {
    const v = Math.floor(Number(adjustUser.balance));
    if (!Number.isFinite(v) || v < 0 || v > 10000000) { showToast('请输入 0~10000000 的整数', 2000); return; }
    try {
      const d = await api.adminSetPoints(adjustUser.username, v);
      showToast(`${d.username} 余额已设为 ${d.balance}`, 2200);
      setAdjustUser(null);
      const tu = await api.adminStatsTopUsers(10).catch(() => null);
      if (tu) setStats((s) => ({ ...s, tu }));
    } catch (e) {
      showToast((e && e.message) || '调整失败', 2600);
    }
  };
  // v1.18.1: 破限白名单开关（管理员在消费排行表里直接授权/撤销）
  const toggleJailbreak = async (u) => {
    const next = !(u.jailbreak_allowed || u.is_admin);
    try {
      await api.adminSetJailbreak(u.id, next);
      setStats((s) => ({ ...s, tu: s.tu.map((x) => (x.id === u.id ? { ...x, jailbreak_allowed: next } : x)) }));
      showToast(`${u.username} 破限权限已${next ? '开通' : '关闭'}`, 2000);
    } catch (e) {
      showToast((e && e.message) || '操作失败', 2600);
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
  const wlModels = ((pointsInfo && pointsInfo.models) || []).map((m) => ({ id: m.id, name: `${m.name} · ${m.desc}` }));
  // v1.18.3: 模型分布按模型+用途聚合（后端按 model,reason 分组）
  // v1.19.0: 积分 / 自带API 切换（自带API 按调用次数排）
  const [modelSrc, setModelSrc] = useState('points');
  const modelGroups = (() => {
    if (!stats) return [];
    const rows = modelSrc === 'points' ? stats.mo : stats.am || [];
    const valKey = modelSrc === 'points' ? 'points' : 'calls';
    const byModel = new Map();
    for (const r of rows) {
      if (!byModel.has(r.model)) byModel.set(r.model, { model: r.model, val: 0, calls: 0, reasons: [] });
      const g = byModel.get(r.model);
      g.val += r[valKey] || 0;
      g.calls += r.calls;
      g.reasons.push(r);
    }
    return [...byModel.values()].sort((a, b) => b.val - a.val);
  })();
  const maxModelPts = Math.max(1, ...modelGroups.map((m) => m.val));

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
                <>
                  <p className="key-desc small">当前为自带 Key 模式：用你自己的 OpenRouter Key，不花积分。</p>
                  <div className="save-row">
                    <button className="btn secondary" onClick={() => { setBillingMode('points'); save('points'); }} disabled={loading}>
                      切换回平台积分
                    </button>
                  </div>
                </>
              )}
            </>
          )}

          {tab === 'api' && (
            <>
              <p className="key-desc">配置保存在<b>服务器</b>（Key 加密存储，永不回显），随账号走，换设备也生效。</p>
              <label>
                提供商
                <select
                  value={form.provider || 'custom'}
                  onChange={(e) => {
                    const pid = e.target.value;
                    const p = (providers || []).find((x) => x.id === pid);
                    setForm((f) => ({ ...f, provider: pid, baseUrl: (p && p.defaultBaseUrl) || f.baseUrl }));
                  }}
                >
                  {(providers || []).map((p) => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </select>
              </label>
              {(() => {
                const p = (providers || []).find((x) => x.id === (form.provider || 'custom'));
                return p && p.note ? <p className="key-desc small"><Icon name="alert" size={14} /> {p.note}</p> : null;
              })()}
              <label>
                API 地址
                <input value={form.baseUrl} onChange={setField('baseUrl')} placeholder={DEFAULT_BASE_URL} spellCheck={false} autoComplete="off" />
              </label>
              <p className="key-desc small">同一家可有多个地址（北京/国际版/按量计费等），填你自己的那个就行，协议按上面的提供商走。</p>
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
              {(() => {
                const p = (providers || []).find((x) => x.id === (form.provider || 'custom'));
                return <p className="key-desc small">{p && p.modelHint ? `模型 ID 格式：${p.modelHint}` : ''}{models.length > 0 ? `共 ${models.length} 个可用模型，可在输入框中搜索选择。` : '该地址可能不支持拉取列表，可手动输入模型 ID。'}</p>;
              })()}
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
                  <div className="model-src-tabs">
                    <button className={modelSrc === 'points' ? 'active' : ''} onClick={() => setModelSrc('points')}>积分</button>
                    <button className={modelSrc === 'byok' ? 'active' : ''} onClick={() => setModelSrc('byok')}>自带API</button>
                  </div>
                  {modelGroups.length ? (
                    <div className="model-bars">
                      {modelGroups.map((m) => (
                        <div key={m.model}>
                          <div className="model-bar-row">
                            <span className="model-bar-name" title={m.model}>{m.model}</span>
                            <div className="model-bar-track">
                              <div className="model-bar-fill" style={{ width: `${Math.max(2, (m.val / maxModelPts) * 100)}%` }} />
                            </div>
                            <span className="model-bar-val">{modelSrc === 'points' ? `${m.val} 积分 · ${m.calls} 次` : `${m.calls} 次`}</span>
                          </div>
                          <div className="model-bar-reasons">
                            {m.reasons.map((r) => (
                              <span key={r.reason} className="model-bar-reason">{r.reason_label} {r.calls}次</span>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="key-desc small">暂无数据</p>
                  )}
                  <div className="card-title" style={{ marginTop: 4 }}>消费 Top 10</div>
                  {stats.tu.length ? (
                    <table className="stat-table">
                      <thead><tr><th>用户</th><th>消耗</th><th>获赠</th><th>余额</th><th>API调用</th><th>破限</th><th>操作</th></tr></thead>
                      <tbody>
                        {stats.tu.map((u) => (
                          <tr key={u.username}>
                            <td>{u.username}</td><td>{u.consumed}</td><td>{u.granted}</td><td>{u.balance}</td><td>{u.api_calls || 0}</td>
                            <td>
                              {u.is_admin ? (
                                <span className="key-desc small">管理员</span>
                              ) : (
                                <label className="jb-allow-toggle" title={u.jailbreak_allowed ? '点击撤销破限权限' : '点击授权破限权限'}>
                                  <input
                                    type="checkbox"
                                    checked={!!u.jailbreak_allowed}
                                    onChange={() => toggleJailbreak(u)}
                                  />
                                  <span>{u.jailbreak_allowed ? '已授权' : '未授权'}</span>
                                </label>
                              )}
                            </td>
                            <td>
                              <button
                                className="btn secondary small"
                                onClick={() => setAdjustUser({ username: u.username, balance: String(u.balance ?? '') })}
                              >
                                调整
                              </button>
                            </td>
                          </tr>
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
                  <div className="card-title" style={{ marginTop: 4 }}>注册送积分</div>
                  <div className="key-input-row">
                    <input value={signupBonus} onChange={(e) => setSignupBonus(e.target.value)} placeholder="数量" inputMode="numeric" autoComplete="off" style={{ maxWidth: 96 }} />
                    <button className="btn secondary" onClick={saveSignupBonus} disabled={signupBonusSaving}>{signupBonusSaving ? '保存中…' : '保存'}</button>
                  </div>
                  <p className="key-desc small">新用户首次聊天成功后到账；只影响新用户，已发放的不追溯。</p>
                </>
              ) : (
                <p className="key-desc small">暂无数据</p>
              )}
            </>
          )}
          {tab === 'models' && isAdmin && (
            <ModelsTab showToast={showToast} />
          )}
          {tab === 'dna-presets' && isAdmin && (
            <DnaPresetsTab showToast={showToast} />
          )}
          {tab === 'prompts' && isAdmin && (
            <>
              {promptLoading ? (
                <p className="key-desc">加载中…</p>
              ) : promptCfg ? (
                <>
                  <div className="card-title" style={{ marginTop: 0 }}>扮演模式默认提示词</div>
                  <p className="key-desc small">
                    角色开启扮演模式但未自定义提示词时使用。{promptCfg.roleplay_template_custom ? '当前为你的自定义版本。' : '当前为系统内置版本。'}清空并保存 = 恢复内置。
                  </p>
                  <label>
                    <textarea
                      value={promptCfg.roleplay_template}
                      onChange={(e) => setPromptCfg((f) => ({ ...f, roleplay_template: e.target.value }))}
                      rows={10}
                      spellCheck={false}
                    />
                  </label>
                  <div className="card-title" style={{ marginTop: 12 }}>破限预设提示词</div>
                  <p className="key-desc small">按预设分别覆盖 prompt；某条清空并保存 = 该预设恢复内置。选中哪个预设就注入哪个，不限聊天模型。</p>
                  {promptCfg.jailbreak_presets.map((p) => (
                    <div key={p.key} style={{ marginBottom: 12 }}>
                      <div className="pm-name">{p.name}{p.custom && <span className="pm-off-tag">已自定义</span>}</div>
                      <div className="pm-id">{p.key} · 调优目标：{(p.models || []).join('、') || '通用'}</div>
                      <label>
                        <textarea
                          value={(promptCfg.jailbreak && promptCfg.jailbreak[p.key]) || ''}
                          onChange={(e) => setPromptCfg((f) => ({ ...f, jailbreak: { ...(f.jailbreak || {}), [p.key]: e.target.value } }))}
                          rows={8}
                          spellCheck={false}
                          style={{ marginTop: 4 }}
                        />
                      </label>
                    </div>
                  ))}
                  <div className="key-input-row" style={{ marginTop: 8 }}>
                    <button className="btn primary" onClick={savePromptCfg} disabled={promptSaving}>
                      {promptSaving ? '保存中…' : '保存提示词模板'}
                    </button>
                    <button className="btn secondary" onClick={loadPromptCfg} disabled={promptSaving}>重新加载</button>
                  </div>
                </>
              ) : (
                <p className="key-desc small">加载失败，请重试。</p>
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
                        <span className="preset-avatar"><Avatar src={item.card.avatar} size={40} /></span>
                        <div className="review-meta">
                          <div className="review-name">{item.card.name}</div>
                          <div className="review-sub">
                            by {item.author_name} · {item.card.tagline}
                            {item.report_count > 0 && (
                              <span className="report-flag"><Icon name="alert" size={14} />被举报 {item.report_count} 次</span>
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
        {version && <div className="settings-foot">Fashion Studio v{version}</div>}
        {/* v1.18.1: 按用户调整积分 */}
        {adjustUser && (
          <div className="conv-menu-backdrop" onClick={() => setAdjustUser(null)}>
            <div
              className="conv-menu"
              style={{ left: '50%', top: '40%', transform: 'translate(-50%,-50%)', minWidth: 240, padding: 12 }}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="conv-menu-title">调整积分 · {adjustUser.username}</div>
              <div className="key-input-row" style={{ marginTop: 8 }}>
                <input
                  value={adjustUser.balance}
                  onChange={(e) => setAdjustUser({ ...adjustUser, balance: e.target.value })}
                  placeholder="目标余额"
                  inputMode="numeric"
                  autoComplete="off"
                  autoFocus
                  onKeyDown={(e) => { if (e.key === 'Enter') saveAdjustPoints(); }}
                />
              </div>
              <p className="key-desc small">直接设为目标余额，账本记一笔调整记录。</p>
              <div className="modal-actions">
                <button className="btn" onClick={() => setAdjustUser(null)}>取消</button>
                <button className="btn primary" onClick={saveAdjustPoints}>设为该余额</button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
    </SettingsErrorBoundary>
  );
}
