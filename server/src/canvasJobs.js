import { canvasCrop, canvasSourceBytes } from './canvasImages.js';
import { canvasAnalysisSpec, planCanvasRun } from './canvasAgent.js';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { getDb } from './db.js';
import { getConfig } from './config.js';
import { ah } from './asyncHandler.js';
import { problem } from './exploreErrors.js';
import { resolveExploreModel, availableModels } from './exploreModels.js';
import { chooseOutput } from './imageCapabilities.js';
import { imageTaskAllowed } from '../../shared/imageOptions.js';
import { generateImage, saveStudioImage } from './image.js';
import { addLedger, getBalance } from './points.js';
import { canvasProject, registerCanvasAsset } from './canvas.js';
import { localImage } from './styleWorkspace.js';
import { studioFileExists } from './imageLifecycle.js';

const now=()=>new Date().toISOString();
const owner=req=>req.userId||'local';
const digest=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const read=row=>JSON.parse(row.input_json);
const running=new Set();
// Personal single-user keys stay in memory only, matching the existing API contract.
const requestContexts=new Map();
let draining=false;
function publicRun(row) {
  const {input_json,result_json,...safe}=row;
  return {...safe,input:read(row),result:JSON.parse(result_json)};
}
function requireRun(id,req) {
  const row=getDb().prepare('SELECT * FROM canvas_runs WHERE id=? AND user_id=?').get(id,owner(req));
  if(!row)throw problem('CANVAS_RUN_NOT_FOUND','任务不存在',404);
  return row;
}
function release(row) {
  if(row.reserved>0)addLedger(row.user_id,row.reserved,'canvas_release','canvas_run',row.id,{accountingDelta:0});
}
export function recoverCanvasRuns() {
  const db=getDb();
  db.transaction(()=>{
    const rows=db.prepare("SELECT * FROM canvas_runs WHERE status='running' AND lease_until<?").all(Date.now());
    for(const row of rows){
      const q=read(row),steps=db.prepare('SELECT * FROM canvas_steps WHERE run_id=? ORDER BY sequence').all(row.id);
      const planned=steps.find(s=>s.sequence===0&&s.status==='succeeded'),plan=planned?JSON.parse(planned.output_json):null;
      const brain=plan&&Number.isSafeInteger(plan.charge)?Math.max(0,Math.min(q.analysis?.budget||0,plan.charge)):0;
      const imageDispatched=steps.some(s=>s.sequence===1),analysisDispatched=steps.some(s=>s.sequence===0);
      const uncertain=imageDispatched||analysisDispatched&&!planned;
      const hold=uncertain?(imageDispatched?q.imageUnit:(q.analysis?.budget||0)):0;
      const refund=row.reserved-hold-brain;
      if(refund>0)addLedger(row.user_id,refund,'canvas_release','canvas_run',row.id,{accountingDelta:0});
      if(brain>0)addLedger(row.user_id,0,'canvas_settle','canvas_run',row.id,{accountingDelta:-brain,model:q.analysis?.upstreamModel});
      const result={analysis:plan,code:uncertain?'RESULT_UNCERTAIN':'INTERRUPTED',error:uncertain?'执行中断，供应商结果待核对，请勿重复生成；管理员核对后可退款':'任务中断，未派发的图片生成额度已释放'};
      db.prepare("UPDATE canvas_runs SET status=?,result_json=?,reserved=?,settled=?,updated_at=? WHERE id=? AND status='running'").run(uncertain?'uncertain':'failed',JSON.stringify(result),hold,brain,now(),row.id);
    }
  })();
}
function sourceManifest(req,projectId,references) {
  if(!Array.isArray(references)||references.length>16)throw problem('CANVAS_REFERENCES_INVALID','参考图片数量无效');
  if(new Set(references.map(r=>r?.assetId)).size!==references.length)throw problem('CANVAS_REFERENCES_DUPLICATE','同一图片只需引用一次');
  let totalBytes=0;
  return references.map((ref,i)=>{
    if(!ref||!['reference','model','garment','style'].includes(ref.role||'reference'))throw problem('CANVAS_ROLE_INVALID','图片角色无效');
    const asset=getDb().prepare('SELECT a.* FROM canvas_assets a JOIN canvas_project_assets p ON p.asset_id=a.id WHERE a.id=? AND a.user_id=? AND p.project_id=?').get(ref.assetId,owner(req),projectId);
    if(!asset||!studioFileExists(asset.image_path))throw problem('CANVAS_SOURCE_MISSING',`图${i+1}文件不可用，请重新选择`,404);
    totalBytes+=fs.statSync(localImage(asset.image_path)).size;
    if(totalBytes>32*1024*1024)throw problem('CANVAS_INPUT_TOO_LARGE','参考图总量超过32MB，请先缩小图片');
    const fingerprint=digest(fs.readFileSync(localImage(asset.image_path)));
    if(ref.assetVersion!==asset.fingerprint||fingerprint!==asset.fingerprint)throw problem('CANVAS_SOURCE_CHANGED',`图${i+1}已变化，请重新添加`,409);
    return {assetId:asset.id,assetVersion:fingerprint,path:asset.image_path,width:asset.width,height:asset.height,shapeId:typeof ref.shapeId==='string'?ref.shapeId.slice(0,150):null,crop:canvasCrop(ref.crop),flipX:ref.flipX===true,flipY:ref.flipY===true,role:ref.role||'reference',number:i+1,name:asset.name};
  });
}
function promptFor(message,sources) {
  return [message,sources.length?'实际附件按以下顺序提供：'+sources.map(s=>`图${s.number}：${{reference:'参考图',model:'模特身份参考',garment:'服装款式参考',style:'视觉风格参考'}[s.role]}`).join('；'):'',sources.some(s=>s.role==='model')?'使用实际模特参考图保留人物身份、脸部及发型；按照用户要求修改服装或场景。':'',sources.some(s=>s.role==='garment')?'服装结构、颜色与细节以实际服装参考图为准。':''].filter(Boolean).join('\n');
}
export function makeCanvasQuote(req,projectId,body) {
  canvasProject(projectId,req);
  let recipe;
  if(body.recipeId){
    const row=getDb().prepare('SELECT * FROM canvas_recipes WHERE id=? AND user_id=?').get(body.recipeId,owner(req));
    if(!row)throw problem('CANVAS_RECIPE_NOT_FOUND','工作流不存在',404);
    recipe=JSON.parse(row.definition_json);
    if(!Array.isArray(body.references)||body.references.length!==recipe.slots.length)throw problem('CANVAS_RECIPE_INPUT_INVALID',`此工作流需要 ${recipe.slots.length} 张输入图片`);
    body={...body,message:recipe.message,modelId:recipe.modelId,size:recipe.size,quality:recipe.quality,analysisModelId:null,references:body.references.map((r,i)=>({...r,role:recipe.slots[i].role}))};
  }
  if(typeof body.message!=='string'||!body.message.trim()||body.message.length>4000)throw problem('CANVAS_MESSAGE_INVALID','请填写1～4000字的生成要求');
  const sources=sourceManifest(req,projectId,body.references||[]), model=resolveExploreModel(req,body.modelId,'image');
  if(!imageTaskAllowed(model.capabilities,sources.length))throw problem('CANVAS_MODEL_INCOMPATIBLE','所选模型不支持当前图片数量，请更换模型或移除引用',422);
  const output=chooseOutput(model,body.size||model.sizes[0],body.quality||'');
  const analysis=canvasAnalysisSpec(req,body,sources);
  const payload={analysis,imageUnit:model.billable?output.unit:0,message:body.message.trim(),prompt:promptFor(body.message.trim(),sources),sources,modelId:model.id,modelName:model.name,signature:model.config_signature,size:output.size,quality:output.quality,unit:(model.billable?output.unit:0)+(analysis?.budget||0),quotedUnit:output.unit,billable:model.billable};
  if(body.brandKitId&&!recipe){const kit=getDb().prepare('SELECT * FROM canvas_brand_kits WHERE id=? AND user_id=?').get(body.brandKitId,owner(req));if(!kit)throw problem('CANVAS_BRAND_NOT_FOUND','品牌套件不存在',404);payload.brand={name:kit.name,...JSON.parse(kit.definition_json)};payload.prompt+='\n品牌视觉要求：'+JSON.stringify(payload.brand);}
  if(recipe){payload.prompt=recipe.executionPrompt;payload.recipeId=body.recipeId;}
  const id=crypto.randomUUID(),expiresAt=Date.now()+300000;
  getDb().prepare('INSERT INTO canvas_quotes VALUES(?,?,?,?,?,?)').run(id,projectId,owner(req),JSON.stringify(payload),expiresAt,now());
  return {id,expiresAt,credits:payload.unit,payload};
}
export function startCanvasRun(req,projectId,body,allowBusy=false) {
  const db=getDb();canvasProject(projectId,req);
  if(typeof body.requestKey!=='string'||!/^[A-Za-z0-9_-]{8,100}$/.test(body.requestKey))throw problem('CANVAS_REQUEST_KEY_REQUIRED','缺少有效请求标识');
  const byKey=db.prepare('SELECT * FROM canvas_runs WHERE user_id=? AND request_key=?').get(owner(req),body.requestKey);
  if(byKey&&byKey.quote_id!==body.quoteId)throw problem('CANVAS_REQUEST_KEY_REUSED','请求标识已绑定其他报价',409);
  const existing=byKey||db.prepare('SELECT * FROM canvas_runs WHERE user_id=? AND quote_id=?').get(owner(req),body.quoteId||'');
  if(existing){if(existing.project_id!==projectId)throw problem('CANVAS_REQUEST_KEY_REUSED','请求标识已用于其他画板',409);return publicRun(existing);}
  const quote=db.prepare('SELECT * FROM canvas_quotes WHERE id=? AND project_id=? AND user_id=?').get(body.quoteId,projectId,owner(req));
  if(!quote||quote.expires_at<Date.now())throw problem('CANVAS_QUOTE_EXPIRED','报价已失效，请重新确认',409);
  const q=JSON.parse(quote.payload_json),model=resolveExploreModel(req,q.modelId,'image'),output=chooseOutput(model,q.size,q.quality);
  if(model.config_signature!==q.signature||output.unit!==q.quotedUnit||model.billable!==q.billable)throw problem('CANVAS_QUOTE_CHANGED','模型配置或价格已变化，请重新报价',409);
  sourceManifest(req,projectId,q.sources);
  const id=crypto.randomUUID(),stamp=now();
  db.transaction(()=>{
    const unresolved=db.prepare("SELECT input_json FROM canvas_runs WHERE user_id=? AND project_id=? AND status='uncertain'").all(owner(req),projectId);
    if(unresolved.some(row=>{const old=JSON.parse(row.input_json);return old.message===q.message&&old.modelId===q.modelId&&JSON.stringify(old.sources.map(s=>[s.assetId,s.assetVersion,s.crop,s.role]))===JSON.stringify(q.sources.map(s=>[s.assetId,s.assetVersion,s.crop,s.role]));}))throw problem('RESULT_UNCERTAIN','相同图片与要求的任务结果待核对，请勿重复生成',409);
    if(!allowBusy&&db.prepare("SELECT 1 FROM canvas_runs WHERE user_id=? AND status IN ('queued','running')").get(owner(req)))throw problem('CANVAS_RUN_BUSY','已有任务执行中，请等待完成或停止后再提交',409);
    if(q.unit>0&&getBalance(owner(req))<q.unit)throw problem('POINTS_INSUFFICIENT','积分不足，请充值或更换模型',422);
    if(q.unit>0)addLedger(owner(req),-q.unit,'canvas_reserve','canvas_run',id,{accountingDelta:0});
    db.prepare('INSERT INTO canvas_runs(id,project_id,user_id,request_key,quote_id,status,input_json,reserved,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,projectId,owner(req),body.requestKey,quote.id,'queued',quote.payload_json,q.unit,stamp,stamp);
  })();
  if(q.analysis?.transientPersonal)requestContexts.set(id,Object.fromEntries(['x-openrouter-key','x-api-base-url','x-api-provider'].map(key=>[key,req.headers[key]])));
  setImmediate(()=>drainCanvasJobs().catch(()=>{}));
  return publicRun(db.prepare('SELECT * FROM canvas_runs WHERE id=?').get(id));
}
async function execute(row) {
  const db=getDb(),q=read(row);let attempted=false,imageDispatched=false,generated=null,brainCharge=0,analysis=null;
  const step=(sequence,tool,status,input,output={})=>db.prepare('INSERT INTO canvas_steps(id,run_id,sequence,tool,status,input_json,output_json) VALUES(?,?,?,?,?,?,?) ON CONFLICT(run_id,sequence) DO UPDATE SET tool=excluded.tool,status=excluded.status,output_json=excluded.output_json').run(`${row.id}:${sequence}`,row.id,sequence,tool,status,JSON.stringify(input),JSON.stringify(output));
  const heartbeat=setInterval(()=>{try{db.prepare("UPDATE canvas_runs SET lease_until=? WHERE id=? AND status='running'").run(Date.now()+600000,row.id);}catch{}},30000);heartbeat.unref();
  try {
    const req={userId:row.user_id==='local'?null:row.user_id,headers:requestContexts.get(row.id)||{}};
    if(q.analysis?.transientPersonal&&!req.headers['x-openrouter-key'])throw problem('CANVAS_PERSONAL_KEY_LOST','服务重启后个人 Key 已从内存清除，请重新配置后提交；本次未执行图片生成');
    const model=resolveExploreModel(req,q.modelId,'image');
    if(model.config_signature!==q.signature)throw problem('CANVAS_MODEL_CHANGED','模型配置已变化，任务未执行，额度已退回');
    const bytes=[];let sourceBytes=0;
    for(const source of q.sources){const buffer=await canvasSourceBytes(source);sourceBytes+=buffer.length;if(sourceBytes>32*1024*1024)throw problem('CANVAS_INPUT_TOO_LARGE','处理后的参考图总量超过32MB，请缩小图片后重试');bytes.push(buffer.toString('base64'));}
    let prompt=q.prompt;
    if(q.analysis){
      const update=progress=>db.prepare('UPDATE canvas_runs SET result_json=?,updated_at=? WHERE id=?').run(JSON.stringify({analysis:{status:'running',message:progress?.message||'正在调用模型'}}),now(),row.id);
      update();step(0,'plan_image','running',{message:q.message,sources:q.sources});
      analysis=await planCanvasRun(req,row,q,update,()=>{attempted=true;});brainCharge=analysis.charge;
      step(0,analysis.tool,'succeeded',{message:q.message,sources:q.sources},analysis);
      db.prepare('UPDATE canvas_runs SET result_json=?,updated_at=? WHERE id=?').run(JSON.stringify({analysis:{...analysis,status:'succeeded'}}),now(),row.id);
      if(analysis.tool==='request_clarification'){
        db.transaction(()=>{const current=db.prepare('SELECT * FROM canvas_runs WHERE id=?').get(row.id);const refund=current.reserved-brainCharge;if(refund>0)addLedger(row.user_id,refund,'canvas_release','canvas_run',row.id,{accountingDelta:0});if(brainCharge>0)addLedger(row.user_id,0,'canvas_settle','canvas_run',row.id,{accountingDelta:-brainCharge});db.prepare("UPDATE canvas_runs SET status='needs_input',reserved=0,settled=?,result_json=?,updated_at=? WHERE id=?").run(brainCharge,JSON.stringify({question:analysis.question,analysis}),now(),row.id);})();return;
      }
      prompt=promptFor(analysis.prompt,q.sources)+(q.brand?"\n品牌视觉要求："+JSON.stringify(q.brand):'');
      // Stop during planning prevents the image dispatch, while retaining actual analysis cost.
      attempted=false;
      if(db.prepare('SELECT stop_requested FROM canvas_runs WHERE id=?').get(row.id).stop_requested)throw problem('CANVAS_STOPPED_BEFORE_IMAGE','已停止图片生成，仅结算已完成的分析');
      attempted=false;
    }
    step(1,'generate_image','running',{prompt,sources:q.sources,modelId:q.modelId,size:q.size,quality:q.quality});
    attempted=true;
    imageDispatched=true;
    generated=await generateImage({userId:req.userId,modelId:model.id,prompt,size:q.size,quality:q.quality,sourceImageBase64:bytes[0]||null,referenceImages:bytes.slice(1),executionModel:model,deferBilling:true});
    const files=await saveStudioImage(generated.imageBase64,`canvas-result-${row.id}`);
    const asset=await registerCanvasAsset(req,files,q.message.slice(0,60),'generated');
    db.transaction(()=>{
      const current=db.prepare('SELECT * FROM canvas_runs WHERE id=?').get(row.id);
      if(current.status!=='running')return;
      db.prepare('INSERT OR IGNORE INTO canvas_project_assets VALUES(?,?)').run(row.project_id,asset.id);
      for(const source of q.sources)db.prepare('INSERT OR IGNORE INTO canvas_asset_events VALUES(?,?,?)').run(row.id,source.assetId,asset.id);
      const actual=q.imageUnit+brainCharge,refund=current.reserved-actual;
      if(refund>0)addLedger(row.user_id,refund,'canvas_release','canvas_run',row.id,{accountingDelta:0});
      if(q.imageUnit>0)addLedger(row.user_id,0,'canvas_settle','canvas_run',row.id,{accountingDelta:-q.imageUnit,model:model.model_id});
      if(brainCharge>0)addLedger(row.user_id,0,'canvas_settle','canvas_run',row.id,{accountingDelta:-brainCharge,model:q.analysis.upstreamModel,tokensInput:analysis?.usage?.input,tokensOutput:analysis?.usage?.output});
      step(1,'generate_image','succeeded',{},{assetId:asset.id});
      const result={analysis,asset,shapeId:`shape:canvas_result_${row.id}`,trace:{...generated.request_transport,model:model.model_id,prompt,sources:q.sources.map(s=>({assetId:s.assetId,assetVersion:s.assetVersion,role:s.role,number:s.number}))},stopRequested:!!current.stop_requested};
      db.prepare("UPDATE canvas_runs SET status='succeeded',result_json=?,settled=?,reserved=0,updated_at=? WHERE id=?").run(JSON.stringify(result),actual,now(),row.id);
    })();
  } catch(e) {
    if(e.analysisComplete){brainCharge=e.analysisCharge||0;attempted=false;}
    // After dispatch, every ambiguous error requires reconciliation. Never silently resubmit.
    const explicitRejection=Number.isInteger(e.status)&&e.status>=400&&e.status<500&&e.status!==408;
    const uncertain=attempted&&!explicitRejection;
    db.transaction(()=>{
      const current=db.prepare('SELECT * FROM canvas_runs WHERE id=?').get(row.id);if(current.status!=='running')return;
      const held=uncertain?(imageDispatched?q.imageUnit:(q.analysis?.budget||current.reserved)):0;
      const refund=current.reserved-held-brainCharge;
      if(refund>0)addLedger(row.user_id,refund,'canvas_release','canvas_run',row.id,{accountingDelta:0});
      if(brainCharge>0)addLedger(row.user_id,0,'canvas_settle','canvas_run',row.id,{accountingDelta:-brainCharge,model:q.analysis?.upstreamModel});
      db.prepare("UPDATE canvas_steps SET status=?,output_json=? WHERE run_id=? AND status='running'").run(uncertain?'uncertain':'failed',JSON.stringify({code:e.code||'EXECUTION_INTERRUPTED'}),row.id);
      const result={analysis,code:uncertain?'RESULT_UNCERTAIN':(e.code||'GENERATION_REJECTED'),error:uncertain?'供应商结果待确认，请勿重复提交；管理员核对后可退款':(e.publicMessage||'生成请求被拒绝，预留积分已退回')};
      db.prepare("UPDATE canvas_steps SET status=? WHERE run_id=? AND status='running'").run(uncertain?'uncertain':'failed',row.id);
      db.prepare('UPDATE canvas_runs SET status=?,result_json=?,reserved=?,settled=?,updated_at=? WHERE id=?').run(uncertain?'uncertain':e.code==='CANVAS_STOPPED_BEFORE_IMAGE'?'cancelled':'failed',JSON.stringify(result),held,brainCharge,now(),row.id);
    })();
  } finally {clearInterval(heartbeat);requestContexts.delete(row.id);}
}
export async function drainCanvasJobs() {
  if(draining)return;draining=true;
  try{
    recoverCanvasRuns();
    while(running.size<2){
      const row=getDb().transaction(()=>{
        const next=getDb().prepare("SELECT * FROM canvas_runs WHERE status='queued' ORDER BY created_at,id LIMIT 1").get();
        if(!next)return null;
        if(!getDb().prepare("UPDATE canvas_runs SET status='running',lease_until=?,updated_at=? WHERE id=? AND status='queued'").run(Date.now()+600000,now(),next.id).changes)return null;
        return next;
      })();
      if(!row)break;
      running.add(row.id);
      execute(row).catch(()=>{}).finally(()=>{running.delete(row.id);setImmediate(()=>drainCanvasJobs().catch(()=>{}));});
    }
  }finally{draining=false;}
}
export function mountCanvasJobRoutes(app) {
  setImmediate(()=>drainCanvasJobs().catch(()=>{}));
  const timer=setInterval(()=>drainCanvasJobs().catch(()=>{}),30000);timer.unref();
  app.get('/api/canvas/models',(req,res)=>res.json({models:availableModels('image'),analysisModels:availableModels('chat')}));
  app.post('/api/canvas/projects/:id/quotes',ah(async(req,res)=>res.json({quote:makeCanvasQuote(req,req.params.id,req.body)})));
  app.post('/api/canvas/projects/:id/runs',ah(async(req,res)=>res.status(202).json({run:startCanvasRun(req,req.params.id,req.body)})));
  app.get('/api/canvas/projects/:id/runs',ah(async(req,res)=>{canvasProject(req.params.id,req);res.json({runs:getDb().prepare('SELECT * FROM canvas_runs WHERE project_id=? AND user_id=? ORDER BY created_at,id').all(req.params.id,owner(req)).map(publicRun)});}));
  app.get('/api/canvas/projects/:id/events',ah(async(req,res)=>{
    canvasProject(req.params.id,req);
    res.set({'Content-Type':'text/event-stream','Cache-Control':'no-cache, no-transform','X-Accel-Buffering':'no'});res.flushHeaders();
    let previous='';
    const emit=()=>{const rows=getDb().prepare('SELECT * FROM canvas_runs WHERE project_id=? AND user_id=? ORDER BY created_at,id').all(req.params.id,owner(req)).map(publicRun);const data=JSON.stringify(rows);if(data!==previous){res.write(`data: ${JSON.stringify({type:'runs',runs:rows})}\n\n`);previous=data;}else res.write(': heartbeat\n\n');};
    emit();const timer=setInterval(emit,2000);const end=setTimeout(()=>res.end(),300000);req.on('close',()=>{clearInterval(timer);clearTimeout(end);});
  }));
  app.post('/api/canvas/runs/:id/delivered',ah(async(req,res)=>{
    const row=requireRun(req.params.id,req);if(row.status!=='succeeded')throw problem('CANVAS_RESULT_NOT_READY','任务尚未完成',409);
    const project=canvasProject(row.project_id,req),result=JSON.parse(row.result_json),store=JSON.parse(project.snapshot_json||'{}').document?.store;
    const shape=store?.[result.shapeId],asset=shape&&store?.[shape.props?.assetId];
    if(!shape||asset?.meta?.canvasAssetId!==result.asset.id||asset?.props?.src!==result.asset.src)throw problem('CANVAS_RESULT_NOT_SAVED','结果尚未保存到画板',409);
    getDb().prepare('UPDATE canvas_runs SET delivered=1 WHERE id=? AND user_id=?').run(row.id,owner(req));res.json({ok:true});
  }));
  app.post('/api/canvas/runs/:id/stop',ah(async(req,res)=>{
    const db=getDb();db.transaction(()=>{const row=requireRun(req.params.id,req);if(row.status==='queued'){release(row);db.prepare("UPDATE canvas_runs SET status='cancelled',reserved=0,stop_requested=1,updated_at=? WHERE id=?").run(now(),row.id);}else if(row.status==='running')db.prepare('UPDATE canvas_runs SET stop_requested=1,updated_at=? WHERE id=?').run(now(),row.id);})();
    res.json({run:publicRun(requireRun(req.params.id,req)),message:'已停止后续操作；已发送的图片请求无法撤回，完成后仍会保存结果并结算'});
  }));
  app.post('/api/canvas/runs/:id/reconcile',ah(async(req,res)=>{
    const db=getDb();if(getConfig().multiUser&&!db.prepare('SELECT is_admin FROM users WHERE id=?').get(req.userId)?.is_admin)throw problem('ADMIN_REQUIRED','仅管理员可核对任务',403);
    if(!['refund','charged'].includes(req.body.action)||typeof req.body.reason!=='string'||req.body.reason.trim().length<4)throw problem('CANVAS_RECONCILE_INVALID','请填写核对原因并选择退款或确认消耗');
    db.transaction(()=>{const row=db.prepare('SELECT * FROM canvas_runs WHERE id=?').get(req.params.id);if(!row)throw problem('CANVAS_RUN_NOT_FOUND','任务不存在',404);if(row.status!=='uncertain')throw problem('CANVAS_RUN_RESOLVED','任务已处理',409);if(req.body.action==='refund')release(row);else if(row.reserved>0)addLedger(row.user_id,0,'canvas_settle','canvas_run',row.id,{accountingDelta:-row.reserved});db.prepare("UPDATE canvas_runs SET status='failed',settled=?,reserved=0,result_json=?,updated_at=? WHERE id=?").run(row.settled+(req.body.action==='charged'?row.reserved:0),JSON.stringify({error:req.body.action==='refund'?'管理员核对完成，预留额度已退回':'管理员已确认上游消耗',reconciliation:{action:req.body.action,reason:req.body.reason,actor:owner(req)}}),now(),row.id);})();res.json({ok:true});
  }));
  app.post('/api/canvas/projects/:id/batch-quotes',ah(async(req,res)=>{
    const project=canvasProject(req.params.id,req),db=getDb();
    const row=db.prepare('SELECT * FROM canvas_recipes WHERE id=? AND user_id=?').get(req.body.recipeId,owner(req));
    if(!row)throw problem('CANVAS_RECIPE_NOT_FOUND','工作流不存在',404);
    const recipe=JSON.parse(row.definition_json),slot=req.body.slot;
    if(!Number.isInteger(slot)||slot<0||slot>=recipe.slots.length)throw problem('CANVAS_BATCH_SLOT_INVALID','请选择要替换的工作流图片槽位');
    const targets=req.body.targets;
    if(!Array.isArray(targets)||!targets.length||targets.length>20||new Set(targets.map(t=>t.assetId)).size!==targets.length)throw problem('CANVAS_BATCH_TARGET_INVALID','请选择1～20张不重复的商品图');
    const budget=req.body.budget;
    if(!Number.isSafeInteger(budget)||budget<0||budget>1e9)throw problem('CANVAS_BATCH_BUDGET_INVALID','请填写有效的批量最高积分预算');
    const quotes=db.transaction(()=>{
      for(const slot of recipe.slots){const asset=db.prepare('SELECT id FROM canvas_assets WHERE id=? AND user_id=?').get(slot.originalAssetId,owner(req));if(!asset)throw problem('CANVAS_SOURCE_MISSING','工作流参考图不可用',404);db.prepare('INSERT OR IGNORE INTO canvas_project_assets VALUES(?,?)').run(project.id,asset.id);}
      return targets.map(target=>{
        const refs=recipe.slots.map((s,i)=>{if(i===slot)return target;const asset=db.prepare('SELECT * FROM canvas_assets WHERE id=? AND user_id=?').get(s.originalAssetId,owner(req));return {assetId:asset.id,assetVersion:asset.fingerprint};});
        return makeCanvasQuote(req,project.id,{recipeId:row.id,references:refs});
      });
    })();
    const total=quotes.reduce((sum,q)=>sum+q.credits,0);
    if(total>budget)throw problem('CANVAS_BATCH_BUDGET_EXCEEDED',`本批需要 ${total} 积分，超过预算 ${budget}`,422);
    const id=crypto.randomUUID(),payload={quoteIds:quotes.map(q=>q.id),total,budget,count:quotes.length,expiresAt:Math.min(...quotes.map(q=>q.expiresAt))};
    db.prepare('INSERT INTO canvas_batches(id,project_id,user_id,recipe_id,payload_json,created_at) VALUES(?,?,?,?,?,?)').run(id,project.id,owner(req),row.id,JSON.stringify(payload),now());res.json({batch:{id,...payload}});
  }));
  app.post('/api/canvas/projects/:id/batches',ah(async(req,res)=>{
    const db=getDb();canvasProject(req.params.id,req);
    const batch=db.prepare('SELECT * FROM canvas_batches WHERE id=? AND project_id=? AND user_id=?').get(req.body.batchId,req.params.id,owner(req));
    if(!batch)throw problem('CANVAS_BATCH_NOT_FOUND','批量报价不存在',404);
    if(batch.status==='started')return res.json({runs:db.prepare('SELECT r.* FROM canvas_runs r JOIN canvas_batch_runs b ON b.run_id=r.id WHERE b.batch_id=?').all(batch.id).map(publicRun)});
    const payload=JSON.parse(batch.payload_json);
    if(payload.expiresAt<Date.now())throw problem('CANVAS_QUOTE_EXPIRED','批量报价已失效',409);
    const runs=db.transaction(()=>{
      if(db.prepare("SELECT 1 FROM canvas_runs WHERE user_id=? AND status IN ('queued','running')").get(owner(req)))throw problem('CANVAS_RUN_BUSY','已有任务执行中，请稍后再试',409);
      if(payload.total>0&&getBalance(owner(req))<payload.total)throw problem('POINTS_INSUFFICIENT','积分不足，未启动本批任务',422);
      const runs=payload.quoteIds.map((quoteId,i)=>{const run=startCanvasRun(req,batch.project_id,{quoteId,requestKey:`batch_${batch.id}_${i}`},true);db.prepare('INSERT INTO canvas_batch_runs VALUES(?,?)').run(batch.id,run.id);return run;});
      db.prepare("UPDATE canvas_batches SET status='started' WHERE id=?").run(batch.id);return runs;
    })();res.status(202).json({runs});
  }));
  app.get('/api/canvas/recipes',ah(async(req,res)=>res.json({recipes:getDb().prepare('SELECT id,title,run_id,definition_json,created_at FROM canvas_recipes WHERE user_id=? ORDER BY created_at DESC').all(owner(req)).map(({definition_json,...r})=>({...r,definition:JSON.parse(definition_json)}))})));
  app.post('/api/canvas/recipes',ah(async(req,res)=>{
    const row=requireRun(req.body.runId,req);if(row.status!=='succeeded')throw problem('CANVAS_RECIPE_NOT_READY','仅可保存成功任务');const q=read(row);
    const existing=getDb().prepare('SELECT id FROM canvas_recipes WHERE user_id=? AND run_id=?').get(owner(req),row.id);if(existing)return res.json(existing);
    const id=crypto.randomUUID(),definition={version:1,executionPrompt:JSON.parse(row.result_json).trace?.prompt||q.prompt,message:q.message,modelId:q.modelId,size:q.size,quality:q.quality,slots:q.sources.map(s=>({role:s.role,originalAssetId:s.assetId}))};
    getDb().prepare('INSERT INTO canvas_recipes VALUES(?,?,?,?,?,?)').run(id,owner(req),row.id,q.message.slice(0,60),JSON.stringify(definition),now());res.status(201).json({id});
  }));
  app.put('/api/canvas/recipes/:id',ah(async(req,res)=>{if(typeof req.body.title!=='string'||!req.body.title.trim()||req.body.title.length>100)throw problem('CANVAS_RECIPE_NAME_INVALID','工作流名称需为1～100个字符');if(!getDb().prepare('UPDATE canvas_recipes SET title=? WHERE id=? AND user_id=?').run(req.body.title.trim(),req.params.id,owner(req)).changes)throw problem('CANVAS_RECIPE_NOT_FOUND','工作流不存在',404);res.json({ok:true});}));
  app.delete('/api/canvas/recipes/:id',ah(async(req,res)=>{if(!getDb().prepare('DELETE FROM canvas_recipes WHERE id=? AND user_id=?').run(req.params.id,owner(req)).changes)throw problem('CANVAS_RECIPE_NOT_FOUND','工作流不存在',404);res.json({ok:true});}));
}
