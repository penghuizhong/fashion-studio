import crypto from 'node:crypto';
import { getDb } from '../db.js';
import { getConfig } from '../config.js';
import { canvasProject } from '../canvas.js';
import { makeCanvasQuote,startCanvasRun } from '../canvasJobs.js';
import { canvasAnalysisSpec } from '../canvasAgent.js';
import { resolveExploreModel } from '../exploreModels.js';
import { addLedger,getBalance } from '../points.js';
import { ah } from '../asyncHandler.js';
import { problem } from '../exploreErrors.js';
import { discoverSkills,skillMetadata } from './skillRegistry.js';
import { runPi,credentialTag,callBudget,LIMITS,visionImage } from './runtime.js';

export const agentEnabled=()=>process.env.AGENT_ENABLED==='true';
const now=()=>new Date().toISOString(),owner=req=>req.userId||'local';
const contexts=new Map(),active=new Set();let draining=false;
const errorLabels={AGENT_ALL_REFERENCES_REQUIRED:'未包含本次全部原始参考图，已停止图片派发',AGENT_IMAGE_LIMIT:'已达到确认的图片数量，请增加上限后确认继续',AGENT_BUDGET_EXHAUSTED:'剩余额度不足，请确认后继续',AGENT_TURN_LIMIT:'已达到本任务分析轮次上限',AGENT_TOOL_LIMIT:'已达到本任务工具调用上限',AGENT_PLAN_INCOMPLETE:'实际生成结果少于已确认计划，已停止并退回未用额度',AGENT_PROVIDER_REJECTED:'供应商拒绝请求，请检查模型工具调用兼容性',AGENT_MODEL_CHANGED:'模型配置已变化，未执行后续请求',AGENT_CHILD_UNCERTAIN:'图片结果待核对，请先核对图片子任务',AGENT_CHILD_FAILED:'图片子任务未成功，后续步骤已停止'};
const safeError=e=>e.publicMessage||errorLabels[e.message]||'Agent 未能完成本次执行，请检查步骤记录；未用额度已释放，未知费用需核对';
const requireEnabled=()=>{if(!agentEnabled())throw problem('AGENT_DISABLED','多步 Agent 尚未启用',404);};
function requireRun(id,req){const row=getDb().prepare('SELECT * FROM canvas_agent_runs WHERE id=? AND user_id=?').get(id,owner(req));if(!row)throw problem('AGENT_NOT_FOUND','Agent 任务不存在',404);return row;}
function publicRun(row){const {input_json,messages_json,result_json,...rest}=row,q=JSON.parse(input_json);return {...rest,result:JSON.parse(result_json),input:{message:q.image.message,maxImages:q.maxImages,maxTurns:LIMITS.turns,skills:skillMetadata(q.skills)},steps:getDb().prepare('SELECT sequence,kind,tool,status,child_run_id,charge FROM canvas_agent_steps WHERE run_id=? ORDER BY sequence').all(row.id)};}
function release(row,hold=0){const refund=row.reserved-hold;if(refund>0)addLedger(row.user_id,refund,'canvas_agent_release','canvas_agent',row.id,{accountingDelta:0});}
export function quoteAgent(req,pid,body){
  requireEnabled();canvasProject(pid,req);
  let workflow=null;
  if(body.workflowId){const saved=getDb().prepare('SELECT definition_json FROM canvas_agent_workflows WHERE id=? AND user_id=?').get(body.workflowId,owner(req));if(!saved)throw problem('AGENT_WORKFLOW_NOT_FOUND','工作流不存在',404);workflow=JSON.parse(saved.definition_json);if(body.references?.length!==workflow.slots.length)throw problem('AGENT_WORKFLOW_INPUT','请重新绑定工作流所有输入图片');body={...body,message:workflow.message,references:body.references.map((r,i)=>({...r,role:workflow.slots[i].role}))};}
  if(!body.analysisModelId)throw problem('AGENT_MODEL_REQUIRED','请选择支持原生工具调用的识图模型',422);
  if(!Number.isSafeInteger(body.maxImages)||body.maxImages<1||body.maxImages>LIMITS.images)throw problem('AGENT_IMAGE_LIMIT','请选择1～4张图片上限',422);
  if(!Array.isArray(body.references)||body.references.length>4)throw problem('AGENT_REFERENCE_LIMIT','Agent 最多使用4张输入图片',422);
  if(body.recipeId)throw problem('AGENT_RECIPE_UNSUPPORTED','旧版单步工作流不能作为多步 Agent 任务');
  const image=makeCanvasQuote(req,pid,{...body,analysisModelId:null}).payload;
  const spec=canvasAnalysisSpec(req,body,image.sources),resolved=resolveExploreModel(req,body.analysisModelId,'chat');
  if(!resolved.vision)throw problem('AGENT_VISION_REQUIRED','多步 Agent 需要识图模型',422);
  const extra=JSON.parse(getDb().prepare('SELECT extra_json FROM models WHERE id=?').get(resolved.id).extra_json||'{}');
  if(extra.tool_calling!==true)throw problem('AGENT_TOOL_MODEL_REQUIRED','请先在模型管理启用并验证原生工具调用能力（tool_calling）',422);
  const perCall=callBudget(resolved),available=discoverSkills().filter(s=>s.enabled),skills=workflow?.skills?workflow.skills.filter(s=>available.some(a=>a.name===s.name)):available;
  if(workflow)workflow={...workflow,skills:skillMetadata(skills)};
  const payload={version:1,image,skills,workflow,planFirst:body.planFirst===true,executionConfirmed:body.planFirst!==true,maxImages:body.maxImages,analysis:{...spec,perCall,budget:perCall*LIMITS.turns,credentialTag:credentialTag(resolved)},total:image.unit*body.maxImages+perCall*LIMITS.turns};
  payload.initialTotal=payload.planFirst?perCall*4:payload.total;
  const id=crypto.randomUUID(),expiresAt=Date.now()+300000;
  getDb().prepare('INSERT INTO canvas_agent_quotes VALUES(?,?,?,?,?)').run(id,pid,owner(req),JSON.stringify(payload),expiresAt);
  return {id,expiresAt,credits:payload.initialTotal,executionCeiling:payload.total,planFirst:payload.planFirst,maxImages:payload.maxImages,maxTurns:LIMITS.turns,analysisBudget:payload.analysis.budget,imageBudget:image.unit*body.maxImages,skills:skillMetadata(skills),sources:image.sources,scope:'先分析实际附件，按需加载技能；在确认上限内生成图片并检查结果。具体步骤由 Agent 执行时决定。'};
}
export function startAgent(req,pid,body){
  requireEnabled();canvasProject(pid,req);const db=getDb();
  if(typeof body.requestKey!=='string'||!/^[A-Za-z0-9_-]{8,100}$/.test(body.requestKey))throw problem('AGENT_REQUEST_KEY_REQUIRED','缺少请求标识');
  const prior=db.prepare('SELECT * FROM canvas_agent_runs WHERE user_id=? AND (quote_id=? OR request_key=?)').all(owner(req),body.quoteId,body.requestKey);
  if(prior.length){if(prior.length!==1||prior[0].project_id!==pid||prior[0].quote_id!==body.quoteId)throw problem('AGENT_REQUEST_CONFLICT','请求标识已占用',409);return publicRun(prior[0]);}
  const quote=db.prepare('SELECT * FROM canvas_agent_quotes WHERE id=? AND project_id=? AND user_id=?').get(body.quoteId,pid,owner(req));
  if(!quote||quote.expires_at<Date.now())throw problem('AGENT_QUOTE_EXPIRED','报价已失效',409);
  const q=JSON.parse(quote.payload_json);if(q.resumeRunId)throw problem('AGENT_QUOTE_TYPE','请通过继续执行接口确认此报价',409);const model=resolveExploreModel(req,q.analysis.modelId,'chat');
  assertModel(model,q);
  const checked=makeCanvasQuote(req,pid,{message:q.image.message,modelId:q.image.modelId,size:q.image.size,quality:q.image.quality,references:q.image.sources}).payload;
  if(checked.signature!==q.image.signature||checked.unit!==q.image.unit||checked.quotedUnit!==q.image.quotedUnit)throw problem('AGENT_QUOTE_CHANGED','图片模型价格或配置已变化',409);
  const id=crypto.randomUUID(),stamp=now();
  db.transaction(()=>{
    if(db.prepare("SELECT 1 FROM canvas_agent_runs WHERE user_id=? AND status IN ('queued','running','uncertain')").get(owner(req)))throw problem('AGENT_BUSY','已有 Agent 任务执行中或待核对',409);
    if(db.prepare("SELECT 1 FROM canvas_runs WHERE user_id=? AND status IN ('queued','running','uncertain')").get(owner(req)))throw problem('AGENT_BUSY','已有图片任务执行中或待核对',409);
    if(q.initialTotal>0&&getBalance(owner(req))<q.initialTotal)throw problem('POINTS_INSUFFICIENT','积分不足',422);
    if(q.initialTotal>0)addLedger(owner(req),-q.initialTotal,'canvas_agent_reserve','canvas_agent',id,{accountingDelta:0});
    db.prepare('INSERT INTO canvas_agent_runs(id,project_id,user_id,quote_id,request_key,status,input_json,reserved,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,pid,owner(req),quote.id,body.requestKey,'queued',quote.payload_json,q.initialTotal,stamp,stamp);
  })();
  if(q.analysis.transientPersonal)contexts.set(id,Object.fromEntries(['x-openrouter-key','x-api-base-url','x-api-provider'].map(key=>[key,req.headers[key]])));
  setImmediate(()=>drainAgents().catch(()=>{}));return publicRun(requireRun(id,req));
}
function assertModel(model,q){if(model.config_signature!==q.analysis.signature||credentialTag(model)!==q.analysis.credentialTag)throw problem('AGENT_MODEL_CHANGED','分析模型配置或凭据已变化，请重新报价',409);}
const resumeFingerprint=row=>crypto.createHash('sha256').update(JSON.stringify([row.input_json,row.messages_json,row.status,row.stop_requested])).digest('hex');
export function quoteAgentResume(req,id,body){
  requireEnabled();const row=requireRun(id,req),db=getDb(),q=JSON.parse(row.input_json),result=JSON.parse(row.result_json);
  if(!['needs_confirmation','needs_input'].includes(row.status))throw problem('AGENT_RESUME_STATE','当前任务不可续跑',409);
  if(row.stop_requested)throw problem('AGENT_STOPPED','已停止的任务不可继续',409);
  assertModel(resolveExploreModel(req,q.analysis.modelId,'chat'),q);
  let continuation=null;
  if(row.status==='needs_input'){
    if(typeof body.message!=='string'||!body.message.trim()||body.message.length>4000)throw problem('AGENT_INPUT_REQUIRED','请补充需求和本次实际参考图');
    if(!Array.isArray(body.references)||body.references.length>4)throw problem('AGENT_REFERENCE_LIMIT','最多4张本次参考图');
    const checked=makeCanvasQuote(req,row.project_id,{...q.image,message:body.message,references:body.references,analysisModelId:null}).payload;
    continuation={message:body.message,sources:checked.sources};
  }
  const maxImages=body.maxImages??q.maxImages;
  if(!Number.isSafeInteger(maxImages)||maxImages<q.maxImages||maxImages>LIMITS.images)throw problem('AGENT_IMAGE_LIMIT','图片总上限只可增加，且最多4张');
  const used=db.prepare("SELECT COUNT(*) n FROM canvas_agent_steps WHERE run_id=? AND kind='model'").get(row.id).n;
  if(used>=LIMITS.turns)throw problem('AGENT_TURN_LIMIT','本任务已达到模型调用上限，请创建新任务');
  const count=db.prepare('SELECT COUNT(*) n FROM canvas_agent_steps WHERE run_id=? AND child_run_id IS NOT NULL').get(row.id).n;
  const images=Math.max(0,maxImages-count),remaining=LIMITS.turns-used;
  const credits=q.analysis.perCall*remaining+q.image.unit*images;
  const checked=makeCanvasQuote(req,row.project_id,{...q.image,references:continuation?.sources||q.image.sources,analysisModelId:null}).payload;
  if(checked.signature!==q.image.signature||checked.quotedUnit!==q.image.quotedUnit)throw problem('AGENT_QUOTE_CHANGED','原任务图片模型或价格已变化，请新建任务',409);
  const quoteId=crypto.randomUUID(),expiresAt=Date.now()+300000;
  const payload={resumeRunId:id,fingerprint:resumeFingerprint(row),credits,maxImages,continuation,executionConfirmed:row.status==='needs_confirmation'?(!q.planFirst||!!result.plan):q.executionConfirmed};
  db.prepare('INSERT INTO canvas_agent_quotes VALUES(?,?,?,?,?)').run(quoteId,row.project_id,row.user_id,JSON.stringify(payload),expiresAt);
  return {id:quoteId,expiresAt,credits,maxImages,remainingTurns:remaining,plan:result.plan||null};
}
export async function confirmAgentResume(req,id,body){
  requireEnabled();const db=getDb(),row=requireRun(id,req),current=JSON.parse(row.input_json);
  if(current.resumeQuoteId===body.quoteId)return publicRun(row);
  const quote=db.prepare('SELECT * FROM canvas_agent_quotes WHERE id=? AND user_id=? AND project_id=?').get(body.quoteId,owner(req),row.project_id);
  if(!quote||quote.expires_at<Date.now())throw problem('AGENT_QUOTE_EXPIRED','继续执行报价已过期',409);
  const payload=JSON.parse(quote.payload_json);
  if(payload.resumeRunId!==id||payload.fingerprint!==resumeFingerprint(row)||!['needs_confirmation','needs_input'].includes(row.status))throw problem('AGENT_RESUME_CHANGED','任务已变化，请重新确认',409);
  // Revalidate prices, credentials and file fingerprints at confirmation, before reserving.
  const fresh=quoteAgentResume(req,id,{message:payload.continuation?.message,references:payload.continuation?.sources,maxImages:payload.maxImages});
  if(fresh.credits!==payload.credits)throw problem('AGENT_QUOTE_CHANGED','费用已变化',409);
  let messages=JSON.parse(row.messages_json),result=JSON.parse(row.result_json);
  if(payload.continuation){
    for(const m of messages)if(Array.isArray(m.content))m.content=m.content.filter(c=>c.type!=='image');
    const images=await Promise.all(payload.continuation.sources.map(visionImage));
    messages.push({role:'user',content:[{type:'text',text:JSON.stringify({request:payload.continuation.message,sources:payload.continuation.sources.map(({path,...s})=>s),note:'只有这次附件是当前原始参考；先前图片仅作文字上下文'})},...images],timestamp:Date.now()});
    current.image.sources=payload.continuation.sources;current.image.message=payload.continuation.message;
  }
  if(row.status==='needs_confirmation'&&!result.pendingToolId&&messages.at(-1)?.role==='assistant'&&messages.at(-1).errorMessage==='AGENT_BUDGET_EXHAUSTED')messages.pop();
  if(result.pendingToolId){
    const pendingId=result.pendingToolId;messages=messages.filter(m=>!(m.role==='toolResult'&&m.toolCallId===pendingId));
  }
  current.executionConfirmed=payload.executionConfirmed;current.maxImages=payload.maxImages;current.resumeQuoteId=quote.id;
  result={...result,question:null,awaitingConfirmation:false,pendingToolId:null,error:null};
  db.transaction(()=>{
    const live=requireRun(id,req);if(resumeFingerprint(live)!==payload.fingerprint)throw problem('AGENT_RESUME_CHANGED','任务已变化',409);
    if(db.prepare("SELECT 1 FROM canvas_agent_runs WHERE user_id=? AND id!=? AND status IN ('queued','running','uncertain')").get(row.user_id,id)||db.prepare("SELECT 1 FROM canvas_runs WHERE user_id=? AND status IN ('queued','running','uncertain')").get(row.user_id))throw problem('AGENT_BUSY','其他任务执行中或待核对',409);
    if(payload.credits>0&&getBalance(row.user_id)<payload.credits)throw problem('POINTS_INSUFFICIENT','积分不足',422);
    if(payload.credits>0)addLedger(row.user_id,-payload.credits,'canvas_agent_reserve','canvas_agent',id,{accountingDelta:0});
    db.prepare("UPDATE canvas_agent_runs SET status='queued',reserved=?,input_json=?,messages_json=?,result_json=?,updated_at=? WHERE id=?").run(payload.credits,JSON.stringify(current),JSON.stringify(messages),JSON.stringify(result),now(),id);
    db.prepare("UPDATE canvas_agent_steps SET status='pending' WHERE run_id=? AND status='awaiting_budget'").run(id);
  })();
  if(current.analysis.transientPersonal)contexts.set(id,Object.fromEntries(['x-openrouter-key','x-api-base-url','x-api-provider'].map(key=>[key,req.headers[key]])));setImmediate(()=>drainAgents().catch(()=>{}));return publicRun(requireRun(id,req));
}
export function saveAgentWorkflow(row){
  const db=getDb();if(row.status!=='succeeded')throw problem('AGENT_WORKFLOW_NOT_READY','仅可保存已成功的任务',409);
  const prior=db.prepare('SELECT id FROM canvas_agent_workflows WHERE run_id=? AND user_id=?').get(row.id,row.user_id);if(prior)return prior;
  const q=JSON.parse(row.input_json),steps=db.prepare("SELECT * FROM canvas_agent_steps WHERE run_id=? AND kind='tool' AND status='succeeded' ORDER BY sequence").all(row.id),producer=new Map();
  const nodes=steps.map(s=>{
    const args=JSON.parse(s.input_json),inputSlots=(args.assetIds||[]).map(id=>{const slot=q.image.sources.findIndex(s=>s.assetId===id);return slot>=0?`input:${slot+1}`:`output:${producer.get(id)||'unknown'}`;}),dependencies=(args.assetIds||[]).map(id=>producer.get(id)).filter(Boolean),node={id:`step_${s.sequence}`,tool:s.tool,args:{...args,...(args.assetIds?{assetIds:undefined}:{})},inputSlots,dependsOn:[...new Set(dependencies)]};
    if(inputSlots.includes('output:unknown'))throw problem('AGENT_WORKFLOW_INPUT_CHANGED','本任务曾更换外部参考，请以一组完整参考重新建立工作流',422);
    if(s.child_run_id){const child=db.prepare('SELECT result_json FROM canvas_runs WHERE id=?').get(s.child_run_id),asset=JSON.parse(child.result_json).asset;if(asset)producer.set(asset.id,node.id);}
    return node;
  });
  const definition={version:1,mode:'agent-guided',message:q.image.message,modelId:q.image.modelId,analysisModelId:q.analysis.modelId,size:q.image.size,quality:q.image.quality,maxImages:q.maxImages,slots:q.image.sources.map(s=>({role:s.role,originalAssetId:s.assetId})),skills:q.skills,nodes};
  const id=crypto.randomUUID();db.prepare('INSERT INTO canvas_agent_workflows VALUES(?,?,?,?,?,?)').run(id,row.user_id,row.id,q.image.message.slice(0,80),JSON.stringify(definition),now());return {id};
}
export function recoverAgents(){
  const db=getDb();
  db.transaction(()=>{
    for(const row of db.prepare("SELECT * FROM canvas_agent_runs WHERE status='running' AND lease_until<?").all(Date.now())){
      if(active.has(row.id))continue;
      const unknown=db.prepare("SELECT 1 FROM canvas_agent_steps WHERE run_id=? AND kind='model' AND status='dispatched'").get(row.id);
      if(unknown){const q=JSON.parse(row.input_json),hold=q.analysis.perCall;release(row,hold);db.prepare("UPDATE canvas_agent_runs SET status='uncertain',reserved=?,result_json=?,updated_at=? WHERE id=?").run(hold,JSON.stringify({error:'分析请求已派发但结果未知，需核对，未自动重发'}),now(),row.id);}
      else if(db.prepare("SELECT 1 FROM canvas_agent_steps WHERE run_id=? AND kind='model' AND status='succeeded'").get(row.id)){
        release(row);db.prepare("UPDATE canvas_agent_runs SET status='failed',reserved=0,result_json=?,updated_at=? WHERE id=?").run(JSON.stringify({error:'模型已结算，但响应未完成持久化；为避免重复收费已停止'}),now(),row.id);
      }else db.prepare("UPDATE canvas_agent_runs SET status='queued',updated_at=? WHERE id=?").run(now(),row.id);
    }
  })();
}
async function execute(row){
  const db=getDb(),q=JSON.parse(row.input_json),req={userId:row.user_id==='local'?null:row.user_id,headers:contexts.get(row.id)||{}};
  const stopped=()=>!!db.prepare('SELECT stop_requested FROM canvas_agent_runs WHERE id=?').get(row.id)?.stop_requested;
  const heartbeat=setInterval(()=>db.prepare('UPDATE canvas_agent_runs SET lease_until=? WHERE id=?').run(Date.now()+600000,row.id),30000);heartbeat.unref();
  try{
    if(q.analysis.transientPersonal&&!req.headers['x-openrouter-key'])throw problem('AGENT_KEY_LOST','个人 Key 已从内存清除，未派发后续请求');
    const resolved=resolveExploreModel(req,q.analysis.modelId,'chat');assertModel(resolved,q);
    const submitImage=async(args,sources,step)=>{
      let child;
      if(step.child_run_id)child=db.prepare('SELECT * FROM canvas_runs WHERE id=? AND user_id=?').get(step.child_run_id,row.user_id);
      if(!child){
        if(stopped())throw Error('AGENT_STOPPED');
        if(db.prepare('SELECT COUNT(*) n FROM canvas_agent_steps WHERE run_id=? AND child_run_id IS NOT NULL').get(row.id).n>=q.maxImages)throw Error('AGENT_IMAGE_LIMIT');
        const quote=makeCanvasQuote(req,row.project_id,{message:args.prompt+(q.image.brand?"\n已确认品牌视觉要求："+JSON.stringify(q.image.brand):""),modelId:q.image.modelId,size:q.image.size,quality:q.image.quality,references:sources});
        if(quote.payload.signature!==q.image.signature||quote.credits!==q.image.unit||quote.payload.quotedUnit!==q.image.quotedUnit)throw Error('AGENT_IMAGE_MODEL_CHANGED');
        // Transfer the exact image reserve to the existing child job atomically; never reserve twice.
        child=db.transaction(()=>{
          const current=requireRun(row.id,req);if(current.reserved<quote.credits)throw Error('AGENT_BUDGET_EXHAUSTED');
          if(quote.credits>0)addLedger(row.user_id,quote.credits,'canvas_agent_transfer','canvas_agent',row.id,{accountingDelta:0});
          db.prepare('UPDATE canvas_agent_runs SET reserved=reserved-? WHERE id=?').run(quote.credits,row.id);
          const run=startCanvasRun(req,row.project_id,{quoteId:quote.id,requestKey:`agent_${crypto.createHash('sha256').update(step.id).digest('hex')}`},true);
          db.prepare('UPDATE canvas_agent_steps SET child_run_id=? WHERE id=?').run(run.id,step.id);return run;
        })();
      }
      while(['queued','running'].includes(child.status)){
        if(stopped())db.transaction(()=>{
          const live=db.prepare('SELECT * FROM canvas_runs WHERE id=?').get(child.id);
          if(live.status==='queued'){
            if(live.reserved>0)addLedger(row.user_id,live.reserved,'canvas_release','canvas_run',child.id,{accountingDelta:0});
            db.prepare("UPDATE canvas_runs SET status='cancelled',reserved=0,stop_requested=1 WHERE id=? AND status='queued'").run(child.id);
          }else if(live.status==='running')db.prepare('UPDATE canvas_runs SET stop_requested=1 WHERE id=?').run(child.id);
        })();
        await new Promise(r=>setTimeout(r,100));child=db.prepare('SELECT * FROM canvas_runs WHERE id=?').get(child.id);
      }
      if(child.status!=='succeeded'){const e=Error(child.status==='uncertain'?'AGENT_CHILD_UNCERTAIN':'AGENT_CHILD_FAILED');e.childUncertain=child.status==='uncertain';throw e;}
      return {...child,result:typeof child.result_json==='string'?JSON.parse(child.result_json):child.result};
    };
    const result=await runPi({row,resolved,req,submitImage,stopped,validateModel:()=>assertModel(resolveExploreModel(req,q.analysis.modelId,'chat'),q)});
    if(!result.question&&!result.awaitingConfirmation&&!stopped()){const expected=JSON.parse(db.prepare('SELECT result_json FROM canvas_agent_runs WHERE id=?').get(row.id).result_json).plan?.steps.filter(s=>s.tool==='generate_image').length||0;const completed=db.prepare("SELECT COUNT(*) n FROM canvas_agent_steps s JOIN canvas_runs r ON r.id=s.child_run_id WHERE s.run_id=? AND r.status='succeeded'").get(row.id).n;if(completed<expected)throw Error('AGENT_PLAN_INCOMPLETE');}
    finish(row.id,stopped()?'cancelled':result.question?'needs_input':result.awaitingConfirmation?'needs_confirmation':'succeeded',result,0);
  }catch(e){
    const unknown=db.prepare("SELECT 1 FROM canvas_agent_steps WHERE run_id=? AND kind='model' AND status='dispatched'").get(row.id);
    finish(row.id,unknown||e.childUncertain?'uncertain':stopped()?'cancelled':e.needsApproval?'needs_confirmation':'failed',{error:safeError(e)},unknown?q.analysis.perCall:0);
  }finally{clearInterval(heartbeat);contexts.delete(row.id);}
}
function finish(id,status,result,hold){const db=getDb();db.transaction(()=>{const row=db.prepare('SELECT * FROM canvas_agent_runs WHERE id=?').get(id);release(row,hold);const old=JSON.parse(row.result_json);db.prepare('UPDATE canvas_agent_runs SET status=?,reserved=?,result_json=?,updated_at=? WHERE id=?').run(status,hold,JSON.stringify({...old,...result}),now(),id);})();}
export async function drainAgents(){
  if(draining)return;
  if(!agentEnabled()){recoverAgents();for(const row of getDb().prepare("SELECT id FROM canvas_agent_runs WHERE status='queued' AND stop_requested=1").all())finish(row.id,'cancelled',{},0);return;}
  draining=true;
  try{recoverAgents();if(active.size>=1)return;
    const row=getDb().transaction(()=>{const row=getDb().prepare("SELECT * FROM canvas_agent_runs WHERE status='queued' ORDER BY created_at,id LIMIT 1").get();if(!row)return null;getDb().prepare("UPDATE canvas_agent_runs SET status='running',lease_until=?,updated_at=? WHERE id=? AND status='queued'").run(Date.now()+600000,now(),row.id);return row;})();
    if(row){active.add(row.id);execute(row).catch(()=>{}).finally(()=>{active.delete(row.id);setImmediate(()=>drainAgents().catch(()=>{}));});}
  }finally{draining=false;}
}
export function mountAgentRoutes(app){
  const timer=setInterval(()=>drainAgents().catch(()=>{}),30000);timer.unref();setImmediate(()=>drainAgents().catch(()=>{}));
  app.get('/api/canvas/agent/capabilities',(req,res)=>res.json({enabled:agentEnabled(),hasRuns:!!getDb().prepare('SELECT 1 FROM canvas_agent_runs WHERE user_id=? LIMIT 1').get(owner(req)),limits:LIMITS,skills:agentEnabled()?skillMetadata(discoverSkills()):[]}));
  app.get('/api/canvas/agent/workflows',ah(async(req,res)=>res.json({workflows:getDb().prepare('SELECT id,title,run_id,definition_json FROM canvas_agent_workflows WHERE user_id=? ORDER BY created_at DESC').all(owner(req)).map(({definition_json,...r})=>({...r,definition:JSON.parse(definition_json)}))})));
  app.post('/api/canvas/agent-runs/:id/workflow',ah(async(req,res)=>res.json(saveAgentWorkflow(requireRun(req.params.id,req)))));
  app.delete('/api/canvas/agent/workflows/:id',ah(async(req,res)=>{if(!getDb().prepare('DELETE FROM canvas_agent_workflows WHERE id=? AND user_id=?').run(req.params.id,owner(req)).changes)throw problem('AGENT_WORKFLOW_NOT_FOUND','工作流不存在',404);res.json({ok:true});}));
  app.post('/api/canvas/agent-runs/:id/resume-quotes',ah(async(req,res)=>res.json({quote:quoteAgentResume(req,req.params.id,req.body)})));
  app.post('/api/canvas/agent-runs/:id/confirm',ah(async(req,res)=>res.json({run:await confirmAgentResume(req,req.params.id,req.body)})));
  app.post('/api/canvas/projects/:id/agent-quotes',ah(async(req,res)=>res.json({quote:quoteAgent(req,req.params.id,req.body)})));
  app.post('/api/canvas/projects/:id/agent-runs',ah(async(req,res)=>res.status(202).json({run:startAgent(req,req.params.id,req.body)})));
  app.get('/api/canvas/projects/:id/agent-runs',ah(async(req,res)=>{canvasProject(req.params.id,req);res.json({runs:getDb().prepare('SELECT * FROM canvas_agent_runs WHERE project_id=? AND user_id=? ORDER BY created_at,id').all(req.params.id,owner(req)).map(publicRun)});}));
  app.get('/api/canvas/projects/:id/agent-events',ah(async(req,res)=>{
    canvasProject(req.params.id,req);res.set({'Content-Type':'text/event-stream','Cache-Control':'no-cache, no-transform','X-Accel-Buffering':'no'});res.flushHeaders();let previous='';
    const emit=()=>{const runs=getDb().prepare('SELECT * FROM canvas_agent_runs WHERE project_id=? AND user_id=? ORDER BY created_at,id').all(req.params.id,owner(req)).map(publicRun),data=JSON.stringify(runs);if(data!==previous){res.write(`data: ${JSON.stringify({runs})}\n\n`);previous=data;}else res.write(': heartbeat\n\n');};
    emit();const timer=setInterval(emit,2000),end=setTimeout(()=>res.end(),300000);req.on('close',()=>{clearInterval(timer);clearTimeout(end);});
  }));
  app.get('/api/canvas/agent-runs/:id/events',ah(async(req,res)=>{requireRun(req.params.id,req);const after=Number(req.query.after||0);if(!Number.isSafeInteger(after)||after<0)throw problem('AGENT_CURSOR_INVALID','事件游标无效');res.json({events:getDb().prepare('SELECT sequence,type,payload_json,created_at FROM canvas_agent_events WHERE run_id=? AND sequence>? ORDER BY sequence LIMIT 100').all(req.params.id,after).map(({payload_json,...e})=>({...e,payload:JSON.parse(payload_json)}))});}));
  app.post('/api/canvas/agent-runs/:id/layout-delivered',ah(async(req,res)=>{
    const row=requireRun(req.params.id,req),result=JSON.parse(row.result_json),layout=result.layout;
    if(!layout)throw problem('AGENT_LAYOUT_MISSING','没有排版命令',409);
    const store=JSON.parse(canvasProject(row.project_id,req).snapshot_json||'{}').document?.store||{};
    for(const id of layout.shapeIds)if(store[id]&&store[id].meta?.agentLayoutId!==layout.id)throw problem('AGENT_LAYOUT_NOT_SAVED','排版尚未保存',409);
    result.layout.delivered=true;getDb().prepare('UPDATE canvas_agent_runs SET result_json=? WHERE id=?').run(JSON.stringify(result),row.id);res.json({ok:true});
  }));
  app.post('/api/canvas/agent-runs/:id/stop',ah(async(req,res)=>{const row=requireRun(req.params.id,req);getDb().prepare('UPDATE canvas_agent_runs SET stop_requested=1 WHERE id=?').run(row.id);if(['queued','needs_confirmation','needs_input'].includes(row.status))finish(row.id,'cancelled',{},0);res.json({run:publicRun(requireRun(row.id,req))});}));
  app.post('/api/canvas/agent-runs/:id/reconcile',ah(async(req,res)=>{
    const db=getDb();if(getConfig().multiUser&&!db.prepare('SELECT is_admin FROM users WHERE id=?').get(req.userId)?.is_admin)throw problem('ADMIN_REQUIRED','仅管理员可核对',403);
    if(!['refund','charged'].includes(req.body.action)||typeof req.body.reason!=='string'||(req.body.reason.trim().length<4||req.body.reason.length>2000))throw problem('AGENT_RECONCILE_INVALID','请填写核对原因和处理方式');
    db.transaction(()=>{const row=db.prepare('SELECT * FROM canvas_agent_runs WHERE id=?').get(req.params.id);if(!row)throw problem('AGENT_NOT_FOUND','Agent任务不存在',404);if(row.status!=='uncertain')throw problem('AGENT_RESOLVED','任务已处理',409);if(db.prepare("SELECT 1 FROM canvas_agent_steps s JOIN canvas_runs r ON r.id=s.child_run_id WHERE s.run_id=? AND r.status='uncertain'").get(row.id))throw problem('AGENT_CHILD_UNCERTAIN','请先核对生图子任务',409);if(req.body.action==='charged'&&row.reserved>0){addLedger(row.user_id,0,'canvas_agent_settle','canvas_agent',row.id,{accountingDelta:-row.reserved});db.prepare('UPDATE canvas_agent_runs SET settled=settled+?,reserved=0 WHERE id=?').run(row.reserved,row.id);}finish(row.id,'failed',{reconciliation:{action:req.body.action,reason:req.body.reason,actor:owner(req)}},0);})();res.json({ok:true});
  }));
}
