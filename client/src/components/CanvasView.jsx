import { fitCanvas } from './canvasPlacement.js';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Tldraw, AssetRecordType, createShapeId, useEditor, useValue } from 'tldraw';
import { getAssetUrlsByImport } from '@tldraw/assets/imports.vite';
import 'tldraw/tldraw.css';
import './canvas.css';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import Icon from './icons.jsx';
import CanvasGeneration from './CanvasGeneration.jsx';
import { canvasShapeUtils } from './CanvasPending.jsx';
import { CanvasPersistence } from './canvasPersistence.js';

function CanvasMark() { return <svg width="34" height="34" viewBox="0 0 40 40" aria-hidden="true"><path d="M30 6h4v7M15 6h10c6 0 10 5 10 11v9c0 6-4 10-10 10H15C9 36 5 32 5 26v-9C5 11 9 6 15 6Z" fill="none" stroke="currentColor" strokeWidth="2"/><circle cx="16" cy="17" r="1.8" fill="currentColor"/><circle cx="26" cy="17" r="1.8" fill="currentColor"/></svg>; }
const assetUrls = getAssetUrlsByImport();
const tools = [['select','选择','↖'],['hand','拖动','✋'],['draw','铅笔','✎'],['text','文字','T'],['geo','形状','□'],['arrow','箭头','↗'],['eraser','橡皮','◇']];
const states = { loading:'加载中…', saved:'已保存', unsaved:'有未保存修改', saving:'正在保存…', conflict:'版本冲突 · 本地修改已保留', error:'保存失败 · 可重试' };
const hidden = shape => shape.meta.hidden ? 'hidden' : 'inherit';
function readFile(file) {
  if (file.size > 20*1024*1024 || !/^image\/(png|jpeg|webp|gif|avif|tiff)$/.test(file.type)) return Promise.reject(new Error('请上传不超过20MB的 PNG、JPEG、WebP 等位图'));
  return new Promise((resolve,reject)=>{ const reader=new FileReader(); reader.onerror=()=>reject(new Error('读取图片失败')); reader.onload=()=>resolve(String(reader.result).split(',')[1]); reader.readAsDataURL(file); });
}
function download(data, name) {
  const url=URL.createObjectURL(data), a=document.createElement('a'); a.href=url; a.download=name; a.click(); setTimeout(()=>URL.revokeObjectURL(url),1000);
}
function addImage(editor, asset) {
  const id=AssetRecordType.createId(asset.id);
  if (!editor.getAsset(id)) editor.createAssets([{id,type:'image',typeName:'asset',props:{name:asset.name,src:asset.src,w:asset.width,h:asset.height,mimeType:'image/'+(asset.image_path.endsWith('.jpg')?'jpeg':asset.image_path.split('.').pop()),isAnimated:false},meta:{canvasAssetId:asset.id,assetVersion:asset.fingerprint}}]);
  const shapes=editor.getCurrentPageShapes(), last=shapes.at(-1), box=last&&editor.getShapePageBounds(last), center=editor.getViewportPageBounds().center;
  const width=Math.min(320,asset.width), height=width*asset.height/asset.width, shapeId=createShapeId();
  editor.markHistoryStoppingPoint('add-canvas-image');
  editor.createShape({id:shapeId,type:'image',x:box?box.x:center.x-width/2,y:box?box.maxY+32:center.y-height/2,props:{assetId:id,w:width,h:height},meta:{title:asset.name,originType:asset.origin}});
  editor.select(shapeId); fitCanvas(editor);
}
function BoardControls({ onUpload, onLibrary, onReferences, onError }) {
  const editor=useEditor();
  const data=useValue('board controls',()=>({shapes:editor.getCurrentPageShapesSorted(),selected:editor.getSelectedShapeIds(),tool:editor.getCurrentToolId(),viewport:editor.getViewportPageBounds()}),[editor]);
  const [layers,setLayers]=useState(true),[savedModels,setSavedModels]=useState([]);
  const images=data.shapes.filter(s=>s.type==='image');
  const selectedImageIds=[...new Set(data.selected.flatMap(id=>editor.getShape(id)?.type==='group'?[...editor.getShapeAndDescendantIds([id])]:[id]))];
  const signature=JSON.stringify(selectedImageIds.map(id=>{const s=editor.getShape(id);return [id,s?.props.crop,s?.props.flipX,s?.props.flipY,editor.isShapeHidden(id)];}));
  useEffect(()=>{
    const references=selectedImageIds.map(id=>editor.getShape(id)).filter(s=>s?.type==='image'&&!editor.isShapeHidden(s)).map(s=>{
      const asset=editor.getAsset(s.props.assetId);
      return asset?.meta.canvasAssetId?{shapeId:s.id,crop:s.props.crop,flipX:s.props.flipX,flipY:s.props.flipY,assetId:asset.meta.canvasAssetId,assetVersion:asset.meta.assetVersion,src:asset.props.src,name:s.meta.title||asset.props.name}:null;
    }).filter(Boolean);
    if (references.length) onReferences(references);
  },[signature,editor,onReferences]);
  const boxes=data.shapes.map(s=>editor.getShapePageBounds(s)).filter(Boolean);
  const minX=Math.min(data.viewport.x,...boxes.map(b=>b.x)),minY=Math.min(data.viewport.y,...boxes.map(b=>b.y));
  const maxX=Math.max(data.viewport.maxX,...boxes.map(b=>b.maxX)),maxY=Math.max(data.viewport.maxY,...boxes.map(b=>b.maxY));
  const selected=data.selected;
  const exportImage=async()=>{try{const result=await editor.toImage(selected.length?selected:data.shapes.map(s=>s.id),{format:'png',background:true});download(result.blob,'画板.png');}catch(e){onError(e.message);}};
  return <>
    {images.filter(s=>selected.includes(s.id)&&!s.meta.hidden).map(s=>{const b=editor.getShapePageBounds(s),asset=editor.getAsset(s.props.assetId);if(!b||!asset)return null;const p=editor.pageToViewport({x:b.x,y:b.maxY});return <div className="canvas-image-label" key={s.id} style={{left:p.x,top:p.y+5,width:b.w*editor.getZoomLevel()}}><span>{s.meta.originType==='generated'?'生成图片':'Uploaded'}</span><span>{asset.props.w} × {asset.props.h}</span></div>;})}
    {layers&&<aside className="canvas-layers" aria-label="画布图层"><div className="canvas-layer-heading"><strong>图层</strong><button className="icon-btn" title="收起图层" onClick={()=>setLayers(false)}>‹</button></div>{[...data.shapes].reverse().map(shape=><div className={`canvas-layer${selected.includes(shape.id)?' selected':''}`} key={shape.id}>
      <button className="canvas-layer-name" onClick={e=>editor.setSelectedShapes(e.shiftKey?[...new Set([...selected,shape.id])]:[shape.id])}>{shape.meta.title||shape.type}</button>
      <button title={shape.meta.hidden?'显示图层':'隐藏图层'} onClick={()=>editor.updateShape({id:shape.id,type:shape.type,meta:{...shape.meta,hidden:!shape.meta.hidden}})}>{shape.meta.hidden?'◌':'◉'}</button>
      <button title={shape.isLocked?'解锁图层':'锁定图层'} onClick={()=>editor.toggleLock([shape.id])}>{shape.isLocked?'▣':'▢'}</button>
    </div>)}</aside>}
    {!!selected.length&&<div className="canvas-selection" aria-label="选中对象工具"><span>已选 {selected.length} 个</span>{selected.length===1&&editor.getShape(selected[0])?.type==='image'&&<button className="btn secondary small" onClick={()=>{editor.setCurrentTool('select');editor.setCroppingShape(selected[0]);editor.setCurrentTool('select.crop');}}>裁剪</button>}<button className="btn secondary small" onClick={()=>editor.duplicateShapes(selected,{x:30,y:30})}>复制</button><button className="btn secondary small" onClick={()=>editor.bringToFront(selected)}>置顶</button><button className="btn secondary small" onClick={()=>editor.sendToBack(selected)}>置底</button>{selected.length===1&&editor.getShape(selected[0])?.type==='image'&&<button className="btn secondary small" disabled={savedModels.includes(selected[0])} onClick={async()=>{try{const shape=editor.getShape(selected[0]),asset=editor.getAsset(shape.props.assetId);await api.canvas.saveCanvasModel(asset.meta.canvasAssetId);setSavedModels(ids=>[...ids,shape.id]);}catch(e){onError(e.message);}}}>{savedModels.includes(selected[0])?'已存为模特':'存为模特'}</button>}<button className="btn secondary small" onClick={exportImage}>下载</button><button className="btn secondary small" onClick={()=>editor.deleteShapes(selected)}>删除</button></div>}
    <svg className="canvas-mini" aria-label="画布缩略导航" viewBox={`${minX-20} ${minY-20} ${maxX-minX+40} ${maxY-minY+40}`} onClick={e=>{const p=e.currentTarget.createSVGPoint();p.x=e.clientX;p.y=e.clientY;const point=p.matrixTransform(e.currentTarget.getScreenCTM().inverse());editor.centerOnPoint(point,{animation:{duration:150}});}}>
      {images.flatMap(s=>(s.meta.sourceShapeIds||[]).map(id=>{const from=editor.getShapePageBounds(id),to=editor.getShapePageBounds(s);return from&&to?<line key={`${id}:${s.id}`} x1={from.maxX} y1={from.center.y} x2={to.x} y2={to.center.y}/>:null;}))}
      {images.filter(s=>!s.meta.hidden).map(s=>{const box=editor.getShapePageBounds(s),asset=editor.getAsset(s.props.assetId);return box&&asset?<image key={s.id} href={asset.props.src} x={box.x} y={box.y} width={box.w} height={box.h}/>:null;})}
      <rect x={data.viewport.x} y={data.viewport.y} width={data.viewport.w} height={data.viewport.h}/>
    </svg>
    <nav className="canvas-toolbar" aria-label="画布工具栏">{tools.map(([id,label,symbol])=><button key={id} aria-pressed={data.tool===id} onClick={()=>editor.setCurrentTool(id)}><span>{symbol}</span>{label}</button>)}<button onClick={onUpload}><Icon name="plus" size={18}/>上传</button><button onClick={onLibrary}><Icon name="book" size={18}/>图库</button><button aria-pressed={layers} onClick={()=>setLayers(v=>!v)}>▱<span>图层</span></button><button title="撤销" onClick={()=>editor.undo()}>↶<span>撤销</span></button><button title="重做" onClick={()=>editor.redo()}>↷<span>重做</span></button><button onClick={()=>fitCanvas(editor)}>⛶<span>适应</span></button></nav>
  </>;
}
function Library({ onChoose, onClose, onError }) {
  const [tab,setTab]=useState('model'),[items,setItems]=useState([]),[search,setSearch]=useState(''),[busy,setBusy]=useState(false);
  useEffect(()=>{let cancelled=false;setBusy(true);setItems([]);(async()=>{
    if(tab==='style'){
      const result=await api.studio.listTemplates();
      const rows=await Promise.all((result.templates||[]).filter(t=>!search||t.name.includes(search)).slice(0,40).map(async t=>{const w=await api.studio.workspace(t.id,{view:'summary'});const r=w.primary_reference;return r?.image_path?{id:t.id,name:`${t.name} · ${r.origin==='original'?'原图参考（当前版本暂无成图）':'当前版本'}`,image_path:r.image_path,thumb_path:r.thumb_path,available:true}:null;}));
      return rows.filter(Boolean);
    }
    if(tab==='canvas'){const r=await api.canvas.assets(search);return r.assets;}
    if(tab==='asset'){const r=await api.studio.assets({limit:100});return (r.assets||[]).filter(x=>x.image_available&&(!search||(x.name||String(x.id)).includes(search))).map(x=>({...x,name:x.name||`商品图 #${x.id}`}));}
    const r=await api.studio.references({kind:tab,search,limit:100});return (r.references||[]).filter(x=>x.image_available);
  })().then(rows=>{if(!cancelled)setItems(rows);}).catch(e=>{if(!cancelled)onError(e.message);}).finally(()=>{if(!cancelled)setBusy(false);});return()=>{cancelled=true;};},[tab,search,onError]);
  return <section className="canvas-library" aria-label="选择画板图片"><div className="canvas-library-head"><h3>添加到画板</h3><button className="btn secondary small" onClick={onClose}>关闭图库</button></div><div className="canvas-library-head">{[['model','我的模特'],['reference','已上传'],['canvas','画板图片'],['style','款式当前版本'],['asset','商品图']].map(([id,label])=><button className="btn secondary small" aria-pressed={tab===id} key={id} onClick={()=>setTab(id)}>{label}</button>)}<input aria-label="搜索图库" placeholder="搜索名称" value={search} onChange={e=>setSearch(e.target.value)}/></div>{busy?<p role="status">加载中…</p>:<div className="canvas-library-grid">{items.map(item=><button key={item.id} onClick={()=>onChoose(item)}><img src={`/${item.thumb_available===false?item.image_path:item.thumb_path||item.image_path}`} alt={item.name||'参考图'} onError={e=>{if(e.currentTarget.src!==new URL(`/${item.image_path}`,location.origin).href)e.currentTarget.src=`/${item.image_path}`;}}/><span>{item.name||`图片 #${item.id}`}</span></button>)}{!items.length&&<p>暂无可用图片，可先上传图片。</p>}</div>}</section>;
}
function Board({ project:initial, initialAssets, onSaved, onOpenSidebar, onSwitch, onCreated, projects, userKey, theme }) {
  const [editor,setEditor]=useState(null),[name,setName]=useState(initial.title),[status,setStatus]=useState('saved'),[error,setError]=useState(''),[library,setLibrary]=useState(false),[references,setReferences]=useState([]),[message,setMessage]=useState(''),[uploading,setUploading]=useState(false),[recovery,setRecovery]=useState(null),[controlsTarget,setControlsTarget]=useState(null),[hasRuns,setHasRuns]=useState(false),[shareLink,setShareLink]=useState('');
  const editorRef=useRef(null),nameRef=useRef(name),persistence=useRef(null),fileInput=useRef(null),mounted=useRef(true);
  nameRef.current=name;
  const draftKey=`fashion-canvas-draft:${userKey}:${initial.id}`;
  const errorHandler=useCallback(message=>setError(message),[]);
  const onReferences=useCallback(refs=>setReferences(previous=>refs.map(r=>({...r,role:previous.find(x=>x.shapeId===r.shapeId)?.role||'reference'}))),[]);
  const assets=useMemo(()=>({upload:async(_asset,file)=>{const {asset}=await api.canvas.asset(initial.id,{imageBase64:await readFile(file),name:file.name});return {src:asset.src,meta:{canvasAssetId:asset.id,assetVersion:asset.fingerprint}};}}),[initial.id]);
  const controls=useMemo(()=>({InFrontOfTheCanvas:()=> <BoardControls onUpload={()=>fileInput.current?.click()} onLibrary={()=>setLibrary(true)} onReferences={onReferences} onError={errorHandler}/>}),[onReferences,errorHandler]);
  const snapshot=()=>({version:1,engine:'tldraw',engineVersion:'3.15.6',document:editorRef.current.getSnapshot().document});
  const onMount=useCallback(ed=>{
    editorRef.current=ed;
    try {if(initial.snapshot)ed.loadSnapshot({document:initial.snapshot.document});}
    catch(e){setError('画板格式无法加载，请先导出原始快照以便恢复');return;}
    ed.registerExternalAssetHandler('url',null);
    ed.registerExternalContentHandler('url',null);
    // External embeds never bypass the owned asset upload path.
    ed.registerExternalContentHandler('embed',null);
    ed.user.updateUserPreferences({locale:'zh-cn',colorScheme:theme==='black'?'dark':'light'});
    if(ed.getCurrentPageShapes().length)requestAnimationFrame(()=>{if(!ed.isDisposed)fitCanvas(ed);});
    setEditor(ed);
    try {const stored=JSON.parse(localStorage.getItem(draftKey)||'null');if(stored?.data)setRecovery(stored);}catch{}
    const save=new CanvasPersistence({revision:initial.revision,read:()=>({title:nameRef.current,snapshot:snapshot()}),write:body=>api.canvas.save(initial.id,body),
      backup:data=>localStorage.setItem(draftKey,JSON.stringify({baseRevision:save.revision,data})),
      onState:(state,e)=>{if(!mounted.current)return;setStatus(state);if(e)setError(e.message);if(state==='saved'){localStorage.removeItem(draftKey);onSaved(initial.id,nameRef.current);}}
    });
    persistence.current=save;
    const off=ed.store.listen(()=>save.changed(),{scope:'document'});
    return ()=>{off();save.dispose();};
  },[initial.id]);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  useEffect(()=>{if(editor)editor.user.updateUserPreferences({locale:'zh-cn',colorScheme:theme==='black'?'dark':'light'});},[theme,editor]);
  useEffect(()=>{
    const unload=e=>{if(persistence.current&&persistence.current.saved!==persistence.current.sequence){e.preventDefault();e.returnValue='';}};
    const visibility=()=>{if(document.visibilityState==='hidden')persistence.current?.flush().catch(()=>{});};
    window.addEventListener('beforeunload',unload);document.addEventListener('visibilitychange',visibility);
    return()=>{window.removeEventListener('beforeunload',unload);document.removeEventListener('visibilitychange',visibility);};
  },[]);
  const save=async(options={})=>{try{if(options.force===true)persistence.current?.changed();await persistence.current?.flush();return true;}catch(e){setError(e.message);return false;}};
  const choose=async item=>{if(!editor)return;setUploading(true);try{const {asset}=await api.canvas.asset(initial.id,{path:item.image_path,name:item.name});addImage(editor,asset);setLibrary(false);}catch(e){setError(e.message);}finally{setUploading(false);}};
  const upload=async files=>{if(!editor)return;setUploading(true);try{for(const file of files){const {asset}=await api.canvas.asset(initial.id,{imageBase64:await readFile(file),name:file.name});addImage(editor,asset);}}catch(e){setError(e.message);}finally{setUploading(false);}};
  const saveAs=async()=>{
    if(!editor)return;setUploading(true);
    try{
      const data={title:`${nameRef.current.slice(0,90)}（副本）`,snapshot:snapshot()};
      const {project}=await api.canvas.create(data.title);
      const linked=initialAssets.map(a=>a.id),documentAssets=Object.values(data.snapshot.document.store).filter(r=>r.typeName==='asset').map(a=>a.meta.canvasAssetId);
      for(const assetId of new Set([...linked,...documentAssets].filter(Boolean)))await api.canvas.asset(project.id,{assetId});
      await api.canvas.save(project.id,{...data,expectedRevision:0});
      localStorage.removeItem(draftKey);onCreated(project.id);
    }catch(e){setError(e.message);}finally{setUploading(false);}
  };
  return <div className="canvas-workspace">
    <header className="canvas-topbar"><button className="menu-btn icon-btn" title="打开侧边栏" onClick={onOpenSidebar}><Icon name="menu" size={20}/></button><h2>万能画板</h2><input aria-label="画板名称" value={name} maxLength={100} onChange={e=>{setName(e.target.value);nameRef.current=e.target.value;persistence.current?.changed();}}/><select aria-label="切换画板" value={initial.id} onChange={async e=>{const id=e.target.value;if(await save())onSwitch(id);}}>{projects.map(p=><option key={p.id} value={p.id}>{p.title}</option>)}</select><button className="btn secondary small" disabled={uploading} onClick={async()=>{if(await save())onCreated();}}>新建画板</button><button className="btn secondary small" onClick={save}>保存</button><span className="canvas-status" role="status">{uploading?'正在添加图片…':states[status]}</span></header>
    {error&&<div className="canvas-error" role="alert">{error}<button className="btn secondary small" onClick={()=>setError('')}>关闭提示</button>{status==='conflict'&&<><button className="btn secondary small" onClick={saveAs}>另存为新画板</button><button className="btn secondary small" onClick={()=>{if(window.confirm('加载远端版本将替换当前画布。本地修改仍可从浏览器草稿恢复。'))onSwitch(initial.id,true);}}>加载远端版本</button></>}<button className="btn secondary small" onClick={()=>download(new Blob([JSON.stringify(editor?snapshot():initial.snapshot)],{type:'application/json'}),'画板备份.json')}>导出快照</button></div>}
    {recovery&&<div className="canvas-error">发现此浏览器未保存的草稿。<button className="btn secondary small" onClick={()=>{try{editor.loadSnapshot({document:recovery.data.snapshot.document});setName(recovery.data.title);nameRef.current=recovery.data.title;if(recovery.baseRevision!==initial.revision){persistence.current.blocked=true;setStatus('conflict');setError('草稿基于旧版本，请另存为新画板，避免覆盖远端修改');}else persistence.current.changed();setRecovery(null);}catch(e){setError(e.message);}}}>恢复草稿</button><button className="btn secondary small" onClick={()=>{localStorage.removeItem(draftKey);setRecovery(null);}}>忽略草稿</button></div>}
    {shareLink&&<section className="canvas-share" aria-label="画板分享"><p>只读链接有效期7天，持有链接的人可查看画布和其中图片。</p><input aria-label="只读分享链接" readOnly value={shareLink}/><button className="btn secondary small" onClick={async()=>{try{await navigator.clipboard.writeText(shareLink);}catch{setError('复制失败，请从输入框手动复制链接');}}}>复制链接</button><button className="btn secondary small" onClick={async()=>{try{await api.canvas.revokeShare(initial.id);setShareLink('');}catch(e){setError(e.message);}}}>撤销分享</button><button className="btn secondary small" onClick={()=>setShareLink('')}>收起</button></section>}
    <div className="canvas-body"><div className="canvas-editor" data-testid="canvas-editor"><Tldraw hideUi shapeUtils={canvasShapeUtils} assets={assets} assetUrls={assetUrls} components={controls} onMount={onMount} getShapeVisibility={hidden} licenseKey={import.meta.env.VITE_TLDRAW_LICENSE_KEY}/>{library&&<Library onChoose={choose} onClose={()=>setLibrary(false)} onError={errorHandler}/>}<input type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/avif" multiple ref={fileInput} hidden aria-label="上传画板图片" onChange={e=>{upload([...e.target.files]);e.target.value='';}}/></div>
      <aside className="canvas-agent" aria-label="画板助手"><header className="canvas-agent-head"><span className="canvas-mascot" style={{fontSize:24,margin:0}}><CanvasMark/></span><strong>Fashion 画板</strong><button className="btn secondary small" onClick={async()=>{try{if(!await save())return;const r=await api.canvas.share(initial.id);setShareLink(`${location.origin}${location.pathname}?canvasShare=${r.token}`);}catch(e){setError(e.message);}}}>分享只读链接</button><span className="dim small">设计助手</span></header><div className="canvas-agent-content">{!hasRuns&&<div className="canvas-empty"><div className="canvas-mascot"><CanvasMark/></div><h3>想做什么，直接开始。</h3><p className="dim">先添加图片，在画布上整理你的设计。</p><div className="canvas-categories">{['电商设计','社交媒体设计','广告营销设计','品牌套件设计','室内设计'].map(x=><span key={x}>{x}</span>)}</div><div className="canvas-examples"><p>将模特图与服装图放到同一画板</p><p>从“我的模特”直接选用已上传图片</p><p>选中图片，整理图层和设计说明</p></div></div>}<CanvasGeneration projectId={initial.id} editor={editor} references={references} setReferences={setReferences} message={message} setMessage={setMessage} save={save} onError={errorHandler} blocked={status==='conflict'} controlsTarget={controlsTarget} onHasRuns={setHasRuns}/></div><section className="canvas-composer"><div className="canvas-ref-chips">{references.map((r,i)=><span className="canvas-ref-chip" key={r.shapeId}><img src={r.src} alt=""/>图{i+1}<button title={`移除图${i+1}引用`} onClick={()=>setReferences(old=>old.filter(x=>x.shapeId!==r.shapeId))}>×</button></span>)}</div><textarea aria-label="画板需求" placeholder="选中画布图片，记录想要的修改…" value={message} onChange={e=>setMessage(e.target.value)}/><div ref={setControlsTarget}/><p className="canvas-agent-note">引用按编号一起发送；选中图片后可指定模特和服装角色。</p><button className="btn secondary small" onClick={()=>setLibrary(true)}>从图库添加</button></section></aside>
    </div>
  </div>;
}
export default function CanvasView({ onOpenSidebar, theme }) {
  const {user}=useAuth();const userKey=user?.id||'local';
  const [projects,setProjects]=useState([]),[loaded,setLoaded]=useState(null),[error,setError]=useState(''),[epoch,setEpoch]=useState(0);
  const requestId=useRef(0);
  const load=useCallback(async(id)=>{const sequence=++requestId.current;try{setError('');setLoaded(null);const data=await api.canvas.load(id);if(sequence!==requestId.current)return;setLoaded(data);localStorage.setItem(`fashion-canvas-last:${userKey}`,id);setEpoch(n=>n+1);}catch(e){if(sequence===requestId.current)setError(e.message);}},[userKey]);
  const refresh=async()=>{const r=await api.canvas.list();setProjects(r.projects);return r.projects;};
  useEffect(()=>{let active=true;(async()=>{const r=await api.canvas.list();if(!active)return;let rows=r.projects;if(!rows.length){const {project}=await api.canvas.create('未命名画板');rows=[project];}if(!active)return;setProjects(rows);const last=localStorage.getItem(`fashion-canvas-last:${userKey}`);await load(rows.find(p=>p.id===last)?.id||rows[0].id);})().catch(e=>{if(active)setError(e.message);});return()=>{active=false;requestId.current++;};},[load,userKey]);
  const created=async id=>{try{if(!id){const {project}=await api.canvas.create('未命名画板');id=project.id;}await refresh();await load(id);}catch(e){setError(e.message);}};
  if(!loaded)return <div className="studio-view"><button className="btn secondary" onClick={onOpenSidebar}>打开侧边栏</button>{error?<p role="alert">{error}<button className="btn secondary" onClick={()=>location.reload()}>重新加载</button></p>:<p role="status">正在打开画板…</p>}</div>;
  return <Board key={`${loaded.project.id}:${epoch}`} project={loaded.project} initialAssets={loaded.assets} projects={projects} userKey={userKey} theme={theme} onOpenSidebar={onOpenSidebar} onSwitch={load} onCreated={created} onSaved={(id,title)=>setProjects(rows=>rows.map(p=>p.id===id?{...p,title}:p))}/>;
}

export function SharedCanvasView({token}) {
  const [data,setData]=useState(null),[error,setError]=useState('');
  useEffect(()=>{let live=true;api.canvas.shared(token).then(r=>{if(live)setData(r);}).catch(e=>{if(live)setError(e.message);});return()=>{live=false;};},[token]);
  if(error)return <main className="studio-view"><h2>分享画板不可用</h2><p role="alert">{error}</p></main>;
  if(!data)return <p role="status">正在打开分享画板…</p>;
  return <main className="canvas-shared"><header className="canvas-topbar"><h2>{data.title}</h2><span>只读画板</span></header><div className="canvas-editor"><Tldraw hideUi shapeUtils={canvasShapeUtils} assetUrls={assetUrls} getShapeVisibility={hidden} licenseKey={import.meta.env.VITE_TLDRAW_LICENSE_KEY} onMount={editor=>{if(data.snapshot)editor.loadSnapshot({document:data.snapshot.document});editor.updateInstanceState({isReadonly:true});editor.setCurrentTool('hand');editor.zoomToFit();}}/></div></main>;
}
