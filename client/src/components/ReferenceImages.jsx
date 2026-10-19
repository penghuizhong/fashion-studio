import { imageReferenceLimit, imageTaskAllowed } from '../../../shared/imageOptions.js';
import { useEffect, useRef, useState } from 'react';
import StudioImage from './StudioImage.jsx';
import { api } from '../api.js';
export default function ReferenceImages({items,onChange,choices,model,availableLimit=0,onUploaded,onResolved,disabled,onError,templateId}){
 const [uploading,setUploading]=useState(false),[picker,setPicker]=useState(false),[tab,setTab]=useState('current');
 const [search,setSearch]=useState(''),[page,setPage]=useState(1),[result,setResult]=useState({rows:[],total:0}),[selected,setSelected]=useState([]);
 const [loading,setLoading]=useState(false),[error,setError]=useState(''),[retry,setRetry]=useState(0);
 const live=useRef(true);useEffect(()=>{live.current=true;return()=>{live.current=false;};},[]);
 const cap=model?.capabilities,limit=Math.max(imageReferenceLimit(cap),availableLimit);
 const identity=c=>c?.image_path||c?.key;
 const identities=new Set(items.map(key=>identity(choices.find(c=>c.key===key)||{key})));
 const currentOriginal=choices.find(c=>c.key==='original');
 useEffect(()=>{
  if(!picker)return;
  const controller=new AbortController();setLoading(true);setError('');
  const timer=setTimeout(async()=>{
   try{
    let rows,total;
    if(tab==='assets'){
     const r=await api.studio.assets({page,limit:24,search},{signal:controller.signal});
     rows=r.assets.map(i=>({key:`asset:${i.id}`,generation_id:i.id,name:`${i.template_name||'款式'} · 图片 #${i.id}`,...i}));total=r.total;
    }else if(tab==='uploaded'){
     const r=await api.studio.references({page,limit:24,search},{signal:controller.signal});
     rows=r.references.map(i=>({key:`ref:${i.id}`,name:`已上传参考 #${i.id}`,...i}));total=r.total;
    }else{
     const r=await api.studio.workspaceItems(templateId,'images',{page,limit:24,search,state:'active'},{signal:controller.signal});
     const origin=currentOriginal&&(!search||/原图|原始|参考/.test(search))?[currentOriginal]:[];
     rows=[...(page===1?origin:[]),...r.items.map(i=>({key:String(i.id),name:`款式图片 #${i.id}`,...i}))];total=r.total+origin.length;
    }
    if(controller.signal.aborted)return;
    setResult({rows:rows.map(c=>({...c,available:c.available!==false&&c.image_available!==false})),total});
   }catch(e){if(!controller.signal.aborted)setError(e.message);}
   finally{if(!controller.signal.aborted)setLoading(false);}
  },200);
  return()=>{controller.abort();clearTimeout(timer);};
 },[picker,tab,page,search,retry,templateId]);
 const append=async candidates=>{
  setUploading(true);setError('');const next=[...items],known=new Set(identities);
  try{
   for(const c of candidates){
    if(known.has(identity(c)))continue;
    if(next.length>=limit)throw new Error(`兼容模型最多支持 ${limit} 张参考图`);
    let key=c.key;
    if(c.generation_id){const r=await api.studio.uploadReference({generation_id:c.generation_id});if(!live.current)return;onUploaded(r);key=`ref:${r.id}`;}
    else if(c.key.startsWith('ref:'))onUploaded(c);
    known.add(identity(c));next.push(key);
   }
   if(live.current){onResolved?.(candidates.filter(c=>!c.generation_id));onChange(next);setPicker(false);setSelected([]);}
  }catch(e){if(live.current){if(next.length!==items.length)onChange(next);setError(e.message);onError(e);}}
  finally{if(live.current)setUploading(false);}
 };
 const upload=async e=>{
  const files=[...e.target.files];e.target.value='';
  if(items.length+files.length>limit){onError(new Error(`兼容模型最多支持 ${limit} 张参考图，请减少图片`));return;}
  if(files.some(f=>f.size>15*1024*1024||!/^image\//.test(f.type))){onError(new Error('请选择不超过15MB的图片'));return;}
  setUploading(true);const added=[];
  try{
   for(const f of files){
    const image_base64=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result.split(',')[1]);reader.onerror=()=>reject(new Error('图片读取失败'));reader.readAsDataURL(f);});
    const r=await api.studio.uploadReference({image_base64});if(!live.current)return;
    onUploaded(r);added.push(`ref:${r.id}`);
   }
  }catch(e){if(live.current)onError(e);}
  finally{if(live.current){if(added.length)onChange([...items,...added]);setUploading(false);}}
 };
 return <section className="unified-references"><h3>参考图 <small>已选 {items.length} 张{imageReferenceLimit(cap)?` · 当前模型最多 ${imageReferenceLimit(cap)} 张`:''}</small></h3>
  <div className="reference-strip">{items.map((key,i)=>{const c=choices.find(c=>c.key===key);return <article key={key}><StudioImage thumbnail={c?.thumb_path} original={c?.image_path} alt={`参考图${i+1}`}/><strong>图{i+1}{i===0?' · 款式主体':''}</strong><div><button className="btn secondary small" type="button" aria-label={`前移参考图${i+1}`} disabled={disabled||uploading||i===0} onClick={()=>{const next=[...items];[next[i],next[i-1]]=[next[i-1],next[i]];onChange(next);}}>前移</button><button className="btn secondary small" type="button" aria-label={`移除参考图${i+1}`} disabled={disabled||uploading} onClick={()=>onChange(items.filter((_,j)=>j!==i))}>移除</button></div></article>;})}</div>
  <div className="reference-entry-actions">
   <label className={`btn secondary reference-file-button${disabled||uploading||!limit?' disabled':''}`}>
    {uploading?'正在添加…':'上传图片'}<input aria-label="上传参考图" type="file" accept="image/*" multiple onChange={upload} disabled={disabled||uploading||!limit||items.length>=limit}/>
   </label>
   <button className="btn secondary" disabled={disabled||uploading||!limit} aria-expanded={picker} onClick={()=>{setPicker(v=>!v);setSelected([]);}}>从图库选择</button>
  </div>
  {items.length>0&&!imageTaskAllowed(cap,items.length)&&<p role="alert">当前模型不能处理所选参考图，请选择兼容模型或减少图片。</p>}
  <p className="dim small">图1为主体，其余图片可在要求中按图号说明用途。{!items.length?'不添加参考图时，按已保存属性生成。':''}</p>
  {picker&&<section className="reference-picker" aria-label="参考图库">
   <div role="tablist" aria-label="参考图来源">{[['current','当前款式'],['assets','资产库'],['uploaded','已上传']].map(([key,label])=><button key={key} role="tab" aria-selected={tab===key} className="btn secondary small" onClick={()=>{setTab(key);setPage(1);setSearch('');}}>{label}</button>)}</div>
   <label className="style-field">搜索图片<input aria-label="搜索参考图" placeholder={tab==='assets'?'款式名称或图片编号':'图片编号'} maxLength={100} value={search} onChange={e=>{setSearch(e.target.value);setPage(1);}}/></label>
   {loading?<p role="status">正在加载图库…</p>:error?<p role="alert">{error}<button className="btn secondary small" onClick={()=>setRetry(n=>n+1)}>重试</button></p>:<>
    <div className="reference-picker-grid">{result.rows.map(c=>{
     const included=identities.has(identity(c)),checked=selected.some(x=>identity(x)===identity(c));
     return <button key={c.key} type="button" className={`reference-choice${checked||included?' selected':''}`} aria-label={`选择${c.name}`} aria-pressed={checked||included} disabled={!c.available||included||uploading||(!checked&&items.length+selected.length>=limit)} onClick={()=>setSelected(old=>checked?old.filter(x=>identity(x)!==identity(c)):[...old,c])}>
      <StudioImage thumbnail={c.thumb_path} original={c.image_path} alt={c.name} loading="lazy"/><span>{c.name}</span><small>{!c.available?'原图缺失':included?'已添加':checked?'已选中':'选择'}</small>
     </button>;
    })}</div>
    {!result.rows.length&&<p>没有符合条件的图片。</p>}
    <div className="reference-picker-pages"><button className="btn secondary small" disabled={page<=1||uploading} onClick={()=>setPage(p=>p-1)}>上一页</button><span>第 {page} 页 · 共 {result.total} 张</span><button className="btn secondary small" disabled={page*24>=result.total||uploading} onClick={()=>setPage(p=>p+1)}>下一页</button></div>
   </>}
   <div className="reference-picker-footer"><span>待添加 {selected.length} 张</span><button className="btn secondary" disabled={uploading} onClick={()=>setPicker(false)}>取消</button><button className="btn primary" disabled={!selected.length||loading||uploading} onClick={()=>append(selected)}>{uploading?'正在添加…':'添加所选参考图'}</button></div>
  </section>}
 </section>;
}
