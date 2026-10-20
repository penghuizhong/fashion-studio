import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {getDb} from './db.js';
import {getConfig} from './config.js';
import {ah} from './asyncHandler.js';
import {styleTemplate,styleVersion} from './styleVersions.js';
import {DEFAULT_CAMERA} from '../../shared/photography.js';
import {atomic,owner,record,getRecord,createRecord,revise,fingerprint,fail,checkPath} from './productStore.js';
export const VIEW_SLOTS=[['front','正面'],['back','背面'],['side','侧面'],['side_right','另一侧'],['detail','细节']];
export function deliveryViews(t,versionId){return record(getDb().prepare("SELECT * FROM product_records WHERE kind='views' AND template_id=? AND json_extract(payload_json,'$.version_id')=? AND user_id=?").get(t.id,versionId,t.user_id));}
export function mountProductDelivery(app){
 app.get('/api/studio/templates/:id/delivery',ah(async(req,res)=>{
  const t=styleTemplate(req.params.id,req),v=styleVersion(t,Number(req.query.version_id)||t.work_version_id);
  const project=record(getDb().prepare("SELECT * FROM product_records WHERE kind='project' AND template_id=? AND user_id=?").get(t.id,t.user_id));
  res.json({views:deliveryViews(t,v.id),project,slots:VIEW_SLOTS});
 }));
 app.post('/api/studio/templates/:id/delivery/views',ah(async(req,res)=>res.json(atomic(req,req.body,()=>{
  const t=styleTemplate(req.params.id,req),b=req.body,v=styleVersion(t,b.version_id);if(t.lifecycle!=='active')fail('请先恢复款式');
  if(!VIEW_SLOTS.some(([key])=>key===b.slot))fail('请选择有效视角');
  const previous=deliveryViews(t,v.id);if((previous?.revision||0)!==b.expected_revision)fail('三视角资料已更新，请刷新后重试','PRODUCT_CONFLICT',409);
  const slots={...previous?.data.slots};
  if(b.remove===true)delete slots[b.slot];else{
   let image;
   if(b.source?.generation_id){
    const row=getDb().prepare("SELECT * FROM dna_generations WHERE id=? AND template_id=? AND COALESCE(user_rating,'')!='deleted' AND lifecycle IN ('active','archived')").get(b.source.generation_id,t.id);
    if(!row)fail('款式图片不存在','SOURCE_MISSING',404);
    if(row.design_version_id&&row.design_version_id!==v.id)fail('请选择当前设计版本的图片');
    const settings=JSON.parse(row.settings_json||'{}'),expected=b.slot==='side_right'?'side':b.slot;
    if(settings.delivery_slot&&settings.delivery_slot!==b.slot)fail('生成视角与采用位置不一致');
    if(!settings.delivery_slot&&settings.camera&&b.slot!=='detail'&&settings.camera.view!==expected)fail('图片记录的视角与该位置不一致');
    image={generation_id:row.id,task_item_id:row.task_item_id||null,image_path:row.image_path,thumb_path:row.thumb_path,provenance:row.design_version_id?'generated':'manual_legacy',camera:settings.camera||null,design_version_id:v.id,source:settings.source_path?{image_path:settings.source_path,generation_id:row.source_generation_id||null,version_id:settings.source_version_id||null}:null,references:settings.references||[]};
   } else if(b.source?.reference_id){
    const row=getDb().prepare('SELECT * FROM style_references WHERE id=? AND user_id=?').get(b.source.reference_id,t.user_id);
    if(!row)fail('参考图不存在','SOURCE_MISSING',404);
    image={reference_id:row.id,image_path:row.image_path,thumb_path:row.thumb_path,provenance:'manual_upload',design_version_id:v.id};
   }else if(b.source?.original===true){
    image={image_path:t.source_image_path,thumb_path:t.source_thumb_path,provenance:'manual_original',design_version_id:v.id};
   }else fail('请选择或上传该视角图片');
   checkPath(image.image_path,req);
   if(b.confirm!==true)fail('请确认该图片属于当前设计及所选视角');
   slots[b.slot]={...image,slot:b.slot,confirmed:true};
  }
  const data={version_id:v.id,version_number:v.number,slots};
  return {views:previous?revise(previous,data,req,{expected:b.expected_revision}):createRecord('views',data,req,{templateId:t.id})};
 }))));
 app.post('/api/studio/templates/:id/delivery',ah(async(req,res)=>res.json(atomic(req,req.body,()=>{
  const t=styleTemplate(req.params.id,req),v=styleVersion(t,req.body.version_id),views=deliveryViews(t,v.id);
  if(t.lifecycle!=='active')fail('请先恢复款式');
  if(!views||views.revision!==req.body.expected_revision)fail('三视角资料已变化，请重新核对','PRODUCT_CONFLICT',409);
  const slots=views.data.slots;if(['front','back','side'].some(key=>!slots[key]?.confirmed))fail('请先确认正面、背面、侧面三视角');
  const hashes=new Set();for(const slot of Object.values(slots)){checkPath(slot.image_path,req);const hash=crypto.createHash('sha256').update(fs.readFileSync(path.join(getConfig().dataDir,slot.image_path))).digest('hex');if(hashes.has(hash))fail('不同视角不能使用重复图片');hashes.add(hash);}
  if(req.body.consistency_confirmed!==true||req.body.inferred_confirmed!==true)fail('请核对三视角一致性及补全结构');
  const data={name:t.name,category:v.preset_id||v.category,template_id:t.id,version_id:v.id,version_number:v.number,dna:JSON.parse(v.dna_json),design_note:v.design_note||'',slots,description:String(req.body.description||'').slice(0,3000),confirmed_by:owner(req)};
  const existing=record(getDb().prepare("SELECT * FROM product_records WHERE kind='project' AND template_id=? AND user_id=?").get(t.id,t.user_id));
  if(existing?.lifecycle!=='active'&&existing)fail('请先恢复样衣项目','RESTORE_REQUIRED',409);
  if([existing?.data.delivery?.signature,existing?.data.pending_delivery?.signature].includes(fingerprint(data)))return {project:existing,reused:true};
  const delivery=createRecord('delivery',data,req,{templateId:t.id,state:'confirmed',projectId:existing?.id});
  const snapshot={id:delivery.id,revision:delivery.revision,signature:fingerprint(data),...data};
  const project=existing?revise(existing,{...existing.data,pending_delivery:snapshot},req,{action:'new_delivery'}):createRecord('project',{name:t.name,category:v.preset_id||v.category,delivery:snapshot,code:'',notes:'',process:'',measurements:[],colors:[],sizes:[],skus:[],materials:[],fees:[],currency:'CNY',deadline:'',stage:'preparing'},req,{templateId:t.id});
  return {project,delivery};
 }))));
}
