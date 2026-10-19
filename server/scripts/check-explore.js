// Integration tests exercise real model adapters, quoting, SQLite accounting and HTTP auth.
// Upstream HTTP alone is replaced with a deterministic provider; MOCK_LLM is disabled.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
process.env.DATA_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), 'fashion-explore-')
);
process.env.MASTER_KEY = crypto.randomBytes(32).toString('hex');
process.env.MULTI_USER = 'true';
process.env.MOCK_LLM = 'false';
process.env.AUTH_LIMIT_MAX = '100';
process.env.WRITE_LIMIT_MAX = '10000';
const { createApp } = await import('../src/app.js');
const { getDb, setSetting } = await import('../src/db.js');
const { encryptSecret } = await import('../src/secrets.js');
const { getBalance, addLedger } = await import('../src/points.js');
const { expandIntent, validateProposals } = await import('../src/explore.js');
const { resolveExploreModel } = await import('../src/exploreModels.js');
const { getPreset, listPresets } = await import('../src/dnaPresets.js');
const { recoverExploreJobs, waitJob } = await import('../src/exploreJobs.js');
const sharp = (await import('sharp')).default;
const png = (
  await sharp({
    create: { width: 8, height: 8, channels: 3, background: '#123456' },
  })
    .png()
    .toBuffer()
).toString('base64');
const db = getDb(),
  realFetch = global.fetch;
let imageCalls = 0,
  textCalls = 0,
  active = 0,
  maxActive = 0,
  mode = 'success',
  textMode = 'success',
  lastRoute = '',
  lastModel = '',
  repairCalls = 0;
global.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (!u.includes('fixture.invalid')) return realFetch(url, opts);
  const b = JSON.parse(opts.body);
  lastRoute = new URL(u).hostname;
  lastModel = b.model;
  assert.equal(
    opts.headers.Authorization,
    `Bearer ${lastRoute === 'personal.fixture.invalid' ? 'personal-fixture' : `fixture-${lastRoute.split('.')[0]}`}`
  );
  if (u.endsWith('/chat/completions')) {
    textCalls++;
    if (textMode === 'timeout')
      throw new DOMException('timed out', 'TimeoutError');
    if (textMode === 'auth') return new Response('{}', { status: 401 });
    const msg = b.messages[1].content;
    const n = Number(msg.match(/数量：(\d+)/)?.[1] || 2);
    const preset = getPreset('suit');
    const proposals = Array.from({ length: n }, (_, i) => ({
      dna: Object.fromEntries(
        preset.fields.map((f) => [
          f.key,
          {
            value:
              f.key === 'details'
                ? ['贴兜']
                : f.key === 'fabric'
                  ? `面料${i}`
                  : '常规',
            confidence: 0.9,
          },
        ])
      ),
      rationale: '测试',
    }));
    if (
      textMode === 'malformed' ||
      (textMode === 'repair' && repairCalls++ === 0)
    )
      delete proposals[0].dna.lapel;
    return Response.json({
      choices: [{ message: { content: JSON.stringify({ proposals }) } }],
      usage: { prompt_tokens: 120, completion_tokens: 200 },
    });
  }
  imageCalls++;
  const callNumber = imageCalls;
  active++;
  maxActive = Math.max(maxActive, active);
  const captured = mode;
  await new Promise((r) => setTimeout(r, 60));
  active--;
  if (captured === 'timeout')
    throw new DOMException('timed out', 'TimeoutError');
  if (captured === 'auth') return new Response('{}', { status: 401 });
  if (captured === 'partial' && callNumber % 2 === 0)
    return new Response('{}', { status: 429 });
  if (captured === 'disk')
    return Response.json({ data: [{ b64_json: 'not-an-image' }] });
  return Response.json({ data: [{ b64_json: png }] });
};
const server = createApp().listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;
const req = async (method, url, body, cookie = '') => {
  const res = await realFetch(base + url, {
    method,
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return {
    status: res.status,
    json: await res.json(),
    cookie: res.headers
      .getSetCookie()
      .map((c) => c.split(';')[0])
      .join(';'),
  };
};
let passed = 0;
const test = async (name, fn) => {
  await fn();
  passed++;
  console.log(`PASS ${passed}. ${name}`);
};
const now = new Date().toISOString();
for (const id of ['a', 'b']) {
  db.prepare(
    'INSERT INTO providers(id,name,preset,kind,base_url,api_key_encrypted,is_default,is_active,created_at) VALUES(?,?,?,?,?,?,?,?,?)'
  ).run(
    id,
    id,
    'custom',
    'both',
    `https://${id}.fixture.invalid`,
    encryptSecret(process.env.MASTER_KEY, `fixture-${id}`),
    0,
    1,
    now
  );
  for (const kind of ['chat', 'image'])
    db.prepare(
      'INSERT INTO models(id,provider_id,kind,model_id,name,pricing_json,extra_json,is_active,created_at) VALUES(?,?,?,?,?,?,?,?,?)'
    ).run(
      id + kind,
      id,
      kind,
      `${id}/${kind}`,
      id + kind,
      JSON.stringify(
        kind === 'chat'
          ? { input_per_1m: 1000, output_per_1m: 2000 }
          : { per_call: 5 }
      ),
      JSON.stringify({ sizes: ['512x512', '1024x1024'] }),
      1,
      now
    );
}
let cookie, other, uid;
const create = async (extra = {}) => {
  const r = await req(
    'POST',
    '/api/studio/explore',
    {
      preset_id: 'suit',
      axes: ['fabric'],
      count: 6,
      expand_model_id: 'bchat',
      intent_text: '保留版型',
      ...extra,
    },
    cookie
  );
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return r.json;
};
const quote = async (b, indexes = [0, 2], extra = {}) => {
  const r = await req(
    'POST',
    `/api/studio/explore/${b.id}/quote`,
    { indexes, render_model_id: 'bimage', render_size: '512x512', ...extra },
    cookie
  );
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return r.json.quote;
};
const start = async (b, q, key = crypto.randomUUID()) =>
  req(
    'POST',
    `/api/studio/explore/${b.id}/render`,
    { confirm: true, async: true, quote_id: q.id, request_key: key },
    cookie
  );
try {
  await test('create users and platform balance', async () => {
    let r = await req('POST', '/api/auth/register', {
      username: 'explore_admin',
      password: 'fixture-password',
    });
    cookie = r.cookie;
    r = await req('POST', '/api/auth/register', {
      username: 'explore_other',
      password: 'fixture-password',
    });
    other = r.cookie;
    uid = db
      .prepare('SELECT id FROM users WHERE username=?')
      .get('explore_admin').id;
    addLedger(uid, 10000, 'admin_grant');
  });
  await test('explicit model uses its own provider; default respects worker setting; no image dependency', async () => {
    setSetting('worker_model', 'b/chat');
    assert.equal(
      resolveExploreModel({ userId: uid, headers: {} }, null, 'chat').id,
      'bchat'
    );
    db.prepare("UPDATE models SET is_active=0 WHERE kind='image'").run();
    await create({ count: 2 });
    assert.equal(lastRoute, 'b.fixture.invalid');
    assert.equal(lastModel, 'b/chat');
    db.prepare("UPDATE models SET is_active=1 WHERE kind='image'").run();
  });
  let b;
  await test('six candidates, strict schema and expansion snapshot', async () => {
    b = await create();
    assert.equal(b.proposals.length, 6);
    assert.equal(new Set(b.proposals.map((p) => p.dna.fabric.value)).size, 6);
    assert.equal(b.snapshot.expand_model.id, 'bchat');
  });
  await test('price and size validation, missing price differs from free', async () => {
    for (const indexes of [[], [0, 0], [-1], [6], [1.2], ['1']])
      assert.equal(
        (
          await req(
            'POST',
            `/api/studio/explore/${b.id}/quote`,
            { indexes, render_model_id: 'bimage' },
            cookie
          )
        ).status,
        400
      );
    assert.equal(
      (
        await req(
          'POST',
          `/api/studio/explore/${b.id}/quote`,
          { indexes: [0], render_model_id: 'bimage', render_size: 'bad' },
          cookie
        )
      ).status,
      400
    );
    db.prepare("UPDATE models SET pricing_json='{}' WHERE id='bimage'").run();
    assert.equal(
      (
        await req(
          'POST',
          `/api/studio/explore/${b.id}/quote`,
          { indexes: [0], render_model_id: 'bimage' },
          cookie
        )
      ).json.code,
      'PRICE_NOT_CONFIGURED'
    );
    db.prepare(
      "UPDATE models SET pricing_json='{" +
        '"per_call":0' +
        "}' WHERE id='bimage'"
    ).run();
    assert.equal((await quote(b)).total, 0);
    db.prepare(
      "UPDATE models SET pricing_json='{" +
        '"per_call":5' +
        "}' WHERE id='bimage'"
    ).run();
  });
  await test('price changed after quote is rejected before provider call', async () => {
    const q = await quote(b),
      calls = imageCalls;
    db.prepare(
      "UPDATE models SET pricing_json='{" +
        '"per_call":7' +
        "}' WHERE id='bimage'"
    ).run();
    assert.equal((await start(b, q)).json.code, 'QUOTE_CHANGED');
    assert.equal(imageCalls, calls);
    db.prepare(
      "UPDATE models SET pricing_json='{" +
        '"per_call":5' +
        "}' WHERE id='bimage'"
    ).run();
  });
  let job;
  await test('2/6 quote; concurrent identical confirmation calls provider twice and charges once', async () => {
    const q = await quote(b),
      key = crypto.randomUUID(),
      balance = getBalance(uid),
      calls = imageCalls;
    assert.equal(q.total, 10);
    const [a, c] = await Promise.all([start(b, q, key), start(b, q, key)]);
    assert.equal(a.status, 202);
    assert.equal(c.status, 202);
    assert.equal(a.json.job.id, c.json.job.id);
    job = await waitJob(a.json.job.id);
    assert.equal(job.status, 'succeeded');
    assert.equal(imageCalls - calls, 2);
    assert.equal(balance - getBalance(uid), 10);
    assert.equal(job.cost_actual, 10);
    assert.ok(job.renders.every((r) => r.prompt_snapshot.includes('保留版型')));
    assert.ok(maxActive <= 2);
  });
  await test('select cannot reopen completed batch; idempotency key cannot switch quote', async () => {
    assert.equal(
      (
        await req(
          'POST',
          `/api/studio/explore/${b.id}/select`,
          { indexes: [0] },
          cookie
        )
      ).status,
      409
    );
    const q = await quote(b, [1]);
    const existing = db
      .prepare('SELECT request_key FROM explore_jobs WHERE id=?')
      .get(job.id).request_key;
    assert.equal(
      (await start(b, q, existing)).json.code,
      'IDEMPOTENCY_CONFLICT'
    );
  });
  await test('adoption is atomic, validates every index and is idempotent with prompt snapshot', async () => {
    const before = db
      .prepare('SELECT COUNT(*) n FROM style_dna_templates')
      .get().n;
    assert.equal(
      (
        await req(
          'POST',
          `/api/studio/explore/${b.id}/adopt`,
          { indexes: [0, 99] },
          cookie
        )
      ).status,
      400
    );
    assert.equal(
      db.prepare('SELECT COUNT(*) n FROM style_dna_templates').get().n,
      before
    );
    const x = await req(
        'POST',
        `/api/studio/explore/${b.id}/adopt`,
        { indexes: [0] },
        cookie
      ),
      y = await req(
        'POST',
        `/api/studio/explore/${b.id}/adopt`,
        { indexes: [0] },
        cookie
      );
    assert.deepEqual(x.json.template_ids, y.json.template_ids);
    assert.ok(
      db
        .prepare(
          'SELECT prompt_snapshot FROM dna_generations WHERE template_id=?'
        )
        .get(x.json.template_ids[0])
        .prompt_snapshot.includes('保留版型')
    );
  });
  await test('cross-user quote, render, detail and jobs are inaccessible', async () => {
    for (const suffix of ['', '/jobs'])
      assert.equal(
        (
          await req(
            'GET',
            `/api/studio/explore/${b.id}${suffix}`,
            undefined,
            other
          )
        ).status,
        404
      );
    assert.equal(
      (
        await req(
          'POST',
          `/api/studio/explore/${b.id}/quote`,
          { indexes: [0], render_model_id: 'bimage' },
          other
        )
      ).status,
      404
    );
  });
  await test('insufficient balance rolls back whole reservation before provider call', async () => {
    const q = await quote(b),
      saved = getBalance(uid),
      calls = imageCalls;
    db.prepare('UPDATE users SET points_balance=1 WHERE id=?').run(uid);
    assert.equal((await start(b, q)).json.code, 'INSUFFICIENT_POINTS');
    assert.equal(getBalance(uid), 1);
    assert.equal(imageCalls, calls);
    assert.ok(
      !db.prepare('SELECT 1 FROM explore_jobs WHERE quote_id=?').get(q.id)
    );
    db.prepare('UPDATE users SET points_balance=? WHERE id=?').run(saved, uid);
  });
  await test('partial failures refund only failed items; successful files remain available', async () => {
    const c = await create({ count: 2 }),
      q = await quote(c, [0, 1]),
      balance = getBalance(uid);
    mode = 'partial';
    const r = await start(c, q);
    const j = await waitJob(r.json.job.id);
    mode = 'success';
    assert.equal(j.status, 'partial');
    assert.equal(j.renders.filter((r) => r.status === 'failed').length, 1);
    assert.equal(balance - getBalance(uid), 5);
    const failed = j.renders.find((r) => r.status === 'failed').proposal_idx;
    const retry = await quote(c, [failed]);
    const r2 = await start(c, retry);
    await waitJob(r2.json.job.id);
    const detail = await req(
      'GET',
      `/api/studio/explore/${c.id}`,
      undefined,
      cookie
    );
    assert.equal(
      JSON.parse(detail.json.batch.renders_json).filter((x) => x.image_path)
        .length,
      2
    );
  });
  await test('save/thumbnail failure releases reservation', async () => {
    const c = await create({ count: 2 }),
      q = await quote(c, [0]),
      balance = getBalance(uid);
    mode = 'disk';
    const r = await start(c, q);
    const j = await waitJob(r.json.job.id);
    mode = 'success';
    assert.equal(j.renders[0].status, 'failed');
    assert.equal(balance, getBalance(uid));
  });
  await test('timeout remains uncertain and cannot be retried automatically; admin can audit/refund', async () => {
    const c = await create({ count: 2 }),
      q = await quote(c, [0]),
      balance = getBalance(uid);
    mode = 'timeout';
    const r = await start(c, q);
    const j = await waitJob(r.json.job.id);
    mode = 'success';
    assert.equal(j.status, 'uncertain');
    assert.equal(balance - getBalance(uid), 5);
    assert.equal(
      (
        await req(
          'POST',
          `/api/studio/explore/${c.id}/quote`,
          { indexes: [0], render_model_id: 'bimage' },
          cookie
        )
      ).json.code,
      'RESULT_UNCERTAIN'
    );
    const item = j.renders[0].item_id;
    assert.equal(
      (
        await req(
          'POST',
          `/api/admin/explore-items/${item}/resolve`,
          {
            confirmed_failed: true,
            note: '供应商后台已确认此请求失败且无可恢复图片',
          },
          other
        )
      ).status,
      403
    );
    assert.equal(
      (
        await req(
          'POST',
          `/api/admin/explore-items/${item}/resolve`,
          {
            confirmed_failed: true,
            note: '供应商后台已确认此请求失败且无可恢复图片',
          },
          cookie
        )
      ).status,
      200
    );
    assert.equal(balance, getBalance(uid));
  });
  await test('stale job recovery distinguishes unsent from potentially consumed requests', async () => {
    const c = await create({ count: 2 }),
      q = await quote(c, [0, 1]),
      balance = getBalance(uid);
    // Create a crash fixture before workers run; do not make any provider requests.
    const id = crypto.randomUUID();
    db.prepare('INSERT INTO explore_jobs VALUES(?,?,?,?,?,?,?,?,?)').run(
      id,
      c.id,
      uid,
      crypto.randomUUID(),
      q.id,
      'running',
      JSON.stringify(q),
      0,
      now
    );
    for (const [i, status] of ['queued', 'running'].entries()) {
      const item = crypto.randomUUID();
      addLedger(uid, -5, 'explore_reserve', 'explore_item', item);
      db.prepare('INSERT INTO explore_items VALUES(?,?,?,?,?,?)').run(
        item,
        id,
        i,
        status,
        JSON.stringify({ proposal_idx: i }),
        5
      );
    }
    recoverExploreJobs();
    assert.equal(balance - getBalance(uid), 5);
    assert.deepEqual(
      db
        .prepare(
          'SELECT status FROM explore_items WHERE job_id=? ORDER BY proposal_idx'
        )
        .all(id)
        .map((x) => x.status),
      ['failed', 'uncertain']
    );
  });
  await test('all nine category mocks produce eight distinct valid candidates with locked fields', async () => {
    process.env.MOCK_LLM = 'true';
    for (const preset of listPresets()) {
      const list = await expandIntent({
        preset,
        axes: ['fabric'],
        count: 8,
        locked: { primary_color: '藏蓝' },
      });
      assert.equal(list.length, 8);
      assert.equal(new Set(list.map((p) => p.dna.fabric.value)).size, 8);
      assert.ok(list.every((p) => p.dna.primary_color.value === '藏蓝'));
    }
    process.env.MOCK_LLM = 'false';
  });
  await test('strict schema rejects extra fields, wrong types, duplicate axes, altered locks', async () => {
    process.env.MOCK_LLM = 'true';
    const preset = getPreset('suit'),
      list = await expandIntent({ preset, axes: ['fabric'], count: 2 });
    process.env.MOCK_LLM = 'false';
    const opts = { fields: preset.fields, axes: ['fabric'], count: 2 };
    for (const mutate of [
      (p) => (p[0].dna.extra = { value: 'bad', confidence: 1 }),
      (p) => (p[0].dna.lapel.value = {}),
      (p) => (p[1].dna.fabric = p[0].dna.fabric),
      (p) => (p[0].dna.lapel.confidence = 2),
    ]) {
      const clone = structuredClone(list);
      mutate(clone);
      assert.throws(() => validateProposals(clone, opts));
    }
    assert.throws(() =>
      validateProposals(list, { ...opts, locked: { lapel: '戗驳头' } })
    );
  });
  await test('schema repair bounded to two calls and unsuccessful expansion refunded', async () => {
    const balance = getBalance(uid),
      calls = textCalls;
    textMode = 'malformed';
    const r = await req(
      'POST',
      '/api/studio/explore',
      {
        preset_id: 'suit',
        axes: ['fabric'],
        count: 2,
        expand_model_id: 'bchat',
      },
      cookie
    );
    textMode = 'success';
    assert.equal(r.json.code, 'INVALID_MODEL_OUTPUT');
    assert.equal(textCalls - calls, 2);
    assert.equal(getBalance(uid), balance);
    textMode = 'repair';
    repairCalls = 0;
    await create({ count: 2 });
    textMode = 'success';
    assert.equal(repairCalls, 2);
  });
  await test('provider errors expose safe code, not raw response, and never cause login expiry', async () => {
    textMode = 'auth';
    const r = await req(
      'POST',
      '/api/studio/explore',
      {
        preset_id: 'suit',
        axes: ['fabric'],
        count: 2,
        expand_model_id: 'bchat',
      },
      cookie
    );
    textMode = 'success';
    assert.equal(r.status, 422);
    assert.equal(r.json.code, 'PROVIDER_AUTH');
    assert.ok(r.json.request_id);
    assert.ok(!JSON.stringify(r.json).includes('fixture-'));
  });
  await test('disabled provider/model and incomplete BYOK cannot use platform credentials', async () => {
    db.prepare("UPDATE providers SET is_active=0 WHERE id='b'").run();
    assert.equal(
      (
        await req(
          'POST',
          '/api/studio/explore',
          {
            preset_id: 'suit',
            axes: ['fabric'],
            count: 2,
            expand_model_id: 'bchat',
          },
          cookie
        )
      ).json.code,
      'MODEL_UNAVAILABLE'
    );
    db.prepare("UPDATE providers SET is_active=1 WHERE id='b'").run();
    db.prepare("UPDATE users SET billing_mode='byok' WHERE id=?").run(uid);
    assert.throws(
      () => resolveExploreModel({ userId: uid, headers: {} }, 'bchat', 'chat'),
      (e) => e.code === 'BYOK_NOT_CONFIGURED'
    );
    db.prepare("UPDATE users SET billing_mode='points' WHERE id=?").run(uid);
  });
  await test('preset expand_prompt admin CRUD survives migration/restart and snapshot stays stable', async () => {
    const old = db
      .prepare("SELECT prompt FROM dna_presets WHERE id='suit'")
      .get().prompt;
    assert.equal(
      (
        await req(
          'PUT',
          '/api/admin/dna-presets/suit',
          { expand_prompt: '保留管理员测试规则' },
          cookie
        )
      ).status,
      200
    );
    assert.equal(getPreset('suit').prompt, old);
    const c = await create({ count: 2 });
    assert.equal(c.snapshot.preset.expand_prompt, '保留管理员测试规则');
    const child = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import {getDb} from './src/db.js';const db=getDb();if(db.prepare("SELECT expand_prompt FROM dna_presets WHERE id='suit'").get().expand_prompt!=='保留管理员测试规则')process.exit(1);`,
      ],
      {
        cwd: path.resolve(import.meta.dirname, '..'),
        env: process.env,
        encoding: 'utf8',
      }
    );
    assert.equal(child.status, 0, child.stderr);
    await req(
      'PUT',
      '/api/admin/dna-presets/suit',
      { expand_prompt: '新规则' },
      cookie
    );
    const detail = await req(
      'GET',
      `/api/studio/explore/${c.id}`,
      undefined,
      cookie
    );
    assert.equal(
      JSON.parse(detail.json.batch.snapshot_json).preset.expand_prompt,
      '保留管理员测试规则'
    );
  });
  await test('explicit expansion request key replays without extra calls or charge', async () => {
    const key = crypto.randomUUID(),
      params = {
        preset_id: 'suit',
        axes: ['fabric'],
        count: 2,
        expand_model_id: 'bchat',
        request_key: key,
      };
    const x = await req('POST', '/api/studio/explore', params, cookie),
      calls = textCalls,
      balance = getBalance(uid);
    const y = await req('POST', '/api/studio/explore', params, cookie);
    assert.equal(x.json.id, y.json.id);
    assert.equal(y.json.reused, true);
    assert.equal(textCalls, calls);
    assert.equal(getBalance(uid), balance);
    assert.equal(
      (
        await req(
          'POST',
          '/api/studio/explore',
          { ...params, count: 4 },
          cookie
        )
      ).json.code,
      'IDEMPOTENCY_CONFLICT'
    );
  });
  await test('expansion timeout is auditable and refunds only after admin verification', async () => {
    const balance = getBalance(uid),
      key = crypto.randomUUID(),
      params = {
        preset_id: 'suit',
        axes: ['fabric'],
        count: 2,
        expand_model_id: 'bchat',
        intent_text: '唯一超时场景',
        request_key: key,
      };
    textMode = 'timeout';
    const x = await req('POST', '/api/studio/explore', params, cookie);
    textMode = 'success';
    assert.equal(x.json.code, 'RESULT_UNCERTAIN');
    const calls = textCalls;
    assert.equal(
      (await req('POST', '/api/studio/explore', params, cookie)).json.code,
      'RESULT_UNCERTAIN'
    );
    assert.equal(textCalls, calls);
    const pending = await req(
      'GET',
      '/api/admin/explore-recovery',
      undefined,
      cookie
    );
    const item = pending.json.items.find(
      (i) => i.type === 'expansion' && i.id.endsWith(key)
    );
    assert.ok(item);
    assert.equal(balance - getBalance(uid), item.reserved);
    const x2 = await req(
      'POST',
      `/api/admin/explore-expansions/${encodeURIComponent(item.id)}/resolve`,
      {
        confirmed_failed: true,
        note: '供应商侧已核对失败，未返回结果，本次退回预留额度',
      },
      cookie
    );
    assert.equal(x2.status, 200);
    assert.equal(balance, getBalance(uid));
  });
  await test('retry uses failed attempt prompt and seed; historical adoption uses selected job', async () => {
    const c = await create({ count: 2 });
    mode = 'auth';
    let q = await quote(c, [0]);
    let x = await start(c, q);
    const failed = await waitJob(x.json.job.id);
    mode = 'success';
    assert.equal(failed.renders[0].status, 'failed');
    q = await quote(c, [0], { source_job_id: failed.id });
    assert.equal(q.prompts[0], failed.renders[0].prompt_snapshot);
    assert.equal(q.seeds[0], failed.renders[0].seed);
    x = await start(c, q);
    const first = await waitJob(x.json.job.id);
    q = await quote(c, [0]);
    x = await start(c, q);
    const newer = await waitJob(x.json.job.id);
    assert.notEqual(first.renders[0].image_path, newer.renders[0].image_path);
    const a = await req(
      'POST',
      `/api/studio/explore/${c.id}/adopt`,
      { indexes: [0], job_id: first.id },
      cookie
    );
    assert.equal(a.status, 200);
    assert.equal(
      db
        .prepare('SELECT image_path FROM dna_generations WHERE template_id=?')
        .get(a.json.template_ids[0]).image_path,
      first.renders[0].image_path
    );
    assert.equal(
      (
        await req(
          'POST',
          `/api/studio/explore/${c.id}/quote`,
          { indexes: [0], render_model_id: 'bimage', source_job_id: first.id },
          cookie
        )
      ).json.code,
      'INVALID_RETRY'
    );
  });
  await test('distinct concurrent requests do not reopen running batch; provider concurrency shared across batches', async () => {
    const a = await create({ count: 2 }),
      b = await create({ count: 2 }),
      qa = await quote(a, [0, 1]),
      qb = await quote(b, [0, 1]);
    maxActive = 0;
    const xa = await start(a, qa);
    const duplicate = await start(a, qa);
    assert.equal(duplicate.status, 409);
    assert.equal(
      (
        await req(
          'POST',
          `/api/studio/explore/${a.id}/select`,
          { indexes: [0] },
          cookie
        )
      ).status,
      409
    );
    const xb = await start(b, qb);
    await Promise.all([waitJob(xa.json.job.id), waitJob(xb.json.job.id)]);
    assert.ok(maxActive <= 2);
  });
  await test('expired or consumed quotes cannot create a second charge', async () => {
    const c = await create({ count: 2 }),
      q = await quote(c, [0]),
      balance = getBalance(uid),
      calls = imageCalls;
    db.prepare('UPDATE explore_quotes SET expires_at=0 WHERE id=?').run(q.id);
    assert.equal((await start(c, q)).json.code, 'QUOTE_EXPIRED');
    assert.equal(imageCalls, calls);
    assert.equal(balance, getBalance(uid));
    const q2 = await quote(c, [0]),
      x = await start(c, q2);
    await waitJob(x.json.job.id);
    assert.equal((await start(c, q2)).json.code, 'QUOTE_USED');
  });
  await test('image URL normalization avoids duplicate version prefix; full suit vocabulary preserves DNA', async () => {
    const { imageApiUrl, renderDnaPrompt } = await import('../src/image.js');
    assert.equal(
      imageApiUrl('https://example.invalid/v1/', 'generations'),
      'https://example.invalid/v1/images/generations'
    );
    assert.equal(
      imageApiUrl('https://example.invalid', 'generations'),
      'https://example.invalid/v1/images/generations'
    );
    assert.equal(
      imageApiUrl('https://example.invalid/api/v1', 'generations'),
      'https://example.invalid/api/v1/images/generations'
    );
    const dna = {
      lapel: { value: '戗驳头' },
      buttons: { value: '双排六扣' },
      vent: { value: '不开衩' },
      fabric: { value: '羊绒质感' },
      details: { value: ['票兜'] },
    };
    const clone = structuredClone(dna),
      prompt = renderDnaPrompt({
        dna,
        presetId: 'suit',
        intentText: '保留藏蓝',
      });
    assert.match(prompt, /peak lapels/);
    assert.match(prompt, /six-button/);
    assert.match(prompt, /ventless/);
    assert.match(prompt, /cashmere/);
    assert.match(prompt, /ticket pocket/);
    assert.match(prompt, /保留藏蓝/);
    assert.deepEqual(dna, clone);
  });
  await test('BYOK uses complete personal connection without platform charge or credential fallback', async () => {
    const { setUserApiKeys } = await import('../src/auth.js');
    setUserApiKeys(uid, {
      key: 'personal-fixture',
      baseUrl: 'https://personal.fixture.invalid',
      provider: 'custom',
    });
    db.prepare("UPDATE users SET billing_mode='byok' WHERE id=?").run(uid);
    const balance = getBalance(uid);
    await create({ count: 2 });
    assert.equal(lastRoute, 'personal.fixture.invalid');
    assert.equal(lastModel, 'b/chat');
    assert.equal(getBalance(uid), balance);
    assert.ok(
      db
        .prepare(
          "SELECT 1 FROM api_usage WHERE user_id=? AND reason='explore_expand'"
        )
        .get(uid)
    );
    db.prepare("UPDATE users SET billing_mode='points' WHERE id=?").run(uid);
  });
  await test('same upstream name on different providers remains unambiguous by registry ID', async () => {
    db.prepare("UPDATE models SET model_id='b/chat' WHERE id='achat'").run();
    await create({ count: 2, expand_model_id: 'achat' });
    assert.equal(lastRoute, 'a.fixture.invalid');
    assert.equal(lastModel, 'b/chat');
    db.prepare("UPDATE models SET model_id='a/chat' WHERE id='achat'").run();
  });
  await test('generated assets enforce authentication and user ownership', async () => {
    const image = job.renders[0].image_path;
    assert.equal((await realFetch(base + '/' + image)).status, 401);
    assert.equal(
      (await realFetch(base + '/' + image, { headers: { Cookie: other } }))
        .status,
      404
    );
    const own = await realFetch(base + '/' + image, {
      headers: { Cookie: cookie },
    });
    assert.equal(own.status, 200);
    assert.match(own.headers.get('cache-control'), /private/);
  });
  await test('legacy rendering state cannot be blindly retried and has audited admin recovery', async () => {
    const c = await create({ count: 2 });
    db.prepare(
      "UPDATE exploration_batches SET status='rendering' WHERE id=?"
    ).run(c.id);
    assert.equal(
      (
        await req(
          'POST',
          `/api/studio/explore/${c.id}/quote`,
          { indexes: [0], render_model_id: 'bimage' },
          cookie
        )
      ).json.code,
      'LEGACY_RESULT_UNCERTAIN'
    );
    const pending = await req(
      'GET',
      '/api/admin/explore-recovery',
      undefined,
      cookie
    );
    assert.ok(
      pending.json.items.some((i) => i.type === 'legacy' && i.id === c.id)
    );
    assert.equal(
      (
        await req(
          'POST',
          `/api/admin/explore-legacy/${c.id}/resolve`,
          {
            confirmed_failed: true,
            note: '已停止旧进程并核对供应商，确认旧任务已终止',
          },
          cookie
        )
      ).status,
      200
    );
    await quote(c, [0]);
  });
  await test('previous-version database migration preserves administrator preset edits and legacy batches', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fashion-old-schema-'));
    await db.backup(path.join(dir, 'fashion-studio.db'));
    const Database = (await import('better-sqlite3')).default,
      old = new Database(path.join(dir, 'fashion-studio.db'));
    old
      .prepare("UPDATE dna_presets SET prompt='管理员识图保留' WHERE id='suit'")
      .run();
    for (const table of [
      'explore_items',
      'explore_jobs',
      'explore_quotes',
      'explore_expansions',
    ])
      old.exec(`DROP TABLE ${table}`);
    old.exec('ALTER TABLE dna_presets DROP COLUMN expand_prompt');
    old.exec('ALTER TABLE exploration_batches DROP COLUMN snapshot_json');
    old.exec('ALTER TABLE exploration_batches DROP COLUMN adopted_json');
    old.close();
    const child = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import assert from 'node:assert/strict';import {getDb} from './src/db.js';const db=getDb();assert.equal(db.prepare("SELECT prompt FROM dna_presets WHERE id='suit'").get().prompt,'管理员识图保留');assert.equal(db.prepare("SELECT expand_prompt FROM dna_presets WHERE id='suit'").get().expand_prompt,'');assert.ok(db.prepare("SELECT COUNT(*) n FROM exploration_batches").get().n>0);db.close();`,
      ],
      {
        cwd: path.resolve(import.meta.dirname, '..'),
        env: { ...process.env, DATA_DIR: dir },
        encoding: 'utf8',
      }
    );
    assert.equal(child.status, 0, child.stderr);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await test('statistics count settled consumption, not holds/refunds as spending or grants', async () => {
    const before = (
      await req('GET', '/api/admin/stats/overview', undefined, cookie)
    ).json;
    const c = await create({ count: 2 }),
      q = await quote(c, [0, 1]);
    mode = 'auth';
    const x = await start(c, q);
    await waitJob(x.json.job.id);
    mode = 'success';
    const after = (
      await req('GET', '/api/admin/stats/overview', undefined, cookie)
    ).json;
    assert.equal(after.totalGranted, before.totalGranted);
    assert.equal(after.totalConsumed - before.totalConsumed, c.expand_cost);
    for (const endpoint of ['daily', 'models', 'top-users'])
      assert.equal(
        (await req('GET', '/api/admin/stats/' + endpoint, undefined, cookie))
          .status,
        200
      );
    const settled = db
      .prepare(
        "SELECT accounting_delta,tokens_input FROM points_ledger WHERE reason='explore_expand_settle' ORDER BY id DESC LIMIT 1"
      )
      .get();
    assert.equal(settled.accounting_delta, -c.expand_cost);
    assert.equal(settled.tokens_input, 120);
  });
  console.log(`Explore integration: ${passed}/${passed} passed`);
} catch (e) {
  console.error(e);
  process.exitCode = 1;
} finally {
  global.fetch = realFetch;
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  db.close();
  fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
}
