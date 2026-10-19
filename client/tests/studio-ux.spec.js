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
async function derive(page){await page.locator('.style-panel nav').getByRole('button',{name:'款式衍生',exact:true}).click();await expect(page.getByLabel('款式图片模型')).toBeVisible();}
async function generate(request,t,count=1){
 const q=await(await request.post(`/api/studio/templates/${t.id}/quote`,{data:{version_id:t.ws.template.work_version_id,op:'create',mode:'text',model_id:'browser-image-two',size:'512x512',count}})).json();expect(q.ok).toBe(true);
 const r=await request.post(`/api/studio/templates/${t.id}/jobs`,{data:{quote_id:q.quote.id,request_key:crypto.randomUUID(),confirm:true}});expect(r.status()).toBe(202);
 const job=(await r.json()).job;
 await expect.poll(async()=>{const p=await(await request.get(`/api/studio/templates/${t.id}/workspace/progress?known=${encodeURIComponent(JSON.stringify({[job.id]:''}))}`)).json();return p.jobs[0]?.status;}).toBe('succeeded');
}

test('thumbnail paints while workspace is pending; pure viewing makes no auxiliary or original requests',async({page,request})=>{
 const t=await makeStyle(request,'立即预览4K',4096,4096);let release;const gate=new Promise(r=>release=r);let workspaceDone=false;
 await page.route('**/workspace?*',async route=>{await gate;workspaceDone=true;await route.continue();});
 await page.route('**/api/studio/preview?*',async route=>{await gate;await route.continue();});
 await page.goto('/');await page.getByText('设计台',{exact:true}).first().click();await page.locator('.studio-card').filter({hasText:'立即预览4K'}).waitFor();
 const requests=[];page.on('request',r=>requests.push(new URL(r.url()).pathname));
 await page.locator('.studio-card').filter({hasText:'立即预览4K'}).click();
 await expect(page.locator('.style-preview-image img')).toBeVisible();expect(workspaceDone).toBe(false);
 await expect(page.locator('.style-preview-image img')).toHaveAttribute('src','/'+t.ws.template.source_thumb_path);
 release();await expect(page.locator('.style-preview-footer')).toBeVisible();
 await expect(page.locator('.progressive-studio-image')).toHaveAttribute('data-preview-ready','true');
 expect(requests.filter(p=>/\/studio\/(image-models|assets|references)$|\/quote$/.test(p))).toEqual([]);
 expect(requests.filter(p=>p==='/'+t.ws.template.source_image_path)).toEqual([]);
 await page.getByRole('button',{name:'实际尺寸',exact:true}).click();await expect.poll(()=>requests.filter(p=>p==='/'+t.ws.template.source_image_path).length).toBe(1);
});

for(const [width,edge] of [[1440,4096],[390,4096],[1440,1024]])test(`cold/warm progressive timings and complete preview ${width}-${edge}`,async({page,request},info)=>{
 await page.setViewportSize({width,height:900});const t=await makeStyle(request,`性能测量${width}-${edge}`,edge,edge);
 await page.route('**/api/studio/image-models',async route=>{await new Promise(r=>setTimeout(r,800));await route.continue();});
 await page.goto('/');if(width<769)await page.getByRole('button',{name:'打开侧边栏',exact:true}).click();await page.getByText('设计台',{exact:true}).first().click();
 const metrics=[];
 for(let run=0;run<2;run++){
  await page.evaluate(()=>performance.clearResourceTimings());
  const start=Date.now();await page.locator('.studio-card').filter({hasText:`性能测量${width}-${edge}`}).click();
  await page.getByRole('dialog',{name:'款式详情',exact:true}).waitFor();const shell=Date.now()-start;
  await page.locator('.style-preview-image img').waitFor();await page.locator('.style-preview-image img').evaluate(img=>img.decode());const first=Date.now()-start;
  await expect(page.locator('.progressive-studio-image')).toHaveAttribute('data-preview-ready','true');
  const element=page.locator('.style-preview-image img');const clear=Date.now()-start;const decodeMs=await element.evaluate(async img=>{const start=performance.now();await img.decode();return performance.now()-start;});
  const box=await element.boundingBox(),frame=await page.locator('.style-preview-image').boundingBox();expect(box.y+box.height).toBeLessThanOrEqual(frame.y+frame.height+1);
  const resources=await page.evaluate(()=>performance.getEntriesByType('resource').filter(r=>r.name.includes('/api/studio/preview')).map(r=>({bytes:r.transferSize,download_ms:r.responseEnd-r.responseStart,total_ms:r.duration})));
  metrics.push({run:run?'warm':'cold',shell_ms:shell,first_preview_ms:first,clear_preview_ms:clear,decode_ms:decodeMs,resources});
  await page.getByRole('button',{name:'关闭款式详情',exact:true}).click();
 }
 console.log('PREVIEW_METRICS',JSON.stringify({width,edge,original_bytes:t.image.length,metrics}));await info.attach('preview-metrics.json',{body:JSON.stringify(metrics,null,2),contentType:'application/json'});
});

test('failed model loading is isolated from image and attributes and can retry',async({page,request})=>{
 await makeStyle(request,'辅助请求隔离');let fail=true;
 await page.route('**/api/studio/image-models',route=>fail?route.fulfill({status:503,json:{error:'模拟模型列表失败'}}):route.continue());
 await openStyle(page,'辅助请求隔离',true);await expect(page.getByText('结构版型',{exact:true})).toBeVisible();
 await derive(page);await expect(page.getByText(/图片模型加载失败/)).toBeVisible();await expect(page.locator('.style-preview-image img')).toBeVisible();
 fail=false;await page.getByRole('button',{name:'重试加载模型',exact:true}).click();
 await expect(page.getByRole('button',{name:'确认费用并生成',exact:true})).toBeEnabled();
});

test('action drafts persist, white is a primary direction, free design has explicit saved state',async({page,request})=>{
 const t=await makeStyle(request,'动作草稿');await openStyle(page,'动作草稿',true);await derive(page);
 expect(await page.getByLabel('本次要求包含服装设计变化').count()).toBe(0);expect(await page.getByRole('button',{name:'从当前属性整理要求'}).count()).toBe(0);
 await page.getByLabel('本次要求',{exact:true}).fill('自然打光');
 await page.getByRole('button',{name:'换场景 保留服装，调整背景和展示环境',exact:true}).click();await page.getByLabel('本次要求',{exact:true}).fill('更换室内背景');
 await page.getByRole('button',{name:'海岛度假',exact:true}).click();
 await page.getByRole('button',{name:'白底商品图 保留服装，生成纯白背景商品图',exact:true}).click();
 await expect(page.getByRole('button',{name:'海岛度假',exact:true})).toHaveCount(0);await expect(page.getByRole('checkbox',{name:'白底商品图'})).toHaveCount(0);
 await expect(page.getByRole('button',{name:'确认费用并生成',exact:true})).toBeEnabled();
 await page.getByRole('button',{name:'换场景 保留服装，调整背景和展示环境',exact:true}).click();await expect(page.getByLabel('本次要求',{exact:true})).toHaveValue('更换室内背景');await expect(page.getByRole('button',{name:'海岛度假',exact:true})).toHaveAttribute('aria-pressed','true');
 await page.getByRole('button',{name:'生成基础图 按已保存设计生成或参考图片重绘',exact:true}).click();await expect(page.getByLabel('本次要求',{exact:true})).toHaveValue('自然打光');
 await page.getByRole('button',{name:'自由衍生 · 修改设计',exact:true}).click();await page.getByLabel('本次要求',{exact:true}).fill('保留版型，改为条纹面料');
 await expect(page.getByRole('button',{name:'确认费用并生成',exact:true})).toBeDisabled();await page.getByRole('button',{name:'保存要求为新版本',exact:true}).click();
 await expect(page.getByRole('button',{name:'要求已保存',exact:true})).toBeDisabled();await expect(page.getByRole('button',{name:'确认费用并生成',exact:true})).toBeEnabled();
 const ws=await(await request.get(`/api/studio/templates/${t.id}/workspace`)).json();expect(ws.versions).toHaveLength(2);expect(ws.versions.find(v=>v.number===1).design_note).toBe('');
 await page.screenshot({path:'/tmp/style-derivation-new.png'});
 await page.getByRole('button',{name:'关闭款式详情'}).click();await page.locator('.studio-card').filter({hasText:'动作草稿'}).getByRole('button',{name:'款式属性',exact:true}).click();await derive(page);await expect(page.getByLabel('本次要求',{exact:true})).toHaveValue('保留版型，改为条纹面料');
});

test('one reference picker paginates searchable assets, preserves staged selections and deduplicates uploads',async({page,request})=>{
 test.setTimeout(60000);const source=await makeStyle(request,'图库分页资产');await generate(request,source,16);await generate(request,source,16);
 await makeStyle(request,'图库目标款式');await openStyle(page,'图库目标款式',true);await derive(page);await page.getByLabel('款式图片模型').selectOption('browser-image-two');
 let assets=0;page.on('request',r=>{if(new URL(r.url()).pathname==='/api/studio/assets')assets++;});expect(assets).toBe(0);
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
 await openStyle(page,'分页与任务',true);await expect(page.locator('.style-version-row')).toHaveCount(0);
 await page.locator('.style-panel nav').getByRole('button',{name:'版本记录',exact:true}).click();await expect(page.locator('.style-version-row')).toHaveCount(20);await page.getByRole('button',{name:'加载更多版本',exact:true}).click();await expect(page.locator('.style-version-row')).toHaveCount(24);
 // Exercise polling with a history snapshot taken just before the fast mock completes.
 let pending=true;await page.route('**/workspace/jobs?*',async route=>{const r=await route.fetch();const payload=await r.json();if(pending&&payload.items.length){pending=false;payload.items=payload.items.map(j=>({...j,status:'running',completed:0,revision:'browser-before-completion'}));}await route.fulfill({json:payload});});
 await derive(page);await expect(page.getByRole('button',{name:'确认费用并生成',exact:true})).toBeEnabled();const paths=[];page.on('request',r=>paths.push(new URL(r.url()).pathname));
 await page.getByRole('button',{name:'确认费用并生成',exact:true}).click();await expect(page.locator('.style-result-grid article')).toHaveCount(1);
 expect(paths.filter(p=>p.endsWith('/workspace'))).toEqual([]);await expect.poll(()=>paths.some(p=>p.endsWith('/workspace/progress'))).toBe(true);
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
 await openStyle(page,'受限网络4K');await expect(page.locator('.style-preview-image img')).toBeVisible();
 await expect(page.locator('.progressive-studio-image')).toHaveAttribute('data-preview-ready','true');
 const image=page.locator('.style-preview-image img');expect(await image.evaluate(img=>img.naturalWidth)).toBe(1600);
 expect(await image.evaluate(img=>getComputedStyle(img).objectFit)).toBe('contain');
 expect((await(await request.get('/'+t.ws.template.source_image_path)).body()).equals(t.image)).toBe(true);
});

test('closing a pending detail cancels the read and cannot overwrite the next card',async({page,request})=>{
 const a=await makeStyle(request,'过期响应甲'),b=await makeStyle(request,'过期响应乙');let release;const gate=new Promise(r=>release=r);
 await page.route(`**/templates/${a.id}/workspace?*`,async route=>{await gate;try{await route.continue();}catch{}});
 await openStyle(page,'过期响应甲');await expect(page.locator('.style-preview-image img')).toBeVisible();await page.getByRole('button',{name:'关闭款式详情'}).click();
 await page.locator('.studio-card').filter({hasText:'过期响应乙'}).click();await expect(page.locator('.style-workspace-head strong')).toHaveText('过期响应乙');release();
 await expect(page.locator('.style-preview-image img')).toHaveAttribute('alt','过期响应乙');
 const path=await page.locator('.style-preview-image img').getAttribute('src');expect(path.includes(encodeURIComponent(b.ws.template.source_image_path))||path.includes(b.ws.template.source_thumb_path)).toBe(true);
});


test('continuing from an older result keeps that image selected after version hydration',async({page,request})=>{
 const t=await makeStyle(request,'保留指定底图');await generate(request,t,2);await openStyle(page,'保留指定底图',true);await derive(page);
 await page.locator('.style-results').getByRole('button',{name:'展开',exact:true}).click();await expect(page.locator('.style-result-grid article')).toHaveCount(2);
 const ws=await(await request.get(`/api/studio/templates/${t.id}/workspace`)).json(),older=ws.images.at(-1);
 const hydrated=page.waitForResponse(r=>r.url().includes('/workspace/images?')&&new URL(r.url()).searchParams.get('limit')==='1');
 await page.locator('.style-result-grid article').filter({hasText:`#${older.id} ·`}).getByRole('button',{name:'以此继续衍生',exact:true}).click();await hydrated;
 await expect.poll(async()=>{const src=await page.locator('.style-preview-image img').getAttribute('src');return src.includes(encodeURIComponent(older.image_path))||src.includes(older.thumb_path);}).toBe(true);
});
