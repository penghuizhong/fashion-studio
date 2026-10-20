import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import Database from 'better-sqlite3';
import {migrateProducts} from '../src/productSchema.js';
process.env.DATA_DIR=fs.mkdtempSync(path.join(os.tmpdir(),'product-ecosystem-'));
process.env.MULTI_USER='true';process.env.MOCK_LLM='false';process.env.MASTER_KEY=crypto.randomBytes(32).toString('hex');process.env.WRITE_LIMIT_MAX='3000';
const {getDb,closeDb}=await import('../src/db.js');const {createApp}=await import('../src/app.js');const {encryptSecret}=await import('../src/secrets.js');const {waitJob}=await import('../src/exploreJobs.js');
const {calculateSize,costQuote,makeSkus}=await import('../../shared/productMath.js');const {parseSizeCsv}=await import('../../shared/sizeCsv.js');
const db=getDb(),now=new Date().toISOString(),originalFetch=global.fetch;let calls=0;
const png=await sharp({create:{width:800,height:1200,channels:3,background:'#456789'}}).png().toBuffer();
for(const id of ['alice','bob']){db.prepare("INSERT INTO users(id,username,password_hash,created_at,points_balance,billing_mode,is_admin) VALUES(?,?,?,?,1000,'points',?)").run(id,id,'unused',now,id==='alice'?1:0);db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(crypto.createHash('sha256').update(id+'-token').digest('hex'),id,Date.now()+86400000);}
db.prepare("INSERT INTO providers(id,name,preset,kind,base_url,api_key_encrypted,is_active,created_at) VALUES('products','Products','custom','image','https://products.invalid/v1',?,1,?)").run(encryptSecret(process.env.MASTER_KEY,'fixture'),now);
db.prepare("INSERT INTO models(id,provider_id,kind,model_id,name,pricing_json,extra_json,is_active,created_at) VALUES('products','products','image','products','Products','{\"per_call\":5}',?,1,?)").run(JSON.stringify({sizes:['512x512'],image_config:{protocol:'openai_images',text:true,edit:true,max_images:4}}),now);
let failView='';
global.fetch=async(url,opts)=>{if(!String(url).startsWith('https://products.invalid'))return originalFetch(url,opts);calls++;const prompt=opts.body instanceof FormData?opts.body.get('prompt'):JSON.parse(opts.body).prompt;if(failView&&prompt.includes(failView))return new Response('{}',{status:400});const color='#'+crypto.createHash('sha256').update(prompt).digest('hex').slice(0,6);const bytes=await sharp({create:{width:512,height:512,channels:3,background:color}}).png().toBuffer();return new Response(JSON.stringify({data:[{b64_json:bytes.toString('base64')}]}),{headers:{'Content-Type':'application/json'}});};
const server=await new Promise(resolve=>{const s=createApp().listen(0,'127.0.0.1',()=>resolve(s));});const base=`http://127.0.0.1:${server.address().port}`;
async function req(method,url,body,status=200,user='alice'){const r=await originalFetch(base+url,{method,headers:{Cookie:`soulchat_session=${user}-token`,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const j=await r.json();assert.equal(r.status,status,JSON.stringify(j));return j;}
const post=(url,body={},status=200,user='alice')=>req('POST',url,{...body,request_key:body.request_key||crypto.randomUUID()},status,user);
const get=(url,user='alice')=>req('GET',url,undefined,200,user);
let n=0;async function test(name,fn){await fn();console.log(`PASS ${++n}. ${name}`);}
let t,root,project,views,standard,sizeTable,bodyRecord,sample,batch,quote,paper;
const rows=[{key:'chest',label:'胸围',method:'样衣平整后沿腋下水平测量整围',basis:'full',unit:'cm',value:'100',tolerance:'1',step:'4',values:{M:'100',L:'104'}}];
const loadProject=async()=>{project=(await get(`/api/products/projects/${project.id}`)).project;return project;};
const save=async data=>{project=(await post(`/api/products/projects/${project.id}/save`,{expected_revision:project.revision,data})).project;return project;};
try{
 await test('migration creates additive records/history tables and private options',async()=>{assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE name='product_records'").get());assert.equal((await get('/api/products/options')).can_maintain,true);assert.equal((await get('/api/products/options','bob')).can_maintain,false);await originalFetch(base+'/api/products/options').then(r=>assert.equal(r.status,401));});
 await test('legacy upgrade snapshot can be restored and repeat migration does not alter old design data',async()=>{
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),'products-legacy-')),file=path.join(folder,'legacy.db');let legacy=new Database(file);
  try{legacy.exec("CREATE TABLE style_dna_templates(id INTEGER PRIMARY KEY,dna_json TEXT); INSERT INTO style_dna_templates VALUES(1,'{\"fabric\":\"linen\"}')");migrateProducts(legacy,folder);assert.equal(legacy.prepare('SELECT dna_json FROM style_dna_templates').get().dna_json,'{"fabric":"linen"}');
   const backups=fs.readdirSync(path.join(folder,'backups'));assert.equal(backups.length,1);migrateProducts(legacy,folder);assert.equal(fs.readdirSync(path.join(folder,'backups')).length,1);legacy.close();
   fs.copyFileSync(path.join(folder,'backups',backups[0]),file);legacy=new Database(file);assert.equal(legacy.prepare("SELECT count(*) n FROM sqlite_master WHERE name='product_records'").get().n,0);assert.equal(legacy.prepare('SELECT id FROM style_dna_templates').get().id,1);migrateProducts(legacy,folder);assert.equal(legacy.prepare('SELECT count(*) n FROM product_records').get().n,0);
  }finally{legacy.close();fs.rmSync(folder,{recursive:true,force:true});}
 });
 await test('deterministic dimensions, conversion, CSV and non-overlapping SKU codes',async()=>{
  assert.equal(calculateSize('convert',{direction:'in_to_cm',value:1}).result,2.54);assert.equal(calculateSize('ease',{body:90,ease:10}).result,100);assert.equal(calculateSize('ease',{body:1,ease:'0.005'}).result,1.01);assert.equal(calculateSize('grade',{base:'1.005',step:0,steps:0}).result,1.01);assert.equal(calculateSize('shrink',{target:95,rate:5}).result,100);assert.equal(calculateSize('grade',{base:100,step:4,steps:-1}).result,96);assert.throws(()=>calculateSize('shrink',{target:100,rate:100}));assert.throws(()=>calculateSize('grade',{base:100,step:4,steps:1.5}));assert.throws(()=>calculateSize('ease',null));
  const csv=parseSizeCsv('部位代码,部位名称,测量方法,口径,单位,数值,公差,单档增量,M,L\nchest,胸围,"腋下,水平测量",整围,cm,100,1,4,100,104');assert.equal(csv.rows[0].method,'腋下,水平测量');assert.equal(csv.rows[0].basis,'full');assert.deepEqual(csv.sizes,['M','L']);
  const old=makeSkus(['黑'],['M']),next=makeSkus(['白'],['M'],old);assert.equal(new Set(next.map(s=>s.code)).size,2);assert.equal(next.find(s=>s.color==='黑').active,false);
 });
 await test('three-view quote uses independent cameras and common source, charges through existing jobs',async()=>{
  const preset=(await get('/api/studio/dna-presets')).presets.find(p=>p.id==='suit'),dna=Object.fromEntries(preset.fields.map(f=>[f.key,{value:f.key==='details'?['贴兜']:'常规',confidence:.8}]));
  t=await post('/api/studio/templates',{name:'生态闭环测试',preset_id:'suit',dna_json:dna,source_image_base64:png.toString('base64')});root=(await get(`/api/studio/templates/${t.id}/workspace`)).versions[0];
  const q=(await post(`/api/studio/templates/${t.id}/quote`,{version_id:root.id,op:'create',mode:'image',source:'original',model_id:'products',size:'512x512',delivery_views:['front','back','side'],camera:{display:'mannequin'}})).quote;
  assert.equal(q.indexes.length,3);assert.equal(q.total,15);assert.equal(q.style.item_contexts[1].camera.view,'back');assert.match(q.prompts[1],/straight back view/);assert.doesNotMatch(q.prompts[1],/straight front view/);
  const job=(await post(`/api/studio/templates/${t.id}/jobs`,{quote_id:q.id,confirm:true},202)).job;await waitJob(job.id);assert.equal(calls,3);
  views=(await get(`/api/studio/templates/${t.id}/workspace`)).images;assert.equal(views.length,3);assert.deepEqual(new Set(views.map(v=>JSON.parse(v.settings_json).delivery_slot)),new Set(['front','back','side']));
  for(const image of views)assert.equal(image.design_version_id,root.id);
 });
 await test('one failed view refunds only its reservation; retry preserves the failed position and common source',async()=>{
  const balance=()=>db.prepare("SELECT points_balance FROM users WHERE id='alice'").get().points_balance,before=balance();failView='straight back view';
  const q=(await post(`/api/studio/templates/${t.id}/quote`,{version_id:root.id,op:'create',mode:'image',source:'original',model_id:'products',size:'512x512',delivery_views:['front','back','side'],camera:{display:'mannequin'}})).quote;
  const start=(await post(`/api/studio/templates/${t.id}/jobs`,{quote_id:q.id,confirm:true},202)).job,finished=await waitJob(start.id);assert.equal(finished.renders.filter(r=>r.status==='failed').length,1);assert.equal(balance(),before-10);
  const retry=(await post(`/api/studio/templates/${t.id}/retry-quote`,{job_id:start.id})).quote;assert.deepEqual(retry.indexes,[1]);assert.equal(retry.total,5);assert.equal(retry.style.item_contexts[1].delivery_slot,'back');assert.deepEqual(retry.style.references,q.style.references);assert.equal(retry.prompts[0],q.prompts[1]);failView='';
  const retried=(await post(`/api/studio/templates/${t.id}/jobs`,{quote_id:retry.id,confirm:true},202)).job;await waitJob(retried.id);assert.equal(balance(),before-15);const all=(await get(`/api/studio/templates/${t.id}/workspace`)).images;assert.equal(all.filter(i=>JSON.parse(i.settings_json).delivery_slot==='back').length,2);
 });
 await test('missing views and wrong generated camera cannot be delivered',async()=>{
  await post(`/api/studio/templates/${t.id}/delivery`,{version_id:root.id,expected_revision:0,consistency_confirmed:true,inferred_confirmed:true},409);
  const front=views.find(i=>JSON.parse(i.settings_json).delivery_slot==='front');
  await post(`/api/studio/templates/${t.id}/delivery/views`,{version_id:root.id,expected_revision:0,slot:'back',source:{generation_id:front.id},confirm:true},400);
  await req('GET',`/api/studio/templates/${t.id}/delivery?version_id=${root.id}`,undefined,404,'bob');
 });
 await test('view adoption validates revision and design; delivery is idempotent and private',async()=>{
  let revision=0;for(const image of views){const slot=JSON.parse(image.settings_json).delivery_slot;const r=await post(`/api/studio/templates/${t.id}/delivery/views`,{version_id:root.id,expected_revision:revision,slot,source:{generation_id:image.id},confirm:true});revision=r.views.revision;}
  const payload={version_id:root.id,expected_revision:revision,consistency_confirmed:true,inferred_confirmed:true,request_key:crypto.randomUUID()};const a=await post(`/api/studio/templates/${t.id}/delivery`,payload),b=await post(`/api/studio/templates/${t.id}/delivery`,payload);assert.equal(a.project.id,b.project.id);project=a.project;
  const repeated=await post(`/api/studio/templates/${t.id}/delivery`,{...payload,request_key:crypto.randomUUID()});assert.equal(repeated.project.id,project.id);assert.equal(repeated.reused,true);
  await req('GET',`/api/products/projects/${project.id}`,undefined,404,'bob');assert.equal((await get('/api/products/records?kind=project','bob')).total,0);
 });
 await test('same image bytes uploaded separately cannot masquerade as three views',async()=>{
  const original=views.find(i=>JSON.parse(i.settings_json).delivery_slot==='front'),back=views.find(i=>JSON.parse(i.settings_json).delivery_slot==='back');let r=(await get(`/api/studio/templates/${t.id}/delivery?version_id=${root.id}`)).views;
  const duplicate=await post('/api/studio/references',{image_base64:fs.readFileSync(path.join(process.env.DATA_DIR,original.image_path)).toString('base64')});r=(await post(`/api/studio/templates/${t.id}/delivery/views`,{version_id:root.id,expected_revision:r.revision,slot:'back',source:{reference_id:duplicate.id},confirm:true})).views;await post(`/api/studio/templates/${t.id}/delivery`,{version_id:root.id,expected_revision:r.revision,consistency_confirmed:true,inferred_confirmed:true},400);await post(`/api/studio/templates/${t.id}/delivery/views`,{version_id:root.id,expected_revision:r.revision,slot:'back',source:{generation_id:back.id},confirm:true});
 });
 await test('project saves reject stale revisions and forged public bindings',async()=>{
  const rev=project.revision;await save({process:'按确认工艺制作',colors:['黑'],sizes:['M','L'],measurements:rows});assert.equal(project.data.skus.length,2);
  await post(`/api/products/projects/${project.id}/save`,{expected_revision:rev,data:{process:'过时修改'}},409);
  await save({standard_binding:{id:'forged'},delivery:{version_id:999}});assert.equal(project.data.standard_binding,undefined);assert.equal(project.data.delivery.version_id,root.id);
 });
 await test('standards publication requires maintainer, provenance and scope; body remains private',async()=>{
  const data={name:'仅隔离测试的西装规则',category:'suit',content:'测试规则，不是生产知识种子',source:'isolated fixture',scope:'仅测试',files:[]};standard=(await post('/api/products/library',{kind:'standard',data})).record;
  const r=(await post('/api/products/library',{kind:'standard',data},200,'bob')).record;await post(`/api/products/library/${r.id}/publish`,{expected_revision:r.revision,confirm:true},403,'bob');
  standard=(await post(`/api/products/library/${standard.id}/publish`,{expected_revision:standard.revision,confirm:true})).record;
  assert.equal((await get(`/api/products/records/${standard.id}`,'bob')).record.state,'published');await post(`/api/products/library/${standard.id}/save`,{expected_revision:standard.revision,data},409);
  sizeTable=(await post('/api/products/library',{kind:'size_table',data:{...data,name:'测试成衣尺寸',sizes:['M','L'],base_size:'M',rows}})).record;sizeTable=(await post(`/api/products/library/${sizeTable.id}/publish`,{expected_revision:sizeTable.revision,confirm:true})).record;
  bodyRecord=(await post('/api/products/library',{kind:'body',data:{name:'测试实测档案',measured_at:'2026-10-20',posture:'仅测试',rows,files:[]}})).record;await req('GET',`/api/products/records/${bodyRecord.id}`,undefined,404,'bob');
  assert.equal((await get(`/api/products/records/${standard.id}/history`,'bob')).items.every(r=>r.state==='published'),true);
 });
 await test('project applies exact standard and dimensions, and calculator writes only the selected garment record',async()=>{
  for(const record of [standard,bodyRecord,sizeTable])project=(await post(`/api/products/projects/${project.id}/apply-library`,{expected_revision:project.revision,record_id:record.id,size:'M'})).project;
  assert.equal(project.data.measurements[0].value,'100');const r=await post(`/api/products/projects/${project.id}/calculations`,{expected_revision:project.revision,calculator:'ease',inputs:{body:90,ease:10},part:'chest',adjusted_value:101,adjustment_reason:'测试人工调整'});project=r.project;
  assert.equal(project.data.measurements[0].value,101);assert.equal((await get(`/api/products/records/${bodyRecord.id}`)).record.data.rows[0].value,'100');assert.equal(r.record.data.result,100);
 });
 await test('body size tables do not overwrite garment dimensions, and whole/half circumference cannot be confused',async()=>{
  const before=structuredClone(project.data.measurements),data={name:'测试人体号型',source:'隔离测量',scope:'仅测试',measurement_type:'body',sizes:['M'],base_size:'M',rows:[{...rows[0],value:'90',values:{M:'90'}}],files:[]};let table=(await post('/api/products/library',{kind:'size_table',data})).record;table=(await post(`/api/products/library/${table.id}/publish`,{expected_revision:table.revision,confirm:true})).record;
  project=(await post(`/api/products/projects/${project.id}/apply-library`,{expected_revision:project.revision,record_id:table.id,size:'M'})).project;assert.deepEqual(project.data.measurements,before);assert.equal(project.data.body_binding.rows[0].value,'90');
  await save({measurements:before.map(r=>({...r,basis:'half'}))});await post(`/api/products/projects/${project.id}/calculations`,{expected_revision:project.revision,calculator:'ease',inputs:{body:90,ease:10},part:'chest'},400);await save({measurements:before});
 });
 await test('public attachments exclude removed draft files; published updates never overwrite adopted standards',async()=>{
  const file=async name=>(await post('/api/products/files',{name,base64:Buffer.from('%PDF-1.4\n'+name+'\n%%EOF').toString('base64'),image:false})).file;
  const privateFile=await file('private.pdf'),publishedFile=await file('public.pdf');let r=(await post('/api/products/library',{kind:'knowledge',data:{name:'测试文件权限',source:'隔离测试',scope:'仅测试',content:'参考',rows:'不可信多余字段',materials:'不可信多余字段',files:[{...privateFile,name:{bad:'name'},mime:'image/svg+xml'}]}})).record;
  assert.equal(r.data.rows,undefined);assert.equal(r.data.materials,undefined);assert.equal(r.data.files[0].name,'private.pdf');assert.equal(r.data.files[0].mime,'application/pdf');r=(await post(`/api/products/library/${r.id}/save`,{expected_revision:r.revision,data:{...r.data,files:[publishedFile]}})).record;r=(await post(`/api/products/library/${r.id}/publish`,{expected_revision:r.revision,confirm:true})).record;
  for(const [f,status] of [[privateFile,404],[publishedFile,200]])assert.equal((await originalFetch(base+`/api/products/files/${f.file_id}`,{headers:{Cookie:'soulchat_session=bob-token'}})).status,status);
  let next=(await post('/api/products/library',{kind:'standard',parent_id:standard.id,data:{...standard.data,content:'新修订仅测试'}})).record;next=(await post(`/api/products/library/${next.id}/publish`,{expected_revision:next.revision,confirm:true})).record;
  const current=await get(`/api/products/projects/${project.id}`);assert.equal(current.project.data.standard_binding.id,standard.id);assert.equal(current.readiness.updates[0].id,next.id);
 });
 await test('cost uses fixed decimal arithmetic, distinguishes unknown/free and honors override fallback',async()=>{
  await save({skus:project.data.skus.map((s,i)=>({...s,quantity:i?3:2})),materials:[{name:'主料',spec:'测试',unit:'m',usage:'1.25',price:'10.00',waste:'10.00',includes_waste:false,overrides:{[project.data.skus[0].key]:{usage:'',price:'10.00'}}}],fees:[{name:'工价',amount:'2.50'}]});
  let q=(await post(`/api/products/projects/${project.id}/quote`)).quote;assert.equal(q.rows[0].unit_cents,1625);assert.equal(q.total_cents,8125);assert.equal(q.total_quantity,5);assert.throws(()=>costQuote({...project.data,materials:[{...project.data.materials[0],currency:'USD'}]}));assert.throws(()=>costQuote({...project.data,materials:[{...project.data.materials[0],includes_waste:'false'}]}));
  const incomplete=costQuote({...project.data,materials:[{...project.data.materials[0],price:'',overrides:{}}]});assert.ok(incomplete.missing.length);assert.equal(costQuote({...project.data,materials:[{...project.data.materials[0],price:'0',overrides:{}}]}).rows[0].unit_cents,250);
  quote=(await post(`/api/products/projects/${project.id}/confirm-cost`,{expected_revision:project.revision,confirm:true}));project=quote.project;quote=quote.quote;
 });
 await test('paper files require ownership, preserve bytes and are adopted as immutable revisions',async()=>{
  const bytes=Buffer.from('%PDF-1.4\n% isolated paper fixture\n%%EOF');const f=(await post('/api/products/files',{name:'首版纸样.pdf',base64:bytes.toString('base64'),image:false})).file;
  const r=await originalFetch(base+`/api/products/files/${f.file_id}`,{headers:{Cookie:'soulchat_session=alice-token'}});assert.deepEqual(Buffer.from(await r.arrayBuffer()),bytes);assert.match(r.headers.get('content-disposition'),/attachment/);const inline=await originalFetch(base+`/api/products/files/${f.file_id}?preview=1`,{headers:{Cookie:'soulchat_session=alice-token'}});assert.equal(inline.headers.get('content-disposition'),'inline');assert.deepEqual(Buffer.from(await inline.arrayBuffer()),bytes);await post('/api/products/files',{name:'fake.pdf',base64:Buffer.from('not a PDF').toString('base64'),image:false},400);await post('/api/products/files',{name:'script.html',base64:Buffer.from('<script></script>').toString('base64'),image:false},400);
  assert.equal((await originalFetch(base+`/api/products/files/${f.file_id}`,{headers:{Cookie:'soulchat_session=bob-token'}})).status,404);
  const adopted=await post(`/api/products/projects/${project.id}/patterns`,{expected_revision:project.revision,data:{name:'首版',file_id:f.file_id,sizes:['M','L'],note:'测试'}});project=adopted.project;paper=adopted.record;assert.equal(paper.state,'confirmed');
  await post(`/api/products/projects/${project.id}/productions`,{expected_revision:project.revision,name:'过早量产',confirm:true},409);
 });
 await test('sample review requires evidence; unresolved issues carry to next round without automatic resolution',async()=>{
  let r=await post(`/api/products/projects/${project.id}/samples`,{expected_revision:project.revision,name:'首样'});sample=r.record;project=r.project;
  const photo=(await post('/api/products/files',{name:'首样实拍.png',base64:png.toString('base64'),image:true})).file;
  sample=(await post(`/api/products/samples/${sample.id}/save`,{expected_revision:sample.revision,data:{photos:[photo],measurements:rows,notes:'测试试衣',cost:'50'}})).record;
  const issue=(await post(`/api/products/samples/${sample.id}/issues`,{data:{text:'袖口需核对',part:'袖口',photo_id:photo.file_id,x:.3,y:.4}})).record;
  await post(`/api/products/samples/${sample.id}/decide`,{expected_revision:sample.revision,status:'accepted',confirm:true},400);
  r=await post(`/api/products/projects/${project.id}/samples`,{expected_revision:project.revision,name:'二样'});sample=r.record;project=r.project;
  const issues=(await get(`/api/products/records?kind=issue&projectId=${project.id}`)).items;const carried=issues.find(i=>i.data.round_id===sample.id);assert.equal(carried.data.previous_id,issue.id);assert.notEqual(carried.state,'resolved');
  sample=(await post(`/api/products/samples/${sample.id}/save`,{expected_revision:sample.revision,data:{photos:[photo],measurements:rows.map(row=>({...row,basis:'half'})),notes:'错误口径',cost:'30'}})).record;await post(`/api/products/samples/${sample.id}/decide`,{expected_revision:sample.revision,status:'accepted',confirm:true},400);sample=(await post(`/api/products/samples/${sample.id}/save`,{expected_revision:sample.revision,data:{photos:[photo],measurements:rows,notes:'修正后实测',cost:'30'}})).record;
  await post(`/api/products/issues/${carried.id}/resolve`,{expected_revision:carried.revision,resolution:'已对照二样实测核对'});
  sample=(await post(`/api/products/samples/${sample.id}/decide`,{expected_revision:sample.revision,status:'accepted',confirm:true,note:'测试确认'})).record;assert.equal(sample.state,'accepted');
 });
 await test('production freezes sources and exact quantities; duplicate submission does not create another batch',async()=>{
  assert.equal((await get(`/api/products/projects/${project.id}`)).readiness.ready,true);
  const body={expected_revision:project.revision,name:'首批',confirm:true,request_key:crypto.randomUUID()},a=await post(`/api/products/projects/${project.id}/productions`,body),b=await post(`/api/products/projects/${project.id}/productions`,body);assert.equal(a.record.id,b.record.id);batch=a.record;project=a.project;
  assert.equal(batch.data.quantities.reduce((n,s)=>n+s.quantity,0),5);assert.equal(batch.data.baseline.pattern_binding.id,paper.id);
  await save({materials:[{...project.data.materials[0],price:'20'}]});assert.equal((await get(`/api/products/records/${batch.id}`)).record.data.quote.total_cents,8125);assert.equal((await get(`/api/products/projects/${project.id}`)).readiness.ready,false);
  await post(`/api/products/productions/${batch.id}/progress`,{expected_revision:batch.revision,stage:'cutting',quantity:6,note:''},400);
  const updated=await post(`/api/products/productions/${batch.id}/progress`,{expected_revision:batch.revision,stage:'cutting',quantity:5,note:'裁剪完成'});batch=updated.record;project=updated.project;
  await post(`/api/products/productions/${batch.id}/progress`,{expected_revision:batch.revision,stage:'completed',quantity:5,confirm:true,note:''},400);
  const done=await post(`/api/products/productions/${batch.id}/progress`,{expected_revision:batch.revision,stage:'completed',quantity:5,confirm:true,note:'验收通过'});batch=done.record;project=done.project;assert.equal(batch.data.accepted_quantity,5);assert.equal(project.data.stage,'completed');
 });
 await test('new design delivery does not silently replace production or project adopted design',async()=>{
  const dna=JSON.parse(root.dna_json);dna.primary_color={value:'蓝'};const version=(await post(`/api/studio/templates/${t.id}/versions`,{parent_id:root.id,dna})).version;
  let revision=0;for(const [index,slot] of ['front','back','side'].entries()){const bytes=await sharp({create:{width:100,height:100,channels:3,background:['#ff0000','#00ff00','#0000ff'][index]}}).png().toBuffer();const reference=await post('/api/studio/references',{image_base64:bytes.toString('base64')});const r=await post(`/api/studio/templates/${t.id}/delivery/views`,{version_id:version.id,expected_revision:revision,slot,source:{reference_id:reference.id},confirm:true});revision=r.views.revision;}
  const delivered=await post(`/api/studio/templates/${t.id}/delivery`,{version_id:version.id,expected_revision:revision,consistency_confirmed:true,inferred_confirmed:true});project=delivered.project;assert.equal(project.data.delivery.version_id,root.id);assert.equal(project.data.pending_delivery.version_id,version.id);assert.equal((await get(`/api/products/records/${batch.id}`)).record.data.baseline.delivery.version_id,root.id);const repeated=await post(`/api/studio/templates/${t.id}/delivery`,{version_id:version.id,expected_revision:revision,consistency_confirmed:true,inferred_confirmed:true});assert.equal(repeated.reused,true);assert.equal(repeated.project.revision,project.revision);project=(await post(`/api/products/projects/${project.id}/adopt-delivery`,{expected_revision:project.revision})).project;assert.equal(project.data.delivery.version_id,version.id);assert.equal(project.data.pending_delivery,null);assert.equal((await get(`/api/products/records/${batch.id}`)).record.data.baseline.delivery.version_id,root.id);
 });
 await test('history is immutable, project archive restores, and source removal retains project image access',async()=>{
  assert.throws(()=>db.prepare("UPDATE product_history SET action='tamper' WHERE record_id=?").run(project.id));
  project=(await post(`/api/products/projects/${project.id}/lifecycle`,{expected_revision:project.revision,action:'archive'})).project;await post(`/api/products/projects/${project.id}/save`,{expected_revision:project.revision,data:{notes:'blocked'}},409);
  project=(await post(`/api/products/projects/${project.id}/lifecycle`,{expected_revision:project.revision,action:'restore'})).project;
  const image=views[0],before=fs.readFileSync(path.join(process.env.DATA_DIR,image.image_path));await post(`/api/studio/generations/${image.id}/lifecycle`,{action:'trash'});await post(`/api/studio/generations/${image.id}/lifecycle`,{action:'delete',confirm:'永久删除'});
  const clean=await post(`/api/studio/generations/${image.id}/cleanup-files`,{confirm:'清理文件'});assert.equal(clean.retained,true);
  const raw=await originalFetch(base+'/'+image.image_path+'?download=1',{headers:{Cookie:'soulchat_session=alice-token'}});assert.equal(raw.status,200);assert.deepEqual(Buffer.from(await raw.arrayBuffer()),before);
 });
 console.log(`Product ecosystem: ${n}/${n} passed`);
}finally{global.fetch=originalFetch;server.closeAllConnections();await new Promise(r=>server.close(r));closeDb();fs.rmSync(process.env.DATA_DIR,{recursive:true,force:true});}
