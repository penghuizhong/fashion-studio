import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
process.env.DATA_DIR=fs.mkdtempSync(path.join(os.tmpdir(),'studio-ux-'));
process.env.MULTI_USER='true';process.env.MOCK_LLM='false';process.env.MASTER_KEY=crypto.randomBytes(32).toString('hex');process.env.WRITE_LIMIT_MAX='2000';
const {getDb,closeDb}=await import('../src/db.js');
const {createApp}=await import('../src/app.js');
const {encryptSecret}=await import('../src/secrets.js');
const {previewFile}=await import('../src/studioPreview.js');
const {waitJob}=await import('../src/exploreJobs.js');
const {imageRateMatch}=await import('../../shared/imagePricing.js');
const db=getDb(),now=new Date().toISOString(),originalFetch=global.fetch;
const png=await sharp({create:{width:3072,height:4096,channels:3,background:'#345678'}}).png().toBuffer();
let calls=0;
global.fetch=async(url,opts)=>{
 if(!String(url).startsWith('https://ux.invalid'))return originalFetch(url,opts);
 calls++;return new Response(JSON.stringify({data:[{b64_json:png.toString('base64')}]}),{headers:{'Content-Type':'application/json'}});
};
for(const user of ['alice','bob']){
 db.prepare("INSERT INTO users(id,username,password_hash,created_at,points_balance,billing_mode,is_admin) VALUES(?,?,?,?,1000,'points',?)").run(user,user,'unused',now,user==='alice'?1:0);
 db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(crypto.createHash('sha256').update(user+'-token').digest('hex'),user,Date.now()+86400000);
}
db.prepare("INSERT INTO providers(id,name,preset,kind,base_url,api_key_encrypted,is_active,created_at) VALUES('ux','UX','custom','image','https://ux.invalid/v1',?,1,?)").run(encryptSecret(process.env.MASTER_KEY,'fixture'),now);
const extra={sizes:['1024x1024','768x1024'],image_config:{protocol:'openai_images',text:true,edit:true,max_images:4,qualities:[{value:'low',label:'轻量'},{value:'high',label:'精细'}],custom_size:{enabled:true,min:256,max:2048,step:8,max_pixels:4194304}}};
db.prepare("INSERT INTO models(id,provider_id,kind,model_id,name,pricing_json,extra_json,is_active,created_at) VALUES('ux','ux','image','ux','UX',?,?,1,?)").run(JSON.stringify({per_call:5}),JSON.stringify(extra),now);
const server=await new Promise(resolve=>{const s=createApp().listen(0,'127.0.0.1',()=>resolve(s));});
const base=`http://127.0.0.1:${server.address().port}`;
const raw=(url,user='alice',headers={})=>originalFetch(base+url,{headers:{Cookie:`soulchat_session=${user}-token`,...headers}});
async function req(method,url,body,status=200,user='alice'){
 const r=await originalFetch(base+url,{method,headers:{Cookie:`soulchat_session=${user}-token`,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
 const j=await r.json();assert.equal(r.status,status,JSON.stringify(j));return j;
}
let n=0;async function test(name,fn){await fn();console.log(`PASS ${++n}. ${name}`);}
const balance=()=>db.prepare("SELECT points_balance FROM users WHERE id='alice'").get().points_balance;
try{
 const preset=(await req('GET','/api/studio/dna-presets')).presets.find(p=>p.id==='suit');
 const dna=Object.fromEntries(preset.fields.map(f=>[f.key,{value:f.key==='details'?['贴兜']:f.key==='scene'?'海岛度假':'常规',confidence:.8}]));
 const t=await req('POST','/api/studio/templates',{name:'性能与交互',preset_id:'suit',dna_json:dna,source_image_base64:png.toString('base64')});
 const ws=await req('GET',`/api/studio/templates/${t.id}/workspace`),root=ws.versions[0];
 const file=ws.template.source_image_path,thumb=ws.template.source_thumb_path,url=`/api/studio/preview?${new URLSearchParams({path:file,viewer:'alice'})}`;
 await test('1600px preview preserves aspect ratio and full original bytes',async()=>{
  const r=await raw(url);assert.equal(r.status,200);const meta=await sharp(Buffer.from(await r.arrayBuffer())).metadata();
  assert.equal(meta.width,1200);assert.equal(meta.height,1600);assert.equal(meta.format,'webp');
  assert.deepEqual(fs.readFileSync(path.join(process.env.DATA_DIR,file)),png);
  const tm=await sharp(path.join(process.env.DATA_DIR,thumb)).metadata();assert.equal(tm.width,450);assert.equal(tm.height,600);
 });
 await test('private ETag validation checks ownership and viewer before returning 304',async()=>{
  const first=await raw(url),etag=first.headers.get('etag');assert.ok(etag);assert.match(first.headers.get('cache-control'),/private.*no-cache/);assert.match(first.headers.get('vary'),/Cookie/);
  assert.equal((await raw(url,'alice',{'If-None-Match':etag,'Cache-Control':'max-age=0'})).status,304);assert.equal((await raw(url,'bob',{'If-None-Match':etag,'Cache-Control':'max-age=0'})).status,404);
  assert.equal((await raw(url.replace('viewer=alice','viewer=bob'))).status,404);assert.equal((await raw('/api/studio/preview?path=../config.js')).status,404);
 });
 await test('small images never enlarge and downloads preserve exact bytes',async()=>{
  const small=await sharp({create:{width:321,height:123,channels:3,background:'#123456'}}).jpeg().toBuffer();
  const ref=await req('POST','/api/studio/references',{image_base64:small.toString('base64')});
  const r=await raw(`/api/studio/preview?${new URLSearchParams({path:ref.image_path,viewer:'alice'})}`),meta=await sharp(Buffer.from(await r.arrayBuffer())).metadata();assert.equal(meta.width,321);assert.equal(meta.height,123);
  const download=await raw('/'+ref.image_path+'?download=1');assert.match(download.headers.get('content-disposition'),/\.jpg/);assert.deepEqual(Buffer.from(await download.arrayBuffer()),small);
 });
 await test('derivative failure does not discard or recompress a saved original',async()=>{
  const dir=path.join(process.env.DATA_DIR,'uploads/studio/previews'),held=dir+'.held';fs.renameSync(dir,held);fs.writeFileSync(dir,'blocked derivative directory');
  try { const ref=await req('POST','/api/studio/references',{image_base64:png.toString('base64')});assert.deepEqual(fs.readFileSync(path.join(process.env.DATA_DIR,ref.image_path)),png);assert.ok(fs.existsSync(path.join(process.env.DATA_DIR,ref.thumb_path))); }
  finally { fs.unlinkSync(dir);fs.renameSync(held,dir); }
 });
 await test('legacy preview is queued immediately; missing original cannot use stale derivative',async()=>{
  fs.unlinkSync(previewFile(file));const before=Date.now();assert.equal((await raw(url)).status,202);assert.ok(Date.now()-before<1000);
  let ready=false;for(let i=0;i<100;i++){await new Promise(r=>setTimeout(r,30));if((await raw(url)).status===200){ready=true;break;}}assert.ok(ready);
  const abs=path.join(process.env.DATA_DIR,file);fs.renameSync(abs,abs+'.held');assert.equal((await raw(url)).status,404);fs.renameSync(abs+'.held',abs);
 });
 const imageIds=[];
 await test('summary limits history payload while retaining selected version and accurate totals',async()=>{
  let parent=root.id;for(let i=0;i<42;i++)parent=(await req('POST',`/api/studio/templates/${t.id}/versions`,{parent_id:parent,dna:{...dna,primary_color:{value:'蓝'+i}},request_key:crypto.randomUUID()})).version.id;
  for(let i=0;i<47;i++)imageIds.push(Number(db.prepare("INSERT INTO dna_generations(template_id,user_id,image_path,thumb_path,design_version_id,settings_json,created_at) VALUES(?,'alice',?,?,?,?,?)").run(t.id,file,thumb,root.id,JSON.stringify({prompt:'long '.repeat(1000)}),now).lastInsertRowid));
  const summary=await req('GET',`/api/studio/templates/${t.id}/workspace?view=summary&version_id=${parent}`),full=await req('GET',`/api/studio/templates/${t.id}/workspace`);
  assert.equal(summary.totals.versions,43);assert.equal(summary.totals.images,47);assert.ok(summary.versions.length<=3);assert.equal(summary.images.length,0);assert.deepEqual(summary.layouts,[]);assert.ok(JSON.stringify(summary).length<JSON.stringify(full).length/8);
  await req('GET',`/api/studio/templates/${t.id}/workspace?view=summary`,undefined,404,'bob');
 });
 await test('collections paginate and filter lifecycle; saved selected IDs resolve across pages',async()=>{
  const first=await req('GET',`/api/studio/templates/${t.id}/workspace/images?version_id=${root.id}`),second=await req('GET',`/api/studio/templates/${t.id}/workspace/images?version_id=${root.id}&page=2`);
  assert.equal(first.total,47);assert.equal(first.items.length,20);assert.equal(second.items.length,20);assert.ok(!first.items.some(a=>second.items.some(b=>a.id===b.id)));
  const versions=await req('GET',`/api/studio/templates/${t.id}/workspace/versions?page=3`);assert.equal(versions.total,43);assert.equal(versions.items.length,3);assert.ok(versions.items.filter(v=>v.parent_id).every(v=>Number.isInteger(v.parent_number)));
  db.prepare("UPDATE dna_generations SET user_rating='deleted' WHERE id=?").run(imageIds.at(-1));assert.equal((await req('GET',`/api/studio/templates/${t.id}/workspace/images`)).total,46);db.prepare("UPDATE dna_generations SET user_rating=NULL WHERE id=?").run(imageIds.at(-1));
  await req('POST',`/api/studio/generations/${imageIds[0]}/lifecycle`,{action:'archive'});
  assert.equal((await req('GET',`/api/studio/templates/${t.id}/workspace/images?state=archived`)).total,1);
  assert.equal((await req('GET',`/api/studio/templates/${t.id}/workspace/images?ids=${imageIds[0]}`)).items[0].id,imageIds[0]);
  await req('GET',`/api/studio/templates/${t.id}/workspace/images`,undefined,404,'bob');
 });
 await test('asset references reuse identity, paginate/search and enforce ownership',async()=>{
  const a=await req('POST','/api/studio/references',{generation_id:imageIds[1]}),b=await req('POST','/api/studio/references',{generation_id:imageIds[1]});assert.equal(a.id,b.id);
  await req('POST','/api/studio/references',{generation_id:imageIds[1]},404,'bob');
  const refs=await req('GET',`/api/studio/references?ids=${a.id}&limit=1`);assert.equal(refs.total,1);assert.equal(refs.references[0].image_available,true);
  assert.equal((await req('GET','/api/studio/assets?search=不存在')).total,0);
 });
 const body={version_id:root.id,op:'white',mode:'image',source:'original',model_id:'ux',size:'1024x1024',count:1};
 await test('white direction replaces scene presets without changing immutable design',async()=>{
  const q=(await req('POST',`/api/studio/templates/${t.id}/quote`,{...body,visual_style:'island'})).quote;
  assert.equal(q.style.op,'white');assert.equal(q.style.visual_style,'product');assert.match(q.prompts[0],/Pure white/);assert.doesNotMatch(q.prompts[0],/Tropical island|海岛度假/);
  assert.equal(JSON.parse(db.prepare('SELECT dna_json FROM style_versions WHERE id=?').get(root.id).dna_json).scene.value,'海岛度假');
  await req('POST',`/api/studio/templates/${t.id}/quote`,{...body,instruction:'换成海滩背景'},400);
 });
 await test('free design needs saved requirements and keeps structured parent attributes immutable',async()=>{
  await req('POST',`/api/studio/templates/${t.id}/quote`,{...body,op:'free_design',instruction:'改成条纹面料'},400);
  const v=(await req('POST',`/api/studio/templates/${t.id}/versions`,{parent_id:root.id,dna,design_note:'改成条纹面料',request_key:crypto.randomUUID()})).version;
  const q=(await req('POST',`/api/studio/templates/${t.id}/quote`,{...body,op:'free_design',version_id:v.id,instruction:'改成条纹面料'})).quote;
  assert.equal(q.style.version_id,v.id);assert.equal(v.dna_json,root.dna_json);assert.equal(db.prepare('SELECT design_note FROM style_versions WHERE id=?').get(root.id).design_note,'');
 });
 await test('progress omits prompts/DNA and returns only changed owned jobs',async()=>{
  const q=(await req('POST',`/api/studio/templates/${t.id}/quote`,{...body,op:'create'})).quote;
  const job=(await req('POST',`/api/studio/templates/${t.id}/jobs`,{quote_id:q.id,request_key:crypto.randomUUID(),confirm:true},202)).job;await waitJob(job.id);
  const changed=await req('GET',`/api/studio/templates/${t.id}/workspace/progress?known=${encodeURIComponent(JSON.stringify({[job.id]:''}))}`);
  assert.equal(changed.jobs.length,1);assert.equal(changed.jobs[0].status,'succeeded');assert.ok(!changed.jobs[0].snapshot.prompts);assert.ok(!changed.jobs[0].snapshot.style.dna);
  const known=encodeURIComponent(JSON.stringify({[job.id]:changed.jobs[0].revision}));assert.deepEqual((await req('GET',`/api/studio/templates/${t.id}/workspace/progress?known=${known}`)).jobs,[]);
  const other=await req('POST','/api/studio/templates',{name:'其他用户',preset_id:'suit',dna_json:dna},200,'bob');
  assert.deepEqual((await req('GET',`/api/studio/templates/${other.id}/workspace/progress?known=${known}`,undefined,200,'bob')).jobs,[]);
 });
 const preview=pricing=>req('POST','/api/admin/image-price-preview',{extra,pricing,size:'1024x1024',quality:'high',count:3});
 await test('price preview covers defaults/overrides/custom/free without models or charges and requires admin',async()=>{
  const before=calls,money=balance();assert.equal((await preview({per_call:5})).total,15);
  const rates=[{size:'*',quality:'*',per_call:3},{size:'1024x1024',quality:'high',per_call:9}],r=await preview({per_call:50,image_rates:rates});assert.equal(r.unit,9);assert.equal(r.total,27);assert.equal(r.rule.size,'1024x1024');
  assert.equal((await req('POST','/api/admin/image-price-preview',{extra,pricing:{per_call:50,image_rates:rates},size:'800x1200',quality:'',count:2})).total,6);
  assert.equal((await preview({per_call:0})).unit,0);assert.equal(calls,before);assert.equal(balance(),money);
  await req('POST','/api/admin/image-price-preview',{extra,pricing:{per_call:5},size:'1024x1024'},403,'bob');
 });
 await test('uncovered tiers do not fall back to the legacy uniform catalog price',async()=>{
  const pricing={per_call:1,image_rates:[{size:'768x1024',quality:'high',per_call:9}]};
  await req('POST','/api/admin/image-price-preview',{extra,pricing,size:'1024x1024',quality:'high'},422);
  assert.deepEqual((await req('PUT','/api/admin/models/ux',{pricing})).model.pricing,pricing);
  await req('POST',`/api/studio/templates/${t.id}/quote`,body,422);
 });
 await test('manager rejects invalid/duplicate/conflicting prices and stale capabilities',async()=>{
  for(const rates of [
   [{size:'*',quality:'*',per_call:-1}],[{size:'*',quality:'*',per_call:1.5}],
   [{size:'123x456',quality:'*',per_call:1}],[{size:'*',quality:'ultra',per_call:1}],
   [{size:'*',quality:'*',per_call:1},{size:'*',quality:'*',per_call:1}],
   [{size:'1024x1024',quality:'*',per_call:5},{size:'*',quality:'high',per_call:9}],
  ])await req('PUT','/api/admin/models/ux',{pricing:{per_call:5,image_rates:rates}},400);
  assert.match(imageRateMatch([{size:'*',quality:'high',per_call:1},{size:'*',quality:'high',per_call:1},{size:'*',quality:'high',per_call:2}],'1024x1024','high').error,/冲突/);
 });
 await test('administrator price changes invalidate old quotes before billing',async()=>{
  await req('PUT','/api/admin/models/ux',{pricing:{per_call:5,image_rates:[{size:'*',quality:'*',per_call:5}]}});
  const q=(await req('POST',`/api/studio/templates/${t.id}/quote`,body)).quote,money=balance(),before=calls;
  await req('PUT','/api/admin/models/ux',{pricing:{per_call:5,image_rates:[{size:'*',quality:'*',per_call:6}]}});
  await req('POST',`/api/studio/templates/${t.id}/jobs`,{quote_id:q.id,request_key:crypto.randomUUID(),confirm:true},409);assert.equal(calls,before);assert.equal(balance(),money);
 });
 console.log(`Studio UX/performance/pricing: ${n}/${n} passed`);
}finally{global.fetch=originalFetch;server.closeAllConnections();await new Promise(r=>server.close(r));closeDb();fs.rmSync(process.env.DATA_DIR,{recursive:true,force:true});}
