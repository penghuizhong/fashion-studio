// v0.2.0: 统一模型管理（管理员）——供应商 → 模型两层；Key 只写不读
import { useEffect, useState } from 'react';
import { api } from '../api.js';
import Icon from './icons.jsx';

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
  input_per_1m: '', output_per_1m: '', per_call: '', sizes: '["3:4","1:1","16:9"]', is_active: true,
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
      const r = await api.adminProviders.test(p.id, {});
      showToast(r.ok ? `连通正常（${r.latency}ms）` : `连通失败：${r.error || '未知错误'}`);
    } catch (e) {
      showToast(e.message || '测试失败');
    } finally {
      setPTesting('');
    }
  };

  // ---- 模型 ----
  const chatModels = models.filter((m) => m.kind === 'chat');
  const imageModels = models.filter((m) => m.kind === 'image');
  const mStartNew = (kind) => {
    const firstProv = providers.find((p) => p.is_active && (p.kind === 'both' || p.kind === (kind === 'chat' ? 'llm' : 'image')));
    setMForm({ ...emptyMForm, kind, provider_id: firstProv ? firstProv.id : '' });
    setMEditing('new');
  };
  const mStartEdit = (m) => {
    setMForm({
      provider_id: m.provider_id, kind: m.kind, model_id: m.model_id, name: m.name || '',
      input_per_1m: m.pricing.input_per_1m || '', output_per_1m: m.pricing.output_per_1m || '',
      per_call: m.pricing.per_call || '',
      sizes: JSON.stringify(m.extra.sizes || []), is_active: !!m.is_active,
    });
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
    } else {
      const pc = Math.floor(Number(mForm.per_call));
      if (pc == null || pc < 0 || Number.isNaN(pc)) { showToast('按次单价必须是非负整数'); return; }
      pricing.per_call = pc;
      try {
        const sz = JSON.parse(mForm.sizes || '[]');
        extra.sizes = Array.isArray(sz) ? sz : [];
      } catch { showToast('尺寸档位 JSON 格式错误'); return; }
    }
    setMBusy(true);
    try {
      const body = {
        provider_id: mForm.provider_id, kind: mForm.kind,
        model_id: mForm.model_id.trim(), name: mForm.name.trim(),
        pricing, extra, is_active: mForm.is_active,
      };
      if (mEditing === 'new') await api.adminModels.create(body);
      else await api.adminModels.update(mEditing, body);
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
            ? `${m.pricing.input_per_1m | 0}/${m.pricing.output_per_1m | 0} 积分/1M tokens`
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
                {pTesting === p.id ? '测试中…' : '连通测试'}
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
            <select value={mForm.provider_id} onChange={setM('provider_id')}>
              <option value="">选择供应商…</option>
              {providers.filter((p) => p.is_active).map((p) => (
                <option key={p.id} value={p.id}>{p.name}（{KIND_LABEL[p.kind] || p.kind}）</option>
              ))}
            </select>
            <input value={mForm.model_id} onChange={setM('model_id')} placeholder="模型 ID，如：openai/gpt-4o-mini" disabled={mEditing !== 'new'} spellCheck={false} />
          </div>
          <div className="key-input-row" style={{ marginTop: 8 }}>
            <input value={mForm.name} onChange={setM('name')} placeholder="显示名（留空则用模型 ID）" />
          </div>
          {mForm.kind === 'chat' ? (
            <div className="key-input-row" style={{ marginTop: 8 }}>
              <input type="number" min="1" value={mForm.input_per_1m} onChange={setM('input_per_1m')} placeholder="输入单价 /1M tokens" />
              <input type="number" min="1" value={mForm.output_per_1m} onChange={setM('output_per_1m')} placeholder="输出单价 /1M tokens" />
            </div>
          ) : (
            <div className="key-input-row" style={{ marginTop: 8 }}>
              <input type="number" min="0" value={mForm.per_call} onChange={setM('per_call')} placeholder="单价（积分/次）" />
              <input value={mForm.sizes} onChange={setM('sizes')} placeholder='尺寸档位 JSON，如：["3:4","1:1"]' spellCheck={false} />
            </div>
          )}
          <label className="key-desc small" style={{ display: 'block', marginTop: 8 }}>
            <input type="checkbox" checked={mForm.is_active} onChange={setM('is_active')} /> 启用
          </label>
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
