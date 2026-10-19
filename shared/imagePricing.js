import { sizeAllowed } from './imageOptions.js';
export function imageRateMatch(rates,size,quality='') {
  const matches=(rates||[]).filter(r=>(r.size==='*'||r.size===size)&&(r.quality==='*'||r.quality===quality));
  const score=r=>Number(r.size!=='*')+Number(r.quality!=='*');
  matches.sort((a,b)=>score(b)-score(a));
  if(!matches.length)return {error:'此尺寸和质量尚未配置积分价格'};
  const best=matches.filter(r=>score(r)===score(matches[0]));
  if(new Set(best.map(r=>r.per_call)).size>1)return {error:'分档价格规则冲突，请调整交叉覆盖规则'};
  return {unit:matches[0].per_call,rule:matches[0]};
}
export function inspectImageRates(cap,rates) {
  const errors=[],warnings=[];
  if(!Array.isArray(rates)||rates.length>200)return {errors:['价格档位须为不超过 200 条的列表'],warnings};
  const keys=new Set();
  rates.forEach((r,i)=>{
    const row=`第 ${i+1} 档`;
    if(!r||typeof r!=='object'){errors.push(`${row}格式无效`);return;}
    if(r.size!=='*'&&!sizeAllowed(cap,r.size))errors.push(`${row}尺寸已不受模型支持：${r.size}`);
    if(r.quality!=='*'&&r.quality!==''&&!cap.qualities.some(q=>q.value===r.quality))errors.push(`${row}质量已不受模型支持：${r.quality}`);
    if(!Number.isSafeInteger(r.per_call)||r.per_call<0||r.per_call>1e9)errors.push(`${row}价格须为非负整数，免费请明确填写 0`);
    const key=JSON.stringify([r.size,r.quality]);if(keys.has(key))errors.push(`${row}与其他档位重复`);keys.add(key);
  });
  if(errors.length)return {errors,warnings};
  const sizes=[...new Set([...cap.sizes,...rates.filter(r=>r.size!=='*').map(r=>r.size)])];
  const qualities=['',...cap.qualities.map(q=>q.value)];
  let missing=0;
  for(const size of sizes)for(const quality of qualities){
    const result=imageRateMatch(rates,size,quality);
    if(result.error?.includes('冲突'))errors.push(`${size} / ${cap.qualities.find(q=>q.value===quality)?.label||'模型默认质量'}：${result.error}`);
    else if(result.error)missing++;
  }
  // A pair of crossing wildcards can also conflict on supported custom sizes.
  if(cap.custom_size)for(const quality of qualities){
    const wildcard=rates.filter(r=>r.size==='*'&&(r.quality==='*'||r.quality===quality));
    if(!wildcard.length){warnings.push('部分自定义尺寸未配置价格；使用时将无法报价');break;}
  }
  if(missing)warnings.push(`${missing} 个原生尺寸/质量组合未配置价格，使用时将无法报价`);
  return {errors:[...new Set(errors)],warnings};
}
