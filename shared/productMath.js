// Quantities/money use fixed decimal arithmetic. Human measurements never come from images.
export const CALCULATORS = [
 {id:'convert',name:'单位换算',version:'1',formula:'cm = inch × 2.54',fields:[['value','原数值']],note:'长度单位换算；输入值不代表已确认人体或成衣尺寸。'},
 {id:'ease',name:'松量计算',version:'1',formula:'成衣整围 = 人体整围 + 整围松量',fields:[['body','人体整围 cm'],['ease','整围松量 cm']],note:'两项必须是同一部位的整围；松量由版师按品类、面料与设计确定。'},
 {id:'shrink',name:'缩率补偿',version:'1',formula:'处理前尺寸 = 目标处理后尺寸 ÷ (1 − 缩率/100)',fields:[['target','目标尺寸 cm'],['rate','实测缩率 %']],note:'适用于该方向已实测且稳定的线性缩水；经纬方向分别计算，不自动追加缝份。'},
 {id:'grade',name:'放码增量',version:'1',formula:'目标尺码尺寸 = 基础尺寸 + 单档增量 × 档差',fields:[['base','基础尺寸 cm'],['step','单档增量 cm'],['steps','档差']],note:'适用于已确认的该部位线性放码规则；非线性放码需按尺码表逐档确认。'},
];
const bad=message=>{throw Object.assign(new Error(message),{code:'INVALID_PRODUCT_DATA',statusCode:400,publicMessage:message});};
export function decimal(value,scale=4,{min=0,max=1e9}={}) {
 const s=String(value??'').trim();
 if(!/^-?\d+(?:\.\d+)?$/.test(s)||!Number.isFinite(Number(s))||Number(s)<min||Number(s)>max||((s.split('.')[1]||'').length>scale))bad(`请输入 ${min}–${max} 之间、最多 ${scale} 位小数的数值`);
 const neg=s.startsWith('-'),[a,b='']=s.replace('-','').split('.');return (BigInt(a)*10n**BigInt(scale)+BigInt(b.padEnd(scale,'0')))*(neg?-1n:1n);
}
const round=(n,d)=> (n+d/2n)/d;
export function calculateSize(id,input={}) {
 if(!input||typeof input!=='object'||Array.isArray(input))bad('请提供有效计算输入');
 const c=CALCULATORS.find(c=>c.id===id);if(!c)bad('计算工具不存在');
 const n=(key,min=0)=>decimal(input[key],4,{min,max:1000000});
 let numerator,denominator=10000n;
 if(id==='convert') {if(!['cm_to_in','in_to_cm'].includes(input.direction))bad('请选择换算方向');if(input.direction==='cm_to_in'){numerator=n('value')*100n;denominator=2540000n;}else{numerator=n('value')*254n;denominator=1000000n;}}
 if(id==='ease')numerator=n('body')+n('ease',-1000);
 if(id==='shrink'){const rate=n('rate',-100);if(rate>=1000000n)bad('缩率必须小于100%');numerator=n('target')*1000000n;denominator=10000n*(1000000n-rate);}
 if(id==='grade'){const steps=n('steps',-100);if(steps%10000n!==0n)bad('档差应为整数');numerator=n('base')+n('step',-1000)*(steps/10000n);}
 if(numerator<0n||numerator>10000000n*denominator)bad('计算结果超出有效尺寸范围');
 return {calculator:id,version:c.version,formula:c.formula,inputs:input,result:Number(round(numerator*100n,denominator))/100,unit:id==='convert'&&input.direction==='cm_to_in'?'in':'cm',precision:2,rounding:'half_up',note:c.note};
}
export function makeSkus(colors=[],sizes=[],old=[]) {
 const clean=list=>{if(!Array.isArray(list)||list.length>30)bad('颜色或尺码最多30项');const a=list.map(s=>String(s).trim());if(a.some(s=>!s||s.length>40)||new Set(a).size!==a.length)bad('颜色尺码不能为空或重复');return a;};
 const a=clean(colors),b=clean(sizes);if(a.length*b.length>200)bad('SKU组合最多200项');
 const used=new Set(old.map(s=>s.code));let counter=old.length;
 const nextCode=()=>{let code;do{code=`SKU-${String(++counter).padStart(4,'0')}`;}while(used.has(code));used.add(code);return code;};
 const current=a.flatMap((color,i)=>b.map((size,j)=>{const previous=old.find(s=>s.color===color&&s.size===size);return {key:JSON.stringify([color,size]),color,size,code:previous?.code||nextCode(),quantity:previous?.quantity??0,active:true};}));
 return [...current,...old.filter(s=>!current.some(n=>n.key===s.key)).map(s=>({...s,active:false}))];
}
export function costQuote(data) {
 if(data.currency!=='CNY'||[...(data.materials||[]),...(data.fees||[])].some(row=>row.currency&&row.currency!=='CNY'))bad('当前核价统一使用人民币 CNY，不可混合其他币种');
 if((data.materials||[]).some(row=>row.includes_waste!=null&&typeof row.includes_waste!=='boolean'))bad('请明确单耗是否已包含损耗');
 const skus=(data.skus||[]).filter(s=>s.active!==false),missing=[];
 if(!skus.length)bad('请先填写颜色与尺码');
 const money=v=>decimal(v,2,{max:1e8}),q=v=>decimal(v,4,{max:1e6});
 const rows=skus.map(s=>{
  if(!Number.isSafeInteger(s.quantity)||s.quantity<0||s.quantity>10000000)bad('SKU数量应为有效非负整数');
  let cents=0n;
  const materials=(data.materials||[]).filter(m=>(!m.colors?.length||m.colors.includes(s.color))&&(!m.sizes?.length||m.sizes.includes(s.size))).map(m=>{
   if(!m.name?.trim()||!m.unit)bad('请填写材料名称和单位');
   const override=m.overrides?.[s.key]||{};const usage=override.usage===''||override.usage==null?m.usage:override.usage,price=override.price===''||override.price==null?m.price:override.price;
   if(usage===''||usage==null||price===''||price==null){missing.push(`${s.color}/${s.size}：${m.name}缺用量或价格`);return {name:m.name,missing:true};}
   const waste=decimal(m.waste||0,2,{max:1000});
   const amount=round(q(usage)*money(price)*(m.includes_waste?10000n:10000n+waste),100000000n);cents+=amount;
   return {name:m.name,unit:m.unit,usage,price,waste:m.waste||0,includes_waste:!!m.includes_waste,cents:Number(amount)};
  });
  for(const f of data.fees||[]){if(f.amount===''||f.amount==null){missing.push(`${f.name||'费用'}待补`);continue;}cents+=money(f.amount);}
  if(cents>9000000000000n)bad('核价金额超出上限');
  const total=cents*BigInt(s.quantity);if(total>9007199254740991n)bad('总金额超出上限');
  return {key:s.key,color:s.color,size:s.size,quantity:s.quantity,unit_cents:Number(cents),materials,total_cents:Number(total)};
 });
 const total=rows.reduce((n,r)=>n+BigInt(r.total_cents),0n);if(total>9007199254740991n)bad('总金额超出上限');
 return {currency:'CNY',rows,missing:[...new Set(missing)],total_quantity:rows.reduce((n,r)=>n+r.quantity,0),total_cents:Number(total),precision:2};
}
