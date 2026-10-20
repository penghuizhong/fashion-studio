import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import sharp from "sharp";
process.env.DATA_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), "style-security-"),
);
process.env.MULTI_USER = "true";
process.env.MOCK_LLM = "false";
process.env.MASTER_KEY = crypto.randomBytes(32).toString("hex");
process.env.SESSION_SECRET = crypto.randomBytes(32).toString("hex");
process.env.WRITE_LIMIT_MAX = "1000";
const { getDb, closeDb } = await import("../src/db.js");
const { createApp } = await import("../src/app.js");
const { encryptSecret } = await import("../src/secrets.js");
const { waitJob } = await import("../src/exploreJobs.js");
const db = getDb();
const originalFetch = global.fetch;
const png = await sharp({
  create: { width: 600, height: 900, channels: 3, background: "#123456" },
})
  .png()
  .toBuffer();
let mode = "success",
  calls = 0,
  lastForm;
global.fetch = async (url, opts = {}) => {
  if (!String(url).includes("style-fixture.invalid"))
    return originalFetch(url, opts);
  calls++;
  if (mode === "timeout") throw new DOMException("timed out", "TimeoutError");
  if (mode === "fail") return new Response("{}", { status: 429 });
  if (opts.body instanceof FormData) {
    lastForm = opts.body;
    assert.equal(opts.body.get("model"), "edit-upstream");
    const file = opts.body.get("image");
    if (file) assert.equal(file.type, "image/png");
  }
  return new Response(
    JSON.stringify({ data: [{ b64_json: png.toString("base64") }] }),
    { headers: { "Content-Type": "application/json" } },
  );
};
const tokens = { alice: "alice-test-token", bob: "bob-test-token" };
const now = new Date().toISOString();
for (const id of ["alice", "bob"]) {
  db.prepare(
    "INSERT INTO users(id,username,password_hash,created_at,points_balance,billing_mode) VALUES(?,?,?,?,100,'points')",
  ).run(id, id, "test-not-for-login", now);
  db.prepare("INSERT INTO sessions VALUES(?,?,?)").run(
    crypto.createHash("sha256").update(tokens[id]).digest("hex"),
    id,
    Date.now() + 86400000,
  );
}
db.prepare(
  "INSERT INTO providers(id,name,preset,kind,base_url,api_key_encrypted,is_active,created_at) VALUES(?,?,?,?,?,?,1,?)",
).run(
  "style-real",
  "Fixture",
  "custom",
  "image",
  "https://style-fixture.invalid/v1",
  encryptSecret(process.env.MASTER_KEY, "style-fixture-key"),
  now,
);
db.prepare(
  "INSERT INTO models(id,provider_id,kind,model_id,name,pricing_json,extra_json,is_active,created_at) VALUES(?,?,?,?,?,?,?,1,?)",
).run(
  "edit-real",
  "style-real",
  "image",
  "edit-upstream",
  "Edit fixture",
  '{"per_call":5}',
  '{"sizes":["512x512"],"image_edit":true,"multi_reference":true}',
  now,
);
const server = await new Promise((resolve) => {
  const s = createApp().listen(0, "127.0.0.1", () => resolve(s));
});
const base = `http://127.0.0.1:${server.address().port}`;
let n = 0;
async function req(user, method, url, body, status = 200) {
  const response = await originalFetch(base + url, {
    method,
    headers: {
      Cookie: `soulchat_session=${tokens[user]}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await response.json();
  assert.equal(response.status, status, JSON.stringify(json));
  return json;
}
async function test(name, fn) {
  await fn();
  console.log(`PASS ${++n}. ${name}`);
}
try {
  const p = (await req("alice", "GET", "/api/studio/dna-presets")).presets.find(
    (p) => p.id === "suit",
  );
  const dna = Object.fromEntries(
    p.fields.map((f) => [
      f.key,
      { value: f.key === "details" ? ["贴兜"] : "常规", confidence: 0.9 },
    ]),
  );
  const id = (
    await req("alice", "POST", "/api/studio/templates", {
      name: "私有款式",
      preset_id: "suit",
      dna_json: dna,
      source_image_base64: png.toString("base64"),
    })
  ).id;
  const url = `/api/studio/templates/${id}`;
  const ws = await req("alice", "GET", url + "/workspace");
  const version_id = ws.versions[0].id;
  const body = {
    version_id,
    op: "create",
    mode: "image",
    source: "original",
    model_id: "edit-real",
    size: "512x512",
    count: 2,
  };
  let q, job, image;
  await test("workspace, versions, references and raw images enforce ownership", async () => {
    await req("bob", "GET", url + "/workspace", undefined, 404);
    await req(
      "bob",
      "POST",
      url + "/versions",
      { parent_id: version_id, dna, request_key: crypto.randomUUID() },
      404,
    );
    const r = await originalFetch(base + "/" + ws.template.source_image_path, {
      headers: { Cookie: `soulchat_session=${tokens.bob}` },
    });
    assert.equal(r.status, 404);
  });
  await test("reservation, exact retry, settlement and actual edit adapter", async () => {
    q = (await req("alice", "POST", url + "/quote", body)).quote;
    assert.equal(q.total, 10);
    const key = crypto.randomUUID();
    job = (
      await req(
        "alice",
        "POST",
        url + "/jobs",
        { quote_id: q.id, request_key: key, confirm: true },
        202,
      )
    ).job;
    await req(
      "alice",
      "POST",
      url + "/jobs",
      { quote_id: q.id, request_key: key, confirm: true },
      202,
    );
    await waitJob(job.id);
    assert.equal(calls, 2);
    assert.equal(
      db.prepare("SELECT points_balance FROM users WHERE id=?").get("alice")
        .points_balance,
      90,
    );
    const current = await req("alice", "GET", url + "/workspace");
    assert.equal(current.jobs[0].cost_actual, 10);
    assert.equal(current.images.length, 2);
    image = current.images[0];
    assert.ok(lastForm.get("image"));
    assert.equal(current.template.cover_generation_id, null);
  });
  await test("quote ownership and consumed quote cannot be replayed", async () => {
    await req(
      "bob",
      "POST",
      url + "/jobs",
      { quote_id: q.id, request_key: crypto.randomUUID(), confirm: true },
      404,
    );
    await req(
      "alice",
      "POST",
      url + "/jobs",
      { quote_id: q.id, request_key: crypto.randomUUID(), confirm: true },
      409,
    );
    assert.equal(calls, 2);
  });
  await test("price changes require new confirmation and do not charge", async () => {
    const q = (await req("alice", "POST", url + "/quote", body)).quote;
    db.prepare("UPDATE models SET pricing_json=? WHERE id=?").run(
      '{"per_call":7}',
      "edit-real",
    );
    await req(
      "alice",
      "POST",
      url + "/jobs",
      { quote_id: q.id, request_key: crypto.randomUUID(), confirm: true },
      409,
    );
    assert.equal(calls, 2);
    db.prepare("UPDATE models SET pricing_json=? WHERE id=?").run(
      '{"per_call":5}',
      "edit-real",
    );
  });
  await test("explicit provider failure refunds; retry preserves settings", async () => {
    mode = "fail";
    const q = (await req("alice", "POST", url + "/quote", body)).quote;
    const j = (
      await req(
        "alice",
        "POST",
        url + "/jobs",
        { quote_id: q.id, request_key: crypto.randomUUID(), confirm: true },
        202,
      )
    ).job;
    await waitJob(j.id);
    assert.equal(
      db.prepare("SELECT points_balance FROM users WHERE id=?").get("alice")
        .points_balance,
      90,
    );
    const retry = (
      await req("alice", "POST", url + "/retry-quote", { job_id: j.id })
    ).quote;
    assert.deepEqual(retry.camera, q.camera);
    assert.deepEqual(retry.prompts, q.prompts);
    mode = "success";
    const result = (
      await req(
        "alice",
        "POST",
        url + "/jobs",
        { quote_id: retry.id, request_key: crypto.randomUUID(), confirm: true },
        202,
      )
    ).job;
    await waitJob(result.id);
    assert.equal(
      db.prepare("SELECT points_balance FROM users WHERE id=?").get("alice")
        .points_balance,
      80,
    );
  });
  await test("cross-user assets and reference IDs rejected", async () => {
    await req(
      "bob",
      "POST",
      "/api/studio/references",
      { generation_id: image.id },
      404,
    );
    const r = await req("alice", "POST", "/api/studio/references", {
      generation_id: image.id,
    });
    const bobId = (
      await req("bob", "POST", "/api/studio/templates", {
        name: "Bob",
        preset_id: "suit",
        dna_json: dna,
      })
    ).id;
    const bw = await req(
      "bob",
      "GET",
      `/api/studio/templates/${bobId}/workspace`,
    );
    await req(
      "bob",
      "POST",
      `/api/studio/templates/${bobId}/quote`,
      { ...body, version_id: bw.versions[0].id, source: `ref:${r.id}` },
      404,
    );
  });
  await test("retired layout reads/writes reject access and preserve historical references", async () => {
    const config={selected:[image.id]};
    const historical=Number(db.prepare('INSERT INTO style_layouts(template_id,version_id,request_key,config_json,created_at) VALUES(?,?,?,?,?)').run(id,version_id,crypto.randomUUID(),JSON.stringify(config),new Date().toISOString()).lastInsertRowid);
    for (const method of ['POST','GET']) {
      const r=await req('alice',method,url+'/layouts',method==='POST'?{version_id,config}:undefined,410);
      assert.equal(r.code,'FEATURE_RETIRED');
    }
    await req('alice','GET',url+'/workspace/layouts',undefined,410);
    await req('bob','POST',url+'/layouts',{},404);
    await req('bob','GET',url+'/workspace/layouts',undefined,404);
    const ws=await req('alice','GET',url+'/workspace');assert.ok(!Object.hasOwn(ws,'layouts'));
    const summary=await req('alice','GET',url+'/workspace?view=summary');assert.ok(!Object.hasOwn(summary,'layouts'));assert.ok(!Object.hasOwn(summary.totals,'layouts'));
    assert.ok(db.prepare('SELECT 1 FROM style_layouts WHERE id=?').get(historical));
    await req('alice','POST',`/api/studio/generations/${image.id}/archive`,{archived:true});
    await req('alice','POST',`/api/studio/generations/${image.id}/permanent-delete`,{confirm:'永久删除'},409);
    assert.ok(fs.existsSync(path.join(process.env.DATA_DIR,image.image_path)));
  });
  const addImage = (imagePath, thumbPath = imagePath, user = "alice") => Number(db.prepare(
    "INSERT INTO dna_generations(template_id,user_id,image_path,thumb_path,created_at) VALUES(?,?,?,?,?)"
  ).run(id, user, imagePath, thumbPath, now).lastInsertRowid);
  const fixtureFile = () => {
    const relative = `uploads/studio/${crypto.randomUUID()}.png`;
    fs.writeFileSync(path.join(process.env.DATA_DIR, relative), png);
    return relative;
  };
  await test("archiving one shared asset preserves every other record and original bytes", async () => {
    const file = fixtureFile(), thumb = fixtureFile();
    const first = addImage(file, thumb), second = addImage(file, thumb), third = addImage(file, thumb);
    await req("bob", "POST", `/api/studio/generations/${first}/rate`, {rating:"deleted"}, 404);
    await req("alice", "POST", `/api/studio/generations/${first}/rate`, {rating:"deleted"});
    await req("alice", "POST", "/api/studio/assets/bulk-delete", {ids:[second]});
    assert.equal(db.prepare("SELECT archived FROM dna_generations WHERE id=?").get(third).archived, 0);
    const active = await req("alice", "GET", "/api/studio/assets");
    assert.ok(active.assets.some(a => a.id === third && a.image_available && a.thumb_available));
    assert.ok(!active.assets.some(a => a.id === first || a.id === second));
    const archived = await req("alice", "GET", "/api/studio/assets?rating=archived");
    assert.ok(archived.assets.some(a => a.id === first));
    await req("alice", "POST", `/api/studio/generations/${second}/archive`, {archived:false});
    assert.equal(db.prepare("SELECT archived FROM dna_generations WHERE id=?").get(second).archived, 0);
    await req("alice", "POST", `/api/studio/generations/${first}/permanent-delete`, {confirm:"永久删除"}, 409);
    for (const f of [file, thumb]) assert.deepEqual(fs.readFileSync(path.join(process.env.DATA_DIR, f)), png);
    const response = await originalFetch(base + "/" + file, {headers:{Cookie:`soulchat_session=${tokens.alice}`}});
    assert.equal(response.status, 200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), png);
  });
  await test("permanent deletion protects a thumbnail shared with another user's original", async () => {
    const file = fixtureFile(), thumb = fixtureFile();
    const target = addImage(file, thumb);
    addImage(thumb, fixtureFile(), "bob");
    await req("alice", "POST", `/api/studio/generations/${target}/archive`, {});
    await req("alice", "POST", `/api/studio/generations/${target}/permanent-delete`, {confirm:"永久删除"}, 409);
    assert.deepEqual(fs.readFileSync(path.join(process.env.DATA_DIR, thumb)), png);
  });
  await test("missing originals are reported; unique original/thumbnail paths can be deleted once", async () => {
    const file = fixtureFile();
    const target = addImage(file);
    await req("alice", "POST", `/api/studio/generations/${target}/archive`, {});
    await req("alice", "POST", `/api/studio/generations/${target}/permanent-delete`, {confirm:"永久删除"});
    assert.equal(fs.existsSync(path.join(process.env.DATA_DIR, file)), false);
    await req("alice", "POST", `/api/studio/generations/${target}/archive`, {archived:false}, 409);
    const missing = addImage("uploads/studio/missing.png", fixtureFile());
    const a = (await req("alice", "GET", "/api/studio/assets")).assets.find(a => a.id === missing);
    assert.equal(a.image_available, false);
    assert.equal(a.thumb_available, true);
  });
  await test("failed file staging restores the original and leaves metadata unchanged", async () => {
    const file = fixtureFile();
    const target = addImage(file, "uploads/studio/missing-thumbnail.png");
    await req("alice", "POST", `/api/studio/generations/${target}/archive`, {});
    await req("alice", "POST", `/api/studio/generations/${target}/permanent-delete`, {confirm:"永久删除"}, 404);
    assert.deepEqual(fs.readFileSync(path.join(process.env.DATA_DIR, file)), png);
    assert.notEqual(db.prepare("SELECT user_rating FROM dna_generations WHERE id=?").get(target).user_rating, "deleted");
  });
  await test("network uncertainty preserves reserve and blocks blind resubmission", async () => {
    mode = "timeout";
    const q = (
      await req("alice", "POST", url + "/quote", { ...body, count: 1 })
    ).quote;
    const j = (
      await req(
        "alice",
        "POST",
        url + "/jobs",
        { quote_id: q.id, request_key: crypto.randomUUID(), confirm: true },
        202,
      )
    ).job;
    await waitJob(j.id);
    const current = await req("alice", "GET", url + "/workspace");
    assert.equal(current.jobs[0].status, "uncertain");
    assert.equal(current.jobs[0].reserved_total, 5);
    assert.equal(
      db.prepare("SELECT points_balance FROM users WHERE id=?").get("alice")
        .points_balance,
      75,
    );
    await req("alice", "POST", url + "/quote", body, 409);
  });
  console.log(`Style security/billing: ${n}/${n} passed`);
} finally {
  global.fetch = originalFetch;
  await new Promise((resolve) => server.close(resolve));
  closeDb();
  fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
}
