// P4 发散创建：三步弹窗（意图 → 文字筛选 → 渲染收卡）+ 历史批次
import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import Icon from './icons.jsx';
import { DNA_FIELDS, DEFAULT_AXES, fmtDnaValue } from './DnaFields.js';

const imgUrl = (p) => (p ? `/${p}` : '');
const labelOf = (key) => (DNA_FIELDS.find((f) => f.key === key) || {}).label || key;

function DnaCard({ dna, rationale, checked, onToggle }) {
  return (
    <div className={`explore-dna-card${checked ? ' checked' : ''}`} onClick={onToggle}>
      <label className="explore-check">
        <input type="checkbox" checked={!!checked} onChange={onToggle} onClick={(e) => e.stopPropagation()} />
      </label>
      <div className="explore-dna-fields">
        {DNA_FIELDS.map(({ key, label }) => {
          const f = (dna || {})[key] || {};
          const low = Number(f.confidence) < 0.75 && f.value !== '' && f.value != null;
          return (
            <div className="explore-dna-row" key={key}>
              <span className="dim">{label}</span>
              <span className={low ? 'low-conf' : ''}>{fmtDnaValue(f.value)}</span>
            </div>
          );
        })}
      </div>
      {rationale && <div className="explore-rationale">{rationale}</div>}
    </div>
  );
}

export default function ExploreModal({ onClose, onAdopt, showToast }) {
  const [tab, setTab] = useState('new');
  const [step, setStep] = useState('intent');
  const [intent, setIntent] = useState('');
  const [axes, setAxes] = useState(DEFAULT_AXES);
  const [count, setCount] = useState(6);
  const [imgModels, setImgModels] = useState([]);
  const [renderModelId, setRenderModelId] = useState('');
  const [batch, setBatch] = useState(null);
  const [selected, setSelected] = useState([]);
  const [renders, setRenders] = useState([]);
  const [adoptSel, setAdoptSel] = useState([]);
  const [busy, setBusy] = useState(false);
  const [busyMsg, setBusyMsg] = useState('');
  const [batches, setBatches] = useState([]);
  const [replay, setReplay] = useState(null);

  const loadModels = useCallback(async () => {
    try {
      const r = await api.studio.imageModels();
      const ms = r.models || [];
      setImgModels(ms);
      if (!renderModelId && ms.length) {
        const cheapest = [...ms].sort((a, b) => a.price_per_call - b.price_per_call)[0];
        setRenderModelId(cheapest.id);
      }
    } catch (e) {
      showToast(e.message || '加载图片模型失败');
    }
  }, [showToast, renderModelId]);
  useEffect(() => { loadModels(); }, [loadModels]);

  const loadBatches = useCallback(async () => {
    try {
      const r = await api.studio.exploreList();
      setBatches(r.batches || []);
    } catch (e) {
      showToast(e.message || '加载历史失败');
    }
  }, [showToast]);
  useEffect(() => { if (tab === 'history') loadBatches(); }, [tab, loadBatches]);

  const toggleAxis = (key) => {
    setAxes((a) => (a.includes(key) ? a.filter((x) => x !== key) : [...a, key]));
  };

  const cheapest = [...imgModels].sort((a, b) => a.price_per_call - b.price_per_call)[0];
  const curModel = imgModels.find((m) => m.id === renderModelId) || cheapest;
  const estimate = count * ((curModel && curModel.price_per_call) || 0);

  const startExplore = async () => {
    if (busy) return;
    if (!axes.length) { showToast('至少选一个发散轴'); return; }
    setBusy(true);
    setBusyMsg('AI 正在发散灵感…');
    try {
      const r = await api.studio.exploreCreate({
        intent_text: intent.trim(), axes, count,
        render_model_id: renderModelId || undefined,
      });
      setBatch(r);
      setSelected(r.proposals.map((_, i) => i));
      setStep('proposals');
    } catch (e) {
      showToast(e.message || '发散失败');
    } finally {
      setBusy(false);
      setBusyMsg('');
    }
  };

  const toggleSel = (i) => {
    setSelected((s) => (s.includes(i) ? s.filter((x) => x !== i) : [...s, i]));
  };

  const doRender = async () => {
    if (busy || !batch) return;
    const n = selected.length;
    if (!n) { showToast('先选至少一个候选'); return; }
    const unit = (batch.render_model && batch.render_model.price_per_call) || 0;
    if (!window.confirm(`渲染 ${n} 张 × ${unit} 积分 = 共计 ${n * unit} 积分，确认吗？`)) return;
    setBusy(true);
    setBusyMsg(`正在渲染 ${n} 张…`);
    try {
      const r = await api.studio.exploreRender(batch.id, true);
      setRenders(r.renders || []);
      setAdoptSel((r.renders || []).filter((x) => !x.error).map((x) => x.proposal_idx));
      setStep('renders');
    } catch (e) {
      showToast(e.message || '渲染失败');
    } finally {
      setBusy(false);
      setBusyMsg('');
    }
  };

  const toggleAdopt = (i) => {
    setAdoptSel((s) => (s.includes(i) ? s.filter((x) => x !== i) : [...s, i]));
  };

  const doAdopt = async () => {
    if (busy || !batch) return;
    if (!adoptSel.length) { showToast('先选至少一张图'); return; }
    setBusy(true);
    try {
      const r = await api.studio.exploreAdopt(batch.id, adoptSel);
      showToast(`已收 ${r.template_ids.length} 张为款式卡`);
      onAdopt();
    } catch (e) {
      showToast(e.message || '收卡失败');
    } finally {
      setBusy(false);
    }
  };

  const openReplay = async (id) => {
    try {
      const r = await api.studio.exploreGet(id);
      setReplay(r.batch);
    } catch (e) {
      showToast(e.message || '加载失败');
    }
  };

  const proposals = (batch && batch.proposals) || [];

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box studio-modal explore-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span>发散创建</span>
          <div className="explore-tabs">
            <button className={tab === 'new' ? 'active' : ''} onClick={() => setTab('new')}>新发散</button>
            <button className={tab === 'history' ? 'active' : ''} onClick={() => setTab('history')}>历史批次</button>
          </div>
          <button className="icon-btn" onClick={onClose}><Icon name="x" size={20} /></button>
        </div>

        {tab === 'new' && (
          <div className="modal-body">
            {step === 'intent' && (
              <>
                <label className="key-label">灵感（一句话描述/关键词，可空）</label>
                <textarea
                  className="explore-intent"
                  value={intent}
                  onChange={(e) => setIntent(e.target.value)}
                  placeholder="比如：适合通勤的真丝连衣裙，带点复古感…（留空则按流行风格自由发散）"
                  rows={3}
                  maxLength={500}
                />
                <label className="key-label" style={{ marginTop: 12 }}>发散轴（候选方案在这些字段上拉开差异）</label>
                <div className="explore-axes">
                  {DNA_FIELDS.map(({ key, label }) => (
                    <label key={key} className={`explore-axis${axes.includes(key) ? ' checked' : ''}`}>
                      <input type="checkbox" checked={axes.includes(key)} onChange={() => toggleAxis(key)} />
                      {label}
                    </label>
                  ))}
                </div>
                <div className="key-input-row" style={{ marginTop: 12 }}>
                  <label className="key-label">候选数量</label>
                  {[4, 6, 8].map((n) => (
                    <button key={n} className={`btn small${count === n ? ' primary' : ' secondary'}`} onClick={() => setCount(n)}>{n} 张</button>
                  ))}
                </div>
                <div className="key-input-row" style={{ marginTop: 8 }}>
                  <label className="key-label">渲染模型</label>
                  <select value={renderModelId} onChange={(e) => setRenderModelId(e.target.value)}>
                    {imgModels.map((m) => (
                      <option key={m.id} value={m.id}>{m.name || m.model_id}（{m.price_per_call} 积分/次）</option>
                    ))}
                  </select>
                </div>
                <div className="explore-estimate">费用预估：{count} 张 × {((curModel && curModel.price_per_call) || 0)} 积分 = <b>{estimate} 积分</b>（探索用小尺寸）</div>
                <div className="save-row">
                  <button className="btn primary" disabled={busy} onClick={startExplore}>
                    {busy ? busyMsg : '开始发散'}
                  </button>
                </div>
              </>
            )}

            {step === 'proposals' && (
              <>
                <div className="explore-stepbar">
                  <span>第 2 步：文字筛选（{selected.length}/{proposals.length} 已选）</span>
                  <button className="btn secondary small" onClick={() => setStep('intent')}>返回修改</button>
                </div>
                <div className="explore-grid">
                  {proposals.map((p, i) => (
                    <DnaCard key={i} dna={p.dna} rationale={p.rationale} checked={selected.includes(i)} onToggle={() => toggleSel(i)} />
                  ))}
                </div>
                <div className="save-row">
                  <button className="btn primary" disabled={busy || !selected.length} onClick={doRender}>
                    {busy ? busyMsg : `渲染选中（${selected.length} 张）`}
                  </button>
                </div>
              </>
            )}

            {step === 'renders' && (
              <>
                <div className="explore-stepbar">
                  <span>第 3 步：收为款式卡（{adoptSel.length} 已选）</span>
                </div>
                <div className="explore-render-grid">
                  {renders.map((r) => (
                    <div key={r.proposal_idx} className={`explore-render-card${adoptSel.includes(r.proposal_idx) ? ' checked' : ''}`}
                      onClick={() => (r.error ? null : toggleAdopt(r.proposal_idx))}>
                      {r.error ? (
                        <div className="explore-render-err">渲染失败<br />{r.error}</div>
                      ) : (
                        <>
                          <img src={imgUrl(r.thumb_path || r.image_path)} alt={`候选 ${r.proposal_idx + 1}`} />
                          <label className="explore-check">
                            <input type="checkbox" checked={adoptSel.includes(r.proposal_idx)}
                              onChange={() => toggleAdopt(r.proposal_idx)} onClick={(e) => e.stopPropagation()} />
                          </label>
                        </>
                      )}
                    </div>
                  ))}
                </div>
                <div className="save-row">
                  <button className="btn primary" disabled={busy || !adoptSel.length} onClick={doAdopt}>
                    收为款式卡（{adoptSel.length}）
                  </button>
                </div>
              </>
            )}
          </div>
        )}

        {tab === 'history' && !replay && (
          <div className="modal-body">
            {batches.length === 0 ? (
              <div className="sidebar-hint">还没有发散批次</div>
            ) : (
              batches.map((b) => (
                <div key={b.id} className="explore-batch-row" onClick={() => openReplay(b.id)}>
                  <div>
                    <div>{b.intent_text || '（随机灵感）'}</div>
                    <div className="small dim">{b.created_at.slice(0, 16).replace('T', ' ')} · {b.proposal_count} 候选 · {b.status}</div>
                  </div>
                  <Icon name="chevronRight" size={18} />
                </div>
              ))
            )}
          </div>
        )}

        {tab === 'history' && replay && (
          <div className="modal-body">
            <div className="explore-stepbar">
              <span>{(replay.intent_text || '（随机灵感）').slice(0, 30)}</span>
              <button className="btn secondary small" onClick={() => setReplay(null)}>返回列表</button>
            </div>
            {(JSON.parse(replay.proposals_json || '[]')).map((p, i) => (
              <DnaCard key={i} dna={p.dna} rationale={p.rationale} checked={false} onToggle={() => {}} />
            ))}
            {(JSON.parse(replay.renders_json || '[]')).filter((r) => !r.error).length > 0 && (
              <div className="explore-render-grid" style={{ marginTop: 12 }}>
                {(JSON.parse(replay.renders_json || '[]')).filter((r) => !r.error).map((r) => (
                  <div key={r.proposal_idx} className="explore-render-card">
                    <img src={imgUrl(r.thumb_path || r.image_path)} alt={`候选 ${r.proposal_idx + 1}`} />
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
