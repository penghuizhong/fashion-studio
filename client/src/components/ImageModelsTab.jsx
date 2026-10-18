// v0.1.0: 图片模型上架（管理员）——Key 只写不读
import { useEffect, useState } from 'react';
import { api } from '../api.js';
import Icon from './icons.jsx';

const emptyForm = {
  model_id: '', name: '', provider: 'openai_compatible', base_url: '',
  api_key: '', price_per_call: 0, sizes_json: '["3:4","1:1","16:9"]', is_active: true, sort_order: 0,
};

export default function ImageModelsTab({ showToast }) {
  const [models, setModels] = useState([]);
  const [editing, setEditing] = useState(null); // 'new' | id | null
  const [form, setForm] = useState(emptyForm);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try {
      const r = await api.adminImageModels.list();
      setModels(r.models || []);
    } catch (e) {
      showToast(e.message || '加载失败');
    }
  };
  useEffect(() => { load(); }, []);

  const startNew = () => { setForm({ ...emptyForm }); setEditing('new'); };
  const startEdit = (m) => {
    setForm({
      model_id: m.model_id, name: m.name, provider: m.provider, base_url: m.base_url || '',
      api_key: '', price_per_call: m.price_per_call | 0,
      sizes_json: m.sizes_json || '[]', is_active: !!m.is_active, sort_order: m.sort_order | 0,
    });
    setEditing(m.id);
  };

  const save = async () => {
    if (!form.model_id.trim() || !form.name.trim()) { showToast('model_id 与显示名必填'); return; }
    setBusy(true);
    try {
      if (editing === 'new') await api.adminImageModels.create(form);
      else await api.adminImageModels.update(editing, form);
      showToast('已保存');
      setEditing(null);
      await load();
    } catch (e) {
      showToast(e.message || '保存失败');
    } finally {
      setBusy(false);
    }
  };

  const set = (k) => (e) => {
    const v = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
    setForm((f) => ({ ...f, [k]: v }));
  };

  return (
    <div>
      <div className="card-title" style={{ marginTop: 4 }}>图片模型</div>
      <p className="key-desc small">上架后设计台可选用；单价单位：积分 / 次，按次扣费；Key 加密存储，接口只写不读。</p>
      <div className="pm-list">
        {models.map((m) => (
          <div key={m.id} className={`pm-row${m.is_active ? '' : ' off'}`}>
            <div>
              <div><b>{m.name}</b> <span className="key-desc small">{m.model_id} · {m.provider}</span></div>
              <div className="key-desc small">{m.price_per_call | 0} 积分/次{m.is_active ? '' : '（已停用）'}</div>
            </div>
            <button className="btn secondary small" onClick={() => startEdit(m)}>编辑</button>
          </div>
        ))}
        {models.length === 0 && <div className="sidebar-hint">还没有上架图片模型</div>}
      </div>
      {!editing && (
        <button className="btn secondary" style={{ marginTop: 12 }} onClick={startNew}>
          <Icon name="plus" size={16} /> 上架模型
        </button>
      )}
      {editing && (
        <div className="pm-edit" style={{ marginTop: 12 }}>
          <div className="key-input-row">
            <input value={form.model_id} onChange={set('model_id')} placeholder="model_id，如：qwen-image-plus" disabled={editing !== 'new'} />
          </div>
          <div className="key-input-row" style={{ marginTop: 8 }}>
            <input value={form.name} onChange={set('name')} placeholder="显示名" />
          </div>
          <div className="key-input-row" style={{ marginTop: 8 }}>
            <select value={form.provider} onChange={set('provider')}>
              <option value="openai_compatible">openai_compatible（中转站/OpenAI 格式）</option>
              <option value="dashscope">dashscope（阿里原生，文生图）</option>
            </select>
          </div>
          <div className="key-input-row" style={{ marginTop: 8 }}>
            <input value={form.base_url} onChange={set('base_url')} placeholder="Base URL，如：https://xxx/v1" />
          </div>
          <div className="key-input-row" style={{ marginTop: 8 }}>
            <input type="password" value={form.api_key} onChange={set('api_key')} placeholder={editing === 'new' ? 'API Key' : 'API Key（留空不修改）'} />
          </div>
          <div className="key-input-row" style={{ marginTop: 8 }}>
            <input type="number" min="0" value={form.price_per_call} onChange={set('price_per_call')} placeholder="单价（积分/次）" />
            <input value={form.sizes_json} onChange={set('sizes_json')} placeholder='尺寸档位 JSON，如：["3:4","1:1"]' />
          </div>
          <label className="key-desc small" style={{ display: 'block', marginTop: 8 }}>
            <input type="checkbox" checked={form.is_active} onChange={set('is_active')} /> 启用
          </label>
          <div style={{ marginTop: 8, display: 'flex', gap: 8 }}>
            <button className="btn primary small" disabled={busy} onClick={save}>保存</button>
            <button className="btn secondary small" onClick={() => setEditing(null)}>取消</button>
          </div>
        </div>
      )}
    </div>
  );
}
