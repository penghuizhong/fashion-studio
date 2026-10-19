import { useEffect,useState } from 'react';
import { RATIOS,ratioLabel,sizeNumbers,sizeAllowed } from '../../../shared/imageOptions.js';
function customPreset(cap,ratio){
  const [a,b]=ratio.split(':').map(Number),c=cap.custom_size;
  if(!c)return null;
  const scale=Math.min(1024/Math.max(a,b),c.max/a,c.max/b,Math.sqrt(c.max_pixels/(a*b)));
  const k=Math.floor(scale/c.step)*c.step;
  const w=a*k,h=b*k;
  return sizeAllowed(cap,`${w}x${h}`)?`${w}x${h}`:null;
}
export default function ImageOutputOptions({model,size,quality='',onChange}){
  const [custom,setCustom]=useState(false),[locked,setLocked]=useState(false),[lockedRatio,setLockedRatio]=useState(1);
  useEffect(()=>setCustom(false),[model?.id]);
  if(!model)return null;
  const cap=model.capabilities || {sizes:model.sizes||[]},native=cap.sizes||model.sizes||[];
  const presets=[...new Set([...native,...(cap.custom_size?RATIOS.map(r=>customPreset(cap,r)).filter(Boolean):[])])];
  const parts=/^(\d*)[x*](\d*)$/.exec(size||'');
  const numbers=parts?[parts[1],parts[2]]:['1024','1024'];
  return <div className="image-output-options">
    <label>图片尺寸<select aria-label="图片尺寸" value={custom?'custom':presets.includes(size)?size:'custom'} onChange={e=>{setCustom(e.target.value==='custom');if(e.target.value!=='custom')onChange({size:e.target.value});}}>
      {presets.map(s=><option key={s} value={s}>{ratioLabel(s)} · {s}</option>)}
      {cap.custom_size&&<option value="custom">自定义尺寸</option>}
    </select></label>
    {cap.qualities?.length>0&&<label>生成质量<select aria-label="生成质量" value={quality} onChange={e=>onChange({quality:e.target.value})}><option value="">模型默认</option>{cap.qualities.map(q=><option key={q.value} value={q.value}>{q.label}</option>)}</select></label>}
    {(custom||!presets.includes(size))&&cap.custom_size&&<div className="custom-size-row">{['宽','高'].map((label,i)=><label key={label}>{label}<input aria-label={`自定义${label}`} type="number" min={cap.custom_size.min} max={cap.custom_size.max} step={cap.custom_size.step} value={numbers[i]} onChange={e=>{const next=[...numbers];next[i]=e.target.value;if(locked&&next[i]&&Number(next[i])>0){const other=1-i;next[other]=Math.round((i===0?Number(next[i])/lockedRatio:Number(next[i])*lockedRatio)/cap.custom_size.step)*cap.custom_size.step;}onChange({size:next.join('x')});}}/></label>)}<label className="inline-check"><input type="checkbox" checked={locked} onChange={e=>{setLocked(e.target.checked);if(Number(numbers[0])>0&&Number(numbers[1])>0)setLockedRatio(Number(numbers[0])/Number(numbers[1]));}}/>锁定比例</label><small>{cap.custom_size.min}–{cap.custom_size.max}px · {cap.custom_size.step}倍数 · 最多{cap.custom_size.max_pixels.toLocaleString()}像素</small></div>}
    {!sizeAllowed(cap,size)&&<p role="alert">尺寸不符合当前模型限制，请调整。</p>}
  </div>;
}
