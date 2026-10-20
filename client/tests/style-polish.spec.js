import { test, expect } from '@playwright/test';
import sharp from '../../server/node_modules/sharp/lib/index.js';
async function makeStyle(request,name){
 const p=(await(await request.get('/api/studio/dna-presets')).json()).presets.find(p=>p.id==='suit');
 const dna=Object.fromEntries(p.fields.map(f=>[f.key,{value:f.key==='details'?['贴兜']:'常规',confidence:.8}]));
 const image=await sharp({create:{width:800,height:1200,channels:3,background:'#456789'}}).png().toBuffer();
 return (await request.post('/api/studio/templates',{data:{name,preset_id:'suit',dna_json:dna,source_image_base64:image.toString('base64')}})).json();
}
async function open(page,name){
 await page.goto('/');if((await page.viewportSize()).width<769)await page.getByRole('button',{name:'打开侧边栏',exact:true}).click();
 await page.getByText('设计台',{exact:true}).first().click();
 await page.locator('.studio-card').filter({hasText:name}).getByRole('button',{name:'款式属性',exact:true}).click();
 await page.locator('.style-panel nav').getByRole('button',{name:'款式衍生',exact:true}).click();
 await expect(page.getByLabel('款式图片模型')).not.toHaveValue('');
}
const action=(page,name)=>page.locator('.style-action-grid').getByRole('button',{name:new RegExp('^'+name)});
const submit=page=>page.getByRole('button',{name:'确认费用并生成',exact:true});
const workspace=async(request,id)=>(await request.get(`/api/studio/templates/${id}/workspace`)).json();

test('incomplete form never quotes, and errors stay in their owning tab and section',async({page,request})=>{
 await makeStyle(request,'按需反馈');let quotes=0,mode='ok';
 await page.route('**/quote',async route=>{quotes++;if(mode==='fail')return route.fulfill({status:503,json:{code:'PROVIDER_ERROR',error:'报价暂时不可用'}});await route.continue();});
 await open(page,'按需反馈');await expect(submit(page)).toBeEnabled();
 await action(page,'换场景').click();await page.getByLabel('移除参考图1').click();
 const before=quotes;
 await expect(page.locator('.style-workspace-footer')).toContainText('请选择参考图');
 await expect(submit(page)).toBeDisabled();await page.waitForTimeout(700);expect(quotes).toBe(before);
 await expect(page.locator('.style-workspace .style-error')).toHaveCount(0);
 await page.locator('.style-panel nav').getByRole('button',{name:'款式属性',exact:true}).click();await expect(page.locator('.style-workspace .style-error')).toHaveCount(0);
 await page.locator('.style-panel nav').getByRole('button',{name:'款式衍生',exact:true}).click();await action(page,'自由衍生').click();
 await page.getByLabel('本次要求',{exact:true}).fill('条纹领口');await expect(submit(page)).toBeEnabled();
 mode='fail';await page.getByLabel('本次要求',{exact:true}).fill('格纹领口');
 await expect(page.locator('.style-workspace-footer [role=alert]')).toHaveText('报价暂时不可用');
 await page.locator('.style-panel nav').getByRole('button',{name:'版本记录',exact:true}).click();
 await expect(page.locator('.style-workspace [role=alert]')).toHaveCount(0);
 mode='ok';await page.locator('.style-panel nav').getByRole('button',{name:'款式衍生',exact:true}).click();
 await expect(submit(page)).toBeEnabled();await expect(page.locator('.style-workspace .style-error')).toHaveCount(0);
});

test('reference errors appear beside upload and do not leak into attributes',async({page,request})=>{
 await makeStyle(request,'参考错误归属');await open(page,'参考错误归属');
 await page.getByLabel('上传参考图').setInputFiles({name:'broken.txt',mimeType:'text/plain',buffer:Buffer.from('invalid')});
 await expect(page.locator('.unified-references [role=alert]')).toContainText('请选择不超过15MB的图片');
 await expect(page.locator('.style-workspace-footer [role=alert]')).toHaveCount(0);
 await page.locator('.style-panel nav').getByRole('button',{name:'款式属性',exact:true}).click();
 await expect(page.locator('.style-workspace [role=alert]')).toHaveCount(0);
});

test('free design creates a branch on confirmation and recovers a lost response after reopening',async({page,request})=>{
 const t=await makeStyle(request,'断网幂等恢复');await open(page,'断网幂等恢复');
 await action(page,'自由衍生').click();await expect(action(page,'自由衍生')).toHaveAttribute('aria-pressed','true');
 await page.getByLabel('本次要求',{exact:true}).fill('改成酒红色条纹，保留领型');
 await expect(submit(page)).toBeEnabled();expect((await workspace(request,t.id)).versions).toHaveLength(1);
 const bodies=[];let lost=true;
 await page.route(`**/templates/${t.id}/jobs`,async route=>{
  bodies.push(route.request().postDataJSON());
  if(lost){lost=false;await route.fetch();await route.abort('failed');}else await route.continue();
 });
 await submit(page).click();
 await expect(page.getByRole('button',{name:'核对提交结果',exact:true})).toBeEnabled();
 await page.evaluate(id=>{const key=`style-draft-v1:local:${id}`,saved=JSON.parse(sessionStorage.getItem(key));saved.savedAt=Date.now()-2*86400000;sessionStorage.setItem(key,JSON.stringify(saved));},t.id);
 await page.getByRole('button',{name:'关闭款式详情'}).click();
 await page.locator('.studio-card').filter({hasText:'断网幂等恢复'}).getByRole('button',{name:'款式属性',exact:true}).click();
 await page.locator('.style-panel nav').getByRole('button',{name:'款式衍生',exact:true}).click();
 await page.getByRole('button',{name:'核对提交结果',exact:true}).click();
 await expect(page.locator('.style-result-grid article')).toHaveCount(1);
 const ws=await workspace(request,t.id);expect(ws.versions).toHaveLength(2);expect(ws.jobs).toHaveLength(1);
 expect(ws.versions[0].design_note).toContain('酒红色条纹');expect(ws.versions[1].design_note).toBe('');
 expect(bodies).toHaveLength(2);expect(bodies[0]).toEqual(bodies[1]);
});

test('stale confirmation error stays actionable until explicit requote, with no version created',async({page,request})=>{
 const t=await makeStyle(request,'过期报价恢复');await open(page,'过期报价恢复');await action(page,'自由衍生').click();await page.getByLabel('本次要求',{exact:true}).fill('改成条纹');await expect(submit(page)).toBeEnabled();
 await page.route(`**/templates/${t.id}/jobs`,route=>route.fulfill({status:409,json:{code:'QUOTE_CHANGED',error:'价格已变化，请重新报价'}}));
 await submit(page).click();await expect(page.locator('.style-workspace-footer [role=alert]')).toHaveText('价格已变化，请重新报价');
 expect((await workspace(request,t.id)).versions).toHaveLength(1);
 await page.unroute(`**/templates/${t.id}/jobs`);await page.getByRole('button',{name:'重新报价',exact:true}).click();await expect(submit(page)).toBeEnabled();
 await expect(page.locator('.style-workspace-footer [role=alert]')).toHaveCount(0);
});

for(const width of [1440,390])test(`uniform actions, stable header, tab selection, themes and zoom ${width}`,async({page,request})=>{
 await page.setViewportSize({width,height:900});await makeStyle(request,`界面精简${width}`);await open(page,`界面精简${width}`);
 await expect(page.locator('.style-action-grid>button')).toHaveCount(7);
 await expect(page.getByText(/已关联款式 V/)).toHaveCount(0);await expect(page.getByRole('button',{name:'保存要求为新版本'})).toHaveCount(0);
 for(const theme of ['light','black']){
  await page.evaluate(theme=>document.documentElement.setAttribute('data-theme',theme),theme);
  const sizes=await page.locator('.style-toolbar>.btn').evaluateAll(els=>els.map(e=>({height:e.getBoundingClientRect().height,width:e.getBoundingClientRect().width,top:e.getBoundingClientRect().top,display:getComputedStyle(e).display})));
  expect(sizes).toHaveLength(3);for(const s of sizes){expect(s.height).toBe(44);expect(['flex','inline-flex']).toContain(s.display);expect(s.width).toBeCloseTo(sizes[0].width,0);expect(s.top).toBe(sizes[0].top);}
  await action(page,'自由衍生').click();await expect(action(page,'自由衍生')).toHaveClass(/selected/);
  expect(await action(page,'自由衍生').locator('.style-action-check').innerText()).toBe('✓');
  const heights=await page.locator('.style-action-grid>button').evaluateAll(els=>els.map(e=>e.getBoundingClientRect().height));expect(Math.max(...heights)-Math.min(...heights)).toBeLessThan(1);
  const nav=page.locator('.style-panel nav');await expect(nav.getByRole('button',{name:'款式衍生',exact:true})).toHaveAttribute('aria-current','page');
  const states=await nav.locator('button').evaluateAll(els=>els.map(e=>({weight:getComputedStyle(e).fontWeight,border:getComputedStyle(e).borderColor})));expect(states[0].weight).not.toBe(states[1].weight);expect(states[0].border).not.toBe(states[1].border);
  await action(page,'生成基础图').focus();await page.keyboard.press('ArrowRight');await expect(action(page,'自由衍生')).toBeFocused();await expect(action(page,'自由衍生')).toHaveAttribute('aria-pressed','true');
  await page.locator('.style-panel-body').evaluate(e=>e.scrollTop=e.scrollHeight);
  const close=page.getByRole('button',{name:'关闭款式详情'}),box=await close.boundingBox();expect(box.y).toBeGreaterThanOrEqual(0);expect(box.y+box.height).toBeLessThan(900);await expect(close).toBeVisible();
  await page.locator('.style-panel-body').evaluate(e=>e.scrollTop=0);
  await page.screenshot({path:`/tmp/style-polish-${width}-${theme}.png`});
  await page.locator('.style-panel-body').evaluate(e=>e.scrollTop=0);
 }
 await page.evaluate(()=>document.documentElement.style.zoom='2');
 await expect(page.getByRole('button',{name:'关闭款式详情'})).toBeVisible();
 expect(await page.locator('.style-panel-body').evaluate(e=>e.scrollWidth<=e.clientWidth+1)).toBe(true);
});


test('invalid counts, custom sizes and incomplete camera settings do not send quote requests',async({page,request})=>{
 await makeStyle(request,'参数前置校验');await open(page,'参数前置校验');await page.getByLabel('款式图片模型').selectOption('browser-image-two');await expect(submit(page)).toBeEnabled();
 let quotes=0;page.on('request',r=>{if(new URL(r.url()).pathname.endsWith('/quote'))quotes++;});
 await page.getByLabel('款式生成张数').fill('0');await expect(submit(page)).toBeDisabled();await page.waitForTimeout(600);expect(quotes).toBe(0);
 await expect(page.locator('.style-workspace-footer')).toContainText('1–16');
 await page.getByLabel('款式生成张数').fill('1');await expect(submit(page)).toBeEnabled();
 await page.getByLabel('图片尺寸',{exact:true}).selectOption('custom');await page.getByLabel('自定义宽').fill('801');
 const before=quotes;await expect(submit(page)).toBeDisabled();await page.waitForTimeout(600);expect(quotes).toBe(before);
 await page.getByLabel('自定义宽').fill('800');await expect(submit(page)).toBeEnabled();
 await action(page,'出细节图').click();const camera=quotes;await expect(submit(page)).toBeDisabled();
 await expect(page.locator('.style-workspace-footer')).toContainText('特写部位');await page.waitForTimeout(600);expect(quotes).toBe(camera);
});
