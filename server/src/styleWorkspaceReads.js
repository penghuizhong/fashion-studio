import crypto from 'node:crypto';
import { getDb } from './db.js';
import { ah } from './asyncHandler.js';
import { problem } from './exploreErrors.js';
import { styleTemplate, styleVersion, parse } from './styleVersions.js';
import { imageAvailability, templateAvailability } from './imageLifecycle.js';
import { recoverExploreJobs } from './exploreJobs.js';

export function progressJob(id) {
  const db = getDb();
  const j = db.prepare(`SELECT id,batch_id,status,created_at,json_extract(snapshot_json,'$.model.name') model_name,
    json_extract(snapshot_json,'$.style.version_id') version_id,json_extract(snapshot_json,'$.style.version_number') version_number,
    json_extract(snapshot_json,'$.style.op') op, json_extract(snapshot_json,'$.style.plan_id') plan_id, json_extract(snapshot_json,'$.style.plan_revision') plan_revision FROM explore_jobs WHERE id=?`).get(id);
  if (!j) return null;
  const rows = db.prepare('SELECT id,proposal_idx,status,result_json FROM explore_items WHERE job_id=? ORDER BY proposal_idx').all(id);
  const renders = rows.map(r => { const result = parse(r.result_json); return { item_id:r.id,proposal_idx:r.proposal_idx,status:r.status,error:result.error || '',price:result.price || 0,...(r.status==='succeeded'?imageAvailability({image_path:result.image_path,thumb_path:result.thumb_path,generation_id:result.generation_id}):{}) }; });
  const result = { id:j.id,batch_id:j.batch_id,status:j.status,created_at:j.created_at,
    snapshot:{model:{name:j.model_name},style:{version_id:j.version_id,version_number:j.version_number,op:j.op,plan_id:j.plan_id,plan_revision:j.plan_revision}},
    renders,total:rows.length,completed:rows.filter(r=>!['running','queued'].includes(r.status)).length,
    cost_actual:renders.reduce((n,r)=>n+(r.status==='succeeded'?r.price:0),0) };
  result.revision = crypto.createHash('sha256').update(JSON.stringify(result)).digest('hex').slice(0,16);
  return result;
}
export function workspaceSummary(t, query) {
  const db = getDb();
  const selected = styleVersion(t, Number(query.version_id) || t.work_version_id);
  const cover = t.cover_generation_id ? db.prepare("SELECT * FROM dna_generations WHERE id=? AND template_id=? AND lifecycle NOT IN ('trash','deleted')").get(t.cover_generation_id,t.id) : null;
  const requested = Number(query.image_id) ? db.prepare("SELECT * FROM dna_generations WHERE id=? AND template_id=? AND lifecycle!='deleted'").get(Number(query.image_id),t.id) : null;
  const images = [...new Map([cover, requested].filter(Boolean).map(i=>[i.id,imageAvailability(i)])).values()];
  const ids = [...new Set([selected.id,t.work_version_id,Number(query.edit_parent_id)||null,...images.map(i=>i.design_version_id)].filter(Boolean))];
  const versions = ids.map(id=>styleVersion(t,id));
  // Parent labels need metadata, not another full DNA snapshot.
  for (const parent of [...new Set(versions.map(v=>v.parent_id).filter(Boolean))]) if(!ids.includes(parent)) {
    const v=db.prepare('SELECT id,number,parent_id,status,created_at FROM style_versions WHERE id=? AND template_id=?').get(parent,t.id);if(v)versions.push(v);
  }
  recoverExploreJobs();
  const jobs = t.style_batch_id ? db.prepare("SELECT id FROM explore_jobs WHERE batch_id=? AND (status IN ('running','queued') OR id=(SELECT id FROM explore_jobs WHERE batch_id=? ORDER BY rowid DESC LIMIT 1)) ORDER BY rowid DESC").all(t.style_batch_id,t.style_batch_id).map(j=>progressJob(j.id)) : [];
  return {template:templateAvailability(t),versions:versions.sort((a,b)=>b.number-a.number),images,jobs,
    totals:{versions:db.prepare('SELECT COUNT(*) n FROM style_versions WHERE template_id=?').get(t.id).n,
      images:db.prepare("SELECT COUNT(*) n FROM dna_generations WHERE template_id=? AND lifecycle!='deleted'").get(t.id).n,
      jobs:t.style_batch_id?db.prepare('SELECT COUNT(*) n FROM explore_jobs WHERE batch_id=?').get(t.style_batch_id).n:0}};
}
export function mountWorkspaceReads(app) {
  app.get('/api/studio/templates/:id/workspace/progress',ah(async(req,res)=>{
    const t=styleTemplate(req.params.id,req), db=getDb();
    let known={};try{known=JSON.parse(String(req.query.known||'{}'));}catch{}
    if(!known||typeof known!=='object'||Array.isArray(known)||Object.keys(known).length>20)throw problem('INVALID_QUERY','任务选择无效');
    recoverExploreJobs();
    const ids=t.style_batch_id?db.prepare("SELECT id FROM explore_jobs WHERE batch_id=? AND status IN ('running','queued') ORDER BY rowid DESC LIMIT 16").all(t.style_batch_id).map(r=>r.id):[];
    const changed=[];
    for(const id of new Set([...ids,...Object.keys(known)])){
      if(!db.prepare('SELECT 1 FROM explore_jobs WHERE id=? AND batch_id=?').get(id,t.style_batch_id))continue;
      const j=progressJob(id);if(j.revision!==known[id])changed.push(j);
    }
    res.json({jobs:changed,active_ids:ids});
  }));
  app.get('/api/studio/templates/:id/workspace/:collection',ah(async(req,res)=>{
    const t=styleTemplate(req.params.id,req), db=getDb(), collection=req.params.collection;
    if(collection==='layouts'){throw problem('FEATURE_RETIRED','图文排版功能已下线，请使用原图查看与下载',410);}
    if(!['versions','images','jobs'].includes(collection))throw problem('INVALID_QUERY','记录类型无效',404);
    const page=Math.max(1,Number.parseInt(req.query.page)||1),limit=Math.min(50,Math.max(1,Number.parseInt(req.query.limit)||20));
    const table={versions:'style_versions',images:'dna_generations',jobs:'explore_jobs'}[collection];
    const cond=[collection==='jobs'?'batch_id=?':'template_id=?'], args=[collection==='jobs'?t.style_batch_id:t.id];
    if(collection==='images'){
      cond.push("COALESCE(user_rating,'')!='deleted'");
      const state=req.query.state||'active';if(!['active','archived','trash'].includes(state))throw problem('INVALID_QUERY','图片状态无效');
      if(req.query.ids&&!req.query.state)cond.push("lifecycle IN ('active','archived')");else{cond.push('lifecycle=?');args.push(state);}
      if(req.query.version_id){styleVersion(t,Number(req.query.version_id));cond.push('(design_version_id=? OR design_version_id IS NULL)');args.push(Number(req.query.version_id));}
      if(req.query.search){cond.push('CAST(id AS TEXT) LIKE ?');args.push('%'+String(req.query.search).slice(0,100)+'%');}
      if(req.query.ids){const ids=String(req.query.ids).split(',').map(Number);if(ids.length>20||ids.some(n=>!Number.isSafeInteger(n)||n<1))throw problem('INVALID_QUERY','图片选择无效');cond.push(`id IN (${ids.map(()=>'?').join(',')})`);args.push(...ids);}
    }
    const where=cond.join(' AND '),total=db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE ${where}`).get(...args).n;
    const order=collection==='versions'?'number':'rowid';
    const fields=collection==='jobs'?'id':collection==='versions'?'style_versions.*, (SELECT p.number FROM style_versions p WHERE p.id=style_versions.parent_id) AS parent_number':'*';
    const rows=db.prepare(`SELECT ${fields} FROM ${table} WHERE ${where} ORDER BY ${order} DESC LIMIT ? OFFSET ?`).all(...args,limit,(page-1)*limit);
    res.json({items:collection==='images'?rows.map(imageAvailability):collection==='jobs'?rows.map(j=>progressJob(j.id)):rows,total,page,limit});
  }));
}
