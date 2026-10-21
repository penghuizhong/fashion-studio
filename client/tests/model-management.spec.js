import { test, expect } from '@playwright/test';
const provider = (id, patch = {}) => ({ id, name: id, preset: 'custom', kind: 'both', is_active: true, has_key: true, ...patch });
const model = (id, p, patch = {}) => ({ id, provider_id: p.id, provider_name: p.name, provider_preset: p.preset, provider_active: p.is_active, kind: 'image', model_id: 'test-image', name: '删除回归图片模型', is_active: true, pricing: { per_call: 5 }, extra: { sizes: ['1024x1024'], image_config: { protocol: 'openai_images', text: true, edit: true, max_images: 4 } }, checks: [], ...patch });
async function setup(page, width) {
  const p = provider('main-provider');
  const state = { providers: [p, provider('dash-provider', { preset: 'dashscope' }), provider('chat-only', { kind: 'llm' }), provider('inactive', { is_active: false })], models: [model('old-model', p)], mutations: [] };
  await page.setViewportSize({ width, height: 900 });
  await page.route('**/api/config', async route => { const r = await route.fetch(); await route.fulfill({ json: { ...await r.json(), multi_user: true } }); });
  await page.route('**/api/auth/me', r => r.fulfill({ json: { user: { id: 'admin-fixture', username: '管理员', is_admin: true } } }));
  await page.route('**/api/points', r => r.fulfill({ json: { balance: 1000, is_admin: true, billing_mode: 'points', models: [] } }));
  await page.route('**/api/user/api-key', r => r.fulfill({ json: { hasKey: false } }));
  await page.route('**/api/points/ledger?*', r => r.fulfill({ json: [] }));
  await page.route('**/api/admin/explore-recovery', r => r.fulfill({ json: { items: [] } }));
  await page.route('**/api/admin/settings', r => r.fulfill({ json: { worker_model: '', chat_default_model: '', filter_fallback_models: [] } }));
  await page.route('**/api/admin/providers', r => r.fulfill({ json: { providers: state.providers } }));
  await page.route('**/api/admin/providers/*/models', r => r.fulfill({ json: { models: [{ id: 'upstream-option', name: '上游选项' }] } }));
  await page.route('**/api/admin/providers/*', async route => {
    const id = new URL(route.request().url()).pathname.split('/').pop();
    if (route.request().method() !== 'DELETE') return route.fallback();
    state.providers = state.providers.filter(p => p.id !== id);
    const before = state.models.length; state.models = state.models.filter(m => m.provider_id !== id);
    await route.fulfill({ json: { ok: true, deletedModels: before - state.models.length } });
  });
  await page.route('**/api/admin/models', async route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: { models: state.models } });
    const body = route.request().postDataJSON(); state.mutations.push(body);
    const p = state.providers.find(p => p.id === body.provider_id), m = model('new-model', p, body);
    state.models.push(m); await route.fulfill({ json: { ok: true, model: m } });
  });
  await page.route('**/api/admin/models/*', async route => {
    const id = new URL(route.request().url()).pathname.split('/').pop(), method = route.request().method();
    if (method === 'DELETE') {
      if (state.holdDelete) await new Promise(resolve => state.releaseDelete = resolve);
      state.models = state.models.filter(m => m.id !== id);
    } else if (method === 'PUT') {
      const body = route.request().postDataJSON(); state.mutations.push(body);
      state.models = state.models.map(m => m.id === id ? { ...m, ...body } : m);
    } else return route.fallback();
    await route.fulfill({ json: { ok: true } });
  });
  await page.goto('/');
  if (width < 769) await page.getByRole('button', { name: '打开侧边栏', exact: true }).first().click();
  await page.getByTitle('账户', { exact: true }).click();
  await page.getByRole('button', { name: 'API 设置', exact: true }).click();
  await page.getByRole('button', { name: '模型管理', exact: true }).click();
  await expect(page.locator('.pm-row').filter({ hasText: '删除回归图片模型' })).toBeVisible(); return state;
}
for (const width of [1440, 390]) {
  test(`delete removes row/editor, prevents repeat submit and allows same name recreation ${width}`, async ({ page }) => {
    const state = await setup(page, width), row = page.locator('.pm-row').filter({ hasText: '删除回归图片模型' });
    await expect(row).toContainText('未验证（人工声明）');
    await row.getByRole('button', { name: '下架', exact: true }).click();
    await expect(row).toContainText('已下架'); await expect(row.getByRole('button', { name: '上架', exact: true })).toBeEnabled();
    await row.getByRole('button', { name: '编辑', exact: true }).click();
    await expect(page.getByLabel('每张图片积分')).toHaveValue('5'); state.holdDelete = true;
    page.once('dialog', async d => { expect(d.message()).toContain('可重新添加同 ID'); await d.accept(); });
    await row.getByRole('button', { name: '删除', exact: true }).click();
    await expect(row.getByRole('button', { name: '删除', exact: true })).toBeDisabled(); await expect(row.getByRole('button', { name: '处理中…' })).toBeVisible();
    await expect.poll(() => typeof state.releaseDelete).toBe('function'); state.releaseDelete();
    await expect(row).toHaveCount(0); await expect(page.getByLabel('每张图片积分')).toHaveCount(0);
    await page.getByRole('button', { name: '上架图片模型', exact: true }).click();
    await page.locator('.model-picker input').fill('test-image');
    await page.getByPlaceholder('显示名（留空则用模型 ID）', { exact: true }).fill('重新添加的图片模型'); await page.getByLabel('每张图片积分').fill('7');
    await page.locator('.pm-edit').getByRole('button', { name: '保存', exact: true }).click();
    await expect(page.locator('.pm-row').filter({ hasText: '重新添加的图片模型' })).toContainText('7 积分/张');
    expect(state.models[0].id).toBe('new-model'); expect(state.models[0].model_id).toBe('test-image'); expect(state.models[0].provider_id).toBe('main-provider');
    expect(await page.locator('.settings-body').evaluate(el => el.scrollWidth > el.clientWidth + 1)).toBe(false);
    await page.screenshot({ path: `/tmp/model-management-${width}.png`, animations: 'disabled' });
  });
  test(`provider deletion closes dependent editor; cancel preserves data ${width}`, async ({ page }) => {
    const state = await setup(page, width);
    await page.locator('.pm-row').filter({ hasText: '删除回归图片模型' }).getByRole('button', { name: '编辑', exact: true }).click();
    const pRow = page.locator('.pm-row').filter({ has: page.locator('b', { hasText: /^main-provider$/ }) });
    page.once('dialog', d => d.dismiss()); await pRow.getByRole('button', { name: '删除', exact: true }).click();
    await expect(pRow).toBeVisible(); await expect(page.getByLabel('每张图片积分')).toBeVisible();
    page.once('dialog', d => d.accept()); await pRow.getByRole('button', { name: '删除', exact: true }).click();
    await expect(pRow).toHaveCount(0); await expect(page.locator('.pm-edit')).toHaveCount(0); expect(state.models).toHaveLength(0);
  });
}
test('protocol follows new provider, editing refreshes cache, chat choices deduplicate and exclude unavailable providers', async ({ page }) => {
  const state = await setup(page, 1440), p = state.providers[0];
  state.models.push(model('chat-a', p, { kind: 'chat', model_id: 'same-chat', name: '聊天甲', pricing: { input_per_1m: 1, output_per_1m: 2 } }), model('chat-b', state.providers[1], { kind: 'chat', model_id: 'same-chat', name: '聊天乙', pricing: { input_per_1m: 1, output_per_1m: 2 } }), model('chat-off', p, { kind: 'chat', name: '停用聊天', provider_active: false, model_id: 'unavailable-chat' }));
  await page.locator('.pm-row').filter({ hasText: '删除回归图片模型' }).getByRole('button', { name: '下架', exact: true }).click();
  const worker = page.getByRole('combobox', { name: '后台模型', exact: true });
  await expect(worker.getByRole('option', { name: 'same-chat', exact: true })).toHaveCount(1); await expect(worker.getByRole('option', { name: 'unavailable-chat', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '上架图片模型', exact: true }).click(); const select = page.getByLabel('模型供应商');
  await expect(select.locator('option[value="chat-only"]')).toHaveCount(0); await expect(select.locator('option[value="inactive"]')).toHaveCount(0);
  await select.selectOption('dash-provider'); await expect(page.getByLabel('图片调用协议')).toHaveValue('dashscope');
  await select.selectOption('main-provider'); await expect(page.getByLabel('图片调用协议')).toHaveValue('openai_images');
  await page.locator('.model-picker input').focus();
  await expect(page.locator('.model-dropdown')).toBeVisible();
  const cache = page.waitForRequest('**/api/admin/providers/main-provider/models');
  await page.locator('.pm-row').filter({ hasText: '删除回归图片模型' }).getByRole('button', { name: '编辑', exact: true }).click(); await cache;
  await expect(select).toHaveValue('main-provider');
  await expect(page.locator('.model-picker input')).toBeDisabled();
  await expect(page.locator('.model-dropdown')).toHaveCount(0);
});
test('failed deletion keeps the model and editing draft', async ({ page }) => {
  await setup(page, 1440);
  await page.route('**/api/admin/models/old-model', r => r.fulfill({ status: 409, json: { error: '删除暂时失败，请重试' } }));
  const row = page.locator('.pm-row').filter({ hasText: '删除回归图片模型' });
  await row.getByRole('button', { name: '编辑', exact: true }).click(); await page.getByLabel('每张图片积分').fill('9');
  page.once('dialog', d => d.accept()); await row.getByRole('button', { name: '删除', exact: true }).click();
  await expect(page.getByText('删除暂时失败，请重试', { exact: true })).toBeVisible();
  await expect(row.getByRole('button', { name: '删除', exact: true })).toBeEnabled(); await expect(page.getByLabel('每张图片积分')).toHaveValue('9');
});

test('late model cache from previous provider cannot overwrite current suggestions', async ({ page }) => {
  await setup(page, 1440);
  let release, releaseCurrent;
  const currentGate = new Promise(resolve => releaseCurrent = resolve);
  const gate = new Promise(resolve => release = resolve);
  await page.route('**/api/admin/providers/main-provider/models', async route => { await gate; await route.fulfill({ json: { models: [{ id: 'old-provider-only' }] } }); });
  await page.route('**/api/admin/providers/dash-provider/models', async route => { await currentGate; await route.fulfill({ json: { models: [{ id: 'current-provider-only' }] } }); });
  const first = page.waitForRequest('**/api/admin/providers/main-provider/models');
  await page.getByRole('button', { name: '上架图片模型', exact: true }).click(); await first;
  await page.getByLabel('模型供应商').selectOption('dash-provider');
  await page.locator('.model-picker input').focus(); releaseCurrent(); await expect(page.locator('.model-dropdown')).toContainText('current-provider-only');
  const response = page.waitForResponse('**/api/admin/providers/main-provider/models'); release(); await (await response).finished();
  await expect(page.locator('.model-dropdown')).toContainText('current-provider-only'); await expect(page.locator('.model-dropdown')).not.toContainText('old-provider-only');
});
