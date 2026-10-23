import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { nativeStream } from '../src/agent/provider.js';
process.env.DATA_DIR=fs.mkdtempSync(path.join(os.tmpdir(),'fashion-agent-check-'));
process.env.MULTI_USER='true';process.env.MOCK_LLM='false';process.env.AGENT_ENABLED='true';process.env.MASTER_KEY=crypto.randomBytes(32).toString('hex');process.env.WRITE_LIMIT_MAX='2000';
const {getDb,closeDb}=await import('../src/db.js');
const {createApp}=await import('../src/app.js');
const {encryptSecret}=await import('../src/secrets.js');
const {recoverAgents}=await import('../src/agent/jobs.js');
const {discoverSkills}=await import('../src/agent/skillRegistry.js');
const db=getDb(),stamp=new Date().toISOString(),originalFetch=global.fetch;
const bytes=await sharp({create:{width:120,height:180,channels:3,background:'#aaa'}}).png().toBuffer();
const garment=await sharp({create:{width:100,height:160,channels:3,background:'#abc'}}).png().toBuffer();
let mode='chain',imageCalls=0,modelCalls=0,modelBodies=[],imageInputs=[],gate=null,callIndex=0;
const outputs=[];
const call=(name,args)=>({id:`call-${++callIndex}`,type:'function',function:{name,arguments:JSON.stringify(args)}});
global.fetch=async(url,opts)=>{
 if(!String(url).startsWith('https://agent.invalid'))return originalFetch(url,opts);
 if(String(url).includes('/chat/completions')){
   modelCalls++;const body=JSON.parse(opts.body);modelBodies.push(body);
   if(mode==='timeout')throw new TypeError('network unknown');
   if(mode==='reject')return new Response('{}',{status:400});
   if(mode==='malformed')return new Response(JSON.stringify({choices:[{message:{content:'not a tool'},finish_reason:'length'}],usage:{prompt_tokens:100,completion_tokens:10}}));
   const initial=JSON.parse(body.messages.find(m=>m.role==='user').content.find(c=>c.type==='text').text);
   const completed=body.messages.filter(m=>m.role==='tool').map(m=>{try{return JSON.parse(m.content);}catch{return null;}}).filter(Boolean);
   const generated=completed.filter(r=>r.status==='succeeded'&&r.assetId),names=body.messages.flatMap(m=>m.tool_calls||[]).map(c=>c.function.name);
   let toolCall;
   if(mode==='final')toolCall=null;
   else if(mode==='drop-reference')toolCall=call('generate_image',{assetIds:[initial.sources[0].assetId],prompt:'双图换装',title:'漏图应被拒绝'});
   else if(mode==='attack')toolCall=call('exec_shell',{command:'curl http://169.254.169.254/'});
   else if(mode==='clarify')toolCall=call('request_clarification',{question:'请补充服装背面参考图'});
   else if(mode==='bad-asset')toolCall=call('generate_image',{assetIds:['someone-elses-asset'],prompt:'换装',title:'不允许'});
   else if(!names.includes('list_skills'))toolCall=call('list_skills',{});
   else if(!names.includes('load_skill'))toolCall=['virtual-tryon','multi-view','design-consistency','fashion-layout'].map(name=>call('load_skill',{name}));
   else if(mode==='budget-plan'&&names.includes('load_skill'))toolCall=call('get_canvas_selection',{});
   else if(initial.planningOnly&&!names.includes('propose_plan'))toolCall=call('propose_plan',{steps:[{id:'front',tool:'generate_image',title:'换装正面',dependsOn:[]}]});
   else if(generated.length<(mode==='limit'?2:3))toolCall=call('generate_image',{assetIds:generated.length?[generated[0].assetId,initial.sources[1].assetId]:initial.sources.map(s=>s.assetId),prompt:`服装视角${generated.length+1}，保留实际双图参考`,title:`视角${generated.length+1}`});
   else if(!names.includes('inspect_images'))toolCall=call('inspect_images',{assetIds:generated.map(g=>g.assetId)});
   else if(!names.includes('arrange_images'))toolCall=call('arrange_images',{assetIds:generated.map(g=>g.assetId)});
   const raw=toolCall?{content:null,tool_calls:Array.isArray(toolCall)?toolCall:[toolCall]}:{content:'已生成三视角，并检查及排列结果。背部无原图的部分是推测。'};
   if(mode==='gate'&&gate)await gate;
   return new Response(JSON.stringify({choices:[{message:raw,finish_reason:toolCall?'tool_calls':'stop'}],usage:mode==='budget-plan'?{prompt_tokens:100000,completion_tokens:1600}:{prompt_tokens:100,completion_tokens:10}}),{headers:{'Content-Type':'application/json'}});
 }
 imageCalls++;
 const files=opts.body.getAll('image[]');imageInputs.push(await Promise.all(files.map(async f=>Buffer.from(await f.arrayBuffer()))));
 if(mode==='image-timeout')throw Error('unknown image result');
 if(mode==='image-gate'&&gate)await gate;
 // Return distinct persistent assets for each output, as real suppliers would.
 const output=await sharp({create:{width:120,height:180,channels:3,background:{r:120+imageCalls,g:140,b:170}}}).png().toBuffer();outputs.push(output);
 return new Response(JSON.stringify({data:[{b64_json:output.toString('base64')}]}),{headers:{'Content-Type':'application/json'}});
};
for(const uid of ['alice','bob']){db.prepare("INSERT INTO users(id,username,password_hash,created_at,points_balance,billing_mode,is_admin) VALUES(?,?,?,?,100000,'points',?)").run(uid,uid,'unused',stamp,uid==='alice'?1:0);db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(crypto.createHash('sha256').update(uid+'-token').digest('hex'),uid,Date.now()+86400000);}
db.prepare("INSERT INTO providers(id,name,preset,kind,base_url,api_key_encrypted,is_active,created_at) VALUES('agent','Agent','custom','both','https://agent.invalid/v1',?,1,?)").run(encryptSecret(process.env.MASTER_KEY,'fixture-secret'),stamp);
db.prepare("INSERT INTO models(id,provider_id,kind,model_id,name,pricing_json,extra_json,is_active,created_at) VALUES('image','agent','image','image','Image',?,?,1,?)").run('{"per_call":7}',JSON.stringify({sizes:['1024x1024'],image_config:{protocol:'openai_images',text:true,edit:true,max_images:4}}),stamp);
db.prepare("INSERT INTO models(id,provider_id,kind,model_id,name,pricing_json,extra_json,is_active,created_at) VALUES('brain','agent','chat','brain','Pi Brain',?,?,1,?)").run('{"input_per_1m":1000,"output_per_1m":1000}','{"vision":true,"tool_calling":true}',stamp);
const server=createApp().listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base=`http://127.0.0.1:${server.address().port}`;
async function req(method,url,data,status=200,user='alice'){const r=await originalFetch(base+url,{method,headers:{Cookie:`soulchat_session=${user}-token`,'Content-Type':'application/json'},body:data===undefined?undefined:JSON.stringify(data)});const body=await r.json();assert.equal(r.status,status,JSON.stringify(body));return body;}
const balance=()=>db.prepare("SELECT points_balance FROM users WHERE id='alice'").get().points_balance;
async function wait(id){for(let i=0;i<500;i++){const row=db.prepare('SELECT * FROM canvas_agent_runs WHERE id=?').get(id);if(!['queued','running'].includes(row.status))return row;await new Promise(r=>setTimeout(r,20));}throw Error('agent timeout');}
let count=0;async function test(name,fn){await fn();console.log(`PASS ${++count}. ${name}`);}
try{
 const {project}=await req('POST','/api/canvas/projects',{title:'Pi E2E'},201),pid=project.id;
 const a=(await req('POST',`/api/canvas/projects/${pid}/assets`,{imageBase64:bytes.toString('base64'),name:'模特'},201)).asset;
 const b=(await req('POST',`/api/canvas/projects/${pid}/assets`,{imageBase64:garment.toString('base64'),name:'服装'},201)).asset;
 const body={message:'双图换装，生成正背侧并检查排版',modelId:'image',analysisModelId:'brain',size:'1024x1024',maxImages:3,references:[{assetId:a.id,assetVersion:a.fingerprint,role:'model'},{assetId:b.id,assetVersion:b.fingerprint,role:'garment'}]};
 const quote=async extra=>(await req('POST',`/api/canvas/projects/${pid}/agent-quotes`,{...body,...extra})).quote;
 const start=async q=>(await req('POST',`/api/canvas/projects/${pid}/agent-runs`,{quoteId:q.id,requestKey:crypto.randomUUID()},202)).run;
 await test('six builtin skills validate and reject malformed frontmatter and symlink escape',async()=>{
  assert.equal(discoverSkills().length,6);
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'skills-check-'));fs.mkdirSync(path.join(root,'bad'));
  fs.writeFileSync(path.join(root,'bad','SKILL.md'),'---\nname: BAD\ndescription: x\n---\nx');assert.throws(()=>discoverSkills(root));
  fs.unlinkSync(path.join(root,'bad','SKILL.md'));fs.symlinkSync('/etc/hosts',path.join(root,'bad','SKILL.md'));assert.throws(()=>discoverSkills(root),/escapes/);
 });
 await test('disabled flag, ownership and native tools capability fail before paid requests',async()=>{
  process.env.AGENT_ENABLED='false';await req('POST',`/api/canvas/projects/${pid}/agent-quotes`,body,404);process.env.AGENT_ENABLED='true';
  await req('POST',`/api/canvas/projects/${pid}/agent-quotes`,body,404,'bob');
  db.prepare("UPDATE models SET extra_json='{\"vision\":true}' WHERE id='brain'").run();await req('POST',`/api/canvas/projects/${pid}/agent-quotes`,body,422);
  db.prepare("UPDATE models SET extra_json='{\"vision\":true,\"tool_calling\":true}' WHERE id='brain'").run();assert.equal(modelCalls,0);
 });
 let success;
 await test('real Pi multi-turn skills + three image children + visual inspection + layout, exact billing',async()=>{
  const before=balance(),q=await quote();assert.equal(q.credits,1653);assert.equal(modelCalls,0);
  const run=await start(q);success=await wait(run.id);assert.equal(success.status,'succeeded',success.result_json);
  assert.equal(imageCalls,3);assert.equal(modelCalls,8);assert.equal(before-balance(),29);assert.equal(success.settled,8);assert.equal(success.reserved,0);
  assert.deepEqual(imageInputs[0],[bytes,garment]);assert.deepEqual(imageInputs[1],[outputs[0],garment]);
  assert.equal(modelBodies[0].messages.find(m=>m.role==='user').content.filter(c=>c.type==='image_url').length,2);
  assert(modelBodies.at(-1).messages.some(m=>m.role==='user'&&m.content?.some(c=>c.type==='image_url')));
  const messages=JSON.parse(success.messages_json);assert.equal(messages.filter(m=>m.role==='toolResult').length,10);
  assert.equal(JSON.parse(success.result_json).layout.shapeIds.length,3);
  assert(!success.input_json.includes('fixture-secret'));assert(!success.messages_json.includes('fixture-secret'));
  const replay=(await req('POST',`/api/canvas/projects/${pid}/agent-runs`,{quoteId:q.id,requestKey:crypto.randomUUID()},202)).run;assert.equal(replay.id,run.id);assert.equal(imageCalls,3);
  await req('GET',`/api/canvas/agent-runs/${run.id}/events`,undefined,404,'bob');
  const events=(await req('GET',`/api/canvas/agent-runs/${run.id}/events`)).events;assert(events.some(e=>e.type==='tool_execution_end'));
  const after=events[0].sequence;assert((await req('GET',`/api/canvas/agent-runs/${run.id}/events?after=${after}`)).events.every(e=>e.sequence>after));
 });
 await test('clarification consumes one model call, no image, returns unused reserve',async()=>{mode='clarify';const before=balance(),images=imageCalls;const row=await wait((await start(await quote())).id);assert.equal(row.status,'needs_input');assert.equal(before-balance(),1);assert.equal(imageCalls,images);});
 await test('image cap halts before extra paid image',async()=>{mode='limit';const before=imageCalls;const row=await wait((await start(await quote({maxImages:1}))).id);assert.equal(row.status,'needs_confirmation');assert.equal(imageCalls-before,1);
  const resumed=(await req('POST',`/api/canvas/agent-runs/${row.id}/resume-quotes`,{maxImages:2})).quote;const confirm={quoteId:resumed.id};
  await req('POST',`/api/canvas/agent-runs/${row.id}/confirm`,confirm);const done=await wait(row.id);assert.equal(done.status,'succeeded',done.result_json);assert.equal(imageCalls-before,2);
  await req('POST',`/api/canvas/agent-runs/${row.id}/confirm`,confirm);assert.equal(imageCalls-before,2);});
 await test('untrusted asset IDs never reach image API',async()=>{mode='bad-asset';const before=imageCalls;const row=await wait((await start(await quote())).id);assert.equal(row.status,'failed');assert.equal(imageCalls,before);});
 await test('completed malformed model output bills once and releases unused reserve',async()=>{mode='malformed';const before=balance();const row=await wait((await start(await quote())).id);assert.equal(row.status,'failed');assert.equal(before-balance(),1);assert.equal(row.reserved,0);});
 await test('explicit provider rejection refunds, no retry',async()=>{mode='reject';const before=balance(),calls=modelCalls;const row=await wait((await start(await quote())).id);assert.equal(row.status,'failed');assert.equal(balance(),before);assert.equal(modelCalls,calls+1);});
 await test('unknown model dispatch retains only that call budget, no automatic retry; reconcile once',async()=>{
  mode='timeout';const before=balance(),calls=modelCalls;const row=await wait((await start(await quote())).id);assert.equal(row.status,'uncertain');assert.equal(row.reserved,102);assert.equal(before-balance(),102);assert.equal(modelCalls,calls+1);
  await req('POST',`/api/canvas/agent-runs/${row.id}/reconcile`,{action:'refund',reason:'供应商核实未收费'},200,'alice');assert.equal(balance(),before);
  await req('POST',`/api/canvas/agent-runs/${row.id}/reconcile`,{action:'refund',reason:'供应商核实未收费'},409,'alice');
 });
 await test('restart with dispatched model is uncertain, never queued for repeat',async()=>{
  const q=JSON.parse(success.input_json),id=crypto.randomUUID();db.prepare("INSERT INTO canvas_agent_runs(id,project_id,user_id,quote_id,request_key,status,input_json,reserved,created_at,updated_at) VALUES(?,?,?,?,?,'running',?,200,?,?)").run(id,pid,'alice',id,id,success.input_json,stamp,stamp);
  db.prepare("INSERT INTO canvas_agent_steps(id,run_id,sequence,kind,tool,status,input_json) VALUES(?,?,0,'model','chat','dispatched','{}')").run(id+':model',id);recoverAgents();const row=db.prepare('SELECT * FROM canvas_agent_runs WHERE id=?').get(id);assert.equal(row.status,'uncertain');assert.equal(row.reserved,q.analysis.perCall);
  await req('POST',`/api/canvas/agent-runs/${id}/reconcile`,{action:'refund',reason:'测试核对未收费'});
 });
 await test('restart after charged response without transcript stops rather than billing again',async()=>{
  const id=crypto.randomUUID();db.prepare("INSERT INTO canvas_agent_runs(id,project_id,user_id,quote_id,request_key,status,input_json,reserved,created_at,updated_at) VALUES(?,?,?,?,?,'running',?,200,?,?)").run(id,pid,'alice',id,id,success.input_json,stamp,stamp);
  db.prepare("INSERT INTO canvas_agent_steps(id,run_id,sequence,kind,tool,status,input_json,charge) VALUES(?,?,0,'model','chat','succeeded','{}',1)").run(id+':model',id);
  const before=modelCalls;recoverAgents();assert.equal(db.prepare('SELECT status FROM canvas_agent_runs WHERE id=?').get(id).status,'failed');assert.equal(modelCalls,before);
 });
 await test('stop during model dispatch bills that response but never starts image tools',async()=>{
  mode='gate';let unlock;gate=new Promise(r=>{unlock=r;});const before=balance(),images=imageCalls,calls=modelCalls;
  const run=await start(await quote());for(let i=0;i<100&&modelCalls===calls;i++)await new Promise(r=>setTimeout(r,10));
  await req('POST',`/api/canvas/agent-runs/${run.id}/stop`,{});unlock();gate=null;
  const row=await wait(run.id);assert.equal(row.status,'cancelled');assert.equal(imageCalls,images);assert.equal(before-balance(),1);
 });
 await test('changed model price invalidates quote before any dispatch or reservation',async()=>{
  const q=await quote(),before=balance(),calls=modelCalls;db.prepare(`UPDATE models SET pricing_json='{"input_per_1m":1001,"output_per_1m":1000}' WHERE id='brain'`).run();
  await req('POST',`/api/canvas/projects/${pid}/agent-runs`,{quoteId:q.id,requestKey:crypto.randomUUID()},409);assert.equal(balance(),before);assert.equal(modelCalls,calls);
  db.prepare(`UPDATE models SET pricing_json='{"input_per_1m":1000,"output_per_1m":1000}' WHERE id='brain'`).run();
 });
 await test('unknown image child retains only its own reserve; parent and child reconcile separately',async()=>{
  mode='image-timeout';const before=balance(),images=imageCalls,calls=modelCalls;const row=await wait((await start(await quote())).id);
  assert.equal(row.status,'uncertain');assert.equal(row.reserved,0);assert.equal(row.settled,3);assert.equal(imageCalls,images+1);assert.equal(modelCalls,calls+3);assert.equal(before-balance(),10);
  const child=db.prepare('SELECT child_run_id FROM canvas_agent_steps WHERE run_id=? AND child_run_id IS NOT NULL').get(row.id).child_run_id;
  assert.equal(db.prepare('SELECT reserved FROM canvas_runs WHERE id=?').get(child).reserved,7);
  await req('POST',`/api/canvas/agent-runs/${row.id}/reconcile`,{action:'refund',reason:'先核对图片子任务'},409);
  await req('POST',`/api/canvas/runs/${child}/reconcile`,{action:'refund',reason:'供应商确认未生成'});
  await req('POST',`/api/canvas/agent-runs/${row.id}/reconcile`,{action:'refund',reason:'图片子任务已核实'});assert.equal(before-balance(),3);
 });
 await test('restart resumes a known child result without re-dispatching its paid image',async()=>{
  mode='final';const id=crypto.randomUUID(),source=JSON.parse(success.input_json),originalMessages=JSON.parse(success.messages_json);
  const assistantIndex=originalMessages.findIndex(m=>m.role==='assistant'&&m.content.some(c=>c.type==='toolCall'&&c.name==='generate_image'));
  const restored=originalMessages.slice(0,assistantIndex+1),call=restored.at(-1).content.find(c=>c.type==='toolCall');
  const child=db.prepare('SELECT child_run_id FROM canvas_agent_steps WHERE run_id=? AND child_run_id IS NOT NULL ORDER BY sequence LIMIT 1').get(success.id).child_run_id;
  db.prepare("INSERT INTO canvas_agent_runs(id,project_id,user_id,quote_id,request_key,status,input_json,messages_json,reserved,created_at,updated_at) VALUES(?,?,?,?,?,'running',?,?,?,?,?)").run(id,pid,'alice',id,id,success.input_json,JSON.stringify(restored),source.total,stamp,stamp);
  db.prepare("INSERT INTO canvas_agent_steps(id,run_id,sequence,kind,tool,status,input_json,child_run_id) VALUES(?,?,0,'tool','generate_image','running',?,?)").run(`${id}:tool:${call.id}`,id,JSON.stringify(call.arguments),child);
  const before=imageCalls;recoverAgents();const {drainAgents}=await import('../src/agent/jobs.js');await drainAgents();
  const row=await wait(id);assert.equal(row.status,'succeeded',row.result_json);assert.equal(imageCalls,before);assert(JSON.parse(row.messages_json).some(m=>m.role==='toolResult'&&m.toolCallId===call.id));
 });
 await test('planning is billed separately and no image dispatch happens until execution confirmation',async()=>{
  mode='chain';const before=balance(),images=imageCalls;const q=await quote({planFirst:true,maxImages:3});assert.equal(q.credits,408);
  const row=await wait((await start(q)).id);assert.equal(row.status,'needs_confirmation',row.result_json);assert.equal(imageCalls,images);assert.equal(before-balance(),3);assert.equal(row.reserved,0);
  const execution=(await req('POST',`/api/canvas/agent-runs/${row.id}/resume-quotes`,{})).quote;assert(execution.plan);assert.equal(execution.credits,1347);
  await req('POST',`/api/canvas/agent-runs/${row.id}/confirm`,{quoteId:execution.id});const done=await wait(row.id);assert.equal(done.status,'succeeded',done.result_json);assert.equal(imageCalls-images,3);
  const saved=await req('POST',`/api/canvas/agent-runs/${row.id}/workflow`,{});assert.equal((await req('POST',`/api/canvas/agent-runs/${row.id}/workflow`,{})).id,saved.id);
  const workflows=(await req('GET','/api/canvas/agent/workflows')).workflows;assert(workflows[0].definition.nodes.some(n=>n.dependsOn.length));assert(!JSON.stringify(workflows).includes('fixture-secret'));
  const replay=await quote({workflowId:saved.id});assert(replay.id);await req('DELETE',`/api/canvas/agent/workflows/${saved.id}`,undefined,404,'bob');
 });
 await test('clarification continues the same task with only the newly attached actual images',async()=>{
  mode='clarify';const row=await wait((await start(await quote())).id);assert.equal(row.status,'needs_input');mode='final';
  const q=(await req('POST',`/api/canvas/agent-runs/${row.id}/resume-quotes`,{message:'只分析这张服装图',references:[{assetId:b.id,assetVersion:b.fingerprint,role:'garment'}]})).quote;
  await req('POST',`/api/canvas/agent-runs/${row.id}/confirm`,{quoteId:q.id},404,'bob');
  const before=modelCalls;await req('POST',`/api/canvas/agent-runs/${row.id}/confirm`,{quoteId:q.id});const done=await wait(row.id);assert.equal(done.status,'succeeded',done.result_json);assert.equal(modelCalls,before+1);
  const wire=modelBodies.at(-1),images=wire.messages.flatMap(m=>Array.isArray(m.content)?m.content.filter(c=>c.type==='image_url'):[]);assert.equal(images.length,1);
  assert.equal(done.id,row.id);
 });
 await test('unknown shell and network tools cannot execute and the native loop has a hard paid turn cap',async()=>{
  mode='attack';const before=balance(),calls=modelCalls,images=imageCalls;const row=await wait((await start(await quote())).id);
  assert.equal(row.status,'failed');assert.equal(modelCalls-calls,16);assert.equal(before-balance(),16);assert.equal(imageCalls,images);assert.equal(row.reserved,0);
 });
 await test('native SSE fragments preserve function arguments, usage and Pi tool stream events',async()=>{
  const packets=[{choices:[{delta:{tool_calls:[{index:0,id:'stream-call',type:'function',function:{name:'load_skill',arguments:'{"na'}}]}}]},{choices:[{delta:{tool_calls:[{index:0,function:{arguments:'me":"virtual-tryon"}'}}]}}]},{choices:[{delta:{},finish_reason:'tool_calls'}]},{choices:[],usage:{prompt_tokens:12,completion_tokens:8}}];
  const wire=packets.map(p=>'data: '+JSON.stringify(p)+'\r\n\r\n').join('')+'data: [DONE]\r\n\r\n',encoder=new TextEncoder();
  const response=new Response(new ReadableStream({start(controller){for(let i=0;i<wire.length;i+=7)controller.enqueue(encoder.encode(wire.slice(i,i+7)));controller.close();}}),{headers:{'Content-Type':'text/event-stream'}});
  let charges=0,dispatches=0;const adapter=nativeStream({resolved:{model_id:'fixture',baseUrl:'https://fixture.invalid/v1',apiKey:'secret'},beforeRequest:()=>{dispatches++;},onResult:u=>{charges++;assert.equal(u.input,12);assert.equal(u.output,8);},onFailure:e=>{throw e;},fetchFn:async()=>response});
  const stream=adapter({id:'fixture',api:'openai-completions',provider:'fixture'},{messages:[{role:'system',content:'test',toolsAdded:[]}]});const events=[];for await(const e of stream)events.push(e);
  const final=await stream.result();assert.equal(dispatches,1);assert.equal(charges,1);assert.equal(final.stopReason,'toolUse');assert.deepEqual(final.content[0].arguments,{name:'virtual-tryon'});assert(events.some(e=>e.type==='toolcall_delta'));assert(events.some(e=>e.type==='toolcall_end'));
 });
 await test('pre-request budget pause resumes without treating a local error as an upstream response',async()=>{
  mode='budget-plan';const images=imageCalls;const row=await wait((await start(await quote({planFirst:true}))).id);assert.equal(row.status,'needs_confirmation',row.result_json);assert.equal(row.settled,408);assert(!JSON.parse(row.result_json).plan);assert.equal(imageCalls,images);
  mode='chain';let q=(await req('POST',`/api/canvas/agent-runs/${row.id}/resume-quotes`,{})).quote;await req('POST',`/api/canvas/agent-runs/${row.id}/confirm`,{quoteId:q.id});
  const planned=await wait(row.id);assert.equal(planned.status,'needs_confirmation',planned.result_json);assert(JSON.parse(planned.result_json).plan);assert.equal(imageCalls,images);
  q=(await req('POST',`/api/canvas/agent-runs/${row.id}/resume-quotes`,{})).quote;await req('POST',`/api/canvas/agent-runs/${row.id}/confirm`,{quoteId:q.id});assert.equal((await wait(row.id)).status,'succeeded');assert.equal(imageCalls-images,3);
 });
 await test('first image generation cannot silently omit an uploaded reference even without role labels',async()=>{
  mode='drop-reference';const before=imageCalls;const row=await wait((await start(await quote({references:body.references.map(r=>({...r,role:'reference'}))}))).id);assert.equal(row.status,'failed');assert.equal(imageCalls,before);
 });
 await test('disabling Agent leaves legacy generation usable and pending history stoppable',async()=>{
  const id=crypto.randomUUID();db.prepare("INSERT INTO canvas_agent_runs(id,project_id,user_id,quote_id,request_key,status,input_json,created_at,updated_at) VALUES(?,?,?,?,?,'queued',?,?,?)").run(id,pid,'alice',id,id,success.input_json,stamp,stamp);
  process.env.AGENT_ENABLED='false';const cap=await req('GET','/api/canvas/agent/capabilities');assert.equal(cap.enabled,false);assert.equal(cap.hasRuns,true);
  const q=(await req('POST',`/api/canvas/projects/${pid}/quotes`,{...body,analysisModelId:null})).quote;
  const child=(await req('POST',`/api/canvas/projects/${pid}/runs`,{quoteId:q.id,requestKey:crypto.randomUUID()},202)).run;
  for(let i=0;i<100&&db.prepare('SELECT status FROM canvas_runs WHERE id=?').get(child.id).status!=='succeeded';i++)await new Promise(r=>setTimeout(r,10));
  assert.equal(db.prepare('SELECT status FROM canvas_runs WHERE id=?').get(child.id).status,'succeeded');
  await req('POST',`/api/canvas/agent-runs/${id}/stop`,{});assert.equal(db.prepare('SELECT status FROM canvas_agent_runs WHERE id=?').get(id).status,'cancelled');process.env.AGENT_ENABLED='true';
 });
 console.log(`Agent checks: ${count} passed (real Pi core; mock native upstream, no paid calls)`);
}finally{global.fetch=originalFetch;server.closeAllConnections();await new Promise(r=>server.close(r));closeDb();fs.rmSync(process.env.DATA_DIR,{recursive:true,force:true});}
