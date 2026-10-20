import { StateTabs,CardMenu,useLifecycleActions } from './StudioLifecycle.jsx';
import StudioImage from './StudioImage.jsx';
import StyleWorkspace from './StyleWorkspace.jsx';
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
    if(f.size>15*1024*1024){showToast('参考原图不能超过 15MB，请选择其他文件');return;}
    // P6: 先压缩再上传（手机原图几 MB → 100-300KB）
    setCompressing(true);
    try {
      const blob = await compressImage(f);
      const [dataUrl,originalUrl]=await Promise.all([blobToDataUrl(blob),blobToDataUrl(f)]);
      setImgData({ base64: String(dataUrl).split(',')[1], originalBase64:String(originalUrl).split(',')[1], mime: 'image/jpeg', preview: dataUrl });
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
        source_image_base64: imgData.originalBase64 || imgData.base64,
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

// ---------- 主视图：卡片流 ----------
export default function StudioView({ showToast, onOpenSidebar }) {
  const [templates, setTemplates] = useState([]);
  const [lifecycle,setLifecycle]=useState('active');
  const hasLoaded=useRef(false);
  const [loading, setLoading] = useState(true);
  const [cloneOpen, setCloneOpen] = useState(false);
  const [exploreOpen, setExploreOpen] = useState(false);
  const [viewImage,setViewImage]=useState(null);
  const openCard=t=>setViewImage({id:t.id,name:t.name,path:t.last_image||t.source_image_path,thumbnail:t.last_thumb||t.source_thumb_path,image_available:t.image_available,panel:null});

  const load = useCallback(async () => {
    if(!hasLoaded.current)setLoading(true);
    try {
      const r = await api.studio.listTemplates(lifecycle);
      setTemplates(r.templates || []);
    } catch (e) {
      showToast(e.message || '加载失败');
    } finally {
      hasLoaded.current=true;setLoading(false);
    }
  }, [showToast,lifecycle]);
  const lifecycleActions=useLifecycleActions({onChanged:load,showToast});
  useEffect(() => { load(); }, [load]);

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
      <StateTabs value={lifecycle} onChange={setLifecycle}/>
      {lifecycleActions.modal}
      {loading ? (
        <div className="studio-loading"><div className="spinner" /><p>加载中…</p></div>
      ) : templates.length === 0 ? (
        <div className="studio-empty">
          <Icon name="sparkles" size={40} />
          <p>{lifecycle==='trash'?'回收站为空':lifecycle==='archived'?'暂无归档款式':'还没有款式卡'}</p>
          <p className="dim">传一张趋势图，AI 提取款式 DNA，一键开始生产</p>
          <button className="btn secondary" onClick={() => setCloneOpen(true)}>
            <Icon name="plus" size={16} /> 解析款式
          </button>
        </div>
      ) : (
        <div className="studio-grid">
          {templates.map((t) => (
            <div key={t.id} className="studio-card" data-style-id={t.id} role="button" tabIndex={0} aria-label={`查看${t.name}原图`} onKeyDown={e=>{if(e.target===e.currentTarget&&(e.key==='Enter'||e.key===' ')){e.preventDefault();openCard(t);}}} onClick={() => openCard(t)}>
              <div className="studio-card-cover">
                <CardMenu name={t.name} items={lifecycle==='trash'?[
                  {label:'还原款式',action:()=>lifecycleActions.perform('templates',t,'restore')},
                  {label:'永久删除',action:()=>lifecycleActions.perform('templates',t,'delete')},
                ]:[
                  {label:'重命名',action:async()=>{const name=window.prompt('款式名称',t.name);if(!name?.trim())return;try{await api.studio.updateTemplate(t.id,{name:name.trim()});await load();}catch(e){showToast(e.message);}}},
                  {label:'更换展示图',action:()=>setViewImage({id:t.id,name:t.name,path:t.last_image||t.source_image_path,thumbnail:t.last_thumb||t.source_thumb_path,image_available:t.image_available,panel:'versions'})},
                  {label:'另存为新款式',action:async()=>{try{const w=await api.studio.workspace(t.id);const r=await api.studio.forkStyle(t.id,{version_id:w.template.work_version_id,name:t.name+' 副本',generation_id:t.image_available?w.template.cover_generation_id||undefined:undefined,attributes_only:!t.image_available});showToast('已另存为新款式');await load();}catch(e){showToast(e.message);}}},
                  {label:lifecycle==='archived'?'恢复使用':'归档款式',action:()=>lifecycleActions.perform('templates',t,lifecycle==='archived'?'activate':'archive')},
                  {label:'删除（移入回收站）',action:()=>lifecycleActions.perform('templates',t,'trash')},
                ]}/>

                {(t.last_thumb || t.source_image_path) ? (
                  <StudioImage thumbnail={t.last_thumb || t.source_thumb_path} original={t.last_image || t.source_image_path} alt={t.name} loading="lazy" />
                ) : (
                  <div className="studio-card-nocover"><span>{t.image_state==='missing'?'原图文件缺失':'尚未生成图片'}</span></div>
                )}
                <em className={`status-badge ${t.status}`}>{t.status === 'final' ? '定稿' : '培育中'}</em>
              </div>
              <div className="studio-card-body">
                <div className="studio-card-name">{t.name}</div>
                {t.image_state==='thumbnail_only'&&<p className="dim small">仅缩略图可用 · 原图缺失</p>}
                <button className="btn secondary small" onClick={e=>{e.stopPropagation();setViewImage({id:t.id,name:t.name,path:t.last_image||t.source_image_path,thumbnail:t.last_thumb||t.source_thumb_path,image_available:t.image_available,panel:'attributes'});}}>款式属性</button>
                <div className="studio-card-tags">
                  {t.category && <span className="tag">{t.category}</span>}
                  <span className="tag dim">已生成 {t.gen_count || 0} 张</span>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {viewImage&&<StyleWorkspace key={viewImage.id} templateId={viewImage.id} initialImage={viewImage.path?{path:viewImage.path,thumb_path:viewImage.thumbnail,image_available:viewImage.image_available,name:viewImage.name}:null} initialPanel={viewImage.panel} onClose={()=>setViewImage(null)} onChanged={load} showToast={showToast}/>}
      {cloneOpen && (
        <CloneModal onClose={() => setCloneOpen(false)} onSaved={() => { setCloneOpen(false); load(); }} showToast={showToast} />
      )}
      {exploreOpen && (
        <ExploreModal onClose={() => setExploreOpen(false)} onAdopt={(close) => { if (close) setExploreOpen(false); load(); }} showToast={showToast} />
      )}
    </div>
  );
}
