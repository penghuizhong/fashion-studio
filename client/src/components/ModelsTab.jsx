// v0.2.0: 统一模型管理（管理员）——供应商 → 模型两层；Key 只写不读
import { useEffect, useState } from 'react';
import { api } from '../api.js';
import Icon from './icons.jsx';
import ModelPicker from './ModelPicker.jsx';
import { SIZE_FAMILIES, guessFamily, familyById } from './ImageSizePresets.js';

const PRESETS = [
  { id: 'openrouter', name: 'OpenRouter' },
  { id: 'dashscope', name: '千问 DashScope' },
  { id: 'deepseek', name: 'DeepSeek 官方' },
  { id: 'zhipu', name: '智谱 GLM' },
  { id: 'custom', name: '自定义' },
];
const presetName = (id) => (PRESETS.find((p) => p.id === id) || {}).name || id;
const KIND_LABEL = { llm: '仅聊天', image: '仅图片', both: '聊天+图片' };

const emptyPForm = { name: '', preset: 'custom', kind: 'both', base_url: '', api_key: '', is_active: true };
const emptyMForm = {
  provider_id: '', kind: 'chat', model_id: '', name: '',
  input_per_1m: '', output_per_1m: '', per_call: '', sizes: '1024x1024', prompt_extend: true, vision: false,
};

export default function ModelsTab({ showToast }) {
  const [providers, setProviders] = useState([]);
  const [models, setModels] = useState([]);
  const [pEditing, setPEditing] = useState(null); // 'new' | id | null
  const [pForm, setPForm] = useState(emptyPForm);
  const [pBusy, setPBusy] = useState(false);
  const [pTesting, setPTesting] = useState('');
  const [mEditing, setMEditing] = useState(null);
  const [mForm, setMForm] = useState(emptyMForm);
  const [sizeFamily, setSizeFamily] = useState('generic');
  const [mBusy, setMBusy] = useState(false);
  const [modelCfg, setModelCfg] = useState({ worker_model: '', chat_default_model: '', filter_fallback_models: null });
  const [modelCfgSaving, setModelCfgSaving] = useState(false);

  const load = async () => {
    try {
      const [pr, mo, sc] = await Promise.all([
        api.adminProviders.list(),
        api.adminModels.list(),
        api.adminGetSettings().catch(() => null),
      ]);
      setProviders(pr.providers || []);
      setModels(mo.models || []);
      if (sc) {
        setModelCfg({
          worker_model: sc.worker_model || '',
          chat_default_model: sc.chat_default_model || '',
          filter_fallback_models: Array.isArray(sc.filter_fallback_models) ? sc.filter_fallback_models : null,
        });
      }
    } catch (e) {
      showToast(e.message || '加载失败');
    }
  };
  useEffect(() => { load(); }, []);

  const setP = (k) => (e) => {
    const v = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
    setPForm((f) => ({ ...f, [k]: v }));
  };
  const setM = (k) => (e) => {
    const v = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
    setMForm((f) => ({ ...f, [k]: v }));
  };

  // ---- 供应商 ----
  const pStartNew = () => { setPForm({ ...emptyPForm }); setPEditing('new'); };
  const pStartEdit = (p) => {
    setPForm({ name: p.name, preset: p.preset, kind: p.kind, base_url: p.base_url || '', api_key: '', is_active: !!p.is_active });
    setPEditing(p.id);
  };
  const pSave = async () => {
    if (!pForm.name.trim()) { showToast('供应商名称必填'); return; }
    if (pEditing === 'new' && !pForm.api_key.trim()) { showToast('新建供应商请填写 API Key'); return; }
    setPBusy(true);
    try {
      const body = { ...pForm };
      if (!body.api_key.trim()) delete body.api_key; // 留空=不改
      if (pEditing === 'new') await api.adminProviders.create(body);
      else await api.adminProviders.update(pEditing, body);
      showToast('已保存');
      setPEditing(null);
      await load();
    } catch (e) {
      showToast(e.message || '保存失败');
    } finally {
      setPBusy(false);
    }
  };
  const pDel = async (p) => {
    if (!window.confirm(`删除供应商「${p.name}」？其下模型会一并停用（不删除历史计费记录）。`)) return;
    try {
      const r = await api.adminProviders.remove(p.id);
      showToast(r.deactivatedModels ? `已删除，${r.deactivatedModels} 个模型已停用` : '已删除');
      await load();
    } catch (e) {
      showToast(e.message || '删除失败');
    }
  };
  const pSetDefault = async (p) => {
    try {
      await api.adminProviders.setDefault(p.id);
      showToast(`「${p.name}」已设为默认聊天供应商`);
      await load();
    } catch (e) {
      showToast(e.message || '设置失败');
    }
  };
  const pTest = async (p) => {
    setPTesting(p.id);
    try {
      const r = await api.adminProviders.test(p.id);
      if (r.ok) {
        showToast(`连通正常，已拉取 ${r.count} 个可用模型（${r.latency}ms）`);
        await load();
        if (mForm.provider_id === p.id) await loadPulledModels(p.id);
      } else {
        showToast(`连通失败：${r.error || '未知错误'}`);
      }
    } catch (e) {
      showToast(e.message || '测试失败');
    } finally {
      setPTesting('');
    }
  };
  // v0.2.1: 上架模型时，模型 ID 输入框用该供应商缓存的可用模型列表自动补全
  const [pulledModels, setPulledModels] = useState([]);
  const loadPulledModels = async (providerId) => {
    if (!providerId) { setPulledModels([]); return; }
    try {
      const r = await api.adminProviders.models(providerId);
      setPulledModels(r.models || []);
    } catch { setPulledModels([]); }
  };

  // ---- 模型 ----
  const chatModels = models.filter((m) => m.kind === 'chat');
  const imageModels = models.filter((m) => m.kind === 'image');
  const applyFamily = (fid) => {
    setSizeFamily(fid);
    const f = familyById(fid);
    setMForm((m) => ({ ...m, sizes: f.sizes.join(',') }));
  };
  // 模型 ID 变化时按关键词猜家族并带出尺寸（仅图片模型）
  const onModelIdChange = (v) => {
    setMForm((m) => {
      const next = { ...m, model_id: v };
      if (m.kind === 'image') {
        const fid = guessFamily(v);
        setSizeFamily(fid);
        next.sizes = familyById(fid).sizes.join(',');
      }
      return next;
    });
  };
  const mStartNew = (kind) => {
    const firstProv = providers.find((p) => p.is_active && (p.kind === 'both' || p.kind === (kind === 'chat' ? 'llm' : 'image')));
    setMForm({ ...emptyMForm, kind, provider_id: firstProv ? firstProv.id : '' });
    setSizeFamily('generic');
    loadPulledModels(firstProv ? firstProv.id : '');
    setMEditing('new');
  };
  const mStartEdit = (m) => {
    setMForm({
      provider_id: m.provider_id, kind: m.kind, model_id: m.model_id, name: m.name || '',
      input_per_1m: m.pricing.input_per_1m || '', output_per_1m: m.pricing.output_per_1m || '',
      per_call: m.pricing.per_call || '',
      sizes: (m.extra.sizes || []).join(','),
      prompt_extend: m.extra.prompt_extend !== false,
      vision: !!m.extra.vision,
    });
    setSizeFamily(guessFamily(m.model_id));
    setMEditing(m.id);
  };
  const mSave = async () => {
    if (!mForm.provider_id) { showToast('请选择供应商'); return; }
    if (!mForm.model_id.trim()) { showToast('模型 ID 必填'); return; }
    const pricing = {};
    const extra = {};
    if (mForm.kind === 'chat') {
      const ip = Math.floor(Number(mForm.input_per_1m)), op = Math.floor(Number(mForm.output_per_1m));
      if (!ip || ip <= 0 || !op || op <= 0) { showToast('输入/输出单价必须是大于 0 的整数'); return; }
      pricing.input_per_1m = ip; pricing.output_per_1m = op;
      extra.vision = !!mForm.vision;
    } else {
      const pc = Math.floor(Number(mForm.per_call));
      if (pc == null || pc < 0 || Number.isNaN(pc)) { showToast('按次单价必须是非负整数'); return; }
      pricing.per_call = pc;
      extra.sizes = String(mForm.sizes || '').split(/[,，、\s]+/).map((x) => x.trim()).filter(Boolean);
      extra.prompt_extend = !!mForm.prompt_extend;
    }
    setMBusy(true);
    try {
      const body = {
        provider_id: mForm.provider_id, kind: mForm.kind,
        model_id: mForm.model_id.trim(), name: mForm.name.trim(),
        pricing, extra,
      };
      if (mEditing === 'new') {
        body.is_active = true; // 上架即启用
        await api.adminModels.create(body);
      } else {
        await api.adminModels.update(mEditing, body); // 启停走列表「上架/下架」按钮
      }
      showToast('已保存');
      setMEditing(null);
      await load();
    } catch (e) {
      showToast(e.message || '保存失败');
    } finally {
      setMBusy(false);
    }
  };
  const mToggle = async (m) => {
    try {
      await api.adminModels.update(m.id, { is_active: !m.is_active });
      await load();
    } catch (e) {
      showToast(e.message || '操作失败');
    }
  };
  const mDel = async (m) => {
    if (!window.confirm(`删除模型「${m.name || m.model_id}」？历史计费记录不受影响。`)) return;
    try {
      await api.adminModels.remove(m.id);
      showToast('已删除');
      await load();
    } catch (e) {
      showToast(e.message || '删除失败');
    }
  };

  // ---- 后台模型配置 ----
  const saveModelCfg = async () => {
    setModelCfgSaving(true);
    try {
      const body = { ...modelCfg };
      if (body.filter_fallback_models == null) delete body.filter_fallback_models;
      await api.adminUpdateSettings(body);
      showToast('模型配置已保存');
    } catch (e) {
      showToast(e.message || '保存失败');
    } finally {
      setModelCfgSaving(false);
    }
  };
  const activeChatIds = chatModels.filter((m) => m.is_active).map((m) => m.model_id);

  const renderModelRow = (m) => (
    <div key={m.id} className={`pm-row${m.is_active ? '' : ' off'}`}>
      <div>
        <div><b>{m.name || m.model_id}</b> <span className="key-desc small">{m.model_id} · {m.provider_name || ''}</span></div>
        <div className="key-desc small">
          {m.kind === 'chat'
            ? `${m.pricing.input_per_1m | 0}/${m.pricing.output_per_1m | 0} 积分/1M tokens${m.extra && m.extra.vision ? ' · 支持视觉' : ''}`
            : `${m.pricing.per_call | 0} 积分/次`}
          {m.is_active ? '' : '（已停用）'}
        </div>
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        <button className="btn secondary small" onClick={() => mToggle(m)}>{m.is_active ? '下架' : '上架'}</button>
        <button className="btn secondary small" onClick={() => mStartEdit(m)}>编辑</button>
        <button className="btn secondary small" onClick={() => mDel(m)}>删除</button>
      </div>
    </div>
  );

  return (
    <div>
      <div className="card-title" style={{ marginTop: 4 }}>供应商</div>
      <p className="key-desc small">Key 加密存储，只写不读；「设为默认」决定聊天默认走哪家（可在面板改，不用再改 .env）。</p>
      <div className="pm-list">
        {providers.map((p) => (
          <div key={p.id} className={`pm-row${p.is_active ? '' : ' off'}`}>
            <div>
              <div>
                <b>{p.name}</b>{' '}
                <span className="key-desc small">{presetName(p.preset)} · {KIND_LABEL[p.kind] || p.kind} · {p.has_key ? '已配 Key' : '未配 Key'}</span>{' '}
                {p.is_default ? <span className="pm-off-tag" style={{ background: '#e8f5e9', color: '#2e7d32' }}>默认</span> : null}
              </div>
              <div className="key-desc small">{p.base_url || '（未填地址）'}{p.is_active ? '' : '（已停用）'}</div>
            </div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
              {!p.is_default && p.is_active && (p.kind === 'llm' || p.kind === 'both') && (
                <button className="btn secondary small" onClick={() => pSetDefault(p)}>设为默认</button>
              )}
              <button className="btn secondary small" disabled={pTesting === p.id} onClick={() => pTest(p)}>
                {pTesting === p.id ? '拉取中…' : '拉取模型'}
              </button>
              <button className="btn secondary small" onClick={() => pStartEdit(p)}>编辑</button>
              <button className="btn secondary small" onClick={() => pDel(p)}>删除</button>
            </div>
          </div>
        ))}
        {providers.length === 0 && <div className="sidebar-hint">还没有供应商</div>}
      </div>
      {!pEditing && (
        <button className="btn secondary" style={{ marginTop: 12 }} onClick={pStartNew}>
          <Icon name="plus" size={16} /> 新增供应商
        </button>
      )}
      {pEditing && (
        <div className="pm-edit" style={{ marginTop: 12 }}>
          <div className="key-input-row">
            <input value={pForm.name} onChange={setP('name')} placeholder="名称，如：OpenRouter" />
            <select value={pForm.preset} onChange={setP('preset')}>
              {PRESETS.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
            </select>
            <select value={pForm.kind} onChange={setP('kind')}>
              {Object.entries(KIND_LABEL).map(([id, n]) => <option key={id} value={id}>{n}</option>)}
            </select>
          </div>
          <div className="key-input-row" style={{ marginTop: 8 }}>
            <input value={pForm.base_url} onChange={setP('base_url')} placeholder="Base URL，如：https://openrouter.ai/api/v1" spellCheck={false} />
          </div>
          <div className="key-input-row" style={{ marginTop: 8 }}>
            <input type="password" value={pForm.api_key} onChange={setP('api_key')} placeholder={pEditing === 'new' ? 'API Key' : 'API Key（留空不修改）'} spellCheck={false} autoComplete="off" />
          </div>
          <label className="key-desc small" style={{ display: 'block', marginTop: 8 }}>
            <input type="checkbox" checked={pForm.is_active} onChange={setP('is_active')} /> 启用
          </label>
          <div style={{ marginTop: 8, display: 'flex', gap: 8 }}>
            <button className="btn primary small" disabled={pBusy} onClick={pSave}>保存</button>
            <button className="btn secondary small" onClick={() => setPEditing(null)}>取消</button>
          </div>
        </div>
      )}

      <div className="card-title" style={{ marginTop: 20 }}>聊天模型</div>
      <p className="key-desc small">上架后用户可在「积分」tab 选用；单价单位：积分 / 1M tokens。</p>
      <div className="pm-list">
        {chatModels.map(renderModelRow)}
        {chatModels.length === 0 && <div className="sidebar-hint">还没有上架聊天模型</div>}
      </div>

      <div className="card-title" style={{ marginTop: 20 }}>图片模型</div>
      <p className="key-desc small">上架后设计台可选用；单价单位：积分 / 次，按次扣费。</p>
      <div className="pm-list">
        {imageModels.map(renderModelRow)}
        {imageModels.length === 0 && <div className="sidebar-hint">还没有上架图片模型</div>}
      </div>
      {!mEditing && (
        <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
          <button className="btn secondary" onClick={() => mStartNew('chat')}>
            <Icon name="plus" size={16} /> 上架聊天模型
          </button>
          <button className="btn secondary" onClick={() => mStartNew('image')}>
            <Icon name="plus" size={16} /> 上架图片模型
          </button>
        </div>
      )}
      {mEditing && (
        <div className="pm-edit" style={{ marginTop: 12 }}>
          <div className="key-input-row">
            <select value={mForm.provider_id} onChange={(e) => { setM('provider_id')(e); loadPulledModels(e.target.value); }}>
              <option value="">选择供应商…</option>
              {providers.filter((p) => p.is_active).map((p) => (
                <option key={p.id} value={p.id}>{p.name}（{KIND_LABEL[p.kind] || p.kind}）</option>
              ))}
            </select>
          </div>
          <div style={{ marginTop: 8 }}>
            <ModelPicker
              value={mForm.model_id}
              onChange={onModelIdChange}
              models={pulledModels}
              placeholder="模型 ID：输入筛选 400+ 可用模型，或手动输入"
              disabled={mEditing !== 'new'}
            />
            {mEditing === 'new' && !pulledModels.length && (
              <div className="small" style={{ marginTop: 4, opacity: 0.65 }}>
                该供应商尚未拉取模型列表，可先点「拉取模型」
              </div>
            )}
          </div>
          <div className="key-input-row" style={{ marginTop: 8 }}>
            <input value={mForm.name} onChange={setM('name')} placeholder="显示名（留空则用模型 ID）" />
          </div>
          {mForm.kind === 'chat' ? (
            <>
              <div className="key-input-row" style={{ marginTop: 8 }}>
                <input type="number" min="1" value={mForm.input_per_1m} onChange={setM('input_per_1m')} placeholder="输入单价 /1M tokens" />
              </div>
              <div className="key-input-row" style={{ marginTop: 8 }}>
                <input type="number" min="1" value={mForm.output_per_1m} onChange={setM('output_per_1m')} placeholder="输出单价 /1M tokens" />
              </div>
              <label className="key-desc small" style={{ display: 'block', marginTop: 8 }}>
                <input type="checkbox" checked={!!mForm.vision} onChange={setM('vision')} />
                支持视觉识图（克隆款式提取 DNA 时可用）
              </label>
            </>
          ) : (
            <>
              <div className="key-input-row" style={{ marginTop: 8 }}>
                <input type="number" min="0" value={mForm.per_call} onChange={setM('per_call')} placeholder="单价（积分/次）" />
              </div>
              <div className="key-input-row" style={{ marginTop: 8 }}>
                <select value={sizeFamily} onChange={(e) => applyFamily(e.target.value)} title="模型家族：自动带出该家族常用尺寸">
                  {SIZE_FAMILIES.map((f) => (
                    <option key={f.id} value={f.id}>{f.label}</option>
                  ))}
                </select>
              </div>
              <div className="key-input-row" style={{ marginTop: 8 }}>
                <input value={mForm.sizes} onChange={setM('sizes')} placeholder="尺寸档位（API 原生值，逗号分隔），如：1024x1024,1792x1024" spellCheck={false} />
              </div>
              <label className="key-desc small" style={{ display: 'block', marginTop: 8 }}>
                <input type="checkbox" checked={!!mForm.prompt_extend} onChange={setM('prompt_extend')} />
                提示词改写增强（千问系有效；关掉后严格按原提示词生成，不离题）
              </label>
            </>
          )}
          <div style={{ marginTop: 8, display: 'flex', gap: 8 }}>
            <button className="btn primary small" disabled={mBusy} onClick={mSave}>保存</button>
            <button className="btn secondary small" onClick={() => setMEditing(null)}>取消</button>
          </div>
        </div>
      )}

      <div className="card-title" style={{ marginTop: 20 }}>后台模型配置</div>
      <p className="key-desc small">后台任务（群聊导演/记忆提取/摘要）与聊天默认模型；不选 = 自动用最便宜的启用模型。</p>
      <label>
        后台模型
        <select
          value={modelCfg.worker_model}
          onChange={(e) => setModelCfg((f) => ({ ...f, worker_model: e.target.value }))}
        >
          <option value="">自动（最便宜）</option>
          {activeChatIds.map((id) => <option key={id} value={id}>{id}</option>)}
        </select>
      </label>
      <label>
        聊天默认模型
        <select
          value={modelCfg.chat_default_model}
          onChange={(e) => setModelCfg((f) => ({ ...f, chat_default_model: e.target.value }))}
        >
          <option value="">自动（最便宜）</option>
          {activeChatIds.map((id) => <option key={id} value={id}>{id}</option>)}
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
          {activeChatIds.map((id) => <option key={id} value={id}>{id}</option>)}
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
          {activeChatIds.map((id) => <option key={id} value={id}>{id}</option>)}
        </select>
      </label>
      <p className="key-desc small">上游内容过滤拦截时，按顺序自动换模型重试一次；两个都选「不设置」并保存 = 关闭回退。</p>
      <div className="key-input-row" style={{ marginTop: 8 }}>
        <button className="btn primary" onClick={saveModelCfg} disabled={modelCfgSaving}>
          {modelCfgSaving ? '保存中…' : '保存模型配置'}
        </button>
      </div>
    </div>
  );
}
