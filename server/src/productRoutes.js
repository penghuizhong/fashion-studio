import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {getDb} from './db.js';
import {getConfig} from './config.js';
import {ah} from './asyncHandler.js';
import {saveStudioImage} from './image.js';
import {productFileOwned} from './productReferences.js';
import {atomic,owner,isAdmin,requireAdmin,record,getRecord,createRecord,revise,listRecords,history,fail,text,list,object,libraryKinds,fingerprint,stamp,checkPath} from './productStore.js';
import {validateLibrary,validateMeasurements,updateProjectData,costInputs,technicalBase} from './productValidation.js';
import {CALCULATORS,calculateSize,costQuote,decimal} from '../../shared/productMath.js';
import {mountProductDelivery} from './productDelivery.js';
const writeProject=(id,req)=>getRecord(id,req,{kind:'project',write:true});
const child=(id,req,kind)=>{const r=getRecord(id,req,{kind,write:true});if(r.project_id)writeProject(r.project_id,req);return r;};
const childList=(projectId,kind)=>getDb().prepare("SELECT * FROM product_records WHERE project_id=? AND kind=? AND lifecycle='active' ORDER BY rowid DESC").all(projectId,kind).map(record);
function requireRevision(r,b){if(b.expected_revision!==r.revision)fail('资料已更新，请刷新后重试；本地内容保留','PRODUCT_CONFLICT',409);}
function patternReady(p){return !!p.data.pattern_binding?.file_id;}
function readiness(p,req){
 const missing=[],d=p.data;
 if(!d.delivery?.slots?.front||!d.delivery?.slots?.back||!d.delivery?.slots?.side)missing.push('设计三视角');
 if(!d.process?.trim())missing.push('工艺要求');
 if(!d.measurements?.length||d.measurements.some(r=>r.value===''||r.value==null||r.tolerance===''||r.tolerance==null))missing.push('确认成衣尺寸');
 if(!d.standard_binding)missing.push('适用制版标准');
 if(d.standard_binding?.category&&d.standard_binding.category!==d.category&&!d.standard_exception?.trim())missing.push('标准例外原因');
 if(!patternReady(p))missing.push('采用纸样');
 if(patternReady(p)&&d.skus?.some(s=>s.active!==false&&s.quantity>0&&!d.pattern_binding.sizes?.includes(s.size)))missing.push('纸样覆盖生产尺码');
 if(!d.materials?.length)missing.push('面辅料');
 let quote;try {quote=costQuote(d);if(quote.missing.length)missing.push('完整用料价格');}catch {missing.push('颜色尺码及核价');}
 if(!d.skus?.some(s=>s.active!==false&&s.quantity>0))missing.push('生产数量');
 const confirmed=d.confirmed_quote_id?getRecord(d.confirmed_quote_id,req,{kind:'quote'}):null;
 if(!confirmed||confirmed.data.input_signature!==fingerprint(costInputs(d)))missing.push('确认当前核价');
 const sample=childList(p.id,'sample').find(r=>r.state==='accepted'&&r.data.technical_signature===fingerprint(technicalBase(d)));
 if(!sample)missing.push('当前资料的样衣确认');
 const updates=[];
 for(const field of ['standard_binding','size_binding','body_binding']){const binding=d[field];if(!binding)continue;const latest=getDb().prepare("SELECT * FROM product_records WHERE kind=? AND state='published' AND lifecycle='active' AND json_extract(payload_json,'$.family_id')=? ORDER BY CAST(json_extract(payload_json,'$.edition') AS INTEGER) DESC LIMIT 1").get(field==='standard_binding'?'standard':getDb().prepare('SELECT kind FROM product_records WHERE id=?').get(binding.id)?.kind||'size_table',binding.family_id||binding.id);if(latest&&latest.id!==binding.id)updates.push({field,id:latest.id,name:JSON.parse(latest.payload_json).name});}
 return {missing,ready:!missing.length,quote,confirmed_quote:confirmed,sample,updates};
}
function validateFileArray(files,req){return list(files||[],'附件',30).map(f=>{if(!f?.file_id)fail('请选择有效附件');const row=getDb().prepare('SELECT * FROM product_files WHERE id=?').get(f.file_id);if(!row||!productFileOwned(getDb(),row.path,owner(req)))fail('附件不存在','FILE_NOT_FOUND',404);return {id:row.id,file_id:row.id,name:row.name,mime:row.mime,bytes:row.bytes,image_path:row.mime.startsWith('image/')?row.path:null,thumb_path:row.thumb_path};});}

export function mountProductRoutes(app){
 mountProductDelivery(app);
 app.get('/api/products/options',ah(async(req,res)=>res.json({calculators:CALCULATORS,can_maintain:isAdmin(req),currency:'CNY'})));
 app.get('/api/products/records',ah(async(req,res)=>res.json(listRecords(req,req.query))));
 app.get('/api/products/records/:id',ah(async(req,res)=>res.json({record:getRecord(req.params.id,req)})));
 app.get('/api/products/records/:id/history',ah(async(req,res)=>res.json(history(req.params.id,req,Math.max(1,parseInt(req.query.page)||1)))));
 app.get('/api/products/projects/:id',ah(async(req,res)=>{
  const p=getRecord(req.params.id,req,{kind:'project'});
  res.json({project:p,readiness:readiness(p,req)});
 }));
 app.post('/api/products/projects/:id/save',ah(async(req,res)=>res.json(atomic(req,req.body,()=>{
  const p=writeProject(req.params.id,req);requireRevision(p,req.body);
  return {project:revise(p,updateProjectData(p.data,req.body.data),req)};
 }))));
 app.post('/api/products/projects/:id/adopt-delivery',ah(async(req,res)=>res.json(atomic(req,req.body,()=>{
  const p=writeProject(req.params.id,req);requireRevision(p,req.body);if(!p.data.pending_delivery)fail('没有待采用的新交付');
  return {project:revise(p,{...p.data,delivery:p.data.pending_delivery,category:p.data.pending_delivery.category,name:p.data.pending_delivery.name,pending_delivery:null},req,{action:'adopt_delivery'})};
 }))));
 app.post('/api/products/projects/:id/lifecycle',ah(async(req,res)=>res.json(atomic(req,req.body,()=>{
  const p=getRecord(req.params.id,req,{kind:'project'});if(p.user_id!==owner(req)&&getConfig().multiUser)fail('项目不存在','PRODUCT_NOT_FOUND',404);requireRevision(p,req.body);
  const actions={archive:'archived',restore:'active',trash:'trash',delete:'deleted'},next=actions[req.body.action];if(!next)fail('操作无效');
  if(next==='deleted'&&(p.lifecycle!=='trash'||req.body.confirm!=='永久删除'))fail('请先移入回收站，再确认永久删除');
  const updated=revise(p,p.data,req,{lifecycle:next,action:req.body.action});return {project:updated};
 }))));
 app.post('/api/products/projects/:id/quote',ah(async(req,res)=>{
  const p=writeProject(req.params.id,req);res.json({quote:costQuote(p.data),input_signature:fingerprint(costInputs(p.data))});
 }));
 app.post('/api/products/projects/:id/confirm-cost',ah(async(req,res)=>res.json(atomic(req,req.body,()=>{
  const p=writeProject(req.params.id,req);requireRevision(p,req.body);const quote=costQuote(p.data);if(quote.missing.length)fail(quote.missing.join('；'));
  if(req.body.confirm!==true)fail('请确认当前核价');
  const q=createRecord('quote',{name:'确认核价',input_signature:fingerprint(costInputs(p.data)),inputs:costInputs(p.data),...quote},req,{projectId:p.id,templateId:p.template_id,state:'confirmed'});
  return {quote:q,project:revise(p,{...p.data,confirmed_quote_id:q.id},req,{action:'confirm_cost'})};
 }))));
 // Standards are public only after an explicit maintainer publication; body records remain private.
 app.post('/api/products/library',ah(async(req,res)=>res.json(atomic(req,req.body,()=>{
  const {kind}=req.body,data=validateLibrary(kind,req.body.data);data.files=validateFileArray(data.files,req);
  const original=req.body.parent_id?getRecord(req.body.parent_id,req,{kind,write:true}):null;
  const id=crypto.randomUUID(),family=original?.data.family_id||original?.id||id;const edition=original?Number(getDb().prepare("SELECT MAX(CAST(json_extract(payload_json,'$.edition') AS INTEGER)) n FROM product_records WHERE json_extract(payload_json,'$.family_id')=?").get(family).n||1)+1:1;return {record:createRecord(kind,{...data,parent_id:original?.id||null,family_id:family,edition},req,{id})};
 }))));
 app.post('/api/products/library/:id/save',ah(async(req,res)=>res.json(atomic(req,req.body,()=>{
  const r=getRecord(req.params.id,req,{write:true});if(![...libraryKinds,'body'].includes(r.kind))fail('资料类型无效');
  requireRevision(r,req.body);if(r.state==='published')fail('已发布标准请创建新修订','IMMUTABLE_RECORD',409);
  const data=validateLibrary(r.kind,req.body.data);data.files=validateFileArray(data.files,req);
  return {record:revise(r,{...data,parent_id:r.data.parent_id,family_id:r.data.family_id,edition:r.data.edition},req)};
 }))));
 app.post('/api/products/library/:id/publish',ah(async(req,res)=>res.json(atomic(req,req.body,()=>{
  requireAdmin(req);const r=getRecord(req.params.id,req,{write:true});requireRevision(r,req.body);if(!libraryKinds.includes(r.kind))fail('人体实测资料不公开发布');
  if(req.body.confirm!==true||!r.data.source?.trim()||!r.data.scope?.trim())fail('发布前需填写来源、适用范围并核对资料');
  if(['size_table','grading'].includes(r.kind)&&!r.data.rows?.length)fail('尺寸资料不能为空');
  if(['knowledge','standard'].includes(r.kind)&&!r.data.content?.trim())fail('标准内容不能为空');
  if(['size_table','grading'].includes(r.kind)&&!r.data.sizes?.length)fail('请填写适用尺码');
  return {record:revise(r,{...r.data,verified:true,published_by:owner(req),published_at:stamp()},req,{state:'published',action:'publish'})};
 }))));
 app.post('/api/products/library/:id/lifecycle',ah(async(req,res)=>res.json(atomic(req,req.body,()=>{
  const r=getRecord(req.params.id,req);if(r.user_id!==owner(req)&&getConfig().multiUser)fail('资料不存在','PRODUCT_NOT_FOUND',404);requireRevision(r,req.body);
  if(![...libraryKinds,'body'].includes(r.kind))fail('资料类型无效');
  if(libraryKinds.includes(r.kind)&&r.state==='published')requireAdmin(req);
  return {record:revise(r,r.data,req,{lifecycle:req.body.action==='restore'?'active':'archived',action:'lifecycle'})};
 }))));
 app.post('/api/products/projects/:id/apply-library',ah(async(req,res)=>res.json(atomic(req,req.body,()=>{
  const p=writeProject(req.params.id,req);requireRevision(p,req.body);const source=getRecord(req.body.record_id,req);
  if(!['standard','body','size_table','grading'].includes(source.kind))fail('请选择标准或尺寸资料');
  if(source.kind!=='body')getRecord(source.id,req,{published:true});
  const snapshot={id:source.id,revision:source.revision,...source.data};const d={...p.data};
  if(source.kind==='standard'){
   if(source.data.category&&source.data.category!==p.data.category&&!req.body.exception?.trim())fail('标准品类不匹配，请填写本款例外原因');
   d.standard_binding=snapshot;d.standard_exception=String(req.body.exception||'').slice(0,1000);
  }else if(source.kind==='body')d.body_binding=snapshot;
  else {
   if(source.data.measurement_type!=='body')d.size_binding=snapshot;
   const chosen=req.body.size||source.data.base_size;if(!chosen||!source.data.sizes?.includes(chosen))fail('请选择有效基础尺码');
   
   const measurements=source.data.rows.map(r=>{
    const val=r.values?.[chosen]??r.value??'';
    const baseIndex=source.data.sizes.indexOf(source.data.base_size),idx=source.data.sizes.indexOf(chosen);
    let value=val;if(source.kind==='grading'&&r.value!==''&&r.value!=null&&r.step!==''&&r.step!=null)value=calculateSize('grade',{base:r.value,step:r.step,steps:idx-baseIndex}).result;
    return {...r,value,size:chosen};
   });
   if(source.data.measurement_type==='body')d.body_binding={...snapshot,selected_size:chosen,rows:measurements};else d.measurements=measurements;
  }
  return {project:revise(p,d,req,{action:'apply_library'})};
 }))));
 app.post('/api/products/calculate',ah(async(req,res)=>res.json({result:calculateSize(req.body.calculator,req.body.inputs)})));
 app.post('/api/products/projects/:id/calculations',ah(async(req,res)=>res.json(atomic(req,req.body,()=>{
  const p=writeProject(req.params.id,req);requireRevision(p,req.body);const result=calculateSize(req.body.calculator,req.body.inputs);
  text(req.body.part,'目标部位',80,true);text(req.body.adjustment_reason||'','调整原因',1000);
  let value=result.result;if(req.body.adjusted_value!==''&&req.body.adjusted_value!=null){if(!req.body.adjustment_reason?.trim())fail('请说明人工调整原因');value=Number(decimal(req.body.adjusted_value,4,{max:10000}))/10000;}
  const target=p.data.measurements?.find(r=>r.key===req.body.part);if(!target)fail('请先在本款尺寸表建立该部位');
  if(target.unit!==result.unit)fail('结果单位与部位单位不同，请先换算');
  if(req.body.calculator==='ease'&&target.basis!=='full')fail('松量计算输出成衣整围，请选择整围部位；半围需另行换算');
  const r=createRecord('calculation',{name:req.body.part,...result,applied_value:value,adjustment_reason:req.body.adjustment_reason||'',standard:p.data.standard_binding||null,size_source:p.data.size_binding||null},req,{projectId:p.id,state:'confirmed'});
  const measurements=p.data.measurements.map(row=>row.key===target.key?{...row,value,calculation_id:r.id}:row);
  return {record:r,project:revise(p,{...p.data,measurements},req,{action:'apply_calculation'})};
 }))));
 app.post('/api/products/projects/:id/patterns',ah(async(req,res)=>res.json(atomic(req,req.body,()=>{
  const p=writeProject(req.params.id,req);requireRevision(p,req.body);const b=req.body.data;object(b);text(b.name||'','纸样名称',120,true);validateFileArray([{file_id:b.file_id}],req);list(b.sizes||[],'适用尺码',30);text(b.note||'','纸样说明',3000);
  const previous=p.data.pattern_binding;
  const file=getDb().prepare('SELECT mime FROM product_files WHERE id=?').get(b.file_id);
  const r=createRecord('pattern',{...b,mime:file.mime,parent_id:previous?.id||null,edition:(previous?.edition||0)+1},req,{projectId:p.id,templateId:p.template_id,state:'confirmed'});
  return {record:r,project:revise(p,{...p.data,pattern_binding:{id:r.id,revision:r.revision,...r.data}},req,{action:'adopt_pattern'})};
 }))));
 app.post('/api/products/projects/:id/samples',ah(async(req,res)=>res.json(atomic(req,req.body,()=>{
  const p=writeProject(req.params.id,req);requireRevision(p,req.body);const rounds=childList(p.id,'sample'),number=rounds.length+1;
  text(req.body.name||'','样衣名称',120,true);text(req.body.maker||'','制作方',200);text(req.body.deadline||'','交期',30);if(req.body.cost!==''&&req.body.cost!=null)decimal(req.body.cost,2,{max:1e8});
  const r=createRecord('sample',{name:req.body.name,number,maker:req.body.maker||'',deadline:req.body.deadline||'',cost:req.body.cost??'',photos:[],measurements:[],notes:'',source:p.data,technical_signature:fingerprint(technicalBase(p.data))},req,{projectId:p.id,templateId:p.template_id});
  if(rounds[0])for(const issue of childList(p.id,'issue').filter(i=>i.data.round_id===rounds[0].id&&i.state!=='resolved'))createRecord('issue',{...issue.data,round_id:r.id,previous_id:issue.id,resolution:''},req,{projectId:p.id});
  return {record:r,project:revise(p,{...p.data,stage:'sampling'},req,{action:'start_sample'})};
 }))));
 app.post('/api/products/samples/:id/save',ah(async(req,res)=>res.json(atomic(req,req.body,()=>{
  const r=child(req.params.id,req,'sample');requireRevision(r,req.body);if(['accepted','stopped'].includes(r.state))fail('该轮已确认，请建立新轮次');
  const {photos=[],measurements=[],notes='',cost='',maker=r.data.maker,deadline=r.data.deadline}=req.body.data;text(maker||'','制作方',200);text(deadline||'','交期',30);const savedPhotos=validateFileArray(photos,req),savedMeasurements=validateMeasurements(measurements);text(notes,'试衣说明',5000);if(cost!=='')decimal(cost,2,{max:1e8});
  return {record:revise(r,{...r.data,photos:savedPhotos,measurements:savedMeasurements,notes,cost,maker,deadline},req)};
 }))));
 app.post('/api/products/samples/:id/decide',ah(async(req,res)=>res.json(atomic(req,req.body,()=>{
  const r=child(req.params.id,req,'sample');requireRevision(r,req.body);const status=req.body.status;
  if(!['needs_changes','needs_info','accepted','stopped'].includes(status)||['accepted','stopped'].includes(r.state))fail('请选择有效评审结论');
  if(status==='accepted'){
   if(!r.data.photos.length||!r.data.measurements.length||r.data.measurements.some(row=>row.value===''||row.value==null))fail('请补充实拍与实测记录再确认样衣');
   if(!r.data.source.measurements?.length||r.data.source.measurements.some(expected=>!r.data.measurements.some(actual=>actual.key===expected.key&&actual.unit===expected.unit&&actual.basis===expected.basis)))fail('实测记录需覆盖本轮成衣尺寸，并使用相同单位及整围/半围口径');
   if(childList(r.project_id,'issue').some(i=>i.data.round_id===r.id&&i.state!=='resolved'))fail('请先处理该轮未解决问题');
   if(req.body.confirm!==true)fail('请确认样衣评审结论');
  }
  text(req.body.note||'','评审结论',3000);
  return {record:revise(r,{...r.data,decision_note:req.body.note||'',decided_by:owner(req),decided_at:stamp()},req,{state:status,action:'decide_sample'})};
 }))));
 app.post('/api/products/samples/:id/issues',ah(async(req,res)=>res.json(atomic(req,req.body,()=>{
  const r=child(req.params.id,req,'sample');if(['accepted','stopped'].includes(r.state))fail('该轮已结束');const b=req.body.data;object(b);text(b.text||'','问题描述',3000,true);text(b.part||'','部位',80);
  if(b.photo_id&&!r.data.photos.some(f=>f.file_id===b.photo_id))fail('请关联本轮照片');
  for(const coord of [b.x,b.y])if(coord!=null&&(!Number.isFinite(coord)||coord<0||coord>1))fail('标记位置无效');
  const number=childList(r.project_id,'issue').filter(i=>i.data.round_id===r.id).reduce((max,i)=>Math.max(max,i.data.number||0),0)+1;return {record:createRecord('issue',{...b,number,round_id:r.id,resolution:''},req,{projectId:r.project_id})};
 }))));
 app.post('/api/products/issues/:id/resolve',ah(async(req,res)=>res.json(atomic(req,req.body,()=>{
  const r=child(req.params.id,req,'issue');requireRevision(r,req.body);const sample=getRecord(r.data.round_id,req,{kind:'sample'});if(['accepted','stopped'].includes(sample.state))fail('样衣轮次已结束');text(req.body.resolution||'','解决依据',3000,true);
  return {record:revise(r,{...r.data,resolution:req.body.resolution},req,{state:'resolved',action:'resolve_issue'})};
 }))));
 app.post('/api/products/projects/:id/productions',ah(async(req,res)=>res.json(atomic(req,req.body,()=>{
  const p=writeProject(req.params.id,req);requireRevision(p,req.body);const ready=readiness(p,req);if(!ready.ready)fail('请先补齐：'+ready.missing.join('、'),'PRODUCTION_NOT_READY',409);if(req.body.confirm!==true)fail('请确认本次生产采用资料');
  text(req.body.name||'','批次名称',120,true);text(req.body.maker||'','制作方',200);text(req.body.deadline||'','交期',30);
  for(const file of (p.data.pattern_binding?[p.data.pattern_binding]:[]))validateFileArray([file],req);
  const r=createRecord('production',{name:req.body.name,maker:req.body.maker||'',deadline:req.body.deadline||'',baseline:p.data,quote:ready.confirmed_quote.data,sample_id:ready.sample.id,quantities:p.data.skus.filter(s=>s.active!==false).map(s=>({key:s.key,code:s.code,color:s.color,size:s.size,quantity:s.quantity})),progress:[],accepted_quantity:0,notes:''},req,{projectId:p.id,templateId:p.template_id,state:'preparing'});
  return {record:r,project:revise(p,{...p.data,stage:'production'},req,{action:'start_production'})};
 }))));
 app.post('/api/products/productions/:id/progress',ah(async(req,res)=>res.json(atomic(req,req.body,()=>{
  const r=child(req.params.id,req,'production');requireRevision(r,req.body);if(r.state==='completed')fail('该批次已完成');
  const stages=['preparing','cutting','sewing','finishing','inspection','completed'];if(!stages.includes(req.body.stage))fail('生产阶段无效');
  const total=r.data.quantities.reduce((n,s)=>n+s.quantity,0);const quantity=req.body.quantity;if(!Number.isSafeInteger(quantity)||quantity<0||quantity>total)fail('阶段数量不能超过计划数量');text(req.body.note||'','进度说明',3000);
  if(req.body.stage==='completed'&&(req.body.confirm!==true||!req.body.note?.trim()))fail('请填写验收结论并确认完成');
  const progress=[...r.data.progress,{stage:req.body.stage,quantity,note:req.body.note||'',at:stamp(),by:owner(req)}];if(progress.length>500)fail('进度记录过多，请另建批次');
  const updated=revise(r,{...r.data,progress,accepted_quantity:req.body.stage==='completed'?quantity:0},req,{state:req.body.stage,action:'production_progress'});
  const p=writeProject(r.project_id,req);const others=childList(p.id,'production').filter(b=>b.id!==r.id);return {record:updated,project:revise(p,{...p.data,stage:req.body.stage==='completed'&&others.every(b=>b.state==='completed')?'completed':'production'},req,{action:'production_progress'})};
 }))));
 app.post('/api/products/files',ah(async(req,res)=>{
  const b=req.body;const name=text(b.name||'','文件名称',150,true);if(typeof b.base64!=='string'||b.base64.length>28*1024*1024||!/^[A-Za-z0-9+/]*={0,2}$/.test(b.base64))fail('文件应小于20MB且格式有效');
  const bytes=Buffer.from(b.base64,'base64');if(!bytes.length)fail('文件为空');if(bytes.length>20*1024*1024)fail('文件应小于20MB');const id=crypto.randomUUID();let file,mime,thumb;
  if(b.image===true){const result=await saveStudioImage(b.base64,`product_${id}.jpg`);file=result.image_path;thumb=result.thumb_path;mime='image/'+(file.split('.').pop()==='jpg'?'jpeg':file.split('.').pop());}
  else {const ext=path.extname(name).toLowerCase();if(!['.pdf','.dxf','.plt','.ai','.eps','.zip','.rul','.aama','.astm'].includes(ext))fail('支持 PDF、DXF、PLT、AI、EPS、ZIP、RUL 等纸样文件');if(ext==='.pdf'&&!bytes.subarray(0,5).equals(Buffer.from('%PDF-')))fail('PDF文件格式无效');
   file=`uploads/product-files/${id}${ext}`;const abs=path.join(getConfig().dataDir,file);fs.mkdirSync(path.dirname(abs),{recursive:true});fs.writeFileSync(abs,bytes);mime=ext==='.pdf'?'application/pdf':'application/octet-stream';}
  getDb().prepare('INSERT INTO product_files VALUES(?,?,?,?,?,?,?,?)').run(id,owner(req),file,thumb||null,name,mime,bytes.length,stamp());res.json({file:{id,file_id:id,name,image_path:b.image?file:null,thumb_path:thumb,mime,bytes:bytes.length}});
 }));
 app.get('/api/products/files/:id',ah(async(req,res)=>{
  const f=getDb().prepare('SELECT * FROM product_files WHERE id=?').get(req.params.id);if(!f||!productFileOwned(getDb(),f.path,owner(req)))fail('文件不存在','FILE_NOT_FOUND',404);const root=path.resolve(getConfig().dataDir),absolute=path.resolve(root,f.path);if(!absolute.startsWith(root+path.sep)||!fs.existsSync(absolute))fail('文件不存在','FILE_NOT_FOUND',404);
  res.set('Cache-Control','private, no-store');res.set('X-Content-Type-Options','nosniff');res.type(f.mime);if(req.query.preview==='1'&&f.mime==='application/pdf'){res.set('Content-Disposition','inline');return res.sendFile(absolute);}res.download(absolute,f.name);
 }));
}
