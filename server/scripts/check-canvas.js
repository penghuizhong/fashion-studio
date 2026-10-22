import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
process.env.DATA_DIR=fs.mkdtempSync(path.join(os.tmpdir(),'fashion-canvas-check-'));
process.env.MULTI_USER='true';process.env.MOCK_LLM='false';process.env.MASTER_KEY=crypto.randomBytes(32).toString('hex');process.env.WRITE_LIMIT_MAX='2000';
const {getDb,closeDb}=await import('../src/db.js');
const {createApp}=await import('../src/app.js');
const {encryptSecret}=await import('../src/secrets.js');
const {recoverCanvasRuns}=await import('../src/canvasJobs.js');
const {productFileReferenced}=await import('../src/productReferences.js');
const {CanvasPersistence}=await import('../../client/src/components/canvasPersistence.js');
const db=getDb(),stamp=new Date().toISOString(),originalFetch=global.fetch;
const bytes=await sharp({create:{width:120,height:180,channels:3,background:'#bbb'}}).png().toBuffer(),second=await sharp({create:{width:100,height:160,channels:3,background:'#aab'}}).png().toBuffer();
let requests=[],mode='success',gate=null,analysisMode='generate';
global.fetch=async(url,opts)=>{
 if(!String(url).startsWith('https://canvas.invalid'))return originalFetch(url,opts);
 if(String(url).includes('/chat/completions')){
   const content=analysisMode==='clarify'?{tool:'request_clarification',question:'请明确需要保留的服装部位'}:{tool:'generate_image',summary:'保留图1模特身份，将图2服装穿到身上。',prompt:'使用图1模特和图2服装生成试穿图。',title:'双图换装'};
   return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(content)}}],usage:{prompt_tokens:1000,completion_tokens:100}}),{headers:{'Content-Type':'application/json'}});
 }
 requests.push(opts);
 if(gate)await gate;
 if(mode==='timeout')throw new TypeError('fetch failed');
 if(mode==='reject')return new Response(JSON.stringify({error:{message:'bad request'}}),{status:400});
 return new Response(JSON.stringify({data:[{b64_json:bytes.toString('base64')}]}),{headers:{'Content-Type':'application/json'}});
};
for(const uid of ['alice','bob']){db.prepare("INSERT INTO users(id,username,password_hash,created_at,points_balance,billing_mode,is_admin) VALUES(?,?,?,?,1000,'points',?)").run(uid,uid,'unused',stamp,uid==='alice'?1:0);db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(crypto.createHash('sha256').update(uid+'-token').digest('hex'),uid,Date.now()+86400000);}
db.prepare("INSERT INTO providers(id,name,preset,kind,base_url,api_key_encrypted,is_active,created_at) VALUES('canvas','Canvas','custom','both','https://canvas.invalid/v1',?,1,?)").run(encryptSecret(process.env.MASTER_KEY,'fixture'),stamp);
db.prepare("INSERT INTO models(id,provider_id,kind,model_id,name,pricing_json,extra_json,is_active,created_at) VALUES('canvas','canvas','image','canvas','Canvas',?,?,1,?)").run('{"per_call":7}',JSON.stringify({sizes:['1024x1024'],image_config:{protocol:'openai_images',text:true,edit:true,max_images:4}}),stamp);
db.prepare("INSERT INTO models(id,provider_id,kind,model_id,name,pricing_json,extra_json,is_active,created_at) VALUES('canvas-chat','canvas','chat','canvas-chat','Canvas Agent',?,?,1,?)").run('{"input_per_1m":1000,"output_per_1m":1000}','{"vision":true}',stamp);
const server=createApp().listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base=`http://127.0.0.1:${server.address().port}`;
async function req(method,url,data,status=200,user='alice'){const r=await originalFetch(base+url,{method,headers:{Cookie:`soulchat_session=${user}-token`,'Content-Type':'application/json'},body:data===undefined?undefined:JSON.stringify(data)});const body=await r.json();assert.equal(r.status,status,JSON.stringify(body));return body;}
const balance=()=>db.prepare("SELECT points_balance FROM users WHERE id='alice'").get().points_balance;
async function wait(id){for(let i=0;i<100;i++){const row=db.prepare('SELECT * FROM canvas_runs WHERE id=?').get(id);if(!['queued','running'].includes(row.status))return row;await new Promise(r=>setTimeout(r,20));}throw Error('task timeout');}
let count=0;async function test(name,fn){await fn();console.log(`PASS ${++count}. ${name}`);}
try{
 const {project}=await req('POST','/api/canvas/projects',{title:'双图画板'},201),pid=project.id;
 let a,b;
 await test('projects and assets are owner scoped',async()=>{
   await req('GET',`/api/canvas/projects/${pid}`,undefined,404,'bob');
   a=(await req('POST',`/api/canvas/projects/${pid}/assets`,{imageBase64:bytes.toString('base64'),name:'模特'},201)).asset;
   b=(await req('POST',`/api/canvas/projects/${pid}/assets`,{imageBase64:second.toString('base64'),name:'衣服'},201)).asset;
   assert.equal(a.width,120);assert.equal(a.height,180);
   const {project:bob}=await req('POST','/api/canvas/projects',{title:'Bob'},201,'bob');
   await req('POST',`/api/canvas/projects/${bob.id}/assets`,{assetId:a.id},404,'bob');
   await req('POST',`/api/canvas/projects/${bob.id}/assets`,{path:a.image_path},404,'bob');
   const raw=await originalFetch(base+'/'+a.image_path,{headers:{Cookie:'soulchat_session=bob-token'}});assert.equal(raw.status,404);
   assert.equal(productFileReferenced(db,a.image_path),true);
 });
 const snapshot={version:1,document:{store:{},schema:{schemaVersion:2,sequences:{}}}};
 await test('canvas uploads can be reused and promoted to the persistent model library',async()=>{
   await req('POST',`/api/canvas/assets/${a.id}/model`,{});
   await req('POST',`/api/canvas/assets/${a.id}/model`,{});
   assert.equal(db.prepare("SELECT COUNT(*) n FROM style_references WHERE user_id='alice' AND image_path=? AND kind='model'").get(a.image_path).n,1);
   await req('POST',`/api/canvas/assets/${a.id}/model`,{},404,'bob');
   const listed=await req('GET','/api/canvas/assets?search='+encodeURIComponent('模特'));assert(listed.assets.some(row=>row.id===a.id));
   const {project:next}=await req('POST','/api/canvas/projects',{title:'复用画板'},201);
   const imported=(await req('POST',`/api/canvas/projects/${next.id}/assets`,{assetId:a.id})).asset;assert.equal(imported.id,a.id);assert.equal(imported.image_path,a.image_path);
 });
 await test('revision CAS rejects stale writes and snapshots reject external assets',async()=>{
   await req('PUT',`/api/canvas/projects/${pid}`,{title:'画板一',snapshot,expectedRevision:0});
   await req('PUT',`/api/canvas/projects/${pid}`,{title:'旧更新',snapshot,expectedRevision:0},409);
   assert.equal((await req('GET',`/api/canvas/projects/${pid}`)).project.title,'画板一');
   await req('PUT',`/api/canvas/projects/${pid}`,{title:'外部图',snapshot:{...snapshot,document:{...snapshot.document,store:{evil:{typeName:'asset',type:'image',props:{src:'https://evil.invalid/a.png'}}}}},expectedRevision:1},400);
 });
 await test('public shares expose only visible snapshot images and revoke immediately',async()=>{
   const sharedSnapshot={version:1,document:{schema:snapshot.document.schema,store:{'asset:visible':{id:'asset:visible',typeName:'asset',type:'image',props:{src:a.src},meta:{canvasAssetId:a.id}},'asset:unused':{id:'asset:unused',typeName:'asset',type:'image',props:{src:b.src},meta:{canvasAssetId:b.id}},'shape:visible':{id:'shape:visible',typeName:'shape',type:'image',props:{assetId:'asset:visible'}}}}};
   await req('PUT',`/api/canvas/projects/${pid}`,{title:'分享画板',snapshot:sharedSnapshot,expectedRevision:1});
   const share=await req('POST',`/api/canvas/projects/${pid}/share`,{},201);
   const response=await originalFetch(base+`/api/canvas/shared/${share.token}`);assert.equal(response.status,200);const data=await response.json();assert.equal(data.title,'分享画板');assert(!data.snapshot.document.store['asset:unused']);
   const image=await originalFetch(base+data.snapshot.document.store['asset:visible'].props.src);assert.equal(image.status,200);assert.deepEqual(Buffer.from(await image.arrayBuffer()),bytes);
   assert.equal((await originalFetch(base+`/api/canvas/shared/${share.token}/assets/${b.id}`)).status,404);
   await req('DELETE',`/api/canvas/projects/${pid}/share`,undefined,404,'bob');
   await req('DELETE',`/api/canvas/projects/${pid}/share`);
   assert.equal((await originalFetch(base+`/api/canvas/shared/${share.token}`)).status,404);
 });
 const references=[{assetId:a.id,assetVersion:a.fingerprint,role:'model'},{assetId:b.id,assetVersion:b.fingerprint,role:'garment'}];
 const body={message:'图1模特穿上图2衣服',modelId:'canvas',size:'1024x1024',references};
 await test('two real image bytes reach upstream; replay does not double charge or dispatch',async()=>{
   const {quote}=await req('POST',`/api/canvas/projects/${pid}/quotes`,body);assert.equal(quote.credits,7);
   const key=crypto.randomUUID(),before=balance();
   const {run}=await req('POST',`/api/canvas/projects/${pid}/runs`,{quoteId:quote.id,requestKey:key},202);
   const again=await req('POST',`/api/canvas/projects/${pid}/runs`,{quoteId:quote.id,requestKey:key},202);assert.equal(again.run.id,run.id);
   const result=await wait(run.id);assert.equal(result.status,'succeeded');assert.equal(balance(),before-7);assert.equal(requests.length,1);
   const images=requests[0].body.getAll('image[]');assert.equal(images.length,2);assert.deepEqual(Buffer.from(await images[0].arrayBuffer()),bytes);assert.deepEqual(Buffer.from(await images[1].arrayBuffer()),second);
   assert.equal(db.prepare('SELECT COUNT(*) n FROM canvas_asset_events WHERE run_id=?').get(run.id).n,2);
   assert.equal(JSON.parse(result.result_json).trace.image_count,2);
   await req('POST',`/api/canvas/runs/${run.id}/delivered`,{},409);
   const recipe=await req('POST','/api/canvas/recipes',{runId:run.id},201),same=await req('POST','/api/canvas/recipes',{runId:run.id});assert.equal(recipe.id,same.id);
   await req('DELETE',`/api/canvas/recipes/${recipe.id}`,undefined,404,'bob');
 });
 await test('cropped references send the actual cropped pixels',async()=>{
   const cropped=[{...references[0],crop:{topLeft:{x:0,y:0},bottomRight:{x:0.5,y:0.5}}}];
   const {quote}=await req('POST',`/api/canvas/projects/${pid}/quotes`,{...body,references:cropped});
   const {run}=await req('POST',`/api/canvas/projects/${pid}/runs`,{quoteId:quote.id,requestKey:crypto.randomUUID()},202);assert.equal((await wait(run.id)).status,'succeeded');
   const image=requests.at(-1).body.get('image'),metadata=await sharp(Buffer.from(await image.arrayBuffer())).metadata();assert.equal(metadata.width,60);assert.equal(metadata.height,90);
   await req('POST',`/api/canvas/projects/${pid}/quotes`,{...body,references:[{...references[0],crop:{topLeft:{x:-1,y:0},bottomRight:{x:1,y:1}}}]},400);
 });
 await test('brand kit ownership and quote freeze',async()=>{
   const kit=await req('POST','/api/canvas/brand-kits',{name:'品牌',prompt:'自然光，避免品牌标识',palette:['#123456']},201);
   const {quote}=await req('POST',`/api/canvas/projects/${pid}/quotes`,{...body,brandKitId:kit.id});assert(quote.payload.prompt.includes('自然光'));assert.equal(quote.payload.brand.palette[0],'#123456');
   await req('DELETE',`/api/canvas/brand-kits/${kit.id}`,undefined,404,'bob');
   await req('DELETE',`/api/canvas/brand-kits/${kit.id}`);assert(quote.payload.prompt.includes('自然光'));
 });
 await test('invalid roles, duplicates, stale fingerprints and changed quotes never dispatch',async()=>{
   const calls=requests.length;
   await req('POST',`/api/canvas/projects/${pid}/quotes`,{...body,references:[references[0],references[0]]},400);
   await req('POST',`/api/canvas/projects/${pid}/quotes`,{...body,references:[{...references[0],assetVersion:'stale'}]},409);
   await req('POST',`/api/canvas/projects/${pid}/quotes`,{...body,references:[{...references[0],role:'evil'}]},400);
   const {quote}=await req('POST',`/api/canvas/projects/${pid}/quotes`,body);
   db.prepare("UPDATE models SET pricing_json='{"+'"per_call":8'+"}' WHERE id='canvas'").run();
   await req('POST',`/api/canvas/projects/${pid}/runs`,{quoteId:quote.id,requestKey:crypto.randomUUID()},409);
   assert.equal(requests.length,calls);db.prepare("UPDATE models SET pricing_json='{"+'"per_call":7'+"}' WHERE id='canvas'").run();
 });
 await test('explicit upstream rejection refunds once',async()=>{
   mode='reject';const before=balance(),{quote}=await req('POST',`/api/canvas/projects/${pid}/quotes`,body),key=crypto.randomUUID();
   const {run}=await req('POST',`/api/canvas/projects/${pid}/runs`,{quoteId:quote.id,requestKey:key},202);assert.equal((await wait(run.id)).status,'failed');assert.equal(balance(),before);
   await req('POST',`/api/canvas/projects/${pid}/runs`,{quoteId:quote.id,requestKey:key},202);assert.equal(balance(),before);
 });
 await test('ambiguous upstream failure never retries and admin reconciliation is idempotent',async()=>{
   mode='timeout';const before=balance(),calls=requests.length,{quote}=await req('POST',`/api/canvas/projects/${pid}/quotes`,body);
   const {run}=await req('POST',`/api/canvas/projects/${pid}/runs`,{quoteId:quote.id,requestKey:crypto.randomUUID()},202);
   assert.equal((await wait(run.id)).status,'uncertain');assert.equal(balance(),before-7);assert.equal(requests.length,calls+1);
   const fresh=await req('POST',`/api/canvas/projects/${pid}/quotes`,body);await req('POST',`/api/canvas/projects/${pid}/runs`,{quoteId:fresh.quote.id,requestKey:crypto.randomUUID()},409);
   await req('POST',`/api/canvas/runs/${run.id}/reconcile`,{action:'refund',reason:'上游核对未完成'},403,'bob');
   await req('POST',`/api/canvas/runs/${run.id}/reconcile`,{action:'refund',reason:'上游核对未完成'});assert.equal(balance(),before);
   await req('POST',`/api/canvas/runs/${run.id}/reconcile`,{action:'refund',reason:'上游核对未完成'},409);assert.equal(balance(),before);
 });
 await test('stop never falsely claims to cancel an already dispatched request',async()=>{
   mode='success';let releaseGate;gate=new Promise(r=>releaseGate=r);const {quote}=await req('POST',`/api/canvas/projects/${pid}/quotes`,body);
   const {run}=await req('POST',`/api/canvas/projects/${pid}/runs`,{quoteId:quote.id,requestKey:crypto.randomUUID()},202);
   while(!db.prepare("SELECT 1 FROM canvas_runs WHERE id=? AND status='running'").get(run.id))await new Promise(r=>setTimeout(r,10));
   const stopped=await req('POST',`/api/canvas/runs/${run.id}/stop`,{});assert.equal(stopped.run.stop_requested,1);releaseGate();gate=null;assert.equal((await wait(run.id)).status,'succeeded');
 });
 await test('Agent planning uses actual references, records steps and settles measured analysis cost',async()=>{
   const before=balance(),calls=requests.length,{quote}=await req('POST',`/api/canvas/projects/${pid}/quotes`,{...body,analysisModelId:'canvas-chat'});
   assert(quote.credits>7);
   const {run}=await req('POST',`/api/canvas/projects/${pid}/runs`,{quoteId:quote.id,requestKey:crypto.randomUUID()},202),done=await wait(run.id),result=JSON.parse(done.result_json);
   assert.equal(done.status,'succeeded');assert.equal(balance(),before-9);assert.equal(result.analysis.tool,'generate_image');assert.equal(result.trace.image_count,2);assert.equal(requests.length,calls+1);
   assert.equal(db.prepare('SELECT COUNT(*) n FROM canvas_steps WHERE run_id=?').get(run.id).n,2);
 });
 await test('Agent clarification skips image dispatch and releases image reserve',async()=>{
   analysisMode='clarify';const before=balance(),calls=requests.length,{quote}=await req('POST',`/api/canvas/projects/${pid}/quotes`,{...body,analysisModelId:'canvas-chat'});
   const {run}=await req('POST',`/api/canvas/projects/${pid}/runs`,{quoteId:quote.id,requestKey:crypto.randomUUID()},202),done=await wait(run.id);
   assert.equal(done.status,'needs_input');assert.equal(balance(),before-2);assert.equal(requests.length,calls);analysisMode='generate';
 });
 await test('unknown image result settles only measured analysis, keeping only image reserve',async()=>{
   mode='timeout';const before=balance(),{quote}=await req('POST',`/api/canvas/projects/${pid}/quotes`,{...body,analysisModelId:'canvas-chat',message:'未知图片结算验证'});
   const {run}=await req('POST',`/api/canvas/projects/${pid}/runs`,{quoteId:quote.id,requestKey:crypto.randomUUID()},202),done=await wait(run.id);
   assert.equal(done.status,'uncertain');assert.equal(done.reserved,7);assert.equal(done.settled,2);assert.equal(balance(),before-9);
   await req('POST',`/api/canvas/runs/${run.id}/reconcile`,{action:'refund',reason:'供应商图片未产生费用'});
   assert.equal(balance(),before-2);assert.equal(db.prepare('SELECT settled FROM canvas_runs WHERE id=?').get(run.id).settled,2);mode='success';
 });
 await test('workflow batches preserve parameters, enforce budget, and start atomically once',async()=>{
   const recipe=(await req('GET','/api/canvas/recipes')).recipes[0];
   const c=(await req('POST',`/api/canvas/projects/${pid}/assets`,{imageBase64:bytes.toString('base64'),name:'第二位模特'},201)).asset;
   const input={recipeId:recipe.id,slot:0,budget:13,targets:[references[0],{assetId:c.id,assetVersion:c.fingerprint}]};
   await req('POST',`/api/canvas/projects/${pid}/batch-quotes`,input,422);
   const {batch}=await req('POST',`/api/canvas/projects/${pid}/batch-quotes`,{...input,budget:14});assert.equal(batch.total,14);
   const before=balance(),started=await req('POST',`/api/canvas/projects/${pid}/batches`,{batchId:batch.id},202);assert.equal(started.runs.length,2);
   const again=await req('POST',`/api/canvas/projects/${pid}/batches`,{batchId:batch.id});assert.deepEqual(again.runs.map(r=>r.id).sort(),started.runs.map(r=>r.id).sort());
   for(const run of started.runs){const done=await wait(run.id);assert.equal(done.status,'succeeded');assert.equal(JSON.parse(done.input_json).analysis,null);}
   assert.equal(balance(),before-14);
 });
 await test('expired running lease becomes uncertain without provider retry',async()=>{
   const {quote}=await req('POST',`/api/canvas/projects/${pid}/quotes`,body),id=crypto.randomUUID();
   db.prepare('INSERT INTO canvas_runs(id,project_id,user_id,request_key,quote_id,status,input_json,lease_until,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,pid,'alice',crypto.randomUUID(),quote.id,'running',JSON.stringify(quote.payload),0,stamp,stamp);
   db.prepare('INSERT INTO canvas_steps(id,run_id,sequence,tool,status,input_json) VALUES(?,?,?,?,?,?)').run(id+':1',id,1,'generate_image','running','{}');
   const calls=requests.length;recoverCanvasRuns();assert.equal(db.prepare('SELECT status FROM canvas_runs WHERE id=?').get(id).status,'uncertain');assert.equal(requests.length,calls);
 });
 await test('restart recovery retains measured analysis charges and only unknown image reserve',async()=>{
   const {addLedger}=await import('../src/points.js');
   const before=balance(),{quote}=await req('POST',`/api/canvas/projects/${pid}/quotes`,{...body,analysisModelId:'canvas-chat',message:'恢复结算验证'}),id=crypto.randomUUID();
   addLedger('alice',-quote.credits,'canvas_reserve','canvas_run',id,{accountingDelta:0});
   db.prepare('INSERT INTO canvas_runs(id,project_id,user_id,request_key,quote_id,status,input_json,reserved,lease_until,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(id,pid,'alice',crypto.randomUUID(),quote.id,'running',JSON.stringify(quote.payload),quote.credits,0,stamp,stamp);
   db.prepare('INSERT INTO canvas_steps(id,run_id,sequence,tool,status,input_json,output_json) VALUES(?,?,?,?,?,?,?)').run(id+':0',id,0,'generate_image','succeeded','{}','{"charge":2}');
   db.prepare('INSERT INTO canvas_steps(id,run_id,sequence,tool,status,input_json) VALUES(?,?,?,?,?,?)').run(id+':1',id,1,'generate_image','running','{}');
   recoverCanvasRuns();const row=db.prepare('SELECT * FROM canvas_runs WHERE id=?').get(id);assert.equal(row.status,'uncertain');assert.equal(row.reserved,7);assert.equal(row.settled,2);assert.equal(balance(),before-9);
   await req('POST',`/api/canvas/runs/${id}/reconcile`,{action:'refund',reason:'核对图片未产生费用'});assert.equal(balance(),before-2);
 });
 await test('autosave serializes overlapping changes and carries the acknowledged revision',async()=>{
   let value=1,resolveFirst,calls=[];const save=new CanvasPersistence({revision:3,read:()=>({value}),write:async data=>{calls.push(data);if(calls.length===1)await new Promise(r=>resolveFirst=r);return {revision:data.expectedRevision+1};},onState:()=>{},delay:60000});
   save.changed();const flushing=save.flush();value=2;save.changed();resolveFirst();await flushing;assert.deepEqual(calls,[{value:1,expectedRevision:3},{value:2,expectedRevision:4}]);assert.equal(save.saved,save.sequence);save.dispose();
 });
 console.log(`Canvas checks: ${count} passed`);
}finally{global.fetch=originalFetch;server.closeAllConnections();await new Promise(r=>server.close(r));closeDb();fs.rmSync(process.env.DATA_DIR,{recursive:true,force:true});}
