import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import sharp from '../../server/node_modules/sharp/lib/index.js';
import { derive } from './wizard-helpers.js';

async function make(request,name) {
  const preset=(await(await request.get('/api/studio/dna-presets')).json()).presets.find(p=>p.id==='suit');
  const bytes=await sharp({create:{width:320,height:480,channels:3,background:'#cfc1ab'}}).png().toBuffer();
  const template=await(await request.post('/api/studio/templates',{data:{name,preset_id:'suit',dna_json:Object.fromEntries(preset.fields.map(f=>[f.key,{value:f.key==='details'?['贴兜']:'常规',confidence:.8}])),source_image_base64:bytes.toString('base64')}})).json();
  return {template,bytes};
}
async function open(page,name) {
  await page.goto('/');
  if(page.viewportSize().width<769)await page.getByRole('button',{name:'打开侧边栏',exact:true}).click();
  await page.getByRole('button',{name:'设计台',exact:true}).first().click();
  await page.locator('.studio-card').filter({hasText:name}).getByRole('button',{name:'款式属性',exact:true}).click();
  await page.locator('.wizard-steps button').first().click();
  await derive(page);
}
for(const width of [1440,390])test(`missing old image never occupies slot one or blocks replacement ${width}`,async({page,request})=>{
  await page.setViewportSize({width,height:1000});
  const name=`失效图1替换${width}`,{template,bytes}=await make(request,name);
  const workspace=await(await request.get(`/api/studio/templates/${template.id}/workspace`)).json();
  const replacement = width===390 ? await(await request.post('/api/studio/references',{data:{image_base64:bytes.toString('base64')}})).json() : null;
  const plan=(await(await request.post(`/api/studio/templates/${template.id}/plans`,{data:{version_id:workspace.template.work_version_id,request_key:randomUUID(),input:{modules:{main:1},requirements:replacement?'请用图2展示商品':'',references:[{id:'missing-original',source:'original',role:'garment'},...(replacement?[{id:'existing-second',source:`ref:${replacement.id}`,role:'garment'}]:[])],model_id:'browser-image-one',analysis_model_id:'browser-chat-one',size:'512x512'}}})).json()).plan;
  await page.route(`**/templates/${template.id}/workspace?*`,async route=>{
    const response=await route.fetch(),data=await response.json();
    data.template.source_available=false;data.template.source_image_path='uploads/studio/missing-original.png';data.template.source_thumb_path='';data.primary_reference=null;
    await route.fulfill({response,json:data});
  });
  await open(page,name);
  if(!replacement){
    await expect(page.locator('.reference-strip article')).toHaveCount(0);
    await expect(page.getByLabel('上传商品图',{exact:true})).toBeEnabled();
    await page.getByLabel('上传商品图',{exact:true}).setInputFiles({name:'replacement.png',mimeType:'image/png',buffer:bytes});
  }
  await expect(page.locator('.reference-strip article')).toHaveCount(1);
  await expect(page.locator('.reference-strip strong')).toHaveText('图1 · 款式主体');
  await expect.poll(async()=>{
    const saved=await(await request.get(`/api/studio/templates/${template.id}/plans/${plan.id}`)).json();return saved.plan.input.references[0]?.source;
  }).toMatch(/^ref:/);
});

test('current version image becomes image one automatically',async({page,request})=>{
  const name='当前版本自动关联',{template}=await make(request,name);
  const workspace=await(await request.get(`/api/studio/templates/${template.id}/workspace`)).json(),root=workspace.versions[0];
  const version=(await(await request.post(`/api/studio/templates/${template.id}/versions`,{data:{parent_id:root.id,dna:{...JSON.parse(root.dna_json),primary_color:{value:'深蓝色'}},request_key:randomUUID()}})).json()).version;
  const working=await request.post(`/api/studio/templates/${template.id}/working-version`,{data:{expected_version_id:root.id,version_id:version.id}});expect(working.ok()).toBe(true);
  const quoted=await request.post(`/api/studio/templates/${template.id}/quote`,{data:{version_id:version.id,op:'create',mode:'image',source:'original',model_id:'browser-image-one',size:'512x512',count:1}});
  expect(quoted.ok()).toBe(true);const quote=(await quoted.json()).quote;
  const job=(await(await request.post(`/api/studio/templates/${template.id}/jobs`,{data:{quote_id:quote.id,request_key:randomUUID(),confirm:true}})).json()).job;
  await expect.poll(async()=>(await(await request.get(`/api/studio/templates/${template.id}/jobs/${job.id}`)).json()).job.status).toBe('succeeded');
  const summary=await(await request.get(`/api/studio/templates/${template.id}/workspace?view=summary`)).json();
  expect(summary.primary_reference.origin).toBe('version');expect(summary.primary_reference.design_version_id).toBe(version.id);
  await open(page,name);
  await expect(page.locator('.reference-strip article')).toHaveCount(1);
  await expect(page.locator('.reference-strip img')).toHaveAttribute('src','/'+summary.primary_reference.thumb_path);
  await page.locator('.wizard-steps button').first().click();
  await page.getByRole('button',{name:/浏览版本记录/}).click();
  await page.getByLabel('设计版本',{exact:true}).selectOption(String(root.id));
  await derive(page);
  await expect(page.locator('.reference-strip img')).toHaveAttribute('src','/'+workspace.template.source_thumb_path);
  await page.locator('.wizard-steps button').first().click();
  await page.getByRole('button',{name:/浏览版本记录/}).click();
  await page.getByLabel('设计版本',{exact:true}).selectOption(String(version.id));
  await derive(page);
  await expect(page.locator('.reference-strip img')).toHaveAttribute('src','/'+summary.primary_reference.thumb_path);
  const replacement=await sharp({create:{width:200,height:300,channels:3,background:'#264b78'}}).png().toBuffer();
  await page.getByLabel('替换图1',{exact:true}).setInputFiles({name:'version-replacement.png',mimeType:'image/png',buffer:replacement});
  await expect(page.locator('.reference-strip article')).toHaveCount(1);
  await expect(page.locator('.reference-strip img')).toHaveAttribute('src',/reference_/);

});

test('named model is stored and reused in another style without uploading again',async({page,request})=>{
  const first=await make(request,'模特保存款式'),second=await make(request,'模特复用款式');
  await open(page,'模特保存款式');
  await page.getByLabel('上传模特图',{exact:true}).setInputFiles({name:'reusable-model.png',mimeType:'image/png',buffer:first.bytes});
  const name=page.getByLabel('模特1名称',{exact:true});await expect(name).toBeVisible();
  await name.fill('日常长发模特');await name.blur();
  await expect.poll(async()=>(await(await request.get('/api/studio/references?kind=model&search='+encodeURIComponent('日常长发模特'))).json()).total).toBe(1);
  const stored=(await(await request.get('/api/studio/references?kind=model&search='+encodeURIComponent('日常长发模特'))).json()).references[0];
  await page.getByLabel('关闭款式详情').click();
  await open(page,'模特复用款式');
  let uploads=0;page.on('request',r=>{if(r.method()==='POST'&&new URL(r.url()).pathname==='/api/studio/references')uploads++;});
  await page.getByRole('button',{name:'从模特库选择',exact:true}).click();
  await expect(page.getByRole('tab',{name:'我的模特',exact:true})).toHaveAttribute('aria-selected','true');
  await page.getByLabel('搜索参考图',{exact:true}).fill('日常长发模特');
  await page.getByRole('button',{name:'选择日常长发模特',exact:true}).click();
  await page.getByRole('button',{name:'添加所选参考图',exact:true}).click();
  await expect(page.getByLabel('模特1名称',{exact:true})).toHaveValue('日常长发模特');
  await expect(page.locator('.reference-strip strong').last()).toHaveText('图2 · 模特参考');
  expect(uploads).toBe(0);
  await expect(page.locator('.reference-strip img').last()).toHaveAttribute('src','/'+stored.thumb_path);
});
