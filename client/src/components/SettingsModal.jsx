// 设置弹窗（ChatGPT 式）：横向滑动二级导航 + 内容区
// tab: points(积分) / api(API) / invite(邀请) / stats(用量统计·管理员)
import React, { useEffect, useRef, useState } from 'react';
import { api, fetchModels, DEFAULT_BASE_URL } from '../api.js';
import Icon from './icons.jsx';
import Avatar from './Avatar.jsx';

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
  // 积分模型管理
  const [pmModels, setPmModels] = useState([]);
  const [pmForm, setPmForm] = useState({ model_id: '', name: '', description: '', input_per_1m: '', output_per_1m: '' });
  // v1.26.2: 拉取可用模型（带实时报价）+ 连通测试
  const [orModels, setOrModels] = useState([]);
  const [orLoading, setOrLoading] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [testing, setTesting] = useState(false);
  // v1.26.2: 语音模型清单 + 测试
  const [voiceCatalog, setVoiceCatalog] = useState(null);
  const [voiceTesting, setVoiceTesting] = useState('');
  const [voiceTestResult, setVoiceTestResult] = useState(null);
  // v1.29.0: 内置音色批量克隆
  const [batchFiles, setBatchFiles] = useState([]);
  const [batchJob, setBatchJob] = useState(null);
  const [batchUploading, setBatchUploading] = useState(false);
  const [batchError, setBatchError] = useState('');
  const [builtinList, setBuiltinList] = useState(null);
  const builtinAudioRef = useRef(null);
  const [pmAdding, setPmAdding] = useState(false);
  const [pmEditing, setPmEditing] = useState(null); // 正在编辑的行 id
  const [pmEditForm, setPmEditForm] = useState({});
  // v1.12 模型配置（管理员）：后台模型 / 聊天默认模型
  const [modelCfg, setModelCfg] = useState({ worker_model: '', chat_default_model: '', filter_fallback_models: null, voice_tts_model: '', voice_asr_model: '', voice_design_model: '', voice_vc_model: '', voice_enabled: '1' });
  const [modelCfgSaving, setModelCfgSaving] = useState(false);
  const loadModelCfg = async () => {
    try {
      const s = await api.adminGetSettings();
      setModelCfg({
        worker_model: (s && s.worker_model) || '',
        chat_default_model: (s && s.chat_default_model) || '',
        filter_fallback_models: (s && Array.isArray(s.filter_fallback_models)) ? s.filter_fallback_models : null,
        voice_tts_model: (s && s.voice_tts_model) || '',
        voice_asr_model: (s && s.voice_asr_model) || '',
        voice_design_model: (s && s.voice_design_model) || '',
        voice_vc_model: (s && s.voice_vc_model) || '',
        voice_enabled: (s && s.voice_enabled) || '1',
      });
      // v1.18.1: 注册送积分（管理员可配）
      if (s && typeof s.signup_bonus === 'number') setSignupBonus(String(s.signup_bonus));
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

  // v1.26.1: 模型管理 tab 懒加载
  useEffect(() => {
    if (tab !== 'models' || !isAdmin) return;
    let cancelled = false;
    (async () => {
      try {
        const pm = await api.adminPointsModels().catch(() => []);
        if (!cancelled) setPmModels(Array.isArray(pm) ? pm : []);
        if (!cancelled) await loadModelCfg();
      } catch (e) {
        showToast((e && e.message) || '读取模型列表失败', 2200);
      }
    })();
    return () => { cancelled = true; };
  }, [tab, isAdmin]);

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
      setTestResult(null);
      await refreshPmModels();
      await refreshPoints();
      showToast('已上架', 2000);
    } catch (e) {
      showToast((e && e.message) || '添加失败', 2600);
    } finally {
      setPmAdding(false);
    }
  };

  // v1.26.2: 拉取 OpenRouter 可用模型（带实时报价）
  const fetchOrModels = async () => {
    setOrLoading(true);
    setTestResult(null);
    try {
      const models = await fetchModels();
      // 按输入价格排序
      models.sort((a, b) => (a.pricing?.prompt ?? 999) - (b.pricing?.prompt ?? 999));
      setOrModels(models);
      showToast(`拉取到 ${models.length} 个模型`, 2000);
    } catch (e) {
      showToast((e && e.message) || '拉取失败', 2600);
    } finally {
      setOrLoading(false);
    }
  };

  // v1.26.2: 选中模型自动填表单（含实时报价）
  const pickOrModel = (m) => {
    const p = m.pricing || {};
    // USD/1M tokens → 积分/1M tokens（按 1元=100积分，汇率7.2估算）
    const toPoints = (usd) => (usd == null ? '' : String(Math.round(usd * 7.2 * 100)));
    setPmForm((f) => ({
      ...f,
      model_id: m.id,
      name: m.name || m.id,
      input_per_1m: toPoints(p.prompt),
      output_per_1m: toPoints(p.completion),
    }));
    showToast(`已填入 ${m.id}`, 2000);
  };

  // v1.26.2: 连通测试
  const testModel = async () => {
    const mid = pmForm.model_id.trim();
    if (!mid) {
      showToast('请先填写模型 ID', 2000);
      return;
    }
    setTesting(true);
    setTestResult(null);
    try {
      const r = await api.testChatModel(mid);
      setTestResult(r);
    } catch (e) {
      setTestResult({ ok: false, error: (e && e.message) || '测试失败' });
    } finally {
      setTesting(false);
    }
  };

  // v1.26.2: 拉取语音模型清单
  const fetchVoiceCatalog = async () => {
    try {
      const c = await api.listVoiceModels();
      setVoiceCatalog(c);
    } catch (e) {
      showToast((e && e.message) || '拉取失败', 2600);
    }
  };

  // v1.26.2: 语音连通测试
  const testVoice = async (type) => {
    const modelKey = type === 'tts' ? 'voice_tts_model' : 'voice_asr_model';
    const model = modelCfg[modelKey] || '';
    setVoiceTesting(type);
    setVoiceTestResult(null);
    try {
      const r = await api.testVoiceModel({ type, model: model || undefined });
      setVoiceTestResult({ type, ...r });
    } catch (e) {
      setVoiceTestResult({ type, ok: false, error: (e && e.message) || '测试失败' });
    } finally {
      setVoiceTesting('');
    }
  };

  // v1.29.0: 内置音色批量克隆
  const readFileAsBase64 = (f) => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = reject;
    reader.readAsDataURL(f);
  });
  const handleBatchFiles = (e) => {
    const files = [...(e.target.files || [])].slice(0, 12);
    setBatchFiles(files.map((f) => ({ file: f, name: f.name.replace(/\.[^.]+$/, '').slice(0, 16) })));
    setBatchJob(null);
    setBatchError('');
  };
  const startBatchClone = async () => {
    if (!batchFiles.length || batchUploading) return;
    setBatchUploading(true);
    setBatchError('');
    setBatchJob(null);
    try {
      const voices = [];
      for (const bf of batchFiles) {
        if (bf.file.size > 10 * 1024 * 1024) throw new Error(`「${bf.name}」文件过大（限 10MB）`);
        voices.push({ name: bf.name.trim(), audio: await readFileAsBase64(bf.file), mimeType: bf.file.type || 'audio/wav' });
      }
      const r = await api.batchCloneVoices({ voices });
      const poll = async () => {
        try {
          const st = await api.batchCloneStatus(r.job_id);
          setBatchJob(st);
          if (st.status === 'running') {
            setTimeout(poll, 3000);
          } else {
            setBatchUploading(false);
            setBuiltinList(null);
          }
        } catch (e) {
          setBatchUploading(false);
          setBatchError((e && e.message) || '查询任务状态失败');
        }
      };
      poll();
    } catch (e) {
      setBatchUploading(false);
      setBatchError((e && e.message) || '上传失败');
    }
  };
  const loadBuiltinList = async () => {
    try {
      const r = await api.getBuiltinVoices();
      setBuiltinList(r.voices || []);
    } catch (e) {
      setBatchError((e && e.message) || '加载失败');
    }
  };
  // v1.29.4: 内置音色试听（克隆效果，走 TTS 接口）
  // v1.29.6: 试听原音（参考音频，本地播放不调接口）
  const [builtinPreviewing, setBuiltinPreviewing] = useState(null); // name 或 name+':orig'
  const [builtinPreviewError, setBuiltinPreviewError] = useState('');
  const stopBuiltinAudio = () => {
    if (builtinAudioRef.current) { try { builtinAudioRef.current.pause(); } catch {} }
    builtinAudioRef.current = null;
    setBuiltinPreviewing(null);
  };
  const playBuiltinAudio = async (key, label, makeAudio) => {
    if (builtinPreviewing === key) { stopBuiltinAudio(); return; }
    stopBuiltinAudio();
    setBuiltinPreviewing(key);
    setBuiltinPreviewError('');
    try {
      const audio = await makeAudio();
      builtinAudioRef.current = audio;
      audio.onended = () => setBuiltinPreviewing(null);
      audio.onerror = () => { setBuiltinPreviewing(null); setBuiltinPreviewError('音频播放失败'); };
      await audio.play();
    } catch (e) {
      setBuiltinPreviewing(null);
      setBuiltinPreviewError(`「${label}」试听失败：${(e && e.message) || '未知错误'}`);
    }
  };
  const previewBuiltin = (v) => playBuiltinAudio(v.name, v.name, async () => {
    const r = await api.voiceTts({
      text: v.preview || `你好，我是${v.name}。`,
      voice: v.voice_id,
      speed: 1.0,
      forceAll: true,
    });
    if (r.skipped || !r.audioUrl) throw new Error('未返回音频');
    // v1.29.12: 用 HTTP 接口播（替代 data URL）
    return new Audio(r.audioUrl);
  });
  const previewOriginal = (v) => playBuiltinAudio(v.name + ':orig', v.name + '原音', async () => {
    // v1.29.9: 管理页用 admin 接口（v1.29.6 验证可用）；选择器用公开接口
    return new Audio(`/api/admin/voice/builtin/${encodeURIComponent(v.name)}/audio`);
  });
  const clearBuiltinList = async () => {
    if (!window.confirm('确定清空全部系统内置音色吗？音色选择器将恢复默认 12 个。')) return;
    try {
      await api.clearBuiltinVoices();
      setBuiltinList([]);
      setBatchError('');
    } catch (e) {
      setBatchError((e && e.message) || '清空失败');
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
            <>
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
                  <p className="key-desc small">上游内容过滤拦截时，按顺序自动换模型重试一次；两个都选「不设置」并保存 = 关闭回退；不碰这里 = 用系统默认回退链。</p>
                  <div className="key-input-row" style={{ marginTop: 8 }}>
                    <button className="btn primary" onClick={saveModelCfg} disabled={modelCfgSaving}>
                      {modelCfgSaving ? '保存中…' : '保存模型配置'}
                    </button>
                  </div>
                  <div className="card-title" style={{ marginTop: 4 }}>上架新模型</div>
                  {/* v1.26.3: 模型 ID 输入框右置拉取按钮，可下拉选择；下方显示真实报价 */}
                  <label>
                    模型 ID（须与 OpenRouter 一致）
                    <div className="key-input-row">
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <ModelPicker
                          value={pmForm.model_id}
                          onChange={(v) => {
                            setPmForm((f) => ({ ...f, model_id: v }));
                            // 选中后自动填报价
                            const m = orModels.find((x) => x.id === v);
                            if (m) pickOrModel(m);
                          }}
                          models={orModels}
                          placeholder="如 openai/gpt-7-mini"
                          openSignal={orModels.length}
                        />
                      </div>
                      <button className="btn secondary" onClick={fetchOrModels} disabled={orLoading} style={{ whiteSpace: 'nowrap' }}>
                        {orLoading ? '拉取中…' : '拉取可用模型'}
                      </button>
                    </div>
                  </label>
                  {/* 真实报价展示 */}
                  {(() => {
                    const m = orModels.find((x) => x.id === pmForm.model_id.trim());
                    if (!m || !m.pricing) return null;
                    const p = m.pricing;
                    return (
                      <p className="key-desc small" style={{ margin: '4px 0 8px' }}>
                        实时报价：输入 {p.prompt != null ? `$${p.prompt.toFixed(2)}` : '?'} / 输出 {p.completion != null ? `$${p.completion.toFixed(2)}` : '?'}（USD/1M tokens）
                        {m.context_length ? ` · 上下文 ${Math.round(m.context_length / 1000)}K` : ''}
                      </p>
                    );
                  })()}
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
                    <button className="btn secondary" onClick={testModel} disabled={testing}>
                      {testing ? '测试中…' : '连通测试'}
                    </button>
                    <button className="btn primary" onClick={pmAdd} disabled={pmAdding}>{pmAdding ? '上架中…' : '上架'}</button>
                  </div>
                  {/* v1.26.2: 连通测试结果 */}
                  {testResult && (
                    <div className={`test-result${testResult.ok ? ' ok' : ' fail'}`}>
                      {testResult.ok ? (
                        <>✓ 连通正常（{testResult.latency}ms）{testResult.reply && ` · 回复: ${testResult.reply}`}</>
                      ) : (
                        <>✗ {testResult.error || '连接失败'}{testResult.latency != null && `（${testResult.latency}ms）`}</>
                      )}
                    </div>
                  )}
                  <div className="card-title" style={{ marginTop: 16 }}>语音功能</div>
                  <label className="row" style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                    <input
                      type="checkbox"
                      checked={modelCfg.voice_enabled !== '0'}
                      onChange={(e) => setModelCfg((f) => ({ ...f, voice_enabled: e.target.checked ? '1' : '0' }))}
                    />
                    <span>启用语音功能（关闭后所有语音合成/识别/克隆接口停用）</span>
                  </label>
                  <div className="card-title" style={{ marginTop: 8 }}>语音模型</div>
                  <p className="key-desc small">TTS/ASR/音色设计走 DashScope，不选 = 用默认模型。DashScope 无公开模型列表，「查看可用模型」展示的是内置清单（非实时）。</p>
                  {/* v1.26.3: 输入框右置拉取按钮，可下拉选择 */}
                  <label>
                    TTS 模型（语音合成）
                    <div className="key-input-row">
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <ModelPicker
                          value={modelCfg.voice_tts_model || ''}
                          onChange={(v) => setModelCfg((f) => ({ ...f, voice_tts_model: v }))}
                          models={(voiceCatalog?.tts || []).map((m) => ({ id: m.id, name: m.name }))}
                          placeholder="默认：qwen-audio-3.0-tts-plus"
                          openSignal={voiceCatalog?.tts?.length}
                        />
                      </div>
                      <button className="btn secondary small" onClick={fetchVoiceCatalog} style={{ whiteSpace: 'nowrap' }}>
                        查看可用模型
                      </button>
                    </div>
                  </label>
                  <label>
                    ASR 模型（语音识别）
                    <div className="key-input-row">
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <ModelPicker
                          value={modelCfg.voice_asr_model || ''}
                          onChange={(v) => setModelCfg((f) => ({ ...f, voice_asr_model: v }))}
                          models={(voiceCatalog?.asr || []).map((m) => ({ id: m.id, name: m.name }))}
                          placeholder="默认：qwen-audio-3.0-asr-flash"
                          openSignal={voiceCatalog?.asr?.length}
                        />
                      </div>
                      <button className="btn secondary small" onClick={fetchVoiceCatalog} style={{ whiteSpace: 'nowrap' }}>
                        查看可用模型
                      </button>
                    </div>
                  </label>
                  {voiceTestResult && (
                    <div className={`test-result${voiceTestResult.ok ? ' ok' : ' fail'}`}>
                      {voiceTestResult.ok ? (
                        <>✓ {voiceTestResult.type === 'tts' ? 'TTS' : 'ASR'} 连通正常（{voiceTestResult.latency}ms{voiceTestResult.bytes ? `，${voiceTestResult.bytes}字节` : ''}）</>
                      ) : (
                        <>✗ {voiceTestResult.error || '连接失败'}</>
                      )}
                    </div>
                  )}
                  <label>
                    音色设计模型
                    <div className="key-input-row">
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <ModelPicker
                          value={modelCfg.voice_design_model || ''}
                          onChange={(v) => setModelCfg((f) => ({ ...f, voice_design_model: v }))}
                          models={(voiceCatalog?.design || []).map((m) => ({ id: m.id, name: m.name }))}
                          placeholder="默认：qwen3-tts-vd-2026-01-26"
                          openSignal={voiceCatalog?.design?.length}
                        />
                      </div>
                      <button className="btn secondary small" onClick={fetchVoiceCatalog} style={{ whiteSpace: 'nowrap' }}>
                        查看可用模型
                      </button>
                    </div>
                  </label>
                  {/* v1.29.0: 克隆音色合成模型（须与克隆时 target_model 一致） */}
                  <label>
                    克隆音色合成模型
                    <div className="key-input-row">
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <ModelPicker
                          value={modelCfg.voice_vc_model || ''}
                          onChange={(v) => setModelCfg((f) => ({ ...f, voice_vc_model: v }))}
                          models={(voiceCatalog?.vc || []).map((m) => ({ id: m.id, name: m.name }))}
                          placeholder="默认：cosyvoice-v3.5-plus"
                          openSignal={voiceCatalog?.vc?.length}
                        />
                      </div>
                      <button className="btn secondary small" onClick={fetchVoiceCatalog} style={{ whiteSpace: 'nowrap' }}>
                        查看可用模型
                      </button>
                    </div>
                  </label>
                  {/* v1.29.0: 内置音色批量克隆 */}
                  <div className="card-title" style={{ marginTop: 16 }}>内置音色批量克隆</div>
                  <p className="key-desc small">上传参考音频（WAV/MP3/M4A，15–60秒，单人清晰人声），逐个调用克隆接口，拿到的 voice_id 存为系统内置音色，音色选择器即时生效。系统级操作，不扣积分。</p>
                  <input
                    type="file"
                    multiple
                    accept="audio/*,.wav,.mp3,.m4a"
                    onChange={handleBatchFiles}
                    disabled={batchUploading}
                    style={{ marginBottom: 8 }}
                  />
                  {batchFiles.length > 0 && (
                    <div style={{ marginBottom: 8 }}>
                      {batchFiles.map((bf, i) => (
                        <div key={i} className="key-input-row" style={{ marginBottom: 4 }}>
                          <span className="key-desc small" style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{bf.file.name}</span>
                          <input
                            className="key-input"
                            style={{ width: 110 }}
                            value={bf.name}
                            onChange={(e) => setBatchFiles((arr) => arr.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))}
                            placeholder="音色名"
                            disabled={batchUploading}
                          />
                        </div>
                      ))}
                      <button className="btn primary" onClick={startBatchClone} disabled={batchUploading} style={{ marginTop: 4 }}>
                        {batchUploading ? '克隆中…' : `开始克隆（${batchFiles.length} 个）`}
                      </button>
                    </div>
                  )}
                  {batchJob && (
                    <div className="key-desc small" style={{ marginBottom: 8 }}>
                      <div>进度：{batchJob.done}/{batchJob.total}（{batchJob.status === 'running' ? '进行中…' : '完成'}）</div>
                      {batchJob.results.map((r, i) => (
                        <div key={i} style={{ color: r.ok ? 'inherit' : '#c00' }}>
                          {r.ok ? `✓ ${r.name}` : `✗ ${r.name}：${r.error}`}
                        </div>
                      ))}
                    </div>
                  )}
                  {batchError && <div className="test-result fail" style={{ marginBottom: 8 }}>✗ {batchError}</div>}
                  <div className="key-input-row">
                    <button className="btn secondary small" onClick={loadBuiltinList} disabled={batchUploading}>
                      查看当前内置音色{builtinList ? `（${builtinList.length}）` : ''}
                    </button>
                    {builtinList && builtinList.length > 0 && (
                      <button className="btn secondary small" onClick={clearBuiltinList} disabled={batchUploading}>
                        清空内置音色
                      </button>
                    )}
                  </div>
                  {builtinList && builtinList.length > 0 && (
                    <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>
                      {builtinList.map((v) => (
                        <div key={v.name} className="key-input-row" style={{ alignItems: 'center' }}>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontWeight: 600 }}>{v.name}</div>
                            <div className="key-desc small" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {[v.description, v.gender].filter(Boolean).join(' · ') || v.voice_id}
                            </div>
                          </div>
                          <div style={{ display: 'flex', gap: 6 }}>
                            {v.has_audio && (
                              <button
                                className="btn secondary small"
                                onClick={() => previewOriginal(v)}
                                disabled={!!builtinPreviewing && builtinPreviewing !== v.name + ':orig'}
                                title="播放你上传的参考音频（不调接口）"
                              >
                                {builtinPreviewing === v.name + ':orig' ? '停止' : '试听原音'}
                              </button>
                            )}
                            <button
                              className="btn secondary small"
                              onClick={() => previewBuiltin(v)}
                              disabled={!!builtinPreviewing && builtinPreviewing !== v.name}
                              title="用克隆音色合成试听（调 TTS 接口）"
                            >
                              {builtinPreviewing === v.name ? '停止' : '试听克隆'}
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                  {builtinPreviewError && (
                    <div className="test-result fail" style={{ marginTop: 8 }}>{builtinPreviewError}</div>
                  )}
                  <div className="key-input-row" style={{ marginTop: 8 }}>
                    <button className="btn primary" onClick={saveModelCfg} disabled={modelCfgSaving}>
                      {modelCfgSaving ? "保存中…" : "保存模型配置"}
                    </button>
                    <button className="btn secondary" onClick={() => testVoice('tts')} disabled={voiceTesting === 'tts'}>
                      {voiceTesting === 'tts' ? '测试中…' : '连通测试'}
                    </button>
                  </div>
            </>
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
        {version && <div className="settings-foot">SoulChat v{version}</div>}
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
