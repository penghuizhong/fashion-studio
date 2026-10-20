import DesignDelivery from './DesignDelivery.jsx';
import ProgressiveStudioImage from './ProgressiveStudioImage.jsx';
import useWorkspaceCollections, { mergeRecords, CollectionMore } from './useWorkspaceCollections.jsx';
import { imageTaskAllowed,sizeAllowed,imageReferenceLimit } from '../../../shared/imageOptions.js';
import { StateTabs,useLifecycleActions } from "./StudioLifecycle.jsx";
import ReferenceImages from "./ReferenceImages.jsx";
import ImageOutputOptions from "./ImageOutputOptions.jsx";
import { PRESENTATION_STYLES } from "../../../shared/presentationStyles.js";
import StudioImage from "./StudioImage.jsx";
import { generationIssue, generationErrorSection } from "./styleGenerationReadiness.js";
import { useEffect, useRef, useState, useCallback } from "react";
import { api } from "../api.js";
import { useAuth } from "../auth.jsx";
import { DEFAULT_CAMERA } from "../../../shared/photography.js";
import CameraSettings from "./CameraSettings.jsx";
import OriginalImageLink from "./OriginalImageLink.jsx";
import OriginalImageViewer from "./OriginalImageViewer.jsx";
import { fmtDnaValue } from "./DnaFields.js";
const validTab = tab => ["derive", "attributes", "versions"].includes(tab) ? tab : "derive";
const parse = (s, f = {}) => {
  try {
    return JSON.parse(s);
  } catch {
    return f;
  }
};
const actions = [
  ["create", "生成基础图", "按已保存设计生成或参考图片重绘"],
  ["free_design", "自由衍生", "按文字或多张参考图探索新设计"],
  ["recolor", "换色", "指定部位与目标颜色，保存为新版本"],
  ["detail_modify", "改细节", "选择部位与添加、替换或移除"],
  ["detail_shot", "出细节图", "指定局部取景，AI 推演不代表真实工艺"],
  ["scene", "换场景", "保留服装，调整背景和展示环境"],
  ["white", "白底商品图", "保留服装，生成纯白背景商品图"],
];
const actionLabels = [...actions,["variant","再生成","沿用当前设计再出图"]];
const states = {
  running: "生成中",
  queued: "等待中",
  succeeded: "已完成",
  partial: "部分完成",
  uncertain: "结果待核对",
  failed: "失败",
  interrupted: "中断",
};
const defaultForm = {
  op: "create",
  mode: "text",
  source: "",
  model_id: "",
  size: "",
  quality: "",
  count: 1,
  camera: { ...DEFAULT_CAMERA },
  visual_style: "auto",
  purpose: "free",
  instruction: "",
  instruction_scope:"presentation",
  keep: "",
  references: [],
  consistent: true,
  explore_variation: false,
};
export default function StyleWorkspace({
  templateId,
  initialImage,
  initialPanel,
  initialVersionId,
  onClose,
  onChanged,
  onGoSample,
  onGoPattern,
  showToast,
}) {
  const { user, multiUser } = useAuth();
  const draftKey = `style-draft-v1:${multiUser ? user?.id || user?.username : "local"}:${templateId}`;
  const dialog = useRef(null),
    restored = useRef(false),
    saveRequest = useRef({ signature: "", key: "" });
  const [data, setData] = useState(null),
    [models, setModels] = useState([]),
    [presetFields, setFields] = useState([]),
    [references, setReferences] = useState([]),
    [resolvedChoices,setResolvedChoices]=useState([]),
    [modelError, setModelError] = useState("");
  const [versionId, setVersionId] = useState(null),
    [panel, setPanel] = useState(initialPanel ? validTab(initialPanel) : null),
    [tab, setTab] = useState(validTab(initialPanel));
  const [form, setForm] = useState({
      ...defaultForm,
      camera: { ...DEFAULT_CAMERA },
    }),
    [preview, setPreview] = useState(initialImage || null),
    [actual, setActual] = useState(false),
    [large, setLarge] = useState(null);
  const [draft, setDraft] = useState(null),
    [editParent, setEditParent] = useState(null),
    [part, setPart] = useState("primary_color"),
    [target, setTarget] = useState(""),
    [detailAction, setDetailAction] = useState("替换");
  const [notice, setNotice] = useState("");
  const notifiedJobs = useRef(new Map());
  const notify = (message) => {
    setNotice(message);
    showToast?.(message);
  };
  const actionDrafts = useRef({});
  const live = useRef(true), loadController = useRef(null), currentVersion = useRef(null), editParentRef=useRef(null), selectionEpoch=useRef(0);
  const busyLock=useRef(false);
  const [busy, setBusy] = useState(false),
    [errors, setErrors] = useState({}),
    [pendingStart, setPendingStart] = useState(null),
    [quote, setQuote] = useState(null),
    [quoteBusy, setQuoteBusy] = useState(false),
    [quoteNonce, setQuoteNonce] = useState(0),
    [requestKey, setRequestKey] = useState(""),
    [retryJob, setRetryJob] = useState(null);
  const [previewCollapsed, setPreviewCollapsed] = useState(false);
  const [compare, setCompare] = useState(false),
    [mobileCompare, setMobileCompare] = useState("after"),
    [closing, setClosing] = useState(false),
    [showHistory, setShowHistory] = useState(false);
  const [imageState,setImageState]=useState("active");
  currentVersion.current = versionId;editParentRef.current=editParent;
  const {pages,ids:collectionIds,fetchPage} = useWorkspaceCollections(templateId,setData,{versionId,imageState});
  const [refreshCollections,setRefreshCollections]=useState(0);
  const version = data?.versions.find((v) => v.id === versionId),
    dna = parse(version?.dna_json),
    editVersion = data?.versions.find((v) => v.id === editParent);
  const snapshotFields = parse(version?.schema_json, []);
  const schemaFields = snapshotFields.length ? snapshotFields : presetFields;
  const fields = [
    ...schemaFields.filter((f) => f.key in dna),
    ...Object.keys(dna)
      .filter((key) => !schemaFields.some((f) => f.key === key))
      .map((key) => ({ key, label: key })),
  ];
  const dirty =
    draft &&
    JSON.stringify(draft) !==
      JSON.stringify(
        Object.fromEntries(
          Object.entries(parse(editVersion?.dna_json)).map(([k, f]) => [
            k,
            Array.isArray(f.value) ? f.value.join("、") : String(f.value ?? ""),
          ]),
        ),
      );
  const active = data?.jobs.some((j) => ["running","queued"].includes(j.status));
  const clearError = section => setErrors(old => ({...old, [section]: ''}));
  const fail = (e, section = tab === 'derive' ? 'quote' : tab) => {
    if (live.current && e.name !== 'AbortError') setErrors(old => ({...old, [section]: e.message || '操作失败'}));
  };
  const selectedModel = models.find(m => m.id === form.model_id);
  const readiness = generationIssue({data,version,form,model:selectedModel,dirty,active,retryJob,target});
  const sectionError = section => errors[section] && <p role="alert" className="style-error">{errors[section]}</p>;

  const load = useCallback(async (selectedId = currentVersion.current, editId = editParentRef.current) => {
    loadController.current?.abort();const controller=new AbortController();loadController.current=controller;
    const r = await api.studio.workspace(templateId,{view:'summary',...(selectedId?{version_id:selectedId}:{}),...(editId?{edit_parent_id:editId}:{}),...(initialImage?.id?{image_id:initialImage.id}:{})},{signal:controller.signal});
    if(!live.current||controller.signal.aborted)return r;
    setData(d=>d?{...r,versions:mergeRecords(d.versions,r.versions),images:mergeRecords(d.images,r.images),jobs:mergeRecords(d.jobs,r.jobs)}:r);
    setVersionId(selectedId && r.versions.some(v=>v.id===selectedId)?selectedId:r.template.work_version_id);
    setRefreshCollections(n=>n+1);
    return r;
  }, [templateId]);
  useEffect(() => {
    const element = dialog.current,
      opener = document.activeElement,
      old = document.body.style.overflow;
    element.showModal();
    document.body.style.overflow = "hidden";
    return () => {
      element.close();
      document.body.style.overflow = old;
      opener?.focus();
    };
  }, []);
  useEffect(() => {
    live.current=true;
    let saved;
    try { saved=parse(sessionStorage.getItem(draftKey),null); } catch {}
    // An unresolved submission must outlive ordinary form drafts.
    if(saved?.pendingStart)setPendingStart(saved.pendingStart);
    if(saved && Date.now()-saved.savedAt<86400000){
      const oldForm={...defaultForm,...saved.form};
      if(oldForm.purpose==='white'&&['create','scene'].includes(oldForm.op))oldForm.op='white';
      if(oldForm.instruction_scope==='design')oldForm.op='free_design';
      setForm(oldForm);actionDrafts.current=saved.actionDrafts||{};
      const actionSaved=actionDrafts.current[oldForm.op];setTarget(actionSaved?.target||'');setPart(actionSaved?.part||'primary_color');setDetailAction(actionSaved?.detailAction||'替换');
      setPreview(initialImage||saved.preview||null);
      setDraft(saved.draft||null);setEditParent(saved.editParent||null);
    }
    load(initialVersionId||saved?.versionId,saved?.editParent).catch(e=>{if(e.code==="VERSION_NOT_FOUND")return load(null);throw e;}).then(()=>{if(live.current)restored.current=true;}).catch(e=>{if(live.current&&e.name!=="AbortError")fail(e,"load");});
    return()=>{live.current=false;loadController.current?.abort();};
  },[templateId]);
  useEffect(()=>{
    if(!panel||tab!=='derive'||models.length)return;
    const controller=new AbortController();setModelError('');
    api.studio.imageModels({signal:controller.signal}).then(r=>{
      setModels(r.models||[]);
      const model=r.models?.find(m=>m.capabilities?.text&&m.capabilities.default_for?.includes('text'))||r.models?.find(m=>m.price_per_call!==null&&m.capabilities?.text);
      setForm(f=>f.model_id?f:{...f,model_id:model?.id||'',size:model?.sizes?.[0]||''});
    }).catch(e=>{if(!controller.signal.aborted)setModelError(e.message);});
    return()=>controller.abort();
  },[panel,tab,models.length,quoteNonce]);
  useEffect(()=>{
    if(!panel||tab!=='attributes'||!version||snapshotFields.length||presetFields.length)return;
    const controller=new AbortController();
    api.studio.dnaPresets({signal:controller.signal}).then(p=>setFields(p.presets?.find(p=>p.id===data.template.preset_id)?.fields||[])).catch(e=>{if(!controller.signal.aborted)fail(e,'attributes');});
    return()=>controller.abort();
  },[panel,tab,versionId,!!data]);
  useEffect(()=>{
    if(!panel||!data)return;
    if(tab==='versions')fetchPage('versions');
  },[panel,tab,refreshCollections]);
  useEffect(()=>{
    if(!panel||!data||!showHistory)return;
    fetchPage('images');fetchPage('jobs');
  },[panel,showHistory,versionId,imageState,refreshCollections]);
  useEffect(()=>{
    const needed=[form.source,...form.references.map(r=>r.source)].filter(x=>String(x).startsWith('ref:'));
    if(!panel||tab!=='derive'||!needed.length)return;
    const controller=new AbortController();
    api.studio.references({ids:needed.map(x=>x.slice(4)).join(','),limit:16},{signal:controller.signal}).then(r=>setReferences(old=>mergeRecords(old,r.references))).catch(e=>{if(!controller.signal.aborted)fail(e,'references');});
    return()=>controller.abort();
  },[panel,tab,form.source,JSON.stringify(form.references)]);
  useEffect(()=>{
    const ids=[form.source,...form.references.map(r=>r.source)].filter(x=>/^\d+$/.test(String(x))&&!data?.images.some(i=>String(i.id)===String(x)));
    if(!panel||tab!=='derive'||!ids.length)return;
    const controller=new AbortController();api.studio.workspaceItems(templateId,'images',{ids:ids.join(','),limit:16},{signal:controller.signal}).then(r=>setData(d=>({...d,images:mergeRecords(d.images,r.items)}))).catch(e=>{if(!controller.signal.aborted)fail(e,'references');});
    return()=>controller.abort();
  },[panel,tab,form.source,JSON.stringify(form.references),!!data]);
  useEffect(() => {
    if (!restored.current) return;
    try {
      sessionStorage.setItem(
        draftKey,
        JSON.stringify({
          savedAt: Date.now(),
          pendingStart,
          versionId,
          form,
          draft,
          editParent,
          preview,
          actionDrafts:{...actionDrafts.current,[form.op]:{instruction:form.instruction,camera:form.camera,visual_style:form.visual_style,keep:form.keep,explore_variation:form.explore_variation,target,part,detailAction}},
        }),
      );
    } catch {}
  }, [versionId, form, draft, editParent, preview,target,part,detailAction,pendingStart]);
  useEffect(() => {
    if (!active) return;
    const controller=new AbortController();let timer;
    const poll=async()=>{
      try{
        const known=Object.fromEntries((data?.jobs||[]).filter(j=>['running','queued'].includes(j.status)).slice(0,16).map(j=>[j.id,j.revision||'']));
        const r=await api.studio.styleProgress(templateId,known,{signal:controller.signal});
        if(controller.signal.aborted)return;
        clearError('history');
        if(r.jobs.length){setData(d=>({...d,jobs:mergeRecords(d.jobs,r.jobs)}));
          if(r.jobs.some(j=>!['running','queued'].includes(j.status))){setShowHistory(true);setRefreshCollections(n=>n+1);onChanged();}
          else if(r.jobs.some(j=>j.completed>(data.jobs.find(old=>old.id===j.id)?.completed||0)))fetchPage('images');
        }
      }catch(e){if(!controller.signal.aborted)fail(e,'history');}
      if(!controller.signal.aborted)timer=setTimeout(poll,1500);
    };
    timer=setTimeout(poll,1000);
    return()=>{controller.abort();clearTimeout(timer);};
  }, [active,templateId,JSON.stringify(data?.jobs.map(j=>[j.id,j.status,j.revision]))]);
  useEffect(() => {
    if (!data) return;
    for (const j of data.jobs) {
      if (
        notifiedJobs.current.get(j.id) === "running" &&
        j.status !== "running"
      )
        notify(
          `${states[j.status] || j.status}：已处理 ${j.completed}/${j.total} 张，可查看最新任务结果`,
        );
      notifiedJobs.current.set(j.id, j.status);
    }
  }, [data?.jobs]);
  const signature = JSON.stringify({ versionId, ...form, retryJob, dirty });
  useEffect(() => {
    if (pendingStart) return;
    setQuote(null);
    setRequestKey("");
    setErrors(old => ({...old, quote:'', output:'', instruction:'', camera:''}));
    if (
      !data ||
      data.template.lifecycle!=="active" ||
      !versionId ||
      !form.model_id ||
      !form.size ||
      readiness ||
      dirty ||
      active ||
      !panel ||
      tab !== "derive"
    )
      return;
    let alive = true;
    const controller=new AbortController();
    setQuoteBusy(true);
    const timer = setTimeout(async () => {
      try {
        const r = retryJob
          ? await api.studio.styleRetry(templateId, retryJob,{signal:controller.signal})
          : await api.studio.styleQuote(templateId, {
              ...form,
              version_id: versionId,
            },{signal:controller.signal});
        if (alive) {
          setQuote(r.quote);
          setRequestKey(crypto.randomUUID());
          clearError('quote');
        }
      } catch (e) {
        if (alive) fail(e, generationErrorSection(e.code));
      } finally {
        if (alive) setQuoteBusy(false);
      }
    }, 400);
    return () => {
      alive = false;
      clearTimeout(timer);
      controller.abort();
      setQuoteBusy(false);
    };
  }, [signature, active, tab, panel, quoteNonce, !!data,data?.template.lifecycle,readiness?.message]);
  useEffect(() => {
    if (!quote) return;
    const timer = setTimeout(
      () => {
        setQuote(null);
        setQuoteNonce((n) => n + 1);
      },
      Math.max(0, quote.expires_at - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [quote]);
  const update = (key, value) => {
    setRetryJob(null);
    setQuote(null);
    setForm((f) => ({ ...f, [key]: value, ...(['op','count','camera'].includes(key)?{delivery_views:null}:{}) }));
  };
  const run = async (fn, section = tab === 'derive' ? 'quote' : tab) => {
    if (busyLock.current) return;
    busyLock.current=true;
    setBusy(true);
    clearError(section);
    try {
      await fn();
      window.dispatchEvent(new Event("studio-images-changed"));
    } catch (e) {
      fail(e, section);
    } finally {
      busyLock.current=false;
      if(live.current)setBusy(false);
    }
  };
  const close = () => {
    if (dirty) {
      setClosing(true);
      return;
    }
    onClose();
  };
  const beginEdit = () => {
    setEditParent(versionId);
    setDraft(
      Object.fromEntries(
        Object.entries(dna).map(([k, f]) => [
          k,
          Array.isArray(f.value) ? f.value.join("、") : String(f.value ?? ""),
        ]),
      ),
    );
    setTab("attributes");
    setPanel("attributes");
  };
  const save = () =>
    run(async () => {
      const before = parse(editVersion.dna_json);
      const next = Object.fromEntries(
        Object.entries(draft).map(([k, value]) => [
          k,
          {
            ...before[k],
            value: Array.isArray(before[k]?.value)
              ? value
                  .split(/[、,，]/)
                  .map((v) => v.trim())
                  .filter(Boolean)
              : value,
          },
        ]),
      );
      const signature = JSON.stringify({ parent_id: editParent, dna: next });
      if (saveRequest.current.signature !== signature)
        saveRequest.current = { signature, key: crypto.randomUUID() };
      const r = await api.studio.saveVersion(templateId, {
        parent_id: editParent,
        dna: next,
        request_key: saveRequest.current.key,
      });
      await load(r.version.id);
      setVersionId(r.version.id);
      if (r.version.id !== editParent) setPreview(null);
      setDraft(null);
      setEditParent(null);
      notify(
        r.version.id === editParent
          ? "属性未变化，未创建新版本"
          : "已保存为设计版本，原版本和图片保持不变",
      );
    });
  const selectVersion = async (id, preferredImage) => {
    id=Number(id);const epoch=++selectionEpoch.current;setCompare(false);setRetryJob(null);
    try{
      const r=await load(id);
      if(!live.current)return;
      const page=await api.studio.workspaceItems(templateId,'images',{version_id:id,state:'active',limit:1},{signal:loadController.current?.signal});
      if(!live.current||selectionEpoch.current!==epoch)return;
      const image=preferredImage||page.items[0];
      setData(d=>({...d,images:mergeRecords(d.images,page.items)}));
      setPreview(image?{...image,path:image.image_path}:null);
    }catch(e){if(live.current&&e.name!=='AbortError')fail(e);}
  };
  const saveActionDesign = () =>
    run(async () => {
      if (dirty) throw new Error("请先保存或取消属性草稿");
      if (!target.trim()) throw new Error("请填写设计修改");
      const original = parse(version.dna_json),
        key = form.op === "recolor" ? part : "details";
      if (!(key in original))
        throw new Error("当前类目不支持此字段，请在款式属性中修改");
      let value = target.trim();
      if (key === "details") {
        const old = Array.isArray(original.details?.value)
          ? original.details.value
          : [];
        value =
          detailAction === "添加"
            ? [...old, value]
            : detailAction === "移除"
              ? old.filter((v) => v !== value)
              : value.split(/[、,，]/).filter(Boolean);
      }
      const next = { ...original, [key]: { ...original[key], value } };
      const sig = JSON.stringify({ parent_id: versionId, dna: next });
      if (saveRequest.current.signature !== sig)
        saveRequest.current = { signature: sig, key: crypto.randomUUID() };
      const r = await api.studio.saveVersion(templateId, {
        parent_id: versionId,
        dna: next,
        request_key: saveRequest.current.key,
      });
      if (r.version.id === versionId)
        throw new Error("本次修改没有产生属性变化，请调整目标");
      await load(r.version.id);
      setVersionId(r.version.id);
      update(
        "instruction",
        [form.instruction,`${form.op === "recolor" ? fields.find((f) => f.key === part)?.label || part : detailAction + "细节"}：${target}`].filter(Boolean).join("\n"),
      );
      notify(`设计已保存为 V${r.version.number}，生成前请确认报价`);
      setTarget("");
    });
  const changeAction = (op) => {
    if(pendingStart || op===form.op)return;
    actionDrafts.current[form.op]={instruction:form.instruction,camera:form.camera,visual_style:form.visual_style,keep:form.keep,explore_variation:form.explore_variation,target,part,detailAction};
    const saved=actionDrafts.current[op];
    const camera=saved?.camera||{...form.camera,framing:op==='detail_shot'?'detail':form.camera.framing==='detail'?'garment':form.camera.framing,detail:op==='detail_shot'?form.camera.detail||'':''};
    setForm(f=>({...f,op,delivery_views:null,instruction:saved?.instruction||'',instruction_scope:op==='free_design'?'design':'presentation',camera,visual_style:op==='white'?'auto':saved?.visual_style||'auto',purpose:op==='white'?'white':op==='scene'?'scene':op==='detail_shot'?'detail':'free',keep:saved?.keep||'',explore_variation:saved?.explore_variation||false}));
    setTarget(saved?.target||'');setPart(saved?.part||'primary_color');setDetailAction(saved?.detailAction||'替换');setRetryJob(null);setQuote(null);setErrors(old=>({...old,quote:'',references:'',instruction:'',camera:'',output:''}));
    if(!['create','free_design'].includes(op)&&!form.source){
      const base=referenceChoices.find(c=>c.image_path===file&&c.available!==false)||referenceChoices.find(c=>c.available!==false);
      if(base)setReferenceItems([base.key]);
    }
  };
  const start = () => run(async () => {
    if ((!quote || readiness) && !pendingStart) return;
    const submission = pendingStart || { quote_id: quote.id, request_key: requestKey, confirm: true };
    setPendingStart(submission);
    // Save before sending so closing/reloading after a lost response reuses the same key.
    try {
      const saved = parse(sessionStorage.getItem(draftKey), {});
      sessionStorage.setItem(draftKey, JSON.stringify({...saved, savedAt:Date.now(), pendingStart:submission}));
    } catch {}
    let r;
    try { r = await api.studio.styleStart(templateId, submission); }
    catch(e) {
      if (e.code && e.status < 500) {
        setPendingStart(null);
        if (/^QUOTE_/.test(e.code)) setQuote(null);
        try { const saved=parse(sessionStorage.getItem(draftKey),{}); sessionStorage.setItem(draftKey,JSON.stringify({...saved,pendingStart:null})); } catch {}
      }
      if (!e.code || e.status >= 500) throw new Error('提交结果尚未确认，请使用“核对提交结果”恢复原请求');
      throw e;
    }
    setPendingStart(null);
    try { const saved=parse(sessionStorage.getItem(draftKey),{}); sessionStorage.setItem(draftKey,JSON.stringify({...saved,pendingStart:null})); } catch {}
    setData(d => ({...d, jobs: [r.job, ...d.jobs.filter(job=>job.id!==r.job.id)]}));
    setQuote(null);setShowHistory(true);
    const resultVersion = r.job.snapshot.style.version_id;
    if (resultVersion !== versionId) await load(resultVersion);
    setRefreshCollections(n=>n+1);
    notify(`生成任务已提交 · V${r.job.snapshot.style.version_number}，关闭面板也会继续`);
  }, 'quote');
  const chooseSource = (img) => {
    if (pendingStart) return;
    update("source", String(img.id));
    update("mode", "image");
    selectVersion(img.design_version_id || versionId,img);
    setPreview({ ...img, path: img.image_path });
    setTab("derive");
    setPanel("derive");
  };
  const file = preview?.path || preview?.image_path;
  const fileAvailability=data?.images.find(i=>i.image_path===file)?.image_available ?? (file===data?.template.source_image_path?data?.template.source_available:preview?.image_available);

  const previewVersionId =
    preview?.design_version_id ||
    data?.images.find((i) => i.image_path === file)?.design_version_id;
  const sourceImage = form.source==='original'?data?.template.source_image_path:String(form.source).startsWith('ref:')?references.find(r=>String(r.id)===form.source.slice(4))?.image_path:data?.images.find(i=>String(i.id)===form.source)?.image_path||resolvedChoices.find(c=>c.key===form.source)?.image_path;
  const previewThumbnail=preview?.thumb_path || data?.images.find(i=>i.image_path===file)?.thumb_path || (file===data?.template.source_image_path?data?.template.source_thumb_path:null);
  const sourceThumbnail=form.source==='original'?data?.template.source_thumb_path:String(form.source).startsWith('ref:')?references.find(r=>String(r.id)===form.source.slice(4))?.thumb_path:data?.images.find(i=>String(i.id)===form.source)?.thumb_path||resolvedChoices.find(c=>c.key===form.source)?.thumb_path;
  const lifecycleActions=useLifecycleActions({onChanged:async()=>{await load();onChanged();},showToast:notify});
  const setReferenceItems=selected=>{
    const seen=new Set();const items=selected.filter(key=>{const c=referenceChoices.find(c=>c.key===key),identity=c?.image_path||key;if(seen.has(identity))return false;seen.add(identity);return true;});
    const task=items.length>1?'multi':items.length?'single':'text';
    const compatible=m=>imageTaskAllowed(m?.capabilities,items.length);
    const recommended=compatible(selectedModel)?selectedModel:models.find(m=>compatible(m)&&m.capabilities.default_for?.includes(task))||models.find(compatible);
    setRetryJob(null);setQuote(null);clearError('references');
    setForm(f=>({...f,mode:items.length?'image':'text',source:items[0]||'',references:items.slice(1).map(source=>({source,role:'instruction'})),...(recommended&&recommended.id!==f.model_id?{model_id:recommended.id,size:sizeAllowed(recommended.capabilities,f.size)?f.size:recommended.sizes[0],quality:''}:{})}));
    if(recommended&&recommended.id!==form.model_id)notify(`已选择支持${items.length}张参考图的模型：${recommended.name}，请核对报价`);
  };
  const referenceChoices = data ? [
    ...(data.template.source_image_path?[{key:'original',name:'原始参考图',image_path:data.template.source_image_path,thumb_path:data.template.source_thumb_path,available:data.template.source_available}]:[]),
    ...data.images.filter(i=>i.user_rating!=='deleted'&&!['trash','deleted'].includes(i.lifecycle)).map(i=>({key:String(i.id),name:`款式图片 #${i.id}`,image_path:i.image_path,thumb_path:i.thumb_path,available:i.image_available})),
    ...references.map(r=>({key:`ref:${r.id}`,name:`已上传参考 #${r.id}`,...r})),
    ...resolvedChoices,
  ] : [];
  const visibleImages =
    data?.images.filter(
      (i) =>
        (collectionIds.images||[]).includes(i.id) &&
        (i.design_version_id === versionId || i.design_version_id == null) &&
        i.user_rating !== "deleted" &&
        (i.lifecycle || (i.archived?"archived":"active"))===imageState,
    ) || [];
  return (
    <dialog
      ref={dialog}
      className={`style-workspace${panel ? " has-panel" : ""}`}
      aria-label="款式详情"
      onCancel={(e) => {
        e.preventDefault();
        if (e.target === dialog.current) close();
      }}
    >
      <header className="style-workspace-head">
        <div>
          <strong>{data?.template.name || "款式详情"}</strong>
          {version && (
            <span className="tag">
              V{version.number} ·{" "}
              {version.status === "final" ? "已定稿" : "设计中"}
            </span>
          )}
        </div>
        <div className="style-toolbar">
          {fileAvailability!==false&&<OriginalImageLink path={file} />}
          <button
            className="btn secondary small"
            onClick={() => {
              setPanel((p) => (p ? null : "derive"));
              if (!panel) setTab("derive");
            }}
          >
            {panel ? "收起面板" : "款式衍生"}
          </button>
          <button
            className="btn secondary small"
            onClick={() => {
              setPanel("attributes");
              setTab("attributes");
            }}
          >
            款式属性
          </button>
        </div>
        <button className="icon-btn style-workspace-close" aria-label="关闭款式详情" onClick={close}>×</button>
      </header>
      <>
          <div className="style-workspace-main">
            <section
              className={`style-preview${actual ? " actual" : ""}${previewCollapsed ? " collapsed" : ""}`}
              aria-label="款式图片预览"
            >
              <div className="style-preview-toolbar">
                <button
                  className="btn secondary small style-collapse-preview"
                  onClick={() => setPreviewCollapsed((v) => !v)}
                >
                  {previewCollapsed ? "展开预览" : "收起预览"}
                </button>
                <span>
                  {file === data?.template.source_image_path && file
                    ? "原始参考图"
                    : previewVersionId == null && file
                      ? "历史图片（属性版本未记录）"
                      : file
                        ? `图片所属版本：V${data?.versions.find((v) => v.id === previewVersionId)?.number || version?.number}`
                        : `V${version?.number} 尚未生成图片`}
                </span>
                {file && fileAvailability!==false && (
                  <>
                    <button
                      className="btn secondary small style-actual-toggle"
                      onClick={() => setActual((a) => !a)}
                    >
                      {actual ? "适应窗口" : "实际尺寸"}
                    </button>
                    <button
                      className="btn secondary small"
                      onClick={() =>
                        setLarge({ path: file, name: data?.template.name || initialImage?.name || "款式图片" })
                      }
                    >
                      放大原图
                    </button>
                  </>
                )}
              </div>
              {compare && sourceImage && file ? (
                <>
                  <div className="style-mobile-compare">
                    <button onClick={() => setMobileCompare("before")}>
                      底图
                    </button>
                    <button onClick={() => setMobileCompare("after")}>
                      新图
                    </button>
                  </div>
                  <div className="style-comparison">
                    <figure
                      className={mobileCompare === "before" ? "selected" : ""}
                    >
                      <ProgressiveStudioImage original={sourceImage} thumbnail={sourceThumbnail} alt="本次底图" />
                      <figcaption>本次底图</figcaption>
                    </figure>
                    <figure
                      className={mobileCompare === "after" ? "selected" : ""}
                    >
                      <ProgressiveStudioImage original={file} thumbnail={previewThumbnail} alt="生成结果" />
                      <figcaption>生成结果</figcaption>
                    </figure>
                  </div>
                </>
              ) : file ? (
                <div className="style-preview-image">
                  <ProgressiveStudioImage original={file} thumbnail={previewThumbnail} available={fileAvailability} actual={actual} alt={data?.template.name||initialImage?.name||"款式图片"} />
                </div>
              ) : (
                <div className="style-empty">
                  <p>此设计版本尚未生成图片</p>
                  {data?.template.source_image_path && (
                    <button
                      className="btn secondary"
                      onClick={() =>
                        setPreview({ path: data.template.source_image_path })
                      }
                    >
                      查看原始参考图
                    </button>
                  )}
                </div>
              )}
              {data&&<div className="style-preview-footer">
                <span>
                  工作版本：V
                  {
                    data.versions.find(
                      (v) => v.id === data.template.work_version_id,
                    )?.number
                  }{" "}
                  · 展示图：
                  {data.template.cover_generation_id
                    ? `#${data.template.cover_generation_id} · ${data.images.find((i) => i.id === data.template.cover_generation_id)?.design_version_id ? "V" + data.versions.find((v) => v.id === data.images.find((i) => i.id === data.template.cover_generation_id)?.design_version_id)?.number : "历史属性未记录"}`
                    : "原始参考图"}
                </span>
                <span>预览不裁切 · 原图按需加载</span>
              </div>}
            </section>
            {!data&&<div className="style-loading" role="status">正在加载款式资料…{errors.load&&<p role="alert">{errors.load}<button className="btn secondary" onClick={()=>load().then(()=>clearError("load")).catch(e=>fail(e,"load"))}>重试</button></p>}</div>}
            {panel && data && version && (
              <aside className="style-panel">
                <nav aria-label="款式详情功能">
                  {[
                    ["derive", "款式衍生"],
                    ["attributes", "款式属性"],
                    ["versions", "版本记录"],
                  ].map(([key, label]) => (
                    <button
                      key={key}
                      className={tab === key ? "active" : ""}
                      aria-current={tab === key ? 'page' : undefined}
                      onClick={() => setTab(key)}
                    >
                      {label}
                    </button>
                  ))}
                </nav>
                <div className="style-panel-body">
                  <label className="style-field">
                    正在查看的设计版本
                    <select
                      aria-label="设计版本"
                      value={versionId || ""}
                      onChange={(e) => selectVersion(e.target.value)}
                    >
                      {data.versions.map((v) => (
                        <option key={v.id} value={v.id}>
                          V{v.number}
                          {v.parent_id
                            ? ` · 基于 V${v.parent_number || data.versions.find((p) => p.id === v.parent_id)?.number || "?"}`
                            : ""}
                          {v.status === "final" ? " · 已定稿" : ""}
                        </option>
                      ))}
                    </select>
                  </label>
                  {(data.totals?.versions||0)>data.versions.length&&<button className="btn secondary small" onClick={()=>{setTab("versions");}}>浏览全部版本（{data.totals.versions}）</button>}
                  {notice && (
                    <p role="status" className="style-notice">
                      {notice}
                    </p>
                  )}
                  {data.template.lifecycle!=="active"&&<p className="style-notice">此款式已归档或在回收站；可查看属性与历史，恢复后才能生成。</p>}
                  {dirty && (
                    <p role="status" className="style-notice">
                      有未保存属性，生成前请保存为新版本或取消修改。
                    </p>
                  )}
                  {tab === "attributes" && (
                    <>
                      {sectionError('attributes')}
                      <div className="style-section-title">
                        <h3>款式属性</h3>
                        {!draft && (
                          <button
                            className="btn secondary small"
                            onClick={beginEdit}
                          >
                            编辑属性
                          </button>
                        )}
                      </div>
                      {version.status === "final" && (
                        <p className="dim">
                          本版已定稿，编辑将创建新的设计版本，原版不变。
                        </p>
                      )}
                      {draft && editParent !== versionId && (
                        <p>
                          正在编辑 V{editVersion?.number}{" "}
                          的草稿，切换查看不会改变草稿来源。
                        </p>
                      )}
                      {["结构版型", "面料与配色", "风格与细节"].map(
                        (group, index) => (
                          <section
                            className="style-attribute-group"
                            key={group}
                          >
                            <h4>{group}</h4>
                            {fields
                              .filter((f) => {
                                const kind = /fabric|color|pattern/.test(f.key)
                                  ? 1
                                  : /style|scene|details/.test(f.key)
                                    ? 2
                                    : 0;
                                return kind === index;
                              })
                              .map((f) => (
                                <label className="style-field" key={f.key}>
                                  <span>
                                    {f.label}
                                    {dna[f.key]?.confirmed ? (
                                      <small> · 已人工确认</small>
                                    ) : dna[f.key]?.value == null ||
                                      dna[f.key]?.value === "" ? (
                                      <small> · 未填写</small>
                                    ) : Number(dna[f.key]?.confidence) <
                                      0.75 ? (
                                      <small> · 待核对</small>
                                    ) : null}
                                  </span>
                                  {draft ? (
                                    <textarea
                                      rows={f.key === "details" ? 3 : 1}
                                      maxLength={2000}
                                      aria-label={`属性${f.label}`}
                                      value={draft[f.key] || ""}
                                      onChange={(e) =>
                                        setDraft((d) => ({
                                          ...d,
                                          [f.key]: e.target.value,
                                        }))
                                      }
                                    />
                                  ) : (
                                    <span className="style-value">
                                      {fmtDnaValue(dna[f.key]?.value)}
                                    </span>
                                  )}
                                </label>
                              ))}
                          </section>
                        ),
                      )}
                      {draft && (
                        <div className="style-notice">
                          <strong>修改摘要</strong>
                          {Object.keys(draft)
                            .filter(
                              (k) =>
                                draft[k] !==
                                fmtDnaValue(
                                  parse(editVersion?.dna_json)[k]?.value,
                                ).replaceAll("、", "、"),
                            )
                            .map((k) => (
                              <p key={k}>
                                {fields.find((f) => f.key === k)?.label || k}：
                                {fmtDnaValue(
                                  parse(editVersion?.dna_json)[k]?.value,
                                )}{" "}
                                → {draft[k] || "未填写"}
                              </p>
                            ))}
                        </div>
                      )}
                      <details>
                        <summary>识别信息</summary>
                        <p>
                          识别置信度是模型估计，人工确认与其分开记录。旧数据未记录来源时无法还原人工确认历史。
                        </p>
                        {fields.map((f) => (
                          <p key={f.key}>
                            {f.label}：
                            {dna[f.key]?.confidence == null
                              ? "未记录"
                              : `${Math.round(dna[f.key].confidence * 100)}%`}
                          </p>
                        ))}
                      </details>
                    </>
                  )}
                  {tab === "derive" && (
                    <>
                      <fieldset className="style-generation-fields" disabled={busy || active || !!pendingStart}>
                      <h3>本次衍生</h3>
                      <div className="style-action-grid" role="group" aria-label="本次衍生动作" onKeyDown={e=>{
                        if (!['ArrowRight','ArrowLeft','ArrowDown','ArrowUp','Home','End'].includes(e.key)) return;
                        const buttons=[...e.currentTarget.querySelectorAll('button')];
                        if (buttons.some(b=>b.disabled)) return;
                        const current=buttons.indexOf(document.activeElement);
                        if (current<0) return;
                        e.preventDefault();
                        const next=e.key==='Home'?0:e.key==='End'?buttons.length-1:(current+(['ArrowRight','ArrowDown'].includes(e.key)?1:-1)+buttons.length)%buttons.length;
                        buttons[next].focus();buttons[next].click();
                      }}>
                        {actions.map(([op, label, desc]) => (
                          <button
                            key={op}
                            className={form.op === op ? "selected" : ""}
                            aria-pressed={form.op === op}
                            disabled={busy||active}
                            onClick={() => changeAction(op)}
                          >
                            <span className="style-action-title"><strong>{label}</strong><span className="style-action-check" aria-hidden="true">{form.op===op?'✓':''}</span></span>
                            <small>{desc}</small>
                          </button>
                        ))}
                      </div>
                      <div data-generation-section="references">
                      <ReferenceImages onResolved={rows=>setResolvedChoices(old=>[...new Map([...old,...rows].map(c=>[c.key,c])).values()])} templateId={templateId} items={form.mode==='image'?[form.source,...form.references.map(r=>r.source)].filter(Boolean):[]} model={selectedModel} availableLimit={Math.max(0,...models.map(m=>imageReferenceLimit(m.capabilities)))} choices={referenceChoices} disabled={busy||active||!!pendingStart} onUploaded={r=>setReferences(old=>mergeRecords(old,[r]))} onChange={setReferenceItems} />
                      {sectionError('references')}
                      </div>
                      {["recolor", "detail_modify"].includes(form.op) && (
                        <div className="style-notice">
                          <h4>先保存设计变化</h4>
                          {form.op === "recolor" ? (
                            <label className="style-field">
                              颜色字段
                              <select
                                value={part}
                                onChange={(e) => setPart(e.target.value)}
                              >
                                {fields
                                  .filter((f) => /color/.test(f.key))
                                  .map((f) => (
                                    <option key={f.key} value={f.key}>
                                      {f.label}
                                    </option>
                                  ))}
                              </select>
                            </label>
                          ) : (
                            <label className="style-field">
                              细节操作
                              <select
                                value={detailAction}
                                onChange={(e) =>
                                  setDetailAction(e.target.value)
                                }
                              >
                                {["替换", "添加", "移除"].map((v) => (
                                  <option key={v}>{v}</option>
                                ))}
                              </select>
                            </label>
                          )}
                          <label className="style-field">
                            {form.op === "recolor"
                              ? "目标颜色（名称或色号）"
                              : "设计细节（写明部位）"}
                            <input
                              value={target}
                              onChange={(e) => setTarget(e.target.value)}
                              placeholder={
                                form.op === "recolor"
                                  ? "例如：衣身酒红色 #722F37"
                                  : "例如：左袖口添加双排扣"
                              }
                            />
                          </label>
                          <button
                            className="btn secondary"
                            onClick={saveActionDesign}
                            disabled={busy || !target.trim()}
                          >
                            保存变化为新版本
                          </button>
                        </div>
                      )}
                      <label className="style-field">
                        本次要求
                        <textarea
                          aria-label="本次要求"
                          rows={3}
                          maxLength={1200}
                          value={form.instruction}
                          onChange={(e) =>
                            update("instruction", e.target.value)
                          }
                          placeholder={form.op==='white'?'例如：均匀打光，服装完整居中，保留颜色与结构':form.op==='scene'?'例如：换成简洁室内背景，保留服装配色和结构':form.op==='detail_shot'?'例如：展示袖口细节，材质和颜色保持一致':form.op==='free_design'?'例如：保留图1版型，改用图2领子与图3花色':'描述本次想调整的内容；已保存属性会自动关联'}
                        />
                      </label>
                      {sectionError('instruction')}
                      <details><summary>高级设置与必须保留</summary>
                      <label className="style-field">
                        必须保留
                        <input
                          value={form.keep}
                          maxLength={1000}
                          onChange={(e) => update("keep", e.target.value)}
                          placeholder="例如：驳头、扣型、面料纹理"
                        />
                      </label>
                      {form.op === "variant" && (
                        <label>
                          <input
                            type="checkbox"
                            checked={form.explore_variation}
                            onChange={(e) =>
                              update("explore_variation", e.target.checked)
                            }
                          />
                          探索呈现变化（保留设计版本）
                        </label>
                      )}
                      </details>
                      {form.op!=='white'&&<>
                      <h3>风格预设</h3>
                      <p className="dim small">{PRESENTATION_STYLES.some(([v])=>v===form.visual_style)?'仅调整画面氛围，保留服装设计':'未指定风格，沿用当前要求'}</p>
                      <div className="style-text-presets">{PRESENTATION_STYLES.slice(0,6).map(([v,label])=><button key={v} aria-pressed={form.visual_style===v} className={form.visual_style===v?'selected':''} onClick={()=>update('visual_style',form.visual_style===v?'auto':v)}>{label}</button>)}</div>
                      <details><summary>更多风格</summary><div className="style-text-presets">{[...PRESENTATION_STYLES.slice(6),['preserve','沿用底图'],['natural','自然实拍'],['product','商品展示'],['editorial','品牌大片']].map(([v,label])=><button key={v} aria-pressed={form.visual_style===v} onClick={()=>update('visual_style',form.visual_style===v?'auto':v)}>{label}</button>)}</div></details>
                      {form.count>1&&<label className="inline-check"><input type="checkbox" checked={form.consistent} onChange={e=>update('consistent',e.target.checked)}/>保持款式一致<small>沿用设计与参考条件；提示词约束不保证跨图一致，不强制同一视角。</small></label>}
                      </>}
                      <details open={form.op==='detail_shot'?true:undefined}><summary>视角与取景 · {form.camera.view} / {form.camera.framing}</summary><CameraSettings value={form.camera} onChange={c=>update('camera',c)}/></details>

                      {sectionError('camera')}
                      <h3>模型与输出</h3>
                      {sectionError('output')}
                      {modelError&&<p role="alert" className="style-error">图片模型加载失败：{modelError}<button className="btn secondary small" onClick={()=>setQuoteNonce(n=>n+1)}>重试加载模型</button></p>}
                      <div className="style-model-output">
                      <label className="style-field">
                        图片模型
                        <select
                          aria-label="款式图片模型"
                          value={form.model_id}
                          onChange={(e) => {
                            const m = models.find(
                              (m) => m.id === e.target.value,
                            );
                            update("model_id", e.target.value);
                            update("quality", "");
                            if (m && sizeAllowed(m.capabilities,form.size))
                              update("size", form.size);
                            else {
                              update("size", m?.sizes?.[0] || "");
                              notify(
                                "新模型不支持原尺寸，已调整尺寸，请重新确认报价",
                              );
                            }
                          }}
                        >
                          <option value="">请选择</option>
                          {models.map((m) => (
                            <option
                              key={m.id}
                              value={m.id}
                              disabled={
                                m.price_per_call === null ||
                                !imageTaskAllowed(m.capabilities,form.mode==='image'?[form.source,...form.references].filter(Boolean).length:0)
                              }
                            >
                              {m.provider_name} · {m.name} ·{" "}
                              {m.variable_pricing?"分档计费，以报价为准":`${m.price_per_call ?? "未配置"} 积分/张`}
                              {m.capabilities?.image_edit ? " · 图片编辑" : ""}
                            </option>
                          ))}
                        </select>
                      </label>
                      <ImageOutputOptions model={selectedModel} size={form.size} quality={form.quality||''} onChange={values=>{setRetryJob(null);setQuote(null);setForm(f=>({...f,...values}));}} />
                      <label className="style-field">
                        生成张数
                        <input
                          type="number"
                          aria-label="款式生成张数"
                          min={1}
                          max={16}
                          step={1}
                          value={form.count}
                          onChange={(e) =>
                            update("count", Number(e.target.value))
                          }
                        />
                      </label>
                      </div>
                      <p className="dim small">
                        不提供未经模型适配器验证的蒙版、参考强度或高清翻倍选项。原图完整保存，不做生成后强裁切。
                      </p>
                      {quote && (
                        <div className="style-notice">
                          <strong>生成确认</strong>
                          <p>
                            {quote.style?.pending_design ? `基于 V${quote.style.version_number}，确认生成时保存新版本` : `设计 V${quote.style?.version_number}`} ·{" "}
                            {actionLabels.find((a) => a[0] === quote.style?.op)?.[1]}{" "}
                            ·{" "}
                            {quote.style?.source_generation_id
                              ? `底图 #${quote.style.source_generation_id}`
                              : quote.style?.source_path
                                ? "原始参考图"
                                : "按属性生成"}
                          </p>
                          <p>
                            {quote.style?.instruction || "沿用已保存设计"} ·{" "}
                            {quote.style?.camera?.view} /{" "}
                            {quote.style?.camera?.framing}
                          </p>
                          <p>
                            {quote.model.name} · {quote.size} · {form.delivery_views?.length?`视角：${form.delivery_views.join(' / ')} · `:''}{" "}
                            {quote.indexes.length} 张 · {quote.total} 积分
                          </p>
                        </div>
                      )}
                      </fieldset>
                    </>
                  )}
                  {tab === "versions" && (
                    <>
                      {sectionError('versions')}
                      <h3>设计版本</h3>
                      {data.template.source_available&&<button className="btn secondary small" onClick={()=>run(async()=>{await api.studio.setCover(templateId,null);await load();onChanged();notify('已使用原始参考图作展示图');})}>使用原始参考图作展示图</button>}
                      {data.versions.filter(v=>(collectionIds.versions||[]).includes(v.id)).sort((a,b)=>b.number-a.number).map((v) => (
                        <div className="style-version-row" key={v.id}>
                          <strong>
                            V{v.number}
                            {v.parent_id
                              ? ` ← V${v.parent_number || data.versions.find((p) => p.id === v.parent_id)?.number || "?"}`
                              : ""}
                          </strong>
                          <span>
                            {v.status === "final" ? "已定稿" : "设计中"} ·{" "}
                            {new Date(v.created_at).toLocaleString()}
                          </span>
                          {v.design_note&&<p className="style-notice">设计说明：{v.design_note} · 结构化属性请在属性面板核对</p>}
                          <p>
                            {Array.isArray(parse(v.summary, null))
                              ? parse(v.summary)
                                  .map(
                                    (c) =>
                                      `${fields.find((f) => f.key === c.key)?.label || c.key}：${fmtDnaValue(c.before)} → ${fmtDnaValue(c.after)}`,
                                  )
                                  .join("；")
                              : v.summary}
                          </p>
                          <button
                            className="btn secondary small"
                            onClick={() => selectVersion(v.id)}
                          >
                            查看版本
                          </button>
                        </div>
                      ))}
                      <CollectionMore name="版本" info={pages.versions} onLoad={p=>fetchPage("versions",p)}/>
                      <button
                        className="btn secondary"
                        onClick={() =>
                          run(async () => {
                            await api.studio.setWorking(templateId, {
                              version_id: versionId,
                              expected_version_id:
                                data.template.work_version_id,
                            });
                            await load();
                            onChanged();
                          })
                        }
                      >
                        设为当前工作版本
                      </button>
                      <button
                        className="btn secondary"
                        onClick={() =>
                          run(async () => {
                            await api.studio.versionStatus(
                              templateId,
                              versionId,
                              version.status === "final" ? "draft" : "final",
                            );
                            await load();
                          })
                        }
                      >
                        {version.status === "final"
                          ? "取消本版定稿"
                          : "定稿此版本"}
                      </button>
                    </>
                  )}
                  {tab==='derive'&&<DesignDelivery templateId={templateId} versionId={versionId} sourceAvailable={data.template.source_available} sourceImage={data.template.source_image_path} sourceThumb={data.template.source_thumb_path} disabled={busy||active||!!pendingStart||!!dirty} onGoSample={onGoSample} onGoPattern={onGoPattern} onPrepare={slots=>{
                    const base=form.mode==='image'&&form.source?form.source:referenceChoices.find(c=>c.available!==false)?.key;
                    if(!base){fail(new Error('请先选择当前款式基准图'),'references');return;}
                    setForm(f=>({...f,op:'create',instruction_scope:'presentation',mode:'image',source:base,delivery_views:slots,count:slots.length,purpose:'free',visual_style:'product',camera:{...f.camera,display:f.camera.display==='flat'?'mannequin':f.camera.display,angle:'level',framing:slots.includes('detail')?'detail':'garment',detail:slots.includes('detail')?f.camera.detail||'':''}}));setRetryJob(null);setQuote(null);notify('已准备按位置生成，请核对模型与费用后确认');
                  }}/>}
                  <section className="style-results">
                    <div className="style-section-title">
                      <h3>生成结果与历史</h3>
                      <button className="btn secondary small" disabled={busy||active||!!pendingStart} onClick={()=>{changeAction("variant");setTab("derive");setNotice("已选择再生成，沿用当前设计，请核对设置与报价");}}>再生成</button>
                      <button
                        className="btn secondary small"
                        onClick={() => setShowHistory((h) => !h)}
                      >
                        {showHistory ? "收起" : "展开"}
                      </button>
                    </div>
                    {sectionError('history')}
                    {showHistory && (
                      <>
                        <StateTabs value={imageState} onChange={setImageState}/>
                        {data.jobs.filter(j=>(collectionIds.jobs||[]).includes(j.id)||["running","queued"].includes(j.status)).map((j) => (
                          <details
                            className="style-job"
                            key={j.id}
                            open={j.status === "running"}
                          >
                            <summary>
                              {states[j.status] || j.status} · V
                              {j.snapshot.style?.version_number} · {j.completed}
                              /{j.total} · 已结算 {j.cost_actual} 积分
                            </summary>
                            <p>
                              {j.created_at} · {j.snapshot.model.name}
                            </p>
                            {j.renders.map((r) => (
                              <p key={r.proposal_idx}>
                                {r.proposal_idx + 1}：{states[r.status]}{" "}
                                {r.error}
                              </p>
                            ))}
                            {j.renders.some((r) => r.status === "failed") && (
                              <button
                                className="btn secondary small"
                                disabled={busy || active}
                                onClick={() => {
                                  setRetryJob(j.id);
                                  setTab("derive");
                                  notify(
                                    "已恢复原任务快照，确认新报价后重试明确失败项",
                                  );
                                }}
                              >
                                按原设置重试失败项
                              </button>
                            )}
                          </details>
                        ))}
                        <div className="style-result-grid">
                          {visibleImages.map((i) => (
                            <article key={i.id}>
                              <button
                                className="style-image-button"
                                onClick={() =>
                                  i.image_available!==false&&setPreview({ ...i, path: i.image_path })
                                }
                              >
                                <StudioImage
                                  thumbnail={i.thumb_available===false?null:i.thumb_path} original={i.image_available===false?null:i.image_path}
                                  alt={`图片 ${i.id}`}
                                  loading="lazy"
                                />
                              </button>
                              <p>
                                #{i.id} ·{" "}
                                {i.design_version_id
                                  ? `V${data.versions.find((v) => v.id === i.design_version_id)?.number}`
                                  : "历史属性未记录"}
                                {data.template.cover_generation_id === i.id
                                  ? " · 展示图"
                                  : ""}
                                {i.archived ? " · 已归档" : ""}
                              </p>
                              {i.image_available!==false&&<OriginalImageLink path={i.image_path} />}
                              {i.image_available===false&&<p role="status">{i.thumb_available?"仅缩略图可用 · 原图缺失":"图片文件缺失"}</p>}
                              <button
                                className="btn secondary small"
                                onClick={() => {
                                  i.image_available!==false&&setPreview({ ...i, path: i.image_path });
                                  setCompare(true);
                                }}
                              >
                                与本次底图比较
                              </button>
                              <button
                                className="btn secondary small"
                                disabled={!!pendingStart||i.image_available===false||i.lifecycle==='trash'} onClick={() => chooseSource(i)}
                              >
                                以此继续衍生
                              </button>
                              <details>
                                <summary>更多操作</summary>
                                <button
                                  onClick={() =>
                                    run(async () => {
                                      await api.studio.setCover(
                                        templateId,
                                        i.id,
                                      );
                                      await load();
                                      onChanged();
                                    }, 'history')
                                  }
                                >
                                  设为展示图
                                </button>
                                <button
                                  onClick={() =>
                                    run(async () => {
                                      await api.studio.archiveImage(
                                        i.id,
                                        !i.archived,
                                      );
                                      await load();
                                    }, 'history')
                                  }
                                >
                                  {i.archived ? "恢复归档" : "归档（保留原图）"}
                                </button>
                                <button
                                  onClick={() =>
                                    run(async () => {
                                      await api.studio.forkStyle(templateId, {
                                        version_id:
                                          i.design_version_id || versionId,
                                        generation_id: i.id,
                                      });
                                      onChanged();
                                      notify("已另存为新款式");
                                    }, 'history')
                                  }
                                >
                                  另存新款式
                                </button>
                                {i.lifecycle==='trash'?<><button onClick={()=>lifecycleActions.perform('generations',i,'restore')}>还原图片</button><button onClick={()=>lifecycleActions.perform('generations',i,'delete')}>永久删除</button></>:<button onClick={()=>lifecycleActions.perform('generations',i,'trash')}>删除（移入回收站）</button>}
                                <details>
                                  <summary>生成参数</summary>
                                  <pre>
                                    {JSON.stringify(
                                      parse(i.settings_json),
                                      null,
                                      2,
                                    )}
                                  </pre>
                                </details>
                              </details>
                            </article>
                          ))}
                        </div>
                        <CollectionMore name="图片" info={pages.images} onLoad={p=>fetchPage("images",p)}/>
                        <CollectionMore name="任务" info={pages.jobs} onLoad={p=>fetchPage("jobs",p)}/>
                        {!visibleImages.length && !pages.images?.loading && !pages.images?.error && <p>此版本暂无生成结果。</p>}
                      </>
                    )}
                  </section>
                </div>
              </aside>
            )}
          </div>
          {data&&<footer className="style-workspace-footer">
            {!closing && !draft && data.jobs.length > 0 && panel && (
              <button
                className="btn secondary"
                onClick={() => {
                  const latest = data.jobs[0];
                  selectVersion(latest.snapshot.style.version_id);
                  setShowHistory(true);
                  setTab("derive");
                  setPanel("derive");
                  requestAnimationFrame(() =>
                    dialog.current
                      .querySelector(".style-results")
                      ?.scrollIntoView({ block: "start" }),
                  );
                }}
              >
                查看最新任务结果
              </button>
            )}
            {closing ? (
              <>
                <span>有未保存的修改，草稿仍会保留在此浏览器标签页。</span>
                <button
                  className="btn secondary"
                  onClick={() => setClosing(false)}
                >
                  继续编辑
                </button>
                <button className="btn secondary" onClick={onClose}>
                  保留草稿并关闭
                </button>
                <button
                  className="btn secondary"
                  onClick={() => {
                    try {
                      sessionStorage.removeItem(draftKey);
                    } catch {}
                    onClose();
                  }}
                >
                  放弃草稿并关闭
                </button>
              </>
            ) : draft && tab === 'attributes' ? (
              <>
                <span>基于 V{editVersion?.number} 的属性草稿</span>
                <button
                  className="btn secondary"
                  onClick={() => {
                    setDraft(null);
                    setEditParent(null);
                  }}
                >
                  取消修改
                </button>
                <button
                  className="btn primary"
                  disabled={busy || !dirty}
                  onClick={save}
                >
                  保存为新版本
                </button>
              </>
            ) : tab === "derive" && panel ? (
              <>
                {sectionError('quote')}
                <span role="status">
                  {pendingStart ? '提交结果尚未确认，请核对原请求；不会重复扣费' : active
                    ? `生成中 ${data.jobs.find((j) => j.status === "running")?.completed || 0}/${data.jobs.find((j) => j.status === "running")?.total || 0}，可安全关闭`
                    : quoteBusy
                      ? "正在更新报价…"
                      : quote
                        ? `${quote.indexes.length} 张 · 预计 ${quote.total} 积分`
                        : readiness?.message || "请完成生成设置"}
                </span>
                {!quote && !quoteBusy && !readiness && !pendingStart && (
                  <button
                    className="btn secondary"
                    onClick={() => setQuoteNonce((n) => n + 1)}
                  >
                    重新报价
                  </button>
                )}
                <button
                  className="btn primary"
                  disabled={
                    busy || (!pendingStart && (active || quoteBusy || !quote || !!readiness))
                  }
                  onClick={start}
                >
                  {pendingStart ? '核对提交结果' : '确认费用并生成'}
                </button>
              </>
            ) : (
              <span>
                查看历史不会修改当前款式 · 新结果默认保留，不自动设为封面
              </span>
            )}
          </footer>}
        </>
      {lifecycleActions.modal}
      {large && (
        <OriginalImageViewer image={large} onClose={() => setLarge(null)} />
      )}
    </dialog>
  );
}
