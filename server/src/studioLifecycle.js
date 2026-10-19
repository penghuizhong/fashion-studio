import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { getDb } from './db.js';
import { getConfig } from './config.js';
import { ah } from './asyncHandler.js';
import { problem } from './exploreErrors.js';
import { sharedImageFile,studioFileExists } from './imageLifecycle.js';
const tables={templates:'style_dna_templates',generations:'dna_generations',explore:'exploration_batches'};
export const lifecycleState=(value)=>['active','archived','trash'].includes(value)?value:'active';
export function lifecycleObject(kind,id,req){
 const table=tables[kind];if(!table)throw problem('INVALID_OBJECT','对象类型无效');
 const row=getConfig().multiUser?getDb().prepare(`SELECT * FROM ${table} WHERE id=? AND user_id=?`).get(id,req.userId||'local'):getDb().prepare(`SELECT * FROM ${table} WHERE id=?`).get(id);
 if(!row || (kind==='explore'&&row.workflow_kind!=='explore'))throw problem('OBJECT_NOT_FOUND','记录不存在',404);
 return row;
}
function busy(kind,row){
 const db=getDb();
 const batch=kind==='templates'?row.style_batch_id:kind==='explore'?row.id:null;
 if(batch && db.prepare("SELECT 1 FROM explore_jobs WHERE batch_id=? AND (status IN ('running','uncertain') OR EXISTS(SELECT 1 FROM explore_items WHERE job_id=explore_jobs.id AND status='uncertain')) LIMIT 1").get(batch))return true;
 if(kind==='generations')return !!db.prepare(`SELECT 1 FROM explore_jobs j,json_tree(j.snapshot_json) v WHERE (j.status IN ('running','uncertain') OR EXISTS(SELECT 1 FROM explore_items WHERE job_id=j.id AND status='uncertain')) AND v.type='text' AND v.value=? LIMIT 1`).get(row.image_path);
 return false;
}
export function lifecycleImpact(kind,row){
 const db=getDb();
 return {kind,id:row.id,lifecycle:row.lifecycle,busy:busy(kind,row),versions:kind==='templates'?db.prepare('SELECT COUNT(*) n FROM style_versions WHERE template_id=?').get(row.id).n:0,images:kind==='templates'?db.prepare("SELECT COUNT(*) n FROM dna_generations WHERE template_id=? AND lifecycle!='deleted'").get(row.id).n:kind==='generations'?1:0,layouts:kind==='templates'?db.prepare('SELECT COUNT(*) n FROM style_layouts WHERE template_id=?').get(row.id).n:0,files_policy:'仅移除记录，共享图片及历史引用保留；清理空间是独立操作'};
}
export function changeLifecycle(kind,id,req,action,confirm){
 const db=getDb(),table=tables[kind];
 return db.transaction(()=>{
  const row=lifecycleObject(kind,id,req);
  if(!['archive','trash','restore','activate','delete'].includes(action))throw problem('INVALID_ACTION','操作无效');
  if(row.lifecycle==='deleted'){
   if(action==='delete')return {ok:true,reused:true};
   throw problem('OBJECT_DELETED','记录已永久移除，不能还原',409);
  }
  let next=row.lifecycle,previous=row.restore_lifecycle;
  if(action==='archive')next='archived';
  if(action==='activate')next='active';
  if(action==='trash'){next='trash';if(row.lifecycle!=='trash')previous=row.lifecycle;}
  if(action==='restore')next=row.lifecycle==='trash'?lifecycleState(previous):'active';
  if(action==='delete'){
   if(row.lifecycle!=='trash'||confirm!=='永久删除')throw problem('DELETE_CONFIRM_REQUIRED','请先移入回收站并输入“永久删除”');
   if(busy(kind,row))throw problem('TASK_IN_PROGRESS','存在生成中或待核对任务，请完成核对后再永久删除',409);
   next='deleted';
   if(kind==='templates'){
    db.prepare("UPDATE dna_generations SET lifecycle='deleted',archived=1,user_rating='deleted' WHERE template_id=?").run(row.id);
    // Keep immutable design and billing history as tombstones; never unlink here.
   }
  }
  if(row.lifecycle==='trash'&&!['restore','delete','trash'].includes(action))throw problem('RESTORE_REQUIRED','请先从回收站还原',409);
  const archived=next==='active'?0:1;
  if(kind==='templates')db.prepare(`UPDATE ${table} SET lifecycle=?,restore_lifecycle=?,updated_at=? WHERE id=?`).run(next,previous,new Date().toISOString(),row.id);
  else if(kind==='generations')db.prepare(`UPDATE ${table} SET lifecycle=?,restore_lifecycle=?,archived=?,user_rating=CASE WHEN ?='deleted' THEN 'deleted' ELSE user_rating END WHERE id=?`).run(next,previous,archived,next,row.id);
  else db.prepare(`UPDATE ${table} SET lifecycle=?,restore_lifecycle=?,archived=? WHERE id=?`).run(next,previous,archived,row.id);
  if(kind==='generations'&&next==='deleted')db.prepare('UPDATE style_dna_templates SET cover_generation_id=NULL WHERE cover_generation_id=?').run(row.id);
  db.prepare('INSERT INTO studio_lifecycle_events(user_id,object_type,object_id,action,created_at) VALUES(?,?,?,?,?)').run(req.userId||'local',kind,String(row.id),action,new Date().toISOString());
  return {ok:true,lifecycle:next,files_retained:true};
 }).immediate();
}
export function mountStudioLifecycle(app){
 for(const kind of Object.keys(tables)){
  app.get(`/api/studio/${kind}/:id/impact`,ah(async(req,res)=>res.json({ok:true,impact:lifecycleImpact(kind,lifecycleObject(kind,req.params.id,req))})));
  app.post(`/api/studio/${kind}/:id/lifecycle`,ah(async(req,res)=>res.json(changeLifecycle(kind,req.params.id,req,req.body.action,req.body.confirm))));
 }
 app.post('/api/studio/assets/lifecycle',ah(async(req,res)=>{
  const {ids,action,confirm}=req.body||{};
  if(!Array.isArray(ids)||!ids.length||ids.length>200||ids.some(id=>!Number.isSafeInteger(id)||id<=0)||new Set(ids).size!==ids.length)throw problem('INVALID_SELECTION','选择1–200条不同的记录');
  const results=getDb().transaction(()=>ids.map(id=>changeLifecycle('generations',id,req,action,confirm))).immediate();
  res.json({ok:true,changed:results.length});
 }));
 app.post('/api/studio/generations/:id/cleanup-files',ah(async(req,res)=>{
  const db=getDb(),moves=[];
  try{
   const result=db.transaction(()=>{
    const g=lifecycleObject('generations',req.params.id,req);
    if(g.lifecycle!=='deleted'||req.body.confirm!=='清理文件')throw problem('CLEANUP_CONFIRM_REQUIRED','仅永久移除记录后可确认“清理文件”');
    if(busy('generations',g)||sharedImageFile(db,g))return {ok:true,retained:true,message:'文件仍被其他内容或历史任务引用，已保留'};
    const idRef=db.prepare(`SELECT 1 FROM style_dna_templates WHERE cover_generation_id=? AND lifecycle!='deleted'
      UNION ALL SELECT 1 FROM dna_generations WHERE source_generation_id=? AND lifecycle!='deleted'
      UNION ALL SELECT 1 FROM style_layouts l JOIN style_dna_templates t ON t.id=l.template_id,json_each(json_extract(l.config_json,'$.selected')) j WHERE j.value=? AND t.lifecycle!='deleted' LIMIT 1`).get(g.id,g.id,g.id);
    if(idRef)return {ok:true,retained:true,message:'文件仍被封面、底图或排版引用，已保留'};
    const trash=path.resolve(getConfig().dataDir,'.style-trash');fs.mkdirSync(trash,{recursive:true});
    for(const file of new Set([g.image_path,g.thumb_path].filter(Boolean))){if(!studioFileExists(file))continue;const from=path.resolve(getConfig().dataDir,file),to=path.join(trash,crypto.randomUUID());fs.renameSync(from,to);moves.push([from,to]);}
    db.prepare('INSERT INTO studio_lifecycle_events(user_id,object_type,object_id,action,created_at) VALUES(?,?,?,?,?)').run(req.userId||'local','generations',String(g.id),'cleanup-files',new Date().toISOString());
    return {ok:true,retained:false,message:'未引用文件已清理'};
   }).immediate();
   for(const [,to] of moves)try{fs.unlinkSync(to);}catch{}
   res.json(result);
  }catch(e){for(const [from,to] of moves.reverse())if(fs.existsSync(to))fs.renameSync(to,from);throw e;}
 }));
}
