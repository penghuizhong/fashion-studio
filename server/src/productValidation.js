import {fail,object,text,list,libraryKinds} from './productStore.js';
import {decimal,makeSkus} from '../../shared/productMath.js';
export function validateMeasurements(rows){
 list(rows,'尺寸部位',100);const keys=new Set();
 for(const r of rows){object(r);text(r.key,'部位代码',40,true);if(keys.has(r.key))fail('尺寸部位代码重复');keys.add(r.key);text(r.label,'部位名称',80,true);text(r.method,'测量方法',1000,true);
  if(!['cm','in'].includes(r.unit)||!['length','full','half'].includes(r.basis))fail('请明确尺寸单位和整围/半围/长度口径');
  if(r.value!==''&&r.value!=null)decimal(r.value,4,{max:10000});if(r.tolerance!==''&&r.tolerance!=null)decimal(r.tolerance,4,{max:1000});
  if(r.step!==''&&r.step!=null)decimal(r.step,4,{min:-1000,max:1000});
  if(r.values){object(r.values);if(Object.keys(r.values).length>30)fail('尺码最多30项');for(const v of Object.values(r.values))if(v!==''&&v!=null)decimal(v,4,{max:10000});}
 }
 return rows.map(r=>Object.fromEntries(['key','label','method','basis','unit','value','tolerance','step','values','size'].filter(k=>Object.hasOwn(r,k)).map(k=>[k,r[k]])));
}
export function validateLibrary(kind,data){
 object(data);text(data.name,'名称',120,true);text(data.category||'','品类',100);text(data.content||'','说明',12000);text(data.source||'','资料来源',1000);text(data.scope||'','适用范围',1000);text(data.part||'','部位',100);
 if(!libraryKinds.includes(kind)&&kind!=='body')fail('资料类型无效');
 if(kind==='body'){text(data.measured_at||'','测量日期',30,true);text(data.posture||'','体态说明',1000);}
 const rows=['size_table','grading','body'].includes(kind)?validateMeasurements(data.rows||[]):undefined;
 if(kind==='size_table'||kind==='grading'){const sizes=list(data.sizes||[],'尺码',30);for(const size of sizes)text(size,'尺码',40,true);if(new Set(sizes).size!==sizes.length)fail('尺码重复');text(data.base_size||'','基础尺码',40);if(data.base_size&&!sizes.includes(data.base_size))fail('基础尺码不在尺码表内');}
 if(kind==='size_table'&&data.measurement_type&&!['garment','body'].includes(data.measurement_type))fail('请选择人体号型或成衣尺寸');
 list(data.files||[],'附件',20);const fields=['name','category','part','content','source','scope',...(kind==='body'?['measured_at','posture']:[]),...(['size_table','grading'].includes(kind)?['sizes','base_size']:[]),...(kind==='size_table'?['measurement_type']:[])];return {...Object.fromEntries(fields.filter(k=>Object.hasOwn(data,k)).map(k=>[k,data[k]])),files:data.files||[],...(rows?{rows}:{})};
}
const editable=['code','notes','process','measurements','colors','sizes','materials','fees','currency','deadline','scope_notes','standard_exception'];
export function updateProjectData(before,input){
 object(input);const next={...before};for(const key of editable)if(Object.hasOwn(input,key))next[key]=input[key];
 for(const [key,max] of [['code',80],['notes',5000],['process',12000],['deadline',30],['scope_notes',1000],['standard_exception',1000]])text(next[key]||'',key,max);
 next.measurements=validateMeasurements(next.measurements||[]).map(row=>{const old=before.measurements?.find(r=>r.key===row.key);return old?.calculation_id&&['value','unit','basis','method'].every(k=>JSON.stringify(row[k])===JSON.stringify(old[k]))?{...row,calculation_id:old.calculation_id}:row;});
 next.skus=makeSkus(next.colors||[],next.sizes||[],before.skus||[]);
 if(input.skus){list(input.skus,'SKU',300);for(const edit of input.skus){const sku=next.skus.find(s=>s.key===edit.key);if(!sku)fail('SKU不存在');text(edit.code||'','SKU编码',80,true);if(!Number.isSafeInteger(edit.quantity)||edit.quantity<0||edit.quantity>10000000)fail('SKU数量应为非负整数');Object.assign(sku,{code:edit.code,quantity:edit.quantity});}}
 const codes=next.skus.map(s=>s.code);if(new Set(codes).size!==codes.length)fail('SKU编码重复，请调整');
 list(next.materials||[],'面辅料',100);for(const m of next.materials){object(m);text(m.name||'','材料名称',120,true);text(m.spec||'','材料规格',500);text(m.supplier||'','来源',200);text(m.unit||'','材料单位',30,true);for(const k of ['price','usage','waste'])if(m[k]!==''&&m[k]!=null)decimal(m[k],k==='usage'?4:2,{max:k==='waste'?1000:1e8});
  if(m.colors){list(m.colors,'适用颜色',30);if(m.colors.some(c=>!next.colors.includes(c)))fail('材料颜色不在SKU范围内');}if(m.sizes){list(m.sizes,'适用尺码',30);if(m.sizes.some(c=>!next.sizes.includes(c)))fail('材料尺码不在SKU范围内');}
  if(m.overrides){object(m.overrides);for(const [key,o] of Object.entries(m.overrides)){if(!next.skus.some(s=>s.key===key))fail('材料覆盖SKU无效');object(o);if(o.price!==''&&o.price!=null)decimal(o.price,2,{max:1e8});if(o.usage!==''&&o.usage!=null)decimal(o.usage,4,{max:1e6});}}
 }
 list(next.fees||[],'费用',30);for(const f of next.fees){text(f.name||'','费用名称',100,true);if(f.amount!==''&&f.amount!=null)decimal(f.amount,2,{max:1e8});}
 if(next.currency!=='CNY')fail('首轮核价统一使用人民币 CNY');return next;
}
export const costInputs=data=>({currency:data.currency,materials:data.materials,fees:data.fees,skus:data.skus});
export const technicalBase=data=>({delivery:data.delivery,process:data.process,measurements:data.measurements,standard:data.standard_binding,body:data.body_binding,size_table:data.size_binding,pattern:data.pattern_binding,colors:data.colors,sizes:data.sizes,materials:(data.materials||[]).map(({price,usage,waste,overrides,...m})=>m),standard_exception:data.standard_exception});
