import { test, expect } from '@playwright/test';
import sharp from '../../server/node_modules/sharp/lib/index.js';
import { derive, analyze } from './wizard-helpers.js';

for (const width of [1440, 390]) test(`layered plan, missing facts and persisted image design ${width}`, async ({ page, request }) => {
  await page.setViewportSize({ width, height: 1000 });
  const name = `分层方案验收${width}`;
  const preset = (await (await request.get('/api/studio/dna-presets')).json()).presets.find(p => p.id === 'suit');
  const source = await sharp({ create: { width: 400, height: 600, channels: 3, background: '#a3c6e8' } }).png().toBuffer();
  const template = await (await request.post('/api/studio/templates', { data: {
    name, preset_id: 'suit',
    dna_json: Object.fromEntries(preset.fields.map(f => [f.key, { value: f.key === 'details' ? ['贴兜'] : '常规', confidence: 0.8 }])),
    source_image_base64: source.toString('base64'),
  } })).json();
  const open = async () => {
    await page.goto('/');
    if (width < 769) await page.getByRole('button', { name: '打开侧边栏', exact: true }).click();
    await page.getByRole('button', { name: '设计台', exact: true }).first().click();
    await page.locator('.studio-card').filter({ hasText: name }).getByRole('button', { name: '款式属性', exact: true }).click();
    await page.locator('.wizard-steps button').first().click();
    await expect(page.getByLabel('设计版本', { exact: true })).not.toHaveValue('');
  };
  const read = async () => {
    const list = await (await request.get(`/api/studio/templates/${template.id}/plans`)).json();
    return (await (await request.get(`/api/studio/templates/${template.id}/plans/${list.plans[0].id}`)).json()).plan;
  };
  await open();
  await derive(page);
  await page.getByRole('button', { name: '选择品牌介绍', exact: true }).click();
  await analyze(page);
  await expect(page.getByRole('region', { name: '方案核对' })).toContainText('共 2 张');
  await expect(page.locator('.wizard-card-blocker')).toContainText('待补充：品牌资料');
  await expect(page.locator('.wizard-card-blocker')).toContainText('本次不会生成此图');
  await expect(page.locator('.wizard-footer .wizard-primary')).toHaveText('确认费用并生成 1 张');
  await expect(page.locator('.wizard-gen-button')).toHaveCount(0);
  expect(await page.locator('.wizard-standard').evaluate(el => !!(el.compareDocumentPosition(document.querySelector('.wizard-plan-card')) & Node.DOCUMENT_POSITION_FOLLOWING))).toBe(true);
  await page.locator('.wizard-plan-title').first().click();
  await page.getByText('查看九维分析参考', { exact: true }).click();
  await expect(page.locator('.wizard-design-reference dt')).toHaveCount(9);
  await expect(page.locator('.wizard-design-reference')).toContainText('生图以本图两段提示词和整体规范为准');
  const description = page.getByLabel('图片1主要描述', { exact: true });
  await description.fill('图1为商品，模特正面自然站立，完整展示服装，无新增文字。');
  await description.blur();
  await expect.poll(async () => (await read()).content.items[0].description_prompt).toBe('图1为商品，模特正面自然站立，完整展示服装，无新增文字。');
  await page.getByText('查看实际执行提示词', { exact: true }).click();
  const saved = await read();
  await expect(page.locator('.wizard-execution-layers pre')).toHaveText(saved.content.items[0].prompt);
  await expect(page.locator('.wizard-execution-layers')).not.toContainText('系统执行规则');
  await expect(page.locator('.wizard-footer .wizard-primary')).toBeEnabled();
  await page.screenshot({ path: `/tmp/style-prompt-architecture-${width}.png` });
  await page.getByLabel('关闭款式详情').click();
  await open();
  await page.locator('.wizard-steps button').nth(2).click();
  if (width < 700) await page.getByRole('button', { name: '预览', exact: true }).click();
  await page.locator('.wizard-plan-title').first().click();
  await expect(description).toHaveValue('图1为商品，模特正面自然站立，完整展示服装，无新增文字。');
  expect(await page.locator('.style-wizard').evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  await page.getByRole('button', { name: '补充资料', exact: true }).click();
  await expect(page.locator('.wizard-steps button').nth(1)).toHaveAttribute('aria-current', 'step');
  await expect(page.getByLabel('品牌资料', { exact: true })).toBeVisible();
});
