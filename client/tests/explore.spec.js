import { test, expect } from '@playwright/test';

test('real modal: explicit expansion model, select 2/6, image model only at render, recover and adopt', async ({
  page,
}) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  // Navigate the same sidebar entry users use, rather than mounting a substitute component.
  await page.getByText('设计台', { exact: true }).first().click();
  await page.getByRole('button', { name: '创意衍生', exact: true }).click();
  await expect(page.getByLabel('发散模型', { exact: true })).toBeVisible();
  await expect(page.getByLabel('图片模型', { exact: true })).toHaveCount(0);
  await page.getByLabel('服装类目', { exact: true }).selectOption('suit');
  await page
    .getByLabel('发散模型', { exact: true })
    .selectOption('browser-chat-two');
  await page
    .getByLabel('灵感', { exact: true })
    .fill('保留藏蓝色与戗驳头，探索不同面料');
  const createRequest = page.waitForRequest(
    (r) => r.url().endsWith('/api/studio/explore') && r.method() === 'POST'
  );
  await page.getByRole('button', { name: '开始发散', exact: true }).click();
  expect((await createRequest).postDataJSON().expand_model_id).toBe(
    'browser-chat-two'
  );
  await expect(page.locator('.explore-dna-card')).toHaveCount(6);
  await page.getByRole('button', { name: '清空', exact: true }).click();
  await page.locator('.explore-dna-card').nth(0).click();
  await page.locator('.explore-dna-card').nth(2).click();
  await page
    .getByRole('button', { name: '下一步：渲染设置（2 张）', exact: true })
    .click();
  await expect(page.getByLabel('图片模型', { exact: true })).toBeVisible();
  await expect(page.getByLabel('发散模型', { exact: true })).toHaveCount(0);
  await page
    .getByLabel('图片模型', { exact: true })
    .selectOption('browser-image-two');
  const quoteRequest = page.waitForRequest((r) => r.url().endsWith('/quote') && r.postDataJSON().render_size === '512x512' && r.postDataJSON().camera?.view === 'back');
  await page.getByLabel('服装朝向',{exact:true}).selectOption('back');
  await page.getByLabel('图片尺寸', { exact: true }).selectOption('512x512');
  const q = (await quoteRequest).postDataJSON();
  expect(q.indexes).toEqual([0, 2]);
  expect(q.render_model_id).toBe('browser-image-two');
  expect(q.render_size).toBe('512x512');
  expect(q.camera.view).toBe('back');expect(q.camera.framing).toBe('garment');
  await expect(page.getByText(/服务端报价：2 张/)).toBeVisible();
  await page
    .getByRole('button', { name: '确认费用并生成', exact: true })
    .click();
  await expect(page.locator('.explore-render-card img')).toHaveCount(2);
  const downloaded=page.waitForEvent('download');
  await page.getByRole('link',{name:'下载原图',exact:true}).first().click();
  expect((await downloaded).suggestedFilename()).toMatch(/\.png$/);
  expect(await page.locator('.explore-render-card img').first().evaluate(e=>getComputedStyle(e).objectFit)).toBe('contain');

  const images = await page
    .locator('.explore-render-card img')
    .evaluateAll((imgs) => imgs.map((i) => i.getAttribute('src')));
  await page.reload();
  await page.getByText('设计台', { exact: true }).first().click();
  await page.getByRole('button', { name: '创意衍生', exact: true }).click();
  await page.getByRole('button', { name: '历史记录', exact: true }).click();
  await page.locator('.explore-batch-row').first().click();
  await expect(page.locator('.explore-render-card img')).toHaveCount(2);
  expect(
    await page
      .locator('.explore-render-card img')
      .evaluateAll((imgs) => imgs.map((i) => i.getAttribute('src')))
  ).toEqual(images);
  await page
    .getByRole('button', { name: '收为款式卡（2）', exact: true })
    .click();
  await expect(page.locator('.explore-modal')).toBeVisible();
  await expect(page.getByText('方案 1 · 已收卡', {exact:true})).toBeVisible();
  await page.getByRole('button',{name:'前往款式库',exact:true}).click();
  await expect(page.locator('.explore-modal')).toHaveCount(0);
  const card=page.locator('.studio-card').first();
  await expect(card).toBeVisible();
  expect(await card.locator('.studio-card-cover').evaluate(e=>getComputedStyle(e).aspectRatio)).toBe('1 / 1');
  expect(await card.locator('img').evaluate(e=>getComputedStyle(e).objectFit)).toBe('contain');
  await card.click();
  const viewer=page.getByRole('dialog',{name:'款式详情',exact:true});await expect(viewer).toBeVisible();
  const originalSrc=await viewer.locator('.style-preview-image img').getAttribute('src');expect(originalSrc).not.toContain('/thumbs/');
  await page.getByRole('button',{name:'实际尺寸',exact:true}).click();await expect(viewer.locator('.style-preview.actual')).toBeVisible();
  await page.keyboard.press('Escape');await expect(viewer).toHaveCount(0);
  await card.getByRole('button',{name:'款式属性',exact:true}).click();await expect(page.locator('.original-image-viewer')).toHaveCount(0);

  expect(errors).toEqual([]);
});

test('locked field is removed from axes; safe provider error is shown without generic server toast', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByText('设计台', { exact: true }).first().click();
  await page.getByRole('button', { name: '创意衍生', exact: true }).click();
  await page.getByLabel('服装类目', { exact: true }).selectOption('suit');
  await page.getByText('高级设置 · 思考模式、保留条件与费用说明',{exact:true}).click();
  await page.getByText('哪些设计必须保留（可选）', { exact: true }).click();
  await page.getByLabel('添加保留条件',{exact:true}).selectOption('fabric');
  await page.getByLabel('锁定面料外观', { exact: true }).fill('羊毛质感');
  await expect(
    page
      .locator('.explore-axis')
      .filter({ hasText: '面料外观' })
      .getByRole('checkbox')
  ).toBeDisabled();
  let params;
  await page.route('**/api/studio/explore', async (route) => {
    params = route.request().postDataJSON();
    await route.fulfill({
      status: 502,
      contentType: 'application/json',
      body: JSON.stringify({
        code: 'PROVIDER_ERROR',
        error: '发散供应商暂不可用，请更换模型',
        request_id: 'browser-test-request',
      }),
    });
  });
  await page.getByRole('button', { name: '开始发散', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('发散供应商暂不可用');
  await expect(page.getByRole('alert')).toContainText('browser-test-request');
  expect(params.locked_fields.fabric).toBe('羊毛质感');
  expect(params.axes).not.toContain('fabric');
  expect(params.request_key).toBeTruthy();
  await expect(
    page.getByRole('button', { name: '开始发散', exact: true })
  ).toBeEnabled();
});

test('opening history with another category does not change the next new form schema', async ({
  page,
  request,
}) => {
  await request.post('/api/studio/explore', {
    data: {
      preset_id: 'dress',
      axes: ['fabric'],
      count: 2,
      expand_model_id: 'browser-chat-one',
      intent_text: '历史连衣裙',
    },
  });
  await page.goto('/');
  await page.getByText('设计台', { exact: true }).first().click();
  await page.getByRole('button', { name: '创意衍生', exact: true }).click();
  await expect(page.getByLabel('服装类目', { exact: true })).toHaveValue(
    'suit'
  );
  await page.getByRole('button', { name: '历史记录', exact: true }).click();
  await page
    .locator('.explore-batch-row')
    .filter({ hasText: '历史连衣裙' })
    .click();
  await expect(page.locator('.explore-dna-card').first()).toContainText('领口');
  await page.getByRole('button', { name: '当前任务', exact: true }).click();
  await expect(page.getByLabel('服装类目', { exact: true })).toHaveValue(
    'suit'
  );
  await expect(
    page.locator('.explore-axis').filter({ hasText: '驳头' })
  ).toBeVisible();
  await expect(
    page.locator('.explore-axis').filter({ hasText: '领口' })
  ).toHaveCount(0);
});

test('custom candidate count and thinking toggle reach the expansion request', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByText('设计台', { exact: true }).first().click();
  await page.getByRole('button', { name: '创意衍生', exact: true }).click();
  await page.getByLabel('服装类目', { exact: true }).selectOption('suit');
  await page
    .getByLabel('发散模型', { exact: true })
    .selectOption('browser-chat-two');
  await page.getByText('高级设置 · 思考模式、保留条件与费用说明',{exact:true}).click();
  await expect(page.getByLabel('思考模式', { exact: true })).not.toBeChecked();
  await page.getByLabel('思考模式', { exact: true }).check();
  await page.getByLabel('自定义候选数量', { exact: true }).fill('3');
  const request = page.waitForRequest(
    (r) => r.url().endsWith('/api/studio/explore') && r.method() === 'POST'
  );
  await page.getByRole('button', { name: '开始发散', exact: true }).click();
  const body = (await request).postDataJSON();
  expect(body.count).toBe(3);
  expect(body.thinking).toBe(true);
  expect(body.stream_progress).toBe(true);
  await expect(page.locator('.explore-dna-card')).toHaveCount(3);
});

test('reasoning-only model shows enforced thinking capability instead of an ineffective off switch',async({page})=>{
  await page.goto('/');await page.getByText('设计台',{exact:true}).first().click();
  await page.getByRole('button',{name:'创意衍生',exact:true}).click();
  await page.getByLabel('发散模型',{exact:true}).selectOption('browser-reasoner');
  await page.getByText('高级设置 · 思考模式、保留条件与费用说明',{exact:true}).click();
  await expect(page.getByLabel('思考模式',{exact:true})).toBeChecked();
  await expect(page.getByLabel('思考模式',{exact:true})).toBeDisabled();
  await expect(page.getByText(/该模型固定使用思考，无法关闭/)).toBeVisible();
});

for (const viewport of [{width:1440,height:900},{width:1280,height:720},{width:720,height:450},{width:390,height:844},{width:375,height:667}]) {
  test(`fixed shell, preserved navigation and draft ${viewport.width}`, async ({page}) => {
    await page.setViewportSize(viewport);
    let calls=0;
    page.on('request', r => { if(r.method()==='POST' && /\/api\/studio\/explore(?:$|\/[^/]+\/render$)/.test(r.url())) calls++; });
    await page.goto('/');
    if(viewport.width <= 768) await page.getByRole('button',{name:'打开侧边栏',exact:true}).click();
    await page.getByText('设计台',{exact:true}).first().click();
    await page.getByRole('button',{name:'创意衍生',exact:true}).click();
    await page.getByLabel('灵感',{exact:true}).fill('完整保留的测试草稿');
    await page.getByLabel('自定义候选数量',{exact:true}).fill('16');
    await page.getByRole('button',{name:'开始发散',exact:true}).click();
    await expect(page.locator('.explore-dna-card')).toHaveCount(16);
    await page.getByRole('button',{name:'清空',exact:true}).click();
    await page.locator('.explore-dna-card').first().click();
    await page.locator('.explore-modal > .modal-body').evaluate(e=>e.scrollTop=e.scrollHeight);
    const close=page.getByRole('button',{name:'关闭创意衍生',exact:true});
    const footer=page.locator('.explore-footer');
    for (const locator of [close, footer]) {
      const rect=await locator.boundingBox(); expect(rect.y).toBeGreaterThanOrEqual(0);expect(rect.y+rect.height).toBeLessThanOrEqual(viewport.height+1);
    }
    expect(await page.locator('.explore-grid').evaluate(e=>getComputedStyle(e).overflowY)).toBe('visible');
    await page.getByRole('button',{name:'上一步',exact:true}).click();
    await expect(page.getByLabel('灵感',{exact:true})).toHaveValue('完整保留的测试草稿');
    await page.getByRole('button',{name:'2 · 筛选方案',exact:true}).click();
    await expect(page.locator('.explore-dna-card.checked')).toHaveCount(1);
    expect(calls).toBe(1);
    await close.click();
    await page.getByRole('button',{name:'创意衍生',exact:true}).click();
    await expect(page.locator('.explore-dna-card')).toHaveCount(16);
    await expect(page.locator('.explore-dna-card.checked')).toHaveCount(1);
    expect(calls).toBe(1);
    await page.screenshot({path:`/tmp/explore-ux-${viewport.width}.png`,animations:"disabled"});
    await page.evaluate(() => document.documentElement.setAttribute('data-theme','black'));
    await page.screenshot({path:`/tmp/explore-ux-${viewport.width}-dark.png`,animations:'disabled'});
    expect(await page.locator('.explore-modal').evaluate(e => getComputedStyle(e).color)).toBe(await page.locator('body').evaluate(e => getComputedStyle(e).color));
    await page.keyboard.press('Escape');
    await expect(page.locator('.explore-modal')).toHaveCount(0);
    await expect(page.getByRole('button',{name:'创意衍生',exact:true})).toBeFocused();
  });
}

test('latest quote wins; image preview does not select for adoption',async({page})=>{
  await page.goto('/');await page.getByText('设计台',{exact:true}).first().click();
  await page.getByRole('button',{name:'创意衍生',exact:true}).click();
  await page.getByRole('button',{name:'开始发散',exact:true}).click();
  await expect(page.locator('.explore-dna-card')).toHaveCount(6);
  await page.getByRole('button',{name:'下一步：渲染设置（6 张）',exact:true}).click();
  await expect(page.getByLabel('图片模型',{exact:true})).not.toHaveValue('');
  await page.route('**/api/studio/explore/*/quote',async route=>{
    const response=await route.fetch();
    const body=await response.json();
    if(route.request().postDataJSON().render_model_id==='browser-image-one') await new Promise(resolve=>setTimeout(resolve,900));
    await route.fulfill({response,json:body});
  });
  await page.getByLabel('图片模型',{exact:true}).selectOption('browser-image-one');
  await page.waitForRequest(r=>r.url().endsWith('/quote') && r.postDataJSON().render_model_id==='browser-image-one');
  await page.getByLabel('图片模型',{exact:true}).selectOption('browser-image-two');
  await expect(page.getByRole('button',{name:'确认费用并生成',exact:true})).toBeEnabled();
  const request=page.waitForRequest(r=>r.url().endsWith('/render'));
  await page.getByRole('button',{name:'确认费用并生成',exact:true}).click();await request;
  await expect(page.locator('.explore-render-card img')).toHaveCount(6);
  const checkbox=page.getByLabel('收取候选1',{exact:true});const selected=await checkbox.isChecked();
  await page.locator('.explore-render-card img').first().click();
  await expect(page.getByRole('dialog',{name:'方案 1 原图',exact:true})).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.explore-modal')).toBeVisible();
  expect(await checkbox.isChecked()).toBe(selected);
});

test('expired quote refreshes price without automatically submitting a paid task',async({page})=>{
  let quotes=0, renders=0;
  page.on('request',r=>{if(r.method()==='POST' && r.url().endsWith('/render')) renders++;});
  await page.route('**/api/studio/explore/*/quote',async route=>{
    const response=await route.fetch();const body=await response.json();quotes++;
    if(quotes===1) body.quote.expires_at=Date.now()+500;
    else {body.quote.unit_price=123;body.quote.total=738;}
    await route.fulfill({response,json:body});
  });
  await page.goto('/');await page.getByText('设计台',{exact:true}).first().click();
  await page.getByRole('button',{name:'创意衍生',exact:true}).click();
  await page.getByRole('button',{name:'开始发散',exact:true}).click();
  await page.getByRole('button',{name:'下一步：渲染设置（6 张）',exact:true}).click();
  await expect(page.locator('.explore-footer')).toContainText('预计 738 积分');
  expect(quotes).toBeGreaterThanOrEqual(2);expect(renders).toBe(0);
  await expect(page.getByRole('button',{name:'确认费用并生成',exact:true})).toBeEnabled();
});

test('closing a streaming expansion keeps its request and recovers completed proposals',async({page})=>{
  await page.route('**/api/studio/explore',async route=>{
    if(route.request().method()!=='POST') return route.continue();
    const response=await route.fetch();await new Promise(resolve=>setTimeout(resolve,600));
    await route.fulfill({response});
  });
  await page.goto('/');await page.getByText('设计台',{exact:true}).first().click();
  await page.getByRole('button',{name:'创意衍生',exact:true}).click();
  const sent=page.waitForRequest(r=>r.method()==='POST' && r.url().endsWith('/api/studio/explore'));
  await page.getByRole('button',{name:'开始发散',exact:true}).click();await sent;
  await page.getByRole('button',{name:'关闭创意衍生',exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>JSON.parse(sessionStorage.getItem('explore-draft-v1:local') || '{}').batchId)).toBeTruthy();
  await page.getByRole('button',{name:'创意衍生',exact:true}).click();
  await expect(page.locator('.explore-dna-card')).toHaveCount(6);
});

test('outdated draft is repaired visibly and invalid count is associated with its input',async({page})=>{
  await page.goto('/');
  await page.evaluate(()=>sessionStorage.setItem('explore-draft-v1:local',JSON.stringify({savedAt:Date.now(),presetId:'removed',expandId:'removed',axes:['removed'],locked:{removed:'旧值'},count:99,intent:'旧草稿'})));
  await page.getByText('设计台',{exact:true}).first().click();
  await page.getByRole('button',{name:'创意衍生',exact:true}).click();
  await expect(page.getByRole('alert')).toContainText('草稿类目已失效');
  await expect(page.getByRole('alert')).toContainText('草稿发散模型已不可用');
  await expect(page.getByLabel('自定义候选数量',{exact:true})).toHaveValue('6');
  await page.getByLabel('自定义候选数量',{exact:true}).fill('17');
  await expect(page.getByLabel('自定义候选数量',{exact:true})).toHaveAttribute('aria-invalid','true');
  await expect(page.locator('#explore-count-help')).toContainText('请输入 1–16 的整数');
});
