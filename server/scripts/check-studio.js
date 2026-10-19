import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import Database from 'better-sqlite3';
process.env.DATA_DIR=fs.mkdtempSync(path.join(os.tmpdir(),'studio09-'));
process.env.MULTI_USER='true';process.env.MOCK_LLM='false';process.env.MASTER_KEY=crypto.randomBytes(32).toString('hex');process.env.SESSION_SECRET=crypto.randomBytes(32).toString('hex');process.env.WRITE_LIMIT_MAX='2000';
const {getDb,closeDb}=await import('../src/db.js');
const {createApp}=await import('../src/app.js');
const {encryptSecret}=await import('../src/secrets.js');
const {waitJob}=await import('../src/exploreJobs.js');
const {getModel,updateModel,updateProvider}=await import('../src/registry.js');
const {generateImage}=await import('../src/image.js');
const {imageOptions}=await import('../src/imageCapabilities.js');
const db=getDb(),now=new Date().toISOString(),originalFetch=global.fetch;
const png=await sharp({create:{width:512,height:768,channels:3,background:'#123456'}}).png().toBuffer();
const calls=[];let failTest=false;
global.fetch=async(url,opts={})=>{
 if(!String(url).includes('.studio-test.invalid'))return originalFetch(url,opts);
 calls.push({url:String(url),...opts});
 if(failTest)return new Response('{}',{status:400,headers:{'Content-Type':'application/json'}});
 if(String(url).endsWith('/chat/completions'))return new Response(JSON.stringify({choices:[{message:{content:'OK'}}]}),{headers:{'Content-Type':'application/json'}});
 if(String(url).includes('/multimodal-generation/'))return new Response(JSON.stringify({output:{choices:[{message:{content:[{image:`data:image/png;base64,${png.toString('base64')}`}]}}]}}),{headers:{'Content-Type':'application/json'}});
 return new Response(JSON.stringify({data:[{b64_json:png.toString('base64')}]}),{headers:{'Content-Type':'application/json'}});
};
for(const user of ['alice','bob']){
 db.prepare('INSERT INTO users(id,username,password_hash,created_at,points_balance,billing_mode,is_admin) VALUES(?,?,?,?,1000,\'points\',?)').run(user,user,'not-a-password',now,user==='alice'?1:0);
 db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(crypto.createHash('sha256').update(user+'-token').digest('hex'),user,Date.now()+86400000);
}
for(const id of ['one','two']){
 db.prepare('INSERT INTO providers(id,name,preset,kind,base_url,api_key_encrypted,is_active,created_at) VALUES(?,?,?,\'both\',?,?,1,?)').run(id,id,'openrouter',`https://${id}.studio-test.invalid/v1`,encryptSecret(process.env.MASTER_KEY,id+'-key'),now);
 db.prepare('INSERT INTO models(id,provider_id,kind,model_id,name,pricing_json,extra_json,is_active,created_at) VALUES(?,?,\'image\',\'same-upstream-name\',?,?,?,?,?)').run('image-'+id,id,id,JSON.stringify({per_call:5,image_rates:[{size:'*',quality:'*',per_call:5},{size:'*',quality:'high',per_call:9}]}),JSON.stringify({sizes:['1024x1024','768x1024'],image_config:{protocol:'openai_images',text:true,edit:true,max_images:3,qualities:[{value:'high',label:'精细'}],custom_size:{enabled:true,min:256,max:2048,step:8,max_pixels:4194304}}}),1,now);
}
const server=await new Promise(resolve=>{const s=createApp().listen(0,'127.0.0.1',()=>resolve(s));});
const base=`http://127.0.0.1:${server.address().port}`;
async function req(method,url,body,status=200,user='alice'){
 const r=await originalFetch(base+url,{method,headers:{Cookie:`soulchat_session=${user}-token`,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
 const j=await r.json();assert.equal(r.status,status,JSON.stringify(j));return j;
}
let n=0;async function test(name,fn){await fn();console.log(`PASS ${++n}. ${name}`);}
let template,version,dna;
async function make(name='Lifecycle test'){
 return (await req('POST','/api/studio/templates',{name,preset_id:'suit',dna_json:dna,source_image_base64:png.toString('base64')})).id;
}
const fixtureFile=()=>{const file=`uploads/studio/${crypto.randomUUID()}.png`;fs.writeFileSync(path.join(process.env.DATA_DIR,file),png);return file;};
const generation=(template_id,file=fixtureFile(),thumb=file)=>Number(db.prepare('INSERT INTO dna_generations(template_id,user_id,image_path,thumb_path,created_at) VALUES(?,\'alice\',?,?,?)').run(template_id,file,thumb,now).lastInsertRowid);
try{
 const preset=(await req('GET','/api/studio/dna-presets')).presets.find(p=>p.id==='suit');
 dna=Object.fromEntries(preset.fields.map(f=>[f.key,{value:f.key==='details'?['贴兜']:'常规',confidence:0.8}]));
 template=await make();version=(await req('GET',`/api/studio/templates/${template}/workspace`)).versions[0].id;
 const body={version_id:version,op:'create',mode:'image',source:'original',model_id:'image-two',size:'800x1200',quality:'high',count:2};
 await test('non-custom provider uses explicit image protocol and quotes size/quality prices',async()=>{
  const models=(await req('GET','/api/studio/image-models')).models;
  assert.ok(models.find(m=>m.id==='image-two').capabilities.image_edit);
  const q=(await req('POST',`/api/studio/templates/${template}/quote`,body)).quote;
  assert.equal(q.unit_price,9);assert.equal(q.total,18);assert.equal(q.quality,'high');assert.equal(q.size,'800x1200');
  const job=(await req('POST',`/api/studio/templates/${template}/jobs`,{quote_id:q.id,request_key:crypto.randomUUID(),confirm:true},202)).job;
  await waitJob(job.id);assert.equal(calls.at(-1).url,'https://two.studio-test.invalid/v1/images/edits');
  assert.equal(calls.at(-1).body.get('quality'),'high');assert.equal(calls.at(-1).body.get('size'),'800x1200');
  assert.equal((await req('GET',`/api/studio/templates/${template}/workspace`)).jobs[0].cost_actual,18);
  assert.equal(db.prepare("SELECT points_balance FROM users WHERE id='alice'").get().points_balance,982);
 });
 await test('size and quality invalid values are rejected before a model call',async()=>{
  const count=calls.length;
  for(const size of ['801x1200','16x16','8192x8192'])await req('POST',`/api/studio/templates/${template}/quote`,{...body,size},400);
  await req('POST',`/api/studio/templates/${template}/quote`,{...body,quality:'ultra'},400);
  assert.equal(calls.length,count);
 });
 await test('failed quality-specific requests refund and retries preserve output and prompt snapshots',async()=>{
  const before=db.prepare("SELECT points_balance FROM users WHERE id='alice'").get().points_balance;
  const q=(await req('POST',`/api/studio/templates/${template}/quote`,{...body,count:1})).quote;
  failTest=true;
  const job=(await req('POST',`/api/studio/templates/${template}/jobs`,{quote_id:q.id,request_key:crypto.randomUUID(),confirm:true},202)).job;
  const result=await waitJob(job.id);failTest=false;assert.equal(result.status,'failed');
  assert.equal(db.prepare("SELECT points_balance FROM users WHERE id='alice'").get().points_balance,before);
  const retry=(await req('POST',`/api/studio/templates/${template}/retry-quote`,{job_id:job.id})).quote;
  assert.equal(retry.quality,'high');assert.equal(retry.size,'800x1200');assert.deepEqual(retry.prompts,q.prompts);assert.deepEqual(retry.seeds,q.seeds);assert.equal(retry.unit_price,9);
 });
 await test('reference image order and explicit role instructions reach actual multipart request',async()=>{
  const r1=await req('POST','/api/studio/references',{image_base64:png.toString('base64')});
  const r2=await req('POST','/api/studio/references',{image_base64:png.toString('base64')});
  const q=(await req('POST',`/api/studio/templates/${template}/quote`,{...body,count:1,references:[{source:`ref:${r2.id}`,role:'instruction'},{source:`ref:${r1.id}`,role:'instruction'}],instruction:'图2领子、图3袖子'})).quote;
  assert.equal(q.style.references[0].reference_id,r2.id);assert.match(q.prompts[0],/Image 2/);
  const job=(await req('POST',`/api/studio/templates/${template}/jobs`,{quote_id:q.id,request_key:crypto.randomUUID(),confirm:true},202)).job;await waitJob(job.id);
  const files=calls.at(-1).body.getAll('image[]');assert.equal(files.length,3);assert.deepEqual(Buffer.from(await files[0].arrayBuffer()),png);
  await req('POST',`/api/studio/templates/${template}/quote`,{...body,references:Array(3).fill({source:`ref:${r1.id}`,role:'instruction'})},422);
 });
 await test('model changes invalidate quotes, while existing snapshot is retained',async()=>{
  const q=(await req('POST',`/api/studio/templates/${template}/quote`,body)).quote;
  const model=getModel('image-two');updateModel(model.id,{extra:{...model.extra,image_config:{...model.extra.image_config,max_images:2}}});
  await req('POST',`/api/studio/templates/${template}/jobs`,{quote_id:q.id,request_key:crypto.randomUUID(),confirm:true},409);
 });
 await test('admin functional tests route through exact provider and keep user ledger unchanged',async()=>{
  const balance=db.prepare("SELECT points_balance FROM users WHERE id='alice'").get().points_balance;
  await req('POST','/api/admin/models/test',{id:'image-two',task:'single'},400);
  await req('POST','/api/admin/models/test',{id:'image-two',task:'single',confirm:true},403,'bob');
  const r=await req('POST','/api/admin/models/test',{id:'image-two',task:'single',confirm:true});
  assert.equal(r.status,'passed');assert.ok(r.preview);assert.match(calls.at(-1).url,/two\.studio-test/);
  assert.equal(db.prepare("SELECT points_balance FROM users WHERE id='alice'").get().points_balance,balance);
  const models=(await req('GET','/api/admin/models')).models;
  assert.equal(models.find(m=>m.id==='image-two').checks[0].status,'passed');
  updateProvider('two',{base_url:'https://changed.studio-test.invalid/v1'});
  const changed=(await req('GET','/api/admin/models')).models.find(m=>m.id==='image-two');assert.equal(changed.checks[0].status,'stale');
 });
 await test('legacy raw upstream model name cannot select an arbitrary same-named provider',async()=>{
  const count=calls.length;
  await assert.rejects(()=>generateImage({modelId:'same-upstream-name',prompt:'test',size:'1024x1024'}));assert.equal(calls.length,count);
 });
 await test('DashScope native multimodal input follows explicit adapter, including image order',async()=>{
  const cap=imageOptions({image_config:{protocol:'dashscope_multimodal',edit:true,max_images:2},sizes:['1024x1024']},'dashscope');
  await generateImage({modelId:'native',prompt:'use image 1',size:'1024x1024',sourceImageBase64:png.toString('base64'),referenceImages:[png.toString('base64')],executionModel:{model_id:'native',capabilities:cap,apiKey:'test-key',baseUrl:'https://native.studio-test.invalid/compatible-mode/v1',price_per_call:0},deferBilling:true});
  assert.match(calls.at(-1).url,/\/api\/v1\/services\/aigc\/multimodal-generation\/generation$/);
  assert.equal(JSON.parse(calls.at(-1).body).input.messages[0].content.filter(c=>c.image).length,2);
 });
 await test('archive, recycle and restore preserve prior lifecycle and immutable design',async()=>{
  const id=await make('archive');
  await req('POST',`/api/studio/templates/${id}/lifecycle`,{action:'archive'});
  await req('POST',`/api/studio/templates/${id}/lifecycle`,{action:'trash'});
  await req('POST',`/api/studio/templates/${id}/lifecycle`,{action:'trash'});
  await req('POST',`/api/studio/templates/${id}/lifecycle`,{action:'restore'});
  assert.ok((await req('GET','/api/studio/templates?state=archived')).templates.some(t=>t.id===id));
  assert.deepEqual(JSON.parse((await req('GET',`/api/studio/templates/${id}/workspace`)).versions[0].dna_json),dna);
  await req('POST',`/api/studio/templates/${id}/lifecycle`,{action:'activate'},404,'bob');
 });
 await test('asset moves do not delete shared images, and batch operation is atomic across ownership',async()=>{
  const id=await make('assets'),file=fixtureFile(),a=generation(id,file),b=generation(id,file);
  await req('POST',`/api/studio/generations/${a}/lifecycle`,{action:'trash'});
  assert.equal(fs.existsSync(path.join(process.env.DATA_DIR,file)),true);
  await req('POST','/api/studio/assets/lifecycle',{ids:[b,999999],action:'trash'},404);
  assert.equal(db.prepare('SELECT lifecycle FROM dna_generations WHERE id=?').get(b).lifecycle,'active');
  await req('POST',`/api/studio/generations/${a}/lifecycle`,{action:'delete',confirm:'永久删除'});
  const cleanup=await req('POST',`/api/studio/generations/${a}/cleanup-files`,{confirm:'清理文件'});assert.equal(cleanup.retained,true);
  assert.deepEqual(fs.readFileSync(path.join(process.env.DATA_DIR,file)),png);
 });
 await test('permanent asset removal clears cover but retains bytes until explicit unreferenced cleanup',async()=>{
  const id=await make('unique'),file=fixtureFile(),g=generation(id,file);db.prepare('UPDATE style_dna_templates SET cover_generation_id=? WHERE id=?').run(g,id);
  await req('POST',`/api/studio/generations/${g}/lifecycle`,{action:'delete',confirm:'永久删除'},400);
  await req('POST',`/api/studio/generations/${g}/lifecycle`,{action:'trash'});
  await req('POST',`/api/studio/generations/${g}/lifecycle`,{action:'delete',confirm:'永久删除'});
  assert.equal(db.prepare('SELECT cover_generation_id FROM style_dna_templates WHERE id=?').get(id).cover_generation_id,null);
  assert.ok(fs.existsSync(path.join(process.env.DATA_DIR,file)));
  const r=await req('POST',`/api/studio/generations/${g}/cleanup-files`,{confirm:'清理文件'});assert.equal(r.retained,false);assert.equal(fs.existsSync(path.join(process.env.DATA_DIR,file)),false);
  await req('POST',`/api/studio/generations/${g}/lifecycle`,{action:'restore'},409);
 });
 await test('filesystem cleanup rolls back staging when audit write fails',async()=>{
  const id=await make('cleanup rollback'),file=fixtureFile(),thumb=fixtureFile(),g=generation(id,file,thumb);
  await req('POST',`/api/studio/generations/${g}/lifecycle`,{action:'trash'});
  await req('POST',`/api/studio/generations/${g}/lifecycle`,{action:'delete',confirm:'永久删除'});
  db.exec("CREATE TRIGGER test_cleanup_failure BEFORE INSERT ON studio_lifecycle_events WHEN NEW.action='cleanup-files' BEGIN SELECT RAISE(ABORT,'fixture audit failure'); END");
  await req('POST',`/api/studio/generations/${g}/cleanup-files`,{confirm:'清理文件'},500);
  for(const pathValue of [file,thumb])assert.deepEqual(fs.readFileSync(path.join(process.env.DATA_DIR,pathValue)),png);
  db.exec('DROP TRIGGER test_cleanup_failure');
 });
 await test('deleting a style preserves audit, hides children and requires recycle confirmation',async()=>{
  const id=await make('delete style'),g=generation(id),w=await req('GET',`/api/studio/templates/${id}/workspace`);
  await req('POST',`/api/studio/templates/${id}/lifecycle`,{action:'trash'});
  assert.ok(!(await req('GET','/api/studio/assets')).assets.some(a=>a.id===g));
  await req('POST',`/api/studio/templates/${id}/lifecycle`,{action:'delete',confirm:'永久删除'});
  await req('GET',`/api/studio/templates/${id}/workspace`,undefined,404);
  assert.equal(db.prepare('SELECT dna_json FROM style_versions WHERE id=?').get(w.versions[0].id).dna_json,JSON.stringify(dna));
 });
 await test('running and uncertain historical items block destructive style removal',async()=>{
  const id=await make('busy');
  const b=Number(db.prepare("INSERT INTO exploration_batches(user_id,created_at,updated_at,workflow_kind) VALUES('alice',?,?,'style')").run(now,now).lastInsertRowid);
  db.prepare('UPDATE style_dna_templates SET style_batch_id=? WHERE id=?').run(b,id);
  db.prepare("INSERT INTO explore_jobs VALUES('busy-job',?,'alice','busy-key','quote','interrupted','{}',0,?)").run(b,now);
  db.prepare("INSERT INTO explore_items VALUES('busy-item','busy-job',0,'uncertain','{}',0)").run();
  await req('POST',`/api/studio/templates/${id}/lifecycle`,{action:'trash'});
  const impact=(await req('GET',`/api/studio/templates/${id}/impact`)).impact;assert.equal(impact.busy,true);
  await req('POST',`/api/studio/templates/${id}/lifecycle`,{action:'delete',confirm:'永久删除'},409);
 });
 await test('missing-file assets report distinct original and thumbnail availability',async()=>{
  const id=await make('missing'),g=generation(id,'uploads/studio/missing.png',fixtureFile());
  const asset=(await req('GET','/api/studio/assets')).assets.find(a=>a.id===g);
  assert.equal(asset.image_available,false);assert.equal(asset.thumb_available,true);
 });
 await test('saved free-text design changes create immutable versions without inventing structured attributes',async()=>{
  await req('POST',`/api/studio/templates/${template}/quote`,{...body,instruction:'图2的领子改成条纹',instruction_scope:'design'},400);
  const v=(await req('POST',`/api/studio/templates/${template}/versions`,{parent_id:version,dna,design_note:'图2的领子改成条纹',request_key:crypto.randomUUID()})).version;
  assert.notEqual(v.id,version);assert.equal(v.design_note,'图2的领子改成条纹');
  assert.equal(db.prepare('SELECT design_note FROM style_versions WHERE id=?').get(version).design_note,'');
  assert.throws(()=>db.prepare('UPDATE style_versions SET design_note=? WHERE id=?').run('tamper',v.id));
  const q=(await req('POST',`/api/studio/templates/${template}/quote`,{...body,version_id:v.id,instruction:v.design_note,instruction_scope:'design'})).quote;
  assert.match(q.prompts[0],/Saved design change/);assert.equal(q.style.design_note,v.design_note);
 });
 await test('adoption reuse distinguishes archived, recycled, removed cards and refuses missing originals',async()=>{
  const file=fixtureFile();
  const b=Number(db.prepare("INSERT INTO exploration_batches(user_id,proposals_json,renders_json,preset_id,count,status,created_at,updated_at) VALUES('alice',?,?, 'suit',1,'rendered',?,?)").run(JSON.stringify([{dna}]),JSON.stringify([{proposal_idx:0,status:'succeeded',image_path:file,thumb_path:file}]),now,now).lastInsertRowid);
  const adopt=()=>req('POST',`/api/studio/explore/${b}/adopt`,{indexes:[0]});
  const first=(await adopt()).template_ids[0];assert.equal((await adopt()).template_ids[0],first);
  await req('POST',`/api/studio/templates/${first}/lifecycle`,{action:'archive'});
  await req('POST',`/api/studio/explore/${b}/adopt`,{indexes:[0]},409);
  await req('POST',`/api/studio/templates/${first}/lifecycle`,{action:'trash'});
  await req('POST',`/api/studio/explore/${b}/adopt`,{indexes:[0]},409);
  await req('POST',`/api/studio/templates/${first}/lifecycle`,{action:'delete',confirm:'永久删除'});
  const second=(await adopt()).template_ids[0];assert.notEqual(second,first);
  await req('POST',`/api/studio/templates/${second}/lifecycle`,{action:'trash'});
  await req('POST',`/api/studio/templates/${second}/lifecycle`,{action:'delete',confirm:'永久删除'});
  fs.unlinkSync(path.join(process.env.DATA_DIR,file));
  await req('POST',`/api/studio/explore/${b}/adopt`,{indexes:[0]},409);
  const historical=(await req('GET',`/api/studio/explore/${b}`)).batch;assert.equal(JSON.parse(historical.renders_json)[0].image_available,false);
  const row=(await req('GET','/api/studio/explore')).batches.find(r=>r.id===b);assert.equal(row.success_count,1);assert.equal(row.available_count,0);assert.equal(row.missing_count,1);
  await req('POST',`/api/studio/explore/${b}/lifecycle`,{action:'archive'});
  assert.ok(!(await req('GET','/api/studio/explore')).batches.some(r=>r.id===b));
  assert.ok((await req('GET','/api/studio/explore?state=archived')).batches.some(r=>r.id===b));
 });
 await test('administrator chat and text tests use exact credentials and configurable image request fields',async()=>{
  db.prepare("INSERT INTO models(id,provider_id,kind,model_id,name,pricing_json,extra_json,is_active,created_at) VALUES('chat-two','two','chat','chat-upstream','chat','{}','{}',1,?)").run(now);
  const chat=await req('POST','/api/admin/models/test',{id:'chat-two',task:'chat',confirm:true});assert.equal(chat.status,'passed');assert.match(calls.at(-1).url,/changed\.studio-test\.invalid\/v1\/chat\/completions$/);
  assert.equal(JSON.parse(calls.at(-1).body).model,'chat-upstream');
  const model=getModel('image-two');updateModel(model.id,{extra:{...model.extra,image_config:{...model.extra.image_config,generation_path:'/custom/generate',response_format:'omit',seed:false}}});
  const image=await req('POST','/api/admin/models/test',{id:model.id,task:'text',confirm:true});assert.equal(image.status,'passed');
  assert.match(calls.at(-1).url,/\/v1\/custom\/generate$/);assert.equal(JSON.parse(calls.at(-1).body).response_format,undefined);assert.equal(JSON.parse(calls.at(-1).body).seed,undefined);
  assert.throws(()=>updateModel(model.id,{extra:{...model.extra,image_config:{...model.extra.image_config,edit_path:'//another.invalid/edits?secret=1'}}}));
 });
 await test('confirmed quotes cannot start a new task after its style is archived',async()=>{
  const id=await make('archived quote'),w=await req('GET',`/api/studio/templates/${id}/workspace`);
  const q=(await req('POST',`/api/studio/templates/${id}/quote`,{...body,version_id:w.versions[0].id})).quote;
  await req('POST',`/api/studio/templates/${id}/lifecycle`,{action:'archive'});
  const before=calls.length;
  await req('POST',`/api/studio/templates/${id}/jobs`,{quote_id:q.id,request_key:crypto.randomUUID(),confirm:true},409);
  assert.equal(calls.length,before);
 });
 await test('failed capability tests are visible to users and block only the affected task until re-tested',async()=>{
  failTest=true;
  const result=await req('POST','/api/admin/models/test',{id:'image-two',task:'text',confirm:true});assert.equal(result.status,'failed');failTest=false;
  const m=(await req('GET','/api/studio/image-models')).models.find(m=>m.id==='image-two');assert.equal(m.capabilities.task_status.text,'failed');
  const before=calls.length;
  await req('POST',`/api/studio/templates/${template}/quote`,{...body,mode:'text'},422);assert.equal(calls.length,before);
  const passed=await req('POST','/api/admin/models/test',{id:'image-two',task:'text',confirm:true});assert.equal(passed.status,'passed');
 });
 await test('model task defaults are explicit, and provider removal preserves registration history',async()=>{
  const one=getModel('image-one'),two=getModel('image-two');
  updateModel(one.id,{extra:{...one.extra,image_config:{...one.extra.image_config,default_for:['single']}}});
  updateModel(two.id,{extra:{...two.extra,image_config:{...two.extra.image_config,default_for:['single']}}});
  assert.deepEqual(getModel(one.id).extra.image_config.default_for,[]);assert.deepEqual(getModel(two.id).extra.image_config.default_for,['single']);
  await req('DELETE','/api/admin/providers/one');
  assert.ok(db.prepare("SELECT * FROM providers WHERE id='one'").get());assert.equal(getModel(one.id).is_active,false);
  assert.ok(!(await req('GET','/api/studio/image-models')).models.some(m=>m.id===one.id));
 });
 await test('0.8 upgrade preserves archived/deleted distinction, original bytes and a single database snapshot',async()=>{
  const archivedGeneration=db.prepare("SELECT id FROM dna_generations WHERE user_rating!='deleted' AND image_path NOT LIKE '%missing%' LIMIT 1").get().id;
  const deletedGeneration=db.prepare("SELECT id FROM dna_generations WHERE user_rating='deleted' LIMIT 1").get().id;
  const batch=db.prepare("SELECT id FROM exploration_batches WHERE workflow_kind='explore' LIMIT 1").get().id;
  const originalAttributes=db.prepare('SELECT dna_json FROM style_versions WHERE id=?').get(version).dna_json;
  const preservedPath=db.prepare('SELECT image_path FROM dna_generations').all().map(g=>g.image_path).find(p=>fs.existsSync(path.join(process.env.DATA_DIR,p)));
  const preservedBytes=fs.readFileSync(path.join(process.env.DATA_DIR,preservedPath));
  closeDb();
  const old=new Database(path.join(process.env.DATA_DIR,'fashion-studio.db'));
  old.prepare('UPDATE dna_generations SET archived=1 WHERE id=?').run(archivedGeneration);
  old.prepare('UPDATE exploration_batches SET archived=1 WHERE id=?').run(batch);
  for(const table of ['style_dna_templates','dna_generations','exploration_batches'])for(const column of ['lifecycle','restore_lifecycle'])old.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
  old.exec('DROP TRIGGER immutable_style_design_note');old.exec('ALTER TABLE style_versions DROP COLUMN design_note');old.close();
  let upgraded=getDb();
  assert.equal(upgraded.prepare('SELECT lifecycle FROM dna_generations WHERE id=?').get(archivedGeneration).lifecycle,'archived');
  assert.equal(upgraded.prepare('SELECT lifecycle FROM dna_generations WHERE id=?').get(deletedGeneration).lifecycle,'deleted');
  assert.equal(upgraded.prepare('SELECT lifecycle FROM exploration_batches WHERE id=?').get(batch).lifecycle,'archived');
  assert.equal(upgraded.prepare('SELECT dna_json FROM style_versions WHERE id=?').get(version).dna_json,originalAttributes);
  assert.deepEqual(fs.readFileSync(path.join(process.env.DATA_DIR,preservedPath)),preservedBytes);
  const backups=fs.readdirSync(path.join(process.env.DATA_DIR,'backups')).filter(f=>f.startsWith('pre-studio-lifecycle-'));assert.equal(backups.length,1);
  const copy=new Database(path.join(process.env.DATA_DIR,'backups',backups[0]),{readonly:true});assert.equal(copy.pragma('integrity_check',{simple:true}),'ok');copy.close();
  const usersAfter=upgraded.prepare('SELECT id,invite_code,points_balance FROM users ORDER BY id').all();
  assert.equal(new Set(usersAfter.map(u=>u.invite_code)).size,usersAfter.length);assert.ok(usersAfter.every(u=>/^[A-Z2-9]{8}$/.test(u.invite_code)));
  closeDb();upgraded=getDb();assert.deepEqual(upgraded.prepare('SELECT id,invite_code,points_balance FROM users ORDER BY id').all(),usersAfter);assert.equal(fs.readdirSync(path.join(process.env.DATA_DIR,'backups')).filter(f=>f.startsWith('pre-studio-lifecycle-')).length,1);
 });
 console.log(`Studio lifecycle/models: ${n}/${n} passed`);
}finally{global.fetch=originalFetch;await new Promise(resolve=>server.close(resolve));closeDb();fs.rmSync(process.env.DATA_DIR,{recursive:true,force:true});}
