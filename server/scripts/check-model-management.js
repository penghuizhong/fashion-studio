// Isolated HTTP regressions; no real supplier requests or production database.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-management-'));
process.env.DATA_DIR = dir;
process.env.MULTI_USER = 'true';
process.env.MOCK_LLM = 'true';
process.env.MASTER_KEY = crypto.randomBytes(32).toString('hex');
process.env.SESSION_SECRET = crypto.randomBytes(32).toString('hex');
process.env.WRITE_LIMIT_MAX = '2000';
const { getDb, closeDb, setSetting, getSetting } = await import('../src/db.js');
const { createApp } = await import('../src/app.js');
const { getModel, getProviderCreds, getDefaultProvider, listModels, listImageModelsCompat, deleteModel } = await import('../src/registry.js');
const { listPointsModels } = await import('../src/points.js');
const { testRegisteredModel } = await import('../src/modelTests.js');
const db = getDb(), now = new Date().toISOString();
for (const id of ['admin', 'member']) {
  db.prepare('INSERT INTO users(id,username,password_hash,created_at,is_admin) VALUES(?,?,?,?,?)').run(id, id, 'unused', now, id === 'admin' ? 1 : 0);
  db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(crypto.createHash('sha256').update(id).digest('hex'), id, Date.now() + 600000);
}
const server = await new Promise(resolve => { const s = createApp().listen(0, '127.0.0.1', () => resolve(s)); });
const base = `http://127.0.0.1:${server.address().port}`;
async function req(method, url, body, status = 200, user = 'admin') {
  const r = await fetch(base + url, { method, headers: { Cookie: `soulchat_session=${user}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const j = await r.json(); assert.equal(r.status, status, JSON.stringify(j)); return j;
}
const provider = async (name, patch = {}) => (await req('POST', '/api/admin/providers', { name, preset: 'custom', kind: 'both', base_url: 'https://supplier.invalid/v1', api_key: 'fixture-key', ...patch })).provider;
const model = async (p, name, patch = {}) => (await req('POST', '/api/admin/models', { provider_id: p.id, kind: 'chat', model_id: name, pricing: { input_per_1m: 10, output_per_1m: 20 }, ...patch })).model;
let n = 0;
async function test(name, run) { await run(); console.log(`PASS ${++n}. ${name}`); }
try {
  const p = await provider('Lifecycle');
  let old, replacement;
  await test('deleted model disappears from admin/public lists; same upstream ID gets a new registration', async () => {
    old = await model(p, 'same-model');
    await req('DELETE', `/api/admin/models/${old.id}`);
    assert.equal(getModel(old.id), null);
    assert.ok(!(await req('GET', '/api/admin/models')).models.some(m => m.id === old.id));
    assert.ok(!listPointsModels().some(m => m.id === 'same-model'));
    replacement = await model(p, 'same-model'); assert.notEqual(replacement.id, old.id);
    assert.ok(db.prepare('SELECT deleted_at FROM models WHERE id=?').get(old.id).deleted_at);
  });
  await test('image deletion and same-name re-registration preserve pricing history and public registry identity', async () => {
    const m = await model(p, 'same-image', { kind: 'image', pricing: { per_call: 9 }, extra: { sizes: ['1024x1024'], image_config: { protocol: 'openai_images', text: true, edit: true, max_images: 2 } } });
    const previous = db.prepare('SELECT pricing_json,extra_json FROM models WHERE id=?').get(m.id);
    assert.ok((await req('GET', '/api/studio/image-models')).models.some(row => row.id === m.id));
    await req('DELETE', `/api/admin/models/${m.id}`);
    const fresh = await model(p, 'same-image', { kind: 'image', pricing: { per_call: 3 }, extra: { sizes: ['1024x1024'] } });
    assert.notEqual(fresh.id, m.id);
    const publicModels = (await req('GET', '/api/studio/image-models')).models;
    assert.ok(!publicModels.some(row => row.id === m.id)); assert.ok(publicModels.some(row => row.id === fresh.id));
    assert.deepEqual(db.prepare('SELECT pricing_json,extra_json FROM models WHERE id=?').get(m.id), previous);
  });
  await test('deleted IDs cannot be edited, activated, tested or previewed; deletion is idempotent', async () => {
    await req('PUT', `/api/admin/models/${old.id}`, { is_active: true }, 404);
    await req('POST', '/api/admin/models/test', { id: old.id, task: 'chat', confirm: true }, 404);
    await req('GET', `/api/admin/models/${old.id}/test-preview?task=text`, undefined, 404);
    await req('DELETE', `/api/admin/models/${old.id}`);
    await req('DELETE', '/api/admin/models/unknown-record', undefined, 404);
    assert.equal(getModel(replacement.id).is_active, true);
  });
  await test('downlisting is reversible, reserves name and gives an actionable conflict', async () => {
    await req('PUT', `/api/admin/models/${replacement.id}`, { is_active: false });
    const conflict = await req('POST', '/api/admin/models', { provider_id: p.id, kind: 'chat', model_id: 'same-model' }, 409);
    assert.match(conflict.error, /已下架/);
    assert.ok((await req('GET', '/api/admin/models')).models.some(m => m.id === replacement.id));
    await req('PUT', `/api/admin/models/${replacement.id}`, { is_active: true });
  });
  await test('editing name or provider cannot create duplicates, failed edit is atomic', async () => {
    const other = await model(p, 'other-name');
    await req('PUT', `/api/admin/models/${other.id}`, { model_id: ' same-model ', name: 'should-not-change' }, 409);
    assert.equal(getModel(other.id).model_id, 'other-name'); assert.equal(getModel(other.id).name, 'other-name');
    const p2 = await provider('Other'); const m2 = await model(p2, 'same-model');
    await req('PUT', `/api/admin/models/${m2.id}`, { provider_id: p.id }, 409);
    assert.equal(getModel(m2.id).provider_id, p2.id);
    await req('PUT', `/api/admin/models/${other.id}`, { kind: 'image' }, 400);
    await req('DELETE', `/api/admin/models/${m2.id}`);
  });
  await test('disabled provider removes chat/image models from every public registry; enable restores them', async () => {
    const image = await model(p, 'image-model', { kind: 'image', pricing: { per_call: 5 }, extra: { sizes: ['1024x1024'] } });
    await req('PUT', `/api/admin/providers/${p.id}`, { is_active: false });
    assert.ok(!listPointsModels().some(m => m.id === 'same-model'));
    assert.ok(!listModels().some(m => m.provider_id === p.id));
    assert.ok(!listImageModelsCompat().some(m => m.id === image.id));
    assert.equal(getModel(image.id).provider_active, false);
    assert.equal(getModel(image.id).is_active, true);
    await req('POST', '/api/admin/models', { provider_id: p.id, kind: 'chat', model_id: 'disabled-new' }, 400);
    await req('PUT', `/api/admin/models/${image.id}`, { is_active: true }, 400);
    await req('POST', `/api/admin/providers/${p.id}/default`, {}, 400);
    await req('PUT', `/api/admin/providers/${p.id}`, { is_active: true });
    assert.ok(listImageModelsCompat().some(m => m.id === image.id));
  });
  await test('provider type and default validation prevents incompatible routing and partial saves', async () => {
    const imageProvider = await provider('Image only', { kind: 'image' });
    await req('POST', '/api/admin/models', { provider_id: imageProvider.id, kind: 'chat', model_id: 'wrong-kind' }, 400);
    await req('POST', `/api/admin/providers/${imageProvider.id}/default`, {}, 400);
    await req('PUT', `/api/admin/providers/${p.id}`, { kind: 'image' }, 400);
    assert.equal((await req('GET', '/api/admin/providers')).providers.find(row => row.id === p.id).kind, 'both');
    await req('PUT', `/api/admin/providers/${imageProvider.id}`, { name: 'not-saved', is_default: true }, 400);
    assert.equal((await req('GET', '/api/admin/providers')).providers.find(row => row.id === imageProvider.id).name, 'Image only');
    const inactive = await provider('Disabled at creation', { is_active: false }); assert.equal(inactive.is_active, 0);
  });
  await test('same upstream name on another provider keeps defaults until the last usable registration is deleted', async () => {
    const a = await provider('Default A'), b = await provider('Default B');
    const ma = await model(a, 'shared-name'), mb = await model(b, 'shared-name');
    setSetting('worker_model', 'shared-name'); setSetting('chat_default_model', 'shared-name'); setSetting('filter_fallback_models', JSON.stringify(['shared-name']));
    await req('DELETE', `/api/admin/models/${ma.id}`);
    assert.equal(getSetting('worker_model'), 'shared-name');
    await req('DELETE', `/api/admin/models/${mb.id}`);
    assert.equal(getSetting('worker_model'), ''); assert.equal(getSetting('chat_default_model'), ''); assert.equal(getSetting('filter_fallback_models'), '[]');
    await model(a, 'shared-name'); assert.equal(getSetting('worker_model'), '');
  });
  await test('provider deletion hides provider and all models, removes credentials/default and preserves history', async () => {
    const retired = await provider('Retired'); const m = await model(retired, 'history-model');
    await req('POST', `/api/admin/providers/${retired.id}/default`, {});
    const before = db.prepare('SELECT COUNT(*) n FROM models').get().n;
    const file = 'uploads/studio/history-original.png';
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWZkAAAAASUVORK5CYII=', 'base64');
    fs.writeFileSync(path.join(dir, file), bytes);
    const template = db.prepare("INSERT INTO style_dna_templates(user_id,name,created_at,updated_at) VALUES('member','History',?,?)").run(now, now).lastInsertRowid;
    const generation = db.prepare("INSERT INTO dna_generations(template_id,user_id,image_path,model_id,created_at) VALUES(?,'member',?,?,?)").run(template, file, m.id, now).lastInsertRowid;
    const batch = db.prepare("INSERT INTO exploration_batches(user_id,render_model_id,renders_json,created_at,updated_at) VALUES('member',?,?,?,?)").run(m.id, JSON.stringify([{ image_path: file, model_id: m.id }]), now, now).lastInsertRowid;
    const beforeGeneration = db.prepare('SELECT * FROM dna_generations WHERE id=?').get(generation);
    const beforeBatch = db.prepare('SELECT * FROM exploration_batches WHERE id=?').get(batch);
    db.prepare("INSERT INTO points_ledger(user_id,delta,accounting_delta,balance_after,reason,ref_type,ref_id,created_at) VALUES('member',-5,-5,95,'image_generate','model',?,?)").run(m.id, now);
    const ledger = db.prepare("SELECT * FROM points_ledger WHERE ref_id=?").get(m.id);
    const result = await req('DELETE', `/api/admin/providers/${retired.id}`); assert.equal(result.deletedModels, 1);
    assert.ok(!(await req('GET', '/api/admin/providers')).providers.some(p => p.id === retired.id));
    assert.ok(!(await req('GET', '/api/admin/models')).models.some(row => row.provider_id === retired.id));
    assert.equal(getProviderCreds(retired.id), null); assert.notEqual(getDefaultProvider()?.id, retired.id);
    assert.equal(db.prepare('SELECT api_key_encrypted FROM providers WHERE id=?').get(retired.id).api_key_encrypted, '');
    assert.equal(getModel(m.id), null); assert.equal(db.prepare('SELECT COUNT(*) n FROM models').get().n, before);
    assert.deepEqual(db.prepare('SELECT * FROM points_ledger WHERE id=?').get(ledger.id), ledger);
    assert.deepEqual(db.prepare('SELECT * FROM dna_generations WHERE id=?').get(generation), beforeGeneration);
    assert.deepEqual(db.prepare('SELECT * FROM exploration_batches WHERE id=?').get(batch), beforeBatch);
    assert.deepEqual(fs.readFileSync(path.join(dir, file)), bytes);
    await req('PUT', `/api/admin/providers/${retired.id}`, { is_active: true }, 404);
    await req('POST', '/api/admin/models', { provider_id: retired.id, kind: 'chat', model_id: 'new' }, 404);
    await req('DELETE', `/api/admin/providers/${retired.id}`);
    assert.notEqual((await provider('Retired')).id, retired.id);
  });
  await test('old downlisted rows can be deleted; neither replacement nor capability history is reused', async () => {
    const legacy = await model(p, 'legacy-off');
    db.prepare('UPDATE models SET is_active=0 WHERE id=?').run(legacy.id);
    db.prepare("INSERT INTO model_capability_checks(model_id,task,signature,status,message,created_at) VALUES(?,'chat','old','passed','old result',?)").run(legacy.id, now);
    await req('DELETE', `/api/admin/models/${legacy.id}`);
    const fresh = await model(p, 'legacy-off'); assert.deepEqual(fresh.checks, []);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM model_capability_checks WHERE model_id=?').get(legacy.id).n, 1);
  });
  await test('deleted preview is inaccessible even if capability history and file still exist', async () => {
    const preview = 'uploads/studio/admin-preview-fixture.png'; fs.mkdirSync(path.dirname(path.join(dir, preview)), { recursive: true }); fs.writeFileSync(path.join(dir, preview), 'fixture');
    db.prepare("INSERT INTO model_capability_checks(model_id,task,signature,status,message,preview_path,created_at) VALUES(?,'text','old','passed','old',?,?)").run(old.id, preview, now);
    await req('GET', `/api/admin/models/${old.id}/test-preview?task=text`, undefined, 404);
    assert.equal(fs.readFileSync(path.join(dir, preview), 'utf8'), 'fixture');
  });
  await test('late capability results cannot revive deleted models', async () => {
    const m = await model(p, 'late-test', { kind: 'image', pricing: { per_call: 0 }, extra: { sizes: ['512x512'], image_config: { protocol: 'openai_images', text: true } } });
    const pending = testRegisteredModel({ body: { id: m.id, task: 'text', confirm: true } });
    // Delete synchronously while Sharp is constructing the fixture, before test persistence.
    deleteModel(m.id);
    await assert.rejects(pending, e => e.code === 'MODEL_NOT_FOUND');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM model_capability_checks WHERE model_id=?').get(m.id).n, 0);
    assert.equal(getModel(m.id), null);
  });
  await test('admin mutation endpoints reject members and unauthenticated callers', async () => {
    for (const user of ['member', 'missing']) {
      const status = user === 'member' ? 403 : 401;
      await req('DELETE', `/api/admin/models/${replacement.id}`, undefined, status, user);
      await req('DELETE', `/api/admin/providers/${p.id}`, undefined, status, user);
      await req('POST', '/api/admin/models', { provider_id: p.id, model_id: 'forbidden' }, status, user);
    }
    assert.ok(getModel(replacement.id));
  });
  await test('old database migration is additive and repeatable; no inference that inactive means deleted', async () => {
    // Simulate a pre-fix database copy; never downgrade or mutate the live fixture.
    // Complete the unrelated signup-ledger migration before taking the baseline.
    for (const user of ['admin', 'member']) db.prepare("INSERT INTO points_ledger(user_id,delta,accounting_delta,balance_after,reason,created_at) VALUES(?,500,500,500,'signup_bonus',?)").run(user, now);
    const copy = path.join(dir, 'legacy-copy.db'); await db.backup(copy);
    const legacy = new Database(copy);
    legacy.exec('DROP INDEX idx_models_registry_name; ALTER TABLE models DROP COLUMN deleted_at; ALTER TABLE providers DROP COLUMN deleted_at;');
    const modelsBefore = legacy.prepare('SELECT id,model_id,is_active FROM models ORDER BY id').all();
    const ledgerBefore = legacy.prepare('SELECT * FROM points_ledger ORDER BY id').all(); legacy.close();
    closeDb(); fs.copyFileSync(copy, path.join(dir, 'fashion-studio.db'));
    let migrated = getDb();
    assert.deepEqual(migrated.prepare('SELECT id,model_id,is_active FROM models ORDER BY id').all(), modelsBefore);
    assert.deepEqual(migrated.prepare('SELECT * FROM points_ledger ORDER BY id').all(), ledgerBefore);
    assert.equal(migrated.prepare('SELECT COUNT(*) n FROM models WHERE deleted_at IS NOT NULL').get().n, 0);
    closeDb(); migrated = getDb();
    assert.deepEqual(migrated.prepare('SELECT id,model_id,is_active FROM models ORDER BY id').all(), modelsBefore);
    assert.equal(migrated.prepare('PRAGMA table_info(models)').all().filter(c => c.name === 'deleted_at').length, 1);
  });
  console.log(`Model management: ${n}/${n} passed`);
} finally {
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); closeDb(); fs.rmSync(dir, { recursive: true, force: true });
}
