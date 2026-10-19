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
  await page.getByLabel('图片尺寸', { exact: true }).selectOption('512x512');
  const quoteRequest = page.waitForRequest((r) => r.url().endsWith('/quote'));
  await page.getByRole('button', { name: '获取报价', exact: true }).click();
  const q = (await quoteRequest).postDataJSON();
  expect(q.indexes).toEqual([0, 2]);
  expect(q.render_model_id).toBe('browser-image-two');
  expect(q.render_size).toBe('512x512');
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
  await page.getByRole('button', { name: '历史批次', exact: true }).click();
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
  await expect(page.locator('.explore-modal')).toHaveCount(0);
  const card=page.locator('.studio-card').first();
  await expect(card).toBeVisible();
  expect(await card.locator('.studio-card-cover').evaluate(e=>getComputedStyle(e).aspectRatio)).toBe('1 / 1');
  expect(await card.locator('img').evaluate(e=>getComputedStyle(e).objectFit)).toBe('contain');
  await card.click();
  const viewer=page.getByRole('dialog',{name:/原图/});await expect(viewer).toBeVisible();
  const originalSrc=await viewer.locator('img').getAttribute('src');expect(originalSrc).not.toContain('/thumbs/');
  await page.getByRole('button',{name:'实际尺寸',exact:true}).click();await expect(viewer.locator('.actual-size')).toBeVisible();
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
  await page.getByText('必须保留的字段（可选）', { exact: true }).click();
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
  await page.getByRole('button', { name: '历史批次', exact: true }).click();
  await page
    .locator('.explore-batch-row')
    .filter({ hasText: '历史连衣裙' })
    .click();
  await expect(page.locator('.explore-dna-card').first()).toContainText('领口');
  await page.getByRole('button', { name: '新建发散', exact: true }).click();
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
  await expect(page.getByLabel('思考模式',{exact:true})).toBeChecked();
  await expect(page.getByLabel('思考模式',{exact:true})).toBeDisabled();
  await expect(page.getByText(/该模型固定使用思考，无法关闭/)).toBeVisible();
});
