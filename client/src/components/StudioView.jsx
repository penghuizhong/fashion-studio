// v0.1.0: 设计台——款式克隆 DNA 模板工作台
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import Icon from './icons.jsx';
import ExploreModal from './ExploreModal.jsx';

const DNA_FIELDS = [
  { key: 'category', label: '品类' },
  { key: 'silhouette', label: '版型' },
  { key: 'collar', label: '领型' },
  { key: 'sleeve', label: '袖型' },
  { key: 'skirt', label: '裙摆' },
  { key: 'fabric', label: '面料' },
  { key: 'primary_color', label: '主色' },
  { key: 'secondary_color', label: '辅色' },
  { key: 'style', label: '风格' },
  { key: 'details', label: '细节元素' },
  { key: 'scene', label: '场景' },
];
// API 原生像素尺寸（与后端默认 1024x1024 对齐；DashScope 适配器会自动把 x 换成 *）
const SIZES = ['1024x1024', '1024x1792', '1792x1024'];
const imgUrl = (p) => (p ? `/${p}` : '');
const dnaVal = (dna, key) => (dna && dna[key] && dna[key].value) || '';
const dnaConf = (dna, key) => (dna && dna[key] && typeof dna[key].confidence === 'number' ? dna[key].confidence : 0);

// ---------- DNA 字段编辑器（双栏核对 / 抽屉编辑共用；P5: 字段按类目预设动态） ----------
function DnaFields({ dna, setDna, readOnly, fields }) {
  const setVal = (key, val) => {
    setDna((d) => ({ ...d, [key]: { value: val, confidence: 1 } }));
  };
  const list = Array.isArray(fields) && fields.length ? fields : DNA_FIELDS;
  return (
    <div className="dna-fields">
      {list.map(({ key, label }) => {
        const conf = dnaConf(dna, key);
        const low = conf < 0.75;
        const val = dnaVal(dna, key);
        const text = Array.isArray(val) ? val.join('，') : String(val || '');
        return (
          <div key={key} className={`dna-field${low ? ' low' : ''}`}>
            <span className="dna-label">{label}{low && <i title="AI 置信度较低，请核对">!</i>}</span>
            {readOnly ? (
              <span className="dna-value">{text || '—'}</span>
            ) : (
              <input
                className="dna-input"
                value={text}
                placeholder="—"
                onChange={(e) => {
                  const v = e.target.value;
                  setVal(key, key === 'details' ? v.split(/[,，]/).map((s) => s.trim()).filter(Boolean) : v);
                }}
              />
            )}
            <span className="dna-conf">{Math.round(conf * 100)}%</span>
          </div>
        );
      })}
    </div>
  );
}

// ---------- 克隆流程：传图 → 提取 → 核对 → 保存 ----------
// P6: 识图加速——前端 canvas 压缩（最长边 1024px / JPEG 0.85），上传体积降到 1/10~1/20
async function compressImage(file, maxDim = 1024, quality = 0.85) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0, w, h);
  if (bitmap.close) bitmap.close();
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
  return blob;
}
function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

function CloneModal({ onClose, onSaved, showToast }) {
  const [step, setStep] = useState('upload');
  const [imgData, setImgData] = useState(null); // { base64, mime, preview }
  const [dna, setDna] = useState(null);
  const [name, setName] = useState('');
  const [size, setSize] = useState('1024x1024');
  const [busy, setBusy] = useState(false);
  const [compressing, setCompressing] = useState(false); // P6: 压缩中
  const [uploadProgress, setUploadProgress] = useState(0); // P6: 上传进度 0-100
  const [visionModels, setVisionModels] = useState([]);
  const [visionModel, setVisionModel] = useState('');
  // P5: 类目预设
  const [presets, setPresets] = useState([]);
  const [presetId, setPresetId] = useState('');
  const [presetFields, setPresetFields] = useState([]);
  const fileRef = useRef(null);

  useEffect(() => {
    api.studio.visionModels().then((r) => {
      const ms = r.models || [];
      setVisionModels(ms);
      if (ms.length) setVisionModel(ms[0].model_id);
    }).catch(() => {});
    api.studio.dnaPresets().then((r) => {
      const ps = r.presets || [];
      setPresets(ps);
      if (ps.length) {
        setPresetId(ps[0].id);
        setPresetFields(ps[0].fields || []);
      }
    }).catch(() => {});
  }, []);

  const onPresetChange = (id) => {
    setPresetId(id);
    const p = presets.find((x) => x.id === id);
    setPresetFields((p && p.fields) || []);
  };

  const handleFiles = useCallback(async (files) => {
    const f = files && files[0];
    if (!f) return;
    if (!f.type.startsWith('image/')) { showToast('请选择图片文件'); return; }
    // P6: 先压缩再上传（手机原图几 MB → 100-300KB）
    setCompressing(true);
    try {
      const blob = await compressImage(f);
      const dataUrl = await blobToDataUrl(blob);
      setImgData({ base64: String(dataUrl).split(',')[1], mime: 'image/jpeg', preview: dataUrl });
    } catch (e) {
      showToast('图片处理失败，请换一张试试');
    } finally {
      setCompressing(false);
    }
  }, [showToast]);

  const startExtract = useCallback(async () => {
    if (!imgData || busy) return;
    if (!presetId) { showToast('请先选择服装类目'); return; }
    setBusy(true);
    setUploadProgress(0);
    setStep('extracting');
    try {
      // P6: 带上传进度；进度到 100 后进入 AI 分析等待
      const r = await api.studio.extractDnaWithProgress(
        { imageBase64: imgData.base64, mimeType: imgData.mime, model: visionModel || undefined, preset_id: presetId },
        (p) => setUploadProgress(p),
      );
      setDna(r.dna);
      if (Array.isArray(r.fields) && r.fields.length) setPresetFields(r.fields);
      setStep('review');
    } catch (e) {
      showToast(e.message || '提取失败');
      setStep('upload');
    } finally {
      setBusy(false);
      setUploadProgress(0);
    }
  }, [imgData, busy, showToast, presetId, visionModel]);

  const save = useCallback(async () => {
    if (busy || !dna) return;
    if (!name.trim()) { showToast('请给模板起个名字'); return; }
    setBusy(true);
    try {
      await api.studio.createTemplate({
        name: name.trim(),
        category: presetId,
        preset_id: presetId,
        dna_json: dna,
        gen_params_json: { size },
        source_image_base64: imgData.base64,
      });
      showToast('模板已保存');
      onSaved();
    } catch (e) {
      showToast(e.message || '保存失败');
    } finally {
      setBusy(false);
    }
  }, [busy, dna, name, size, imgData, presetId, onSaved, showToast]);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal-box studio-modal"
        onClick={(e) => e.stopPropagation()}
        onPaste={(e) => {
          const items = e.clipboardData && e.clipboardData.items;
          if (!items) return;
          for (const it of items) {
            if (it.type.startsWith('image/')) { handleFiles([it.getAsFile()]); break; }
          }
        }}
      >
        <div className="modal-head">
          <span>克隆款式</span>
          <button className="icon-btn" onClick={onClose}><Icon name="x" size={18} /></button>
        </div>
        {step === 'upload' && (
          <div
            className="studio-drop"
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => { e.preventDefault(); handleFiles(e.dataTransfer.files); }}
            onClick={() => fileRef.current && fileRef.current.click()}
          >
            <input ref={fileRef} type="file" accept="image/*" hidden onChange={(e) => handleFiles(e.target.files)} />
            {compressing ? (
              <div className="studio-loading">
                <div className="spinner" />
                <p>图片压缩中…</p>
              </div>
            ) : imgData ? (
              <img src={imgData.preview} alt="趋势图" className="studio-preview" />
            ) : (
              <div className="studio-drop-hint">
                <Icon name="plus" size={32} />
                <p>拖拽 / 粘贴 / 点击选择趋势图</p>
              </div>
            )}
          </div>
        )}
        {step === 'upload' && imgData && (
          <div className="modal-foot" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 8 }}>
            <select className="text-input" value={presetId} onChange={(e) => onPresetChange(e.target.value)}>
              {presets.length === 0 && <option value="">加载类目中…</option>}
              {presets.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
            {visionModels.length > 0 ? (
              <select className="text-input" value={visionModel} onChange={(e) => setVisionModel(e.target.value)}>
                {visionModels.map((m) => (
                  <option key={m.id} value={m.model_id}>{m.name || m.model_id}（视觉）</option>
                ))}
              </select>
            ) : (
              <div className="small dim">未上架视觉模型：去模型管理上架聊天模型并勾选「支持视觉识图」</div>
            )}
            <button className="btn primary" disabled={busy} onClick={startExtract}>
              <Icon name="sparkles" size={16} /> 提取 DNA
            </button>
          </div>
        )}
        {step === 'extracting' && (
          <div className="studio-loading">
            <div className="spinner" />
            {uploadProgress > 0 && uploadProgress < 100 ? (
              <>
                <p>上传中 {uploadProgress}%…</p>
                <div style={{ width: '80%', height: 6, background: 'var(--border)', borderRadius: 3, overflow: 'hidden' }}>
                  <div style={{ width: `${uploadProgress}%`, height: '100%', background: 'var(--accent)', transition: 'width .2s' }} />
                </div>
              </>
            ) : (
              <p>AI 正在分析款式 DNA…</p>
            )}
          </div>
        )}
        {step === 'review' && dna && (
          <>
            <div className="studio-review">
              <div className="studio-review-img">
                <img src={imgData.preview} alt="来源图" />
              </div>
              <div className="studio-review-fields">
                <DnaFields dna={dna} setDna={setDna} fields={presetFields} />
              </div>
            </div>
            <div className="studio-save-row">
              <input
                className="text-input"
                placeholder="模板名称，如：香槟色鱼尾裙"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
              <select className="text-input" value={size} onChange={(e) => setSize(e.target.value)}>
                {SIZES.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
              <button className="btn primary" disabled={busy} onClick={save}>保存模板</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ---------- 并排验证：采用 / 再调 / 回退 ----------
function CompareModal({ before, after, onAdopt, onRetry, onRevert, busy }) {
  return (
    <div className="modal-overlay" onClick={() => {}}>
      <div className="modal-box studio-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head"><span>变体验证</span></div>
        <div className="studio-compare">
          <div className="studio-compare-pane">
            <span className="pane-tag">原图</span>
            <img src={imgUrl(before)} alt="原图" />
          </div>
          <div className="studio-compare-pane">
            <span className="pane-tag">新图</span>
            <img src={imgUrl(after)} alt="新图" />
          </div>
        </div>
        <div className="modal-foot">
          <button className="btn primary" disabled={busy} onClick={onAdopt}>采用</button>
          <button className="btn secondary" disabled={busy} onClick={onRetry}>再调</button>
          <button className="btn danger" disabled={busy} onClick={onRevert}>回退</button>
        </div>
      </div>
    </div>
  );
}

// ---------- 卡片抽屉 ----------
function TemplateDrawer({ templateId, onClose, onChanged, showToast, onCompare }) {
  const [t, setT] = useState(null);
  const [dna, setDna] = useState({});
  const [history, setHistory] = useState([]);
  const [busy, setBusy] = useState(false);
  const [busyOp, setBusyOp] = useState('');
  const [quickEdit, setQuickEdit] = useState(null); // 'color' | 'scene' | 'detail' | null
  const [quickVal, setQuickVal] = useState('');
  const [batching, setBatching] = useState(false);
  const [batchStep, setBatchStep] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  // P5: 模板关联的类目预设字段（动态渲染）
  const [presetFields, setPresetFields] = useState([]);

  const load = useCallback(async () => {
    try {
      const [td, h, pr] = await Promise.all([
        api.studio.getTemplate(templateId),
        api.studio.history(templateId, showArchived),
        api.studio.dnaPresets().catch(() => null),
      ]);
      setT(td.template);
      setDna(JSON.parse(td.template.dna_json || '{}'));
      setHistory(h.generations || []);
      const pid = td.template.preset_id;
      const presets = (pr && pr.presets) || [];
      const p = presets.find((x) => x.id === pid);
      setPresetFields((p && p.fields) || []);
    } catch (e) {
      showToast(e.message || '加载失败');
    }
  }, [templateId, showArchived, showToast]);
  useEffect(() => { load(); }, [load]);

  const refresh = useCallback(async () => { await load(); onChanged(); }, [load, onChanged]);
  const isFinal = t && t.status === 'final';
  const lastGen = history[0] || null;

  const runGen = useCallback(async (op, changes, sourceId, seedMode) => {
    if (busy || !t) return null;
    setBusy(true);
    setBusyOp(op);
    try {
      const body = { op, changes, seed_mode: seedMode };
      if (sourceId) body.source_generation_id = sourceId;
      const r = op === 'create'
        ? await api.studio.generate(t.id, {})
        : await api.studio.variant(t.id, body);
      return r.generation;
    } catch (e) {
      showToast(e.message || '生图失败');
      return null;
    } finally {
      setBusy(false);
      setBusyOp('');
    }
  }, [busy, t, showToast]);

  // 生成后走并排验证
  const genAndCompare = useCallback(async (op, changes, sourceId, seedMode) => {
    const before = sourceId
      ? (history.find((g) => g.id === sourceId) || {}).image_path
      : (lastGen && lastGen.image_path) || t.source_image_path;
    const g = await runGen(op, changes, sourceId, seedMode);
    if (g) {
      await refresh();
      onCompare({ before, after: g.image_path, generationId: g.id, templateId: t.id });
    }
  }, [runGen, history, lastGen, t, refresh, onCompare]);

  const replicate = useCallback(async (gen) => {
    if (busy || !t) return;
    setBusy(true);
    try {
      const r = await api.studio.generate(t.id, { seed: gen.seed });
      await refresh();
      onCompare({
        before: gen.image_path,
        after: r.generation.image_path,
        generationId: r.generation.id,
        templateId: t.id,
      });
    } catch (e) {
      showToast(e.message || '复刻失败');
    } finally {
      setBusy(false);
    }
  }, [busy, t, showToast, refresh, onCompare]);

  const saveDna = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      await api.studio.updateTemplate(t.id, { dna_json: dna });
      showToast('DNA 已更新');
      await refresh();
    } catch (e) {
      showToast(e.message || '保存失败');
    } finally {
      setBusy(false);
    }
  }, [busy, t, dna, showToast, refresh]);

  const toggleFinal = useCallback(async () => {
    if (busy || !t) return;
    setBusy(true);
    try {
      if (isFinal) await api.studio.unfinalize(t.id);
      else await api.studio.finalize(t.id);
      showToast(isFinal ? '已解锁定，回到培育中' : '已定稿，DNA 锁定');
      await refresh();
    } catch (e) {
      showToast(e.message || '操作失败');
    } finally {
      setBusy(false);
    }
  }, [busy, t, isFinal, showToast, refresh]);

  const doRate = useCallback(async (genId, rating) => {
    try {
      await api.studio.rate(genId, rating);
      showToast(rating === 'liked' ? '已选用' : '已删除');
      await refresh();
    } catch (e) {
      showToast(e.message || '操作失败');
    }
  }, [showToast, refresh]);

  // 批量生产：主图 → 细节图 → 场景图（定稿卡）
  const batchProduce = useCallback(async () => {
    if (batching || !t) return;
    setBatching(true);
    try {
      setBatchStep('主图生成中…');
      const main = await runGen('create');
      if (!main) throw new Error('主图失败');
      setBatchStep('细节图生成中…');
      await runGen('detail_shot', null, main.id);
      setBatchStep('场景图生成中…');
      await runGen('scene', { scene: 'white_bg' }, main.id);
      showToast('批量生产完成');
      await refresh();
    } catch (e) {
      showToast(e.message || '批量生产中断');
    } finally {
      setBatching(false);
      setBatchStep('');
    }
  }, [batching, t, runGen, showToast, refresh]);

  const quickSubmit = useCallback(() => {
    if (!quickVal.trim()) { setQuickEdit(null); return; }
    const v = quickVal.trim();
    if (quickEdit === 'color') genAndCompare('recolor', { primary_color: v }, lastGen && lastGen.id);
    else if (quickEdit === 'scene') genAndCompare('scene', { scene: v }, lastGen && lastGen.id);
    else if (quickEdit === 'detail') genAndCompare('detail_modify', { details: v.split(/[,，]/).map((s) => s.trim()).filter(Boolean) }, lastGen && lastGen.id);
    setQuickEdit(null);
    setQuickVal('');
  }, [quickVal, quickEdit, genAndCompare, lastGen]);

  if (!t) {
    return (
      <div className="drawer-overlay" onClick={onClose}>
        <div className="drawer" onClick={(e) => e.stopPropagation()}>
          <div className="studio-loading"><div className="spinner" /></div>
        </div>
      </div>
    );
  }

  const actions = isFinal
    ? [
      { op: 'recolor', label: '换色', edit: 'color' },
      { op: 'scene', label: '换场景', edit: 'scene' },
    ]
    : [
      { op: 'create', label: '一键生图' },
      { op: 'recolor', label: '换色', edit: 'color' },
      { op: 'detail_modify', label: '改细节', edit: 'detail' },
      { op: 'detail_shot', label: '出细节图' },
      { op: 'scene', label: '换场景', edit: 'scene' },
      { op: 'variant', label: '再来一张' },
    ];

  return (
    <div className="drawer-overlay" onClick={onClose}>
      <div className="drawer studio-drawer" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span>{t.name} <em className={`status-badge ${t.status}`}>{isFinal ? '定稿' : '培育中'}</em></span>
          <button className="icon-btn" onClick={onClose}><Icon name="x" size={18} /></button>
        </div>

        <div className="drawer-sec">
          <div className="drawer-sec-title">DNA</div>
          <DnaFields dna={dna} setDna={setDna} readOnly={isFinal} fields={presetFields} />
          {!isFinal && (
            <button className="btn secondary small" disabled={busy} onClick={saveDna}>保存 DNA</button>
          )}
        </div>

        <div className="drawer-sec">
          <div className="drawer-sec-title">操作</div>
          <div className="studio-actions">
            {actions.map((a) => (
              <button
                key={a.op}
                className="btn secondary small"
                disabled={busy || batching}
                onClick={() => {
                  if (a.edit) { setQuickEdit(a.edit); setQuickVal(''); }
                  else if (a.op === 'create') genAndCompare('create');
                  else if (a.op === 'variant') genAndCompare('variant', null, lastGen && lastGen.id, 'new');
                  else genAndCompare(a.op, null, lastGen && lastGen.id);
                }}
              >
                {busyOp === a.op ? '生成中…' : a.label}
              </button>
            ))}
          </div>
          {quickEdit && (
            <div className="quick-edit-row">
              <input
                className="text-input"
                autoFocus
                placeholder={quickEdit === 'color' ? '新颜色，如：navy_blue' : quickEdit === 'scene' ? '新场景，如：white_bg' : '细节元素，逗号分隔'}
                value={quickVal}
                onChange={(e) => setQuickVal(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') quickSubmit(); if (e.key === 'Escape') setQuickEdit(null); }}
              />
              <button className="btn primary small" onClick={quickSubmit}>生成</button>
              <button className="btn secondary small" onClick={() => setQuickEdit(null)}>取消</button>
            </div>
          )}
          <div className="studio-actions" style={{ marginTop: 8 }}>
            <button className="btn secondary small" disabled={busy || batching} onClick={toggleFinal}>
              {isFinal ? '解锁定（回培育中）' : '定稿'}
            </button>
            {isFinal && (
              <button className="btn primary small" disabled={busy || batching} onClick={batchProduce}>
                {batching ? batchStep : '批量生产'}
              </button>
            )}
          </div>
        </div>

        <div className="drawer-sec">
          <div className="drawer-sec-title">
            历史（{history.length}）
            <button className="btn secondary small" style={{ marginLeft: 8 }} onClick={() => setShowArchived((v) => !v)}>
              {showArchived ? '隐藏归档' : '查看归档'}
            </button>
          </div>
          <div className="studio-history">
            {history.length === 0 && <div className="sidebar-hint">还没有生成记录</div>}
            {history.map((g) => (
              <div key={g.id} className="history-item">
                {g.image_path && imgUrl(g.image_path) ? (
                  <img src={imgUrl(g.thumb_path || g.image_path)} alt="" title={g.op} />
                ) : (
                  <div className="history-deleted">已删</div>
                )}
                <div className="history-hover">
                  <button title="选用" onClick={() => doRate(g.id, 'liked')}><Icon name="heart" size={14} /></button>
                  <button title="删除" onClick={() => doRate(g.id, 'deleted')}><Icon name="trash" size={14} /></button>
                  <button title="复刻" onClick={() => replicate(g)}><Icon name="copy" size={14} /></button>
                </div>
                {g.user_rating === 'liked' && <span className="rated liked">♥</span>}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------- 主视图：卡片流 ----------
export default function StudioView({ showToast, onOpenSidebar }) {
  const [templates, setTemplates] = useState([]);
  const [loading, setLoading] = useState(true);
  const [cloneOpen, setCloneOpen] = useState(false);
  const [exploreOpen, setExploreOpen] = useState(false);
  const [drawerId, setDrawerId] = useState(null);
  const [compare, setCompare] = useState(null);
  const [compareBusy, setCompareBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.studio.listTemplates();
      setTemplates(r.templates || []);
    } catch (e) {
      showToast(e.message || '加载失败');
    } finally {
      setLoading(false);
    }
  }, [showToast]);
  useEffect(() => { load(); }, [load]);

  const handleCompare = useCallback(({ before, after, generationId, templateId }) => {
    setCompare({ before, after, generationId, templateId });
    setDrawerId(null);
  }, []);

  const compareAdopt = useCallback(() => { setCompare(null); load(); }, [load]);
  const compareRetry = useCallback(() => {
    if (compare) setDrawerId(compare.templateId);
    setCompare(null);
  }, [compare]);
  const compareRevert = useCallback(async () => {
    if (!compare || compareBusy) return;
    setCompareBusy(true);
    try {
      await api.studio.rate(compare.generationId, 'deleted');
      showToast('已回退');
    } catch (e) {
      showToast(e.message || '回退失败');
    } finally {
      setCompareBusy(false);
      setCompare(null);
      load();
    }
  }, [compare, compareBusy, showToast, load]);

  return (
    <div className="studio-view">
      <div className="studio-head">
        <div className="studio-head-left">
          <button className="menu-btn icon-btn menu-btn-lg" title="打开侧边栏" onClick={onOpenSidebar}>
            <Icon name="menu" size={22} />
          </button>
          <h2>设计台</h2>
        </div>
        <div className="studio-head-actions">
          <button className="btn secondary small" onClick={() => setExploreOpen(true)}>
            <Icon name="sparkles" size={14} /> 创意衍生
          </button>
          {templates.length > 0 && (
            <button className="btn secondary small" onClick={() => setCloneOpen(true)}>
              <Icon name="plus" size={14} /> 解析款式
            </button>
          )}
        </div>
      </div>
      {loading ? (
        <div className="studio-loading"><div className="spinner" /><p>加载中…</p></div>
      ) : templates.length === 0 ? (
        <div className="studio-empty">
          <Icon name="sparkles" size={40} />
          <p>还没有款式卡</p>
          <p className="dim">传一张趋势图，AI 提取款式 DNA，一键开始生产</p>
          <button className="btn secondary" onClick={() => setCloneOpen(true)}>
            <Icon name="plus" size={16} /> 解析款式
          </button>
        </div>
      ) : (
        <div className="studio-grid">
          {templates.map((t) => (
            <div key={t.id} className="studio-card" onClick={() => setDrawerId(t.id)}>
              <div className="studio-card-cover">
                {(t.last_thumb || t.source_image_path) ? (
                  <img src={imgUrl(t.last_thumb || t.source_thumb_path || t.source_image_path)} alt={t.name} loading="lazy" />
                ) : (
                  <div className="studio-card-nocover"><Icon name="sparkles" size={28} /></div>
                )}
                <em className={`status-badge ${t.status}`}>{t.status === 'final' ? '定稿' : '培育中'}</em>
              </div>
              <div className="studio-card-body">
                <div className="studio-card-name">{t.name}</div>
                <div className="studio-card-tags">
                  {t.category && <span className="tag">{t.category}</span>}
                  <span className="tag dim">已生成 {t.gen_count || 0} 张</span>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {cloneOpen && (
        <CloneModal onClose={() => setCloneOpen(false)} onSaved={() => { setCloneOpen(false); load(); }} showToast={showToast} />
      )}
      {exploreOpen && (
        <ExploreModal onClose={() => setExploreOpen(false)} onAdopt={() => { setExploreOpen(false); load(); }} showToast={showToast} />
      )}
      {drawerId && (
        <TemplateDrawer
          templateId={drawerId}
          onClose={() => setDrawerId(null)}
          onChanged={load}
          showToast={showToast}
          onCompare={handleCompare}
        />
      )}
      {compare && (
        <CompareModal
          before={compare.before}
          after={compare.after}
          busy={compareBusy}
          onAdopt={compareAdopt}
          onRetry={compareRetry}
          onRevert={compareRevert}
        />
      )}
    </div>
  );
}
