import { useState } from 'react';
import StudioImage from './StudioImage.jsx';
import { api } from '../api.js';
export default function ReferenceImages({items,onChange,choices,model,availableLimit=0,onUploaded,disabled,onError}){
 const [uploading,setUploading]=useState(false);
 const cap=model?.capabilities,limit=cap?.max_images||availableLimit;
 const append=key=>{if(items.includes(key))return;onChange([...items,key]);};
 const upload=async e=>{
  const files=[...e.target.files];e.target.value='';
  if(items.length+files.length>limit){onError(new Error(`当前模型最多支持 ${limit} 张参考图，请调整或更换模型`));return;}
  setUploading(true);
  try{
   const added=[];
   for(const f of files){if(f.size>15*1024*1024||!/^image\//.test(f.type))throw new Error('请选择不超过15MB的图片');
    const image_base64=await new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result.split(',')[1]);r.onerror=reject;r.readAsDataURL(f);});
    const r=await api.studio.uploadReference({image_base64});onUploaded(r);added.push(`ref:${r.id}`);
   }
   onChange([...items,...added]);
  }catch(e){onError(e);}finally{setUploading(false);}
 };
 return <section className="unified-references"><h3>参考图 <small>已选 {items.length} 张{limit?` · 当前模型最多 ${limit} 张`:''}</small></h3>
  <div className="reference-strip">{items.map((key,i)=>{const c=choices.find(c=>c.key===key);return <article key={key}><StudioImage thumbnail={c?.thumb_path} original={c?.image_path} alt={`参考图${i+1}`}/><strong>图{i+1}{i===0?' · 款式主体':''}</strong><div><button type="button" aria-label={`前移参考图${i+1}`} disabled={disabled||i===0} onClick={()=>{const next=[...items];[next[i],next[i-1]]=[next[i-1],next[i]];onChange(next);}}>前移</button><button type="button" aria-label={`移除参考图${i+1}`} disabled={disabled} onClick={()=>onChange(items.filter((_,j)=>j!==i))}>移除</button></div></article>;})}
  <label className="reference-upload">＋<span>{uploading?'上传中…':'上传图片'}</span><input aria-label="上传参考图" type="file" accept="image/*" multiple onChange={upload} disabled={disabled||uploading||!limit||items.length>=limit}/></label></div>
  <label>从款式或资产选择<select aria-label="添加参考图" value="" disabled={disabled||uploading} onChange={e=>append(e.target.value)}><option value="">选择原图或已有图片</option>{choices.filter(c=>!items.includes(c.key)&&c.available!==false).map(c=><option key={c.key} value={c.key}>{c.name}</option>)}</select></label>
  {!cap?.image_edit&&<p className="dim small">当前模型未配置参考图能力；添加参考后请切换到支持图片输入的模型。</p>}
  {items.length>limit&&<p role="alert">当前模型不能处理这 {items.length} 张参考图，请更换模型或移除部分图片。</p>}
  <p className="dim small">图1定义主体；在下方要求中描述图2、图3的领子、袖子或花色。调整顺序后请核对图号。无参考图时按已保存属性生成。</p>
 </section>;
}
