import { test, expect } from '@playwright/test';
import sharp from '../../server/node_modules/sharp/lib/index.js';
import { derive, analyze, render } from './wizard-helpers.js';

async function setup(page, request, name, source = true) {
  const preset = (await (await request.get('/api/studio/dna-presets')).json()).presets.find(p => p.id === 'suit');
  const garment = await sharp({ create: { width: 320, height: 480, channels: 3, background: '#a3c6e8' } }).png().toBuffer();
  const model = await sharp({ create: { width: 240, height: 360, channels: 3, background: '#cc7744' } }).png().toBuffer();
  const template = await (await request.post('/api/studio/templates', { data: {
    name, preset_id: 'suit',
    dna_json: Object.fromEntries(preset.fields.map(f => [f.key, { value: f.key === 'details' ? ['贴兜'] : '常规', confidence: .8 }])),
    ...(source ? { source_image_base64: garment.toString('base64') } : {}),
  } })).json();
  await page.goto('/');
  if (page.viewportSize().width < 769) await page.getByRole('button', { name: '打开侧边栏', exact: true }).click();
  await page.getByRole('button', { name: '设计台', exact: true }).first().click();
  await page.locator('.studio-card').filter({ hasText: name }).getByRole('button', { name: '款式属性', exact: true }).click();
  await page.locator('.wizard-steps button').first().click();
  await derive(page);
  const read = async () => {
    const list = await (await request.get(`/api/studio/templates/${template.id}/plans`)).json();
    return await (await request.get(`/api/studio/templates/${template.id}/plans/${list.plans[0].id}`)).json();
  };
  return { template, garment, model, read };
}

for (const width of [1440, 390]) test(`adding model after garment-only analysis updates step 3 and sends both images ${width}`, async ({ page, request }) => {
  await page.setViewportSize({ width, height: 1000 });
  const { template, model, read } = await setup(page, request, `模特补传${width}`);
  await analyze(page);
  expect((await read()).plan.content.standard.subject).toContain('未提供独立模特参考图');
  await page.locator('.wizard-steps button').nth(1).click();
  if (width < 700) await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByLabel('上传模特图', { exact: true }).setInputFiles({ name: 'model.png', mimeType: 'image/png', buffer: model });
  await expect.poll(async () => (await read()).plan.input.references.map(ref => ref.role)).toEqual(['garment', 'model']);
  await analyze(page);
  const data = await read();
  expect(data.plan.content.items[0].reference_ids).toEqual(data.plan.input.references.map(ref => ref.id));
  expect(data.analyses[0].request_trace.image_count).toBe(2);
  expect(data.analyses[0].request_trace.source_manifest.map(ref => ref.role)).toEqual(['garment', 'model']);
  await page.locator('.wizard-plan-title').first().click();
  await page.getByText('查看实际执行提示词', { exact: true }).click();
  await expect(page.locator('.wizard-execution-layers pre')).toContainText('已提供图2模特参考图');
  await expect(page.locator('.wizard-execution-layers pre')).not.toContainText('未提供独立模特参考图');
  await expect(page.locator('.wizard-request-summary')).toContainText(/模特图\s*1\s*张/);
  await render(page);
  const workspace = await (await request.get(`/api/studio/templates/${template.id}/workspace`)).json();
  const job = (await (await request.get(`/api/studio/templates/${template.id}/jobs/${workspace.jobs[0].id}`)).json()).job;
  expect(job.renders[0].request_trace.image_count).toBe(2);
  expect(job.renders[0].request_trace.source_manifest.map(ref => ref.role)).toEqual(['garment', 'model']);
});

test('concurrent garment and model uploads retain both boards after delayed callbacks', async ({ page, request }) => {
  const { garment, model, read } = await setup(page, request, '双图并发上传', false);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let uploaded = 0;
  await page.route('**/api/studio/references', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    const response = await route.fetch();
    uploaded++;
    if (uploaded === 2) release();
    await gate;
    await route.fulfill({ response });
  });
  await page.getByLabel('上传商品图', { exact: true }).setInputFiles({ name: 'garment.png', mimeType: 'image/png', buffer: garment });
  await page.getByLabel('上传模特图', { exact: true }).setInputFiles({ name: 'model.png', mimeType: 'image/png', buffer: model });
  await expect(page.locator('.reference-strip article')).toHaveCount(2);
  await analyze(page);
  expect((await read()).plan.input.references.map(ref => ref.role)).toEqual(['garment', 'model']);
  expect((await read()).analyses[0].request_trace.image_count).toBe(2);
});
