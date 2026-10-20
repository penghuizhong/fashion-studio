import {derive,analyze,render,attributes} from './wizard-helpers.js';
import {test,expect} from '@playwright/test';
import sharp from '../../server/node_modules/sharp/lib/index.js';
async function makeStyle(request,name,width=800,height=1200){
 const p=await(await request.get('/api/studio/dna-presets')).json();
 const dna=Object.fromEntries(p.presets.find(p=>p.id==='suit').fields.map(f=>[f.key,{value:f.key==='details'?['贴兜']:'藏蓝',confidence:.9}]));
 const image=await sharp({create:{width,height,channels:3,background:'#345678'}}).png().toBuffer();
 const r=await request.post('/api/studio/templates',{data:{name,preset_id:'suit',dna_json:dna,source_image_base64:image.toString('base64')}});expect(r.ok()).toBeTruthy();
 const t=await r.json(),ws=await(await request.get(`/api/studio/templates/${t.id}/workspace`)).json();return {...t,dna,ws,image};
}
async function openStyle(page,name,properties=false){
 await page.goto('/');if((await page.viewportSize()).width<769)await page.getByRole('button',{name:'打开侧边栏',exact:true}).click();
 await page.getByText('设计台',{exact:true}).first().click();
 const card=page.locator('.studio-card').filter({hasText:name});
 if(properties)await card.getByRole('button',{name:'款式属性',exact:true}).click();else await card.click();
 await expect(page.getByRole('dialog',{name:'款式详情',exact:true})).toBeVisible();
}
async function generate(request,t,count=1){
 const q=await(await request.post(`/api/studio/templates/${t.id}/quote`,{data:{version_id:t.ws.template.work_version_id,op:'create',mode:'text',model_id:'browser-image-two',size:'512x512',count}})).json();expect(q.ok).toBe(true);
 const r=await request.post(`/api/studio/templates/${t.id}/jobs`,{data:{quote_id:q.quote.id,request_key:crypto.randomUUID(),confirm:true}});expect(r.status()).toBe(202);
 const job=(await r.json()).job;
 await expect.poll(async()=>{const p=await(await request.get(`/api/studio/templates/${t.id}/workspace/progress?known=${encodeURIComponent(JSON.stringify({[job.id]:''}))}`)).json();return p.jobs[0]?.status;}).toBe('succeeded');
}

test('step one opens immediately with a thumbnail; models and originals stay lazy',async({page,request})=>{
 const t=await makeStyle(request,'立即预览4K',4096,4096);let release;const gate=new Promise(r=>release=r);let workspaceDone=false;
 await page.route('**/workspace?*',async route=>{await gate;workspaceDone=true;await route.continue();});
 await page.route('**/api/studio/preview?*',async route=>{await gate;await route.continue();});
 await page.goto('/');await page.getByText('设计台',{exact:true}).first().click();await page.locator('.studio-card').filter({hasText:'立即预览4K'}).waitFor();
 const requests=[];page.on('request',r=>requests.push(new URL(r.url()).pathname));
 await page.locator('.studio-card').filter({hasText:'立即预览4K'}).click();
 await expect(page.locator('.wizard-property-preview img')).toBeVisible();expect(workspaceDone).toBe(false);
 await expect(page.locator('.wizard-property-preview img')).toHaveAttribute('src','/'+t.ws.template.source_thumb_path);
 await expect(page.locator('.wizard-steps button')).toHaveCount(5);await expect(page.locator('.wizard-image-only')).toHaveCount(0);release();await expect(page.getByLabel('设计版本',{exact:true})).not.toHaveValue('');
 await expect(page.locator('.progressive-studio-image')).toHaveAttribute('data-preview-ready','true');
 expect(requests.filter(p=>/\/studio\/(image-models|assets|references)$|\/quote$/.test(p))).toEqual([]);
 expect(requests.filter(p=>p==='/'+t.ws.template.source_image_path)).toEqual([]);
 await page.getByRole('button',{name:'放大原图',exact:true}).click();await page.getByRole('button',{name:'实际尺寸',exact:true}).click();await expect.poll(()=>requests.filter(p=>p==='/'+t.ws.template.source_image_path).length).toBe(1);
});

for(const [width,edge] of [[1440,4096],[390,4096],[1440,1024]])test(`cold/warm progressive timings and complete preview ${width}-${edge}`,async({page,request},info)=>{
 await page.setViewportSize({width,height:900});const t=await makeStyle(request,`性能测量${width}-${edge}`,edge,edge);
 await page.route('**/api/studio/image-models',async route=>{await new Promise(r=>setTimeout(r,800));await route.continue();});
 await page.goto('/');if(width<769)await page.getByRole('button',{name:'打开侧边栏',exact:true}).click();await page.getByText('设计台',{exact:true}).first().click();
 const metrics=[];
 for(let run=0;run<2;run++){
  await page.evaluate(()=>performance.clearResourceTimings());
  const start=Date.now();await page.locator('.studio-card').filter({hasText:`性能测量${width}-${edge}`}).click();
  await page.getByRole('dialog',{name:'款式详情',exact:true}).waitFor();const shell=Date.now()-start;if(width<700)await page.getByRole('button',{name:'预览',exact:true}).click();
  await page.locator('.wizard-property-preview img').waitFor();await page.locator('.wizard-property-preview img').evaluate(img=>img.decode());const first=Date.now()-start;
  await expect(page.locator('.progressive-studio-image')).toHaveAttribute('data-preview-ready','true');
  const element=page.locator('.wizard-property-preview img');const clear=Date.now()-start;const decodeMs=await element.evaluate(async img=>{const start=performance.now();await img.decode();return performance.now()-start;});
  const box=await element.boundingBox(),frame=await page.locator('.wizard-property-preview>.progressive-studio-image').boundingBox();expect(box.y+box.height).toBeLessThanOrEqual(frame.y+frame.height+1);
  const resources=await page.evaluate(()=>performance.getEntriesByType('resource').filter(r=>r.name.includes('/api/studio/preview')).map(r=>({bytes:r.transferSize,download_ms:r.responseEnd-r.responseStart,total_ms:r.duration})));
  metrics.push({run:run?'warm':'cold',shell_ms:shell,first_preview_ms:first,clear_preview_ms:clear,decode_ms:decodeMs,resources});
  await page.getByRole('button',{name:'关闭款式详情',exact:true}).click();
 }
 console.log('PREVIEW_METRICS',JSON.stringify({width,edge,original_bytes:t.image.length,metrics}));await info.attach('preview-metrics.json',{body:JSON.stringify(metrics,null,2),contentType:'application/json'});
});

test('failed model loading is isolated from image and attributes and can retry',async({page,request})=>{
 await makeStyle(request,'辅助请求隔离');let fail=true;
 await page.route('**/api/studio/image-models',route=>fail?route.fulfill({status:503,json:{error:'模拟模型列表失败'}}):route.continue());
 await openStyle(page,'辅助请求隔离',true);await expect(page.getByText('基础属性',{exact:true})).toBeVisible();await expect(page.locator('.wizard-property-preview img')).toBeVisible();
 await page.locator('.wizard-steps button').nth(1).click();await expect(page.locator('.wizard-inputs [role=alert]')).toBeVisible();
 fail=false;await page.getByRole('button',{name:'重试加载模型',exact:true}).click();await expect(page.getByLabel('图片模型',{exact:true})).not.toHaveValue('');await analyze(page);await expect(page.locator('.wizard-footer .wizard-primary')).toBeEnabled();
});

test('directions and requirements persist while design changes save only in attributes',async({page,request})=>{
 const t=await makeStyle(request,'方向草稿');await openStyle(page,'方向草稿',true);await derive(page);
 await page.getByLabel('本次衍生方向').selectOption('white');await page.getByLabel('生成要求').fill('纯白背景，完整展示');await attributes(page);
 await page.getByRole('button',{name:'基于此版本修改',exact:true}).click();await page.getByLabel('设计变化说明').fill('衣领改为条纹');await page.getByRole('button',{name:'保存为新版本',exact:true}).click();await derive(page);await page.getByLabel('本次衍生方向').selectOption('free_design');await analyze(page);
 const before=await(await request.get(`/api/studio/templates/${t.id}/workspace`)).json();expect(before.versions).toHaveLength(2);await render(page);const after=await(await request.get(`/api/studio/templates/${t.id}/workspace`)).json();expect(after.versions).toHaveLength(2);expect(after.jobs[0].snapshot.style.version_id).not.toBe(after.template.work_version_id);
});

test('one reference picker paginates searchable assets, preserves staged selections and deduplicates uploads',async({page,request})=>{
 test.setTimeout(60000);const source=await makeStyle(request,'图库分页资产');await generate(request,source,16);await generate(request,source,16);
 await makeStyle(request,'图库目标款式');await openStyle(page,'图库目标款式',true);await derive(page);await page.getByLabel('图片模型',{exact:true}).selectOption('browser-image-two');
 await page.getByLabel('移除参考图1').click();let assets=0;page.on('request',r=>{if(new URL(r.url()).pathname==='/api/studio/assets')assets++;});expect(assets).toBe(0);
 await page.getByRole('button',{name:'从图库选择',exact:true}).click();await page.getByRole('tab',{name:'资产库',exact:true}).click();await page.getByLabel('搜索参考图').fill('图库分页资产');
 await expect(page.locator('.reference-picker-grid button')).toHaveCount(24);await page.locator('.reference-picker-grid button').first().click();
 await page.getByRole('button',{name:'下一页',exact:true}).click();await expect(page.locator('.reference-picker-grid button')).toHaveCount(8);await page.locator('.reference-picker-grid button').first().click();
 await expect(page.getByText('待添加 2 张',{exact:true})).toBeVisible();await page.getByRole('button',{name:'添加所选参考图',exact:true}).click();await expect(page.locator('.reference-strip article')).toHaveCount(2);
 await page.getByRole('button',{name:'从图库选择',exact:true}).click();await page.getByRole('tab',{name:'已上传',exact:true}).click();await expect(page.locator('.reference-picker-grid button:disabled')).toHaveCount(2);
 await page.getByRole('button',{name:'取消',exact:true}).click();await expect(page.locator('.reference-strip article')).toHaveCount(2);expect(assets).toBeGreaterThan(0);
});

test('history is lazy and paginated; task polling does not reload full workspace',async({page,request})=>{
 const t=await makeStyle(request,'分页与任务');let parent=t.ws.template.work_version_id;
 for(let i=0;i<23;i++){const r=await request.post(`/api/studio/templates/${t.id}/versions`,{data:{parent_id:parent,dna:{...t.dna,primary_color:{value:'蓝'+i}},request_key:crypto.randomUUID()}});parent=(await r.json()).version.id;}
 await openStyle(page,'分页与任务',true);await expect(page.locator('.wizard-version-list')).toHaveCount(0);
 await page.getByRole('button',{name:/浏览版本记录/}).click();await expect(page.locator('.wizard-version-list>button').filter({hasText:/^V/})).toHaveCount(20);await page.getByRole('button',{name:'加载更多版本',exact:true}).click();await expect(page.locator('.wizard-version-list>button').filter({hasText:/^V/})).toHaveCount(24);
 await derive(page);await analyze(page);const paths=[];page.on('request',r=>paths.push(new URL(r.url()).pathname));await render(page);await expect.poll(()=>paths.some(p=>p.endsWith('/workspace/progress'))).toBe(true);expect(paths.filter(p=>p.endsWith('/workspace'))).toEqual([]);
});

for(const width of [1440,390])test(`visual pricing editor preserves tiers and previews authoritative prices ${width}`,async({page},info)=>{
 await page.setViewportSize({width,height:900});
 const provider={id:'ui-provider',name:'界面测试供应商',kind:'both',preset:'custom',is_active:true};
 let model={id:'ui-model',provider_id:provider.id,provider_name:provider.name,provider_preset:'custom',kind:'image',model_id:'ui-image',name:'计费编辑模型',is_active:true,pricing:{per_call:5,image_rates:[{size:'*',quality:'high',per_call:9}]},extra:{sizes:['1024x1024','768x1024'],image_config:{protocol:'openai_images',text:true,edit:true,max_images:4,qualities:[{value:'low',label:'轻量'},{value:'high',label:'精细'}]}}};
 await page.route('**/api/config',async route=>{const r=await route.fetch();await route.fulfill({json:{...await r.json(),multi_user:true}});});
 await page.route('**/api/user/api-key',route=>route.fulfill({json:{hasKey:false}}));
 await page.route('**/api/points/ledger?*',route=>route.fulfill({json:[]}));
 await page.route('**/api/auth/me',route=>route.fulfill({json:{user:{id:'ui-admin',username:'管理员',is_admin:true}}}));
 await page.route('**/api/points',route=>route.fulfill({json:{balance:1000,is_admin:true,billing_mode:'points',models:[]}}));
 await page.route('**/api/admin/providers',route=>route.fulfill({json:{providers:[provider]}}));
 await page.route('**/api/admin/providers/*/models',route=>route.fulfill({json:{models:[]}}));
 await page.route('**/api/admin/explore-recovery',route=>route.fulfill({json:{items:[]}}));
 await page.route('**/api/admin/settings',route=>route.fulfill({json:{worker_model:'',chat_default_model:''}}));
 await page.route('**/api/admin/models',route=>route.fulfill({json:{models:[model]}}));
 let saved;await page.route('**/api/admin/models/ui-model',async route=>{saved=route.request().postDataJSON();model={...model,...saved};await route.fulfill({json:{ok:true,model}});});
 await page.goto('/');if(width<769)await page.getByRole('button',{name:'打开侧边栏',exact:true}).click();await page.getByTitle('账户',{exact:true}).click();await page.getByRole('button',{name:'API 设置',exact:true}).click();await page.getByRole('button',{name:'模型管理',exact:true}).click();
 await page.locator('.pm-row').filter({hasText:'计费编辑模型'}).getByRole('button',{name:'编辑',exact:true}).click();
 const editor=page.getByRole('region',{name:'图片计费设置'});await expect(editor.locator('tbody tr')).toHaveCount(1);await expect(editor.locator('textarea')).toHaveCount(0);await expect(editor.getByLabel('价格档位1积分')).toHaveValue('9');
 await editor.getByRole('button',{name:'添加默认价',exact:true}).click();await editor.getByLabel('价格档位2积分').fill('7');
 await editor.getByText('报价预览 · 不生成图片',{exact:true}).click();await editor.getByLabel('报价预览质量').selectOption('high');await editor.getByLabel('报价预览数量').fill('2');await editor.getByRole('button',{name:'计算报价',exact:true}).click();await expect(editor.getByRole('status')).toContainText('18 积分');
 await page.screenshot({path:`/tmp/pricing-editor-${width}.png`});
 await page.getByRole('button',{name:'保存',exact:true}).click();await expect.poll(()=>saved?.pricing?.image_rates?.length).toBe(2);expect(saved.pricing.image_rates).toEqual([{size:'*',quality:'high',per_call:9},{size:'*',quality:'*',per_call:7}]);
 await page.locator('.pm-row').filter({hasText:'计费编辑模型'}).getByRole('button',{name:'编辑',exact:true}).click();await expect(editor.getByLabel('价格档位2积分')).toHaveValue('7');
 await editor.getByText('批量填写价格',{exact:true}).click();await editor.getByLabel('批量积分').fill('0');await editor.getByRole('button',{name:'批量应用',exact:true}).click();await expect(editor.getByLabel('价格档位1积分')).toHaveValue('0');await expect(editor.getByLabel('价格档位2积分')).toHaveValue('0');
 await page.evaluate(()=>document.documentElement.setAttribute('data-theme','black'));await page.screenshot({path:`/tmp/pricing-editor-${width}-dark.png`,animations:'disabled'});
 await info.attach('pricing-editor.png',{path:`/tmp/pricing-editor-${width}.png`,contentType:'image/png'});
});


test('restricted network keeps a decoded thumbnail visible while clear preview downloads',async({page,request,context})=>{
 const t=await makeStyle(request,'受限网络4K',4096,4096);
 const cdp=await context.newCDPSession(page);await cdp.send('Network.enable');
 await cdp.send('Network.emulateNetworkConditions',{offline:false,latency:150,downloadThroughput:160*1024,uploadThroughput:128*1024});
 await openStyle(page,'受限网络4K');await expect(page.locator('.wizard-property-preview img')).toBeVisible();
 await expect(page.locator('.progressive-studio-image')).toHaveAttribute('data-preview-ready','true');
 const image=page.locator('.wizard-property-preview img');expect(await image.evaluate(img=>img.naturalWidth)).toBe(1600);
 expect(await image.evaluate(img=>getComputedStyle(img).objectFit)).toBe('contain');
 expect((await(await request.get('/'+t.ws.template.source_image_path)).body()).equals(t.image)).toBe(true);
});

test('closing a pending detail cancels the read and cannot overwrite the next card',async({page,request})=>{
 const a=await makeStyle(request,'过期响应甲'),b=await makeStyle(request,'过期响应乙');let release;const gate=new Promise(r=>release=r);
 await page.route(`**/templates/${a.id}/workspace?*`,async route=>{await gate;try{await route.continue();}catch{}});
 await openStyle(page,'过期响应甲');await expect(page.locator('.wizard-property-preview img')).toBeVisible();await page.getByRole('button',{name:'关闭款式详情'}).click();
 await page.locator('.studio-card').filter({hasText:'过期响应乙'}).click();await expect(page.locator('.style-workspace-head strong')).toHaveText('过期响应乙');release();
 await expect(page.locator('.wizard-property-preview img')).toHaveAttribute('alt','款式预览图');
 const path=await page.locator('.wizard-property-preview img').getAttribute('src');expect(path.includes(encodeURIComponent(b.ws.template.source_image_path))||path.includes(b.ws.template.source_thumb_path)).toBe(true);
});


test('continuing from an older result keeps that image as the explicit reference',async({page,request})=>{
 const t=await makeStyle(request,'保留指定底图');await generate(request,t,2);await openStyle(page,'保留指定底图',true);await page.locator('.wizard-steps button').nth(4).click();await page.getByText('历史结果',{exact:false}).first().click();
 const ws=await(await request.get(`/api/studio/templates/${t.id}/workspace`)).json(),older=ws.images.at(-1);
 const card=page.locator('.wizard-result-card').filter({hasText:`历史图片 #${older.id}`});await card.getByRole('button',{name:'以此继续衍生',exact:true}).click();await expect(page.locator('.reference-strip article')).toHaveCount(1);await expect(page.locator('.reference-strip img')).toHaveAttribute('src','/'+older.thumb_path);
});
