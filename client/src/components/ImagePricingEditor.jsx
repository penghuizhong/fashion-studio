import { useEffect, useState } from 'react';
import { imageOptions, ratioLabel } from '../../../shared/imageOptions.js';
import { inspectImageRates } from '../../../shared/imagePricing.js';
import { api } from '../api.js';
const price = value => String(value).trim()===''?NaN:Number(value);
export function pricingPayload(form) {
 const rates=(form.image_rates||[]).map(r=>({...r,per_call:price(r.per_call)}));
 if(form.pricing_mode==='tiered') {
  if(!rates.length)throw new Error('请添加至少一个价格档位');
  const extra={sizes:String(form.sizes||'').split(/[,，、\s]+/).filter(Boolean),image_config:form.image_config};
  const report=inspectImageRates(imageOptions(extra),rates);if(report.errors.length)throw new Error(report.errors.join('；'));
  // Retain the legacy catalog field. Tiered quoting never falls back to it.
  const legacy=price(form.per_call);
  return {...form.original_pricing,per_call:Number.isSafeInteger(legacy)&&legacy>=0?legacy:rates[0].per_call,image_rates:rates};
 }
 const per_call=price(form.per_call);
 if(!Number.isSafeInteger(per_call)||per_call<0||per_call>1e9)throw new Error('请填写有效积分/张，免费请明确填写 0');
 const result={...form.original_pricing,per_call};delete result.image_rates;return result;
}
export default function ImagePricingEditor({value:form,onChange}) {
 const sizes=String(form.sizes||'').split(/[,，、\s]+/).filter(Boolean);
 const extra={sizes,image_config:form.image_config};const cap=imageOptions(extra);
 const tiered=form.pricing_mode==='tiered',rates=form.image_rates||[];
 const [bulk,setBulk]=useState(''),[previewSize,setSize]=useState(sizes[0]||''),[quality,setQuality]=useState(''),[count,setCount]=useState(1);
 const [result,setResult]=useState(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 const report=tiered?inspectImageRates(cap,rates.map(r=>({...r,per_call:price(r.per_call)}))):{errors:[],warnings:[]};
 const changeRow=(i,key,value)=>onChange({image_rates:rates.map((r,j)=>i===j?{...r,[key]:value}:r)});
 const signature=JSON.stringify({form,previewSize,quality,count});
 useEffect(()=>{
  setResult(null);setError('');setBusy(false);
 },[signature]);
 useEffect(()=>{
  if(!sizes.includes(previewSize)&&!cap.custom_size)setSize(sizes[0]||'');
  if(quality&&!cap.qualities.some(q=>q.value===quality))setQuality('');
 },[JSON.stringify(sizes),JSON.stringify(cap.qualities),!!cap.custom_size]);
 const [previewRequest,setPreviewRequest]=useState(null);
 useEffect(()=>()=>previewRequest?.abort(),[previewRequest,signature]);
 const preview=async()=>{
  previewRequest?.abort();const controller=new AbortController();setPreviewRequest(controller);
  setBusy(true);setError('');setResult(null);
  try{const pricing=pricingPayload(form);const r=await api.adminModels.pricePreview({extra,pricing,size:previewSize,quality,count},{signal:controller.signal});if(!controller.signal.aborted)setResult(r);}
  catch(e){if(!controller.signal.aborted)setError(e.message);}
  finally{if(!controller.signal.aborted)setBusy(false);}
 };
 return <section className="image-pricing-editor" aria-label="图片计费设置">
  <h4>图片计费</h4>
  <div className="pricing-mode" role="group" aria-label="计费方式">{[['flat','统一单价'],['tiered','按规格分档']].map(([key,label])=><button type="button" key={key} className="btn secondary small" aria-pressed={(form.pricing_mode||'flat')===key} onClick={()=>onChange({pricing_mode:key})}>{label}</button>)}</div>
  {!tiered?<label className="style-field">每张图片积分<input aria-label="每张图片积分" type="number" min="0" max="1000000000" step="1" value={form.per_call} onChange={e=>onChange({per_call:e.target.value})}/></label>:<>
   <p className="dim small">具体规格优先于默认价。未配置的组合无法报价；0 积分表示免费。</p>
   <div className="pricing-table-scroll"><table className="pricing-table"><thead><tr><th>图片尺寸</th><th>生成质量</th><th>积分/张</th><th>操作</th></tr></thead><tbody>{rates.map((r,i)=><tr key={i}>
    <td data-label="图片尺寸"><select aria-label={`价格档位${i+1}尺寸`} value={r.size} onChange={e=>changeRow(i,'size',e.target.value)}><option value="*">全部支持尺寸</option>{sizes.map(v=><option key={v} value={v}>{ratioLabel(v)} · {v}</option>)}{r.size!=='*'&&!sizes.includes(r.size)&&<option value={r.size}>{r.size}{cap.custom_size?' · 自定义':' · 已失效'}</option>}</select></td>
    <td data-label="生成质量"><select aria-label={`价格档位${i+1}质量`} value={r.quality} onChange={e=>changeRow(i,'quality',e.target.value)}><option value="*">所有质量</option><option value="">模型默认质量</option>{cap.qualities.map(q=><option key={q.value} value={q.value}>{q.label} · {q.value}</option>)}{r.quality&&!['*',...cap.qualities.map(q=>q.value)].includes(r.quality)&&<option value={r.quality}>{r.quality} · 已失效</option>}</select></td>
    <td data-label="积分/张"><input aria-label={`价格档位${i+1}积分`} type="number" min="0" max="1000000000" step="1" value={Number.isNaN(r.per_call)?'':r.per_call} onChange={e=>changeRow(i,'per_call',e.target.value)}/>{String(r.per_call).trim()!==''&&Number(r.per_call)===0&&<small>免费</small>}</td>
    <td data-label="操作"><button type="button" className="btn secondary small" aria-label={`删除价格档位${i+1}`} onClick={()=>onChange({image_rates:rates.filter((_,j)=>j!==i)})}>删除</button></td>
   </tr>)}</tbody></table></div>
   {!rates.length&&<p>尚无价格档位，请添加默认价或具体规格价格。</p>}
   <div className="pricing-actions"><button type="button" className="btn secondary small" disabled={rates.length>=200} onClick={()=>onChange({image_rates:[...rates,{size:sizes[0]||'*',quality:'',per_call:''}]})}>添加价格档位</button><button type="button" className="btn secondary small" disabled={rates.some(r=>r.size==='*'&&r.quality==='*')} onClick={()=>onChange({image_rates:[...rates,{size:'*',quality:'*',per_call:''}]})}>添加默认价</button></div>
   <details><summary>批量填写价格</summary><label className="style-field">应用到全部现有档位<input aria-label="批量积分" type="number" min="0" max="1000000000" value={bulk} onChange={e=>setBulk(e.target.value)}/></label><button type="button" className="btn secondary small" disabled={!rates.length||bulk.trim()===''||!Number.isSafeInteger(Number(bulk))||Number(bulk)<0||Number(bulk)>1e9} onClick={()=>onChange({image_rates:rates.map(r=>({...r,per_call:Number(bulk)}))})}>批量应用</button></details>
   {report.errors.length>0&&<p role="alert">{report.errors.join('；')}</p>}{report.warnings.map(w=><p className="pricing-warning" key={w}>{w}</p>)}
  </>}
  <details><summary>报价预览 · 不生成图片</summary><div className="pricing-preview-fields">
   <label className="style-field">预览尺寸<select aria-label="报价预览尺寸" value={cap.custom_size&&!sizes.includes(previewSize)?'custom':previewSize} onChange={e=>setSize(e.target.value==='custom'?'800x1200':e.target.value)}>{sizes.map(v=><option key={v}>{v}</option>)}{cap.custom_size&&<option value="custom">自定义尺寸</option>}</select></label>
   {cap.custom_size&&!sizes.includes(previewSize)&&<label className="style-field">宽x高<input aria-label="报价自定义尺寸" value={previewSize} onChange={e=>setSize(e.target.value)}/></label>}
   <label className="style-field">预览质量<select aria-label="报价预览质量" value={quality} onChange={e=>setQuality(e.target.value)}><option value="">模型默认质量</option>{cap.qualities.map(q=><option key={q.value} value={q.value}>{q.label}</option>)}</select></label>
   <label className="style-field">数量<input aria-label="报价预览数量" type="number" min="1" max="16" value={count} onChange={e=>setCount(Number(e.target.value))}/></label>
   <button type="button" className="btn secondary" disabled={busy} onClick={preview}>{busy?'正在计算…':'计算报价'}</button>
  </div>{error&&<p role="alert">{error}</p>}{result&&<p role="status">单价 {result.unit} 积分/张 × {result.count} 张 = {result.total} 积分 · {result.rule?`命中：${result.rule.size==='*'?'全部支持尺寸':result.rule.size} / ${result.rule.quality==='*'?'所有质量':cap.qualities.find(q=>q.value===result.rule.quality)?.label||'模型默认质量'}`:'统一单价'}</p>}</details>
 </section>;
}
