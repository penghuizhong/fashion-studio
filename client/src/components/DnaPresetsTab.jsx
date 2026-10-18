// P5: DNA 类目预设管理（管理员）——schema 字段 + 提示词模板存库可编辑
import { useEffect, useState } from 'react';
import { api } from '../api.js';
import Icon from './icons.jsx';

const emptyForm = { id: '', name: '', fields: [], prompt: '', sort_order: 0, is_active: true };
const emptyField = { key: '', label: '', hint: '' };

export default function DnaPresetsTab({ showToast }) {
  const [presets, setPresets] = useState([]);
  const [editing, setEditing] = useState(null); // 'new' | id | null
  const [form, setForm] = useState(emptyForm);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try {
      const r = await api.studio.adminDnaPresets();
      setPresets(r.presets || []);
    } catch (e) {
      showToast(e.message || '加载失败');
    }
  };
  useEffect(() => { load(); }, []);

  const startNew = () => { setForm({ ...emptyForm, fields: [{ ...emptyField }] }); setEditing('new'); };
  const startEdit = (p) => {
    setForm({
      id: p.id, name: p.name,
      fields: (p.fields || []).map((f) => ({ key: f.key, label: f.label, hint: f.hint || '' })),
      prompt: p.prompt || '', sort_order: p.sort_order || 0, is_active: !!p.is_active,
    });
    setEditing(p.id);
  };

  const setF = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const setField = (i, k, v) => setForm((f) => {
    const fields = f.fields.map((fd, j) => (j === i ? { ...fd, [k]: v } : fd));
    return { ...f, fields };
  });
  const addField = () => setForm((f) => ({ ...f, fields: [...f.fields, { ...emptyField }] }));
  const delField = (i) => setForm((f) => ({ ...f, fields: f.fields.filter((_, j) => j !== i) }));
  const moveField = (i, dir) => setForm((f) => {
    const j = i + dir;
    if (j < 0 || j >= f.fields.length) return f;
    const fields = [...f.fields];
    [fields[i], fields[j]] = [fields[j], fields[i]];
    return { ...f, fields };
  });

  const save = async () => {
    const fields = form.fields.map((f) => ({
      key: String(f.key || '').trim(),
      label: String(f.label || '').trim(),
      hint: String(f.hint || '').trim(),
    })).filter((f) => f.key && f.label);
    if (editing === 'new') {
      const id = String(form.id || '').trim().toLowerCase().replace(/[^a-z0-9_]/g, '');
      if (!id) { showToast('ID 必填（英文小写/数字/下划线）'); return; }
    }
    if (!form.name.trim()) { showToast('名称必填'); return; }
    if (!fields.length) { showToast('至少需要一个字段'); return; }
    setBusy(true);
    try {
      const body = { name: form.name.trim(), fields, prompt: form.prompt, sort_order: Number(form.sort_order) || 0, is_active: form.is_active };
      if (editing === 'new') {
        body.id = String(form.id).trim().toLowerCase().replace(/[^a-z0-9_]/g, '');
        await api.studio.adminDnaPresetCreate(body);
      } else {
        await api.studio.adminDnaPresetUpdate(editing, body);
      }
      showToast('已保存');
      setEditing(null);
      load();
    } catch (e) {
      showToast(e.message || '保存失败');
    } finally {
      setBusy(false);
    }
  };

  const toggleActive = async (p) => {
    try {
      await api.studio.adminDnaPresetUpdate(p.id, { is_active: !p.is_active });
      load();
    } catch (e) {
      showToast(e.message || '操作失败');
    }
  };

  const del = async (p) => {
    if (!window.confirm(`删除预设「${p.name}」？已用此预设的模板不受影响。`)) return;
    try {
      await api.studio.adminDnaPresetDelete(p.id);
      showToast('已删除');
      load();
    } catch (e) {
      showToast(e.message || '删除失败');
    }
  };

  return (
    <div>
      <div className="card-title" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span>DNA 类目预设（{presets.length}）</span>
        <button className="btn secondary small" onClick={startNew}><Icon name="plus" size={14} /> 新增类目</button>
      </div>
      <p className="key-desc small">每个类目 = 一套 DNA 字段（schema）+ 专属识图提示词。克隆款式与发散创建时按类目切换。提示词正文不含 Schema，保存时后端按字段自动拼接中文 Schema。</p>

      {presets.map((p) => (
        <div key={p.id} className="model-row">
          <div style={{ flex: 1 }}>
            <div><b>{p.name}</b> <span className="dim small">({p.id})</span> {!p.is_active && <span className="dim small">· 已下架</span>}</div>
            <div className="small dim">{(p.fields || []).length} 个字段：{(p.fields || []).map((f) => f.label).join('、')}</div>
          </div>
          <button className="btn secondary small" onClick={() => toggleActive(p)}>{p.is_active ? '下架' : '上架'}</button>
          <button className="btn secondary small" onClick={() => startEdit(p)}>编辑</button>
          <button className="btn danger small" onClick={() => del(p)}>删除</button>
        </div>
      ))}

      {editing && (
        <div className="modal-overlay" onClick={() => setEditing(null)}>
          <div className="modal-box" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 640 }}>
            <div className="modal-head">
              <span>{editing === 'new' ? '新增类目预设' : `编辑：${form.name || editing}`}</span>
              <button className="icon-btn" onClick={() => setEditing(null)}><Icon name="x" size={18} /></button>
            </div>
            <div className="modal-body">
              <div className="key-input-row">
                <label className="key-label">ID</label>
                <input className="text-input" value={form.id} disabled={editing !== 'new'}
                  placeholder="英文小写，如 suit" onChange={(e) => setF('id', e.target.value)} />
              </div>
              <div className="key-input-row" style={{ marginTop: 8 }}>
                <label className="key-label">名称</label>
                <input className="text-input" value={form.name} placeholder="如：男士西装"
                  onChange={(e) => setF('name', e.target.value)} />
              </div>
              <div className="key-input-row" style={{ marginTop: 8 }}>
                <label className="key-label">排序</label>
                <input className="text-input" type="number" value={form.sort_order}
                  onChange={(e) => setF('sort_order', e.target.value)} />
                <label className="key-label" style={{ marginLeft: 12 }}>
                  <input type="checkbox" checked={form.is_active} onChange={(e) => setF('is_active', e.target.checked)} /> 上架
                </label>
              </div>

              <div className="card-title" style={{ marginTop: 16 }}>字段（{form.fields.length}）</div>
              {form.fields.map((f, i) => (
                <div key={i} style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 8, marginBottom: 8 }}>
                  <div className="key-input-row">
                    <input className="text-input" value={f.key} placeholder="key（英文，如 silhouette）"
                      onChange={(e) => setField(i, 'key', e.target.value)} style={{ flex: 1 }} />
                    <input className="text-input" value={f.label} placeholder="中文名（如 版型）"
                      onChange={(e) => setField(i, 'label', e.target.value)} style={{ flex: 1 }} />
                  </div>
                  <input className="text-input" value={f.hint} placeholder="取值建议，如：修身、常规、宽松"
                    onChange={(e) => setField(i, 'hint', e.target.value)} style={{ marginTop: 6, width: '100%' }} />
                  <div style={{ marginTop: 6, display: 'flex', gap: 6 }}>
                    <button className="btn secondary small" onClick={() => moveField(i, -1)}>上移</button>
                    <button className="btn secondary small" onClick={() => moveField(i, 1)}>下移</button>
                    <button className="btn danger small" onClick={() => delField(i)}>删除字段</button>
                  </div>
                </div>
              ))}
              <button className="btn secondary small" onClick={addField}><Icon name="plus" size={14} /> 加字段</button>

              <div className="card-title" style={{ marginTop: 16 }}>识图提示词</div>
              <textarea className="text-input" rows={8} value={form.prompt}
                placeholder="指引正文（不含 Schema，后端自动拼接）"
                onChange={(e) => setF('prompt', e.target.value)} style={{ width: '100%' }} />

              <div className="save-row" style={{ marginTop: 12 }}>
                <button className="btn primary" disabled={busy} onClick={save}>{busy ? '保存中…' : '保存'}</button>
                <button className="btn secondary" onClick={() => setEditing(null)}>取消</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
