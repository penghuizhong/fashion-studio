import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
process.env.DATA_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), "fashion-style-check-"),
);
process.env.MULTI_USER = "false";
process.env.MOCK_LLM = "true";
process.env.WRITE_LIMIT_MAX = "1000";
const { createApp } = await import("../src/app.js");
const { getDb, closeDb } = await import("../src/db.js");
const { DEFAULT_CAMERA, normalizeCamera } = await import(
  "../../shared/photography.js"
);
const { waitJob, recoverExploreJobs } = await import("../src/exploreJobs.js");
const db = getDb();
const server = await new Promise((resolve) => {
  const s = createApp().listen(0, "127.0.0.1", () => resolve(s));
});
const base = `http://127.0.0.1:${server.address().port}`;
let count = 0;
async function req(
  method,
  url,
  body,
  status = method === "POST" && url.endsWith("/jobs") ? 202 : 200,
) {
  const res = await fetch(base + url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json();
  assert.equal(res.status, status, JSON.stringify(data));
  return data;
}
async function test(name, fn) {
  await fn();
  console.log(`PASS ${++count}. ${name}`);
}
try {
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO providers(id,name,preset,kind,is_active,created_at) VALUES(?,?,?,?,1,?)",
  ).run("style-provider", "Style test", "custom", "image", now);
  for (const edit of [true, false])
    db.prepare(
      "INSERT INTO models(id,provider_id,kind,model_id,name,pricing_json,extra_json,is_active,created_at) VALUES(?,?,?,?,?,?,?,1,?)",
    ).run(
      edit ? "edit-model" : "text-model",
      "style-provider",
      "image",
      edit ? "edit-upstream" : "text-upstream",
      "Test model",
      JSON.stringify({ per_call: 5 }),
      JSON.stringify({
        sizes: ["512x512", "1024x1024"],
        image_edit: edit,
        multi_reference: edit,
      }),
      now,
    );
  const presets = await req("GET", "/api/studio/dna-presets"),
    preset = presets.presets.find((p) => p.id === "suit");
  const dna = Object.fromEntries(
    preset.fields.map((f) => [
      f.key,
      { value: f.key === "details" ? ["贴兜"] : "常规", confidence: 0.8 },
    ]),
  );
  const raw = (
    await sharp({
      create: { width: 800, height: 1200, channels: 3, background: "#223344" },
    })
      .png()
      .toBuffer()
  ).toString("base64");
  const t = await req("POST", "/api/studio/templates", {
    name: "版本测试款式",
    preset_id: "suit",
    dna_json: dna,
    source_image_base64: raw,
  });
  const id = t.id;
  const url = `/api/studio/templates/${id}`;
  let ws = await req("GET", url + "/workspace"),
    root = ws.versions[0],
    v2;
  await test("initial snapshot and legacy images are not falsely associated", async () => {
    assert.equal(ws.versions.length, 1);
    assert.equal(root.number, 1);
    assert.equal(ws.template.work_version_id, root.id);
  });
  await test("immutable save, provenance, idempotency and unchanged working version", async () => {
    const next = { ...dna, primary_color: { value: "酒红", confidence: 1 } };
    const key = randomUUID();
    v2 = (
      await req("POST", url + "/versions", {
        parent_id: root.id,
        dna: next,
        request_key: key,
      })
    ).version;
    assert.equal(v2.parent_id, root.id);
    assert.equal(JSON.parse(v2.dna_json).primary_color.confirmed, true);
    assert.equal(JSON.parse(v2.dna_json).primary_color.confidence, 0.8);
    assert.equal(
      (
        await req("POST", url + "/versions", {
          parent_id: root.id,
          dna: next,
          request_key: key,
        })
      ).version.id,
      v2.id,
    );
    await req(
      "POST",
      url + "/versions",
      { parent_id: root.id, dna, request_key: key },
      409,
    );
    ws = await req("GET", url + "/workspace");
    assert.equal(ws.template.work_version_id, root.id);
    assert.deepEqual(
      JSON.parse(ws.versions.find((v) => v.id === root.id).dna_json),
      dna,
    );
    assert.throws(() =>
      db
        .prepare("UPDATE style_versions SET dna_json=? WHERE id=?")
        .run("{}", root.id),
    );
  });
  await test("no-op save does not create version; incomplete schema rejected", async () => {
    const r = await req("POST", url + "/versions", {
      parent_id: root.id,
      dna,
      request_key: randomUUID(),
    });
    assert.equal(r.version.id, root.id);
    await req(
      "POST",
      url + "/versions",
      { parent_id: root.id, dna: {}, request_key: randomUUID() },
      400,
    );
  });
  await test("working pointer concurrency and version finalization", async () => {
    await req("POST", url + "/working-version", {
      version_id: v2.id,
      expected_version_id: root.id,
    });
    await req(
      "POST",
      url + "/working-version",
      { version_id: root.id, expected_version_id: root.id },
      409,
    );
    await req("POST", url + `/versions/${v2.id}/status`, { status: "final" });
    const next = {
      ...JSON.parse(v2.dna_json),
      fabric: { value: "亚麻", confidence: 0.9 },
    };
    const v3 = (
      await req("POST", url + "/versions", {
        parent_id: v2.id,
        dna: next,
        request_key: randomUUID(),
      })
    ).version;
    assert.equal(v3.status, "draft");
    assert.equal(v3.parent_id, v2.id);
  });
  const body = {
    version_id: v2.id,
    op: "create",
    mode: "text",
    model_id: "edit-model",
    size: "512x512",
    count: 2,
    camera: DEFAULT_CAMERA,
  };
  let q, j;
  await test("camera validation and task snapshot", async () => {
    assert.throws(() =>
      normalizeCamera({ ...DEFAULT_CAMERA, display: "flat" }),
    );
    q = (await req("POST", url + "/quote", body)).quote;
    assert.deepEqual(q.camera, DEFAULT_CAMERA);
    assert.equal(q.style.version_id, v2.id);
    assert.match(q.prompts[0], /both sleeve cuffs/);
    assert.match(q.prompts[0], /straight front view/);
  });
  await test("durable jobs, exact repeat and no automatic cover", async () => {
    const key = randomUUID();
    j = (
      await req("POST", url + "/jobs", {
        quote_id: q.id,
        request_key: key,
        confirm: true,
      })
    ).job;
    const again = await req("POST", url + "/jobs", {
      quote_id: q.id,
      request_key: key,
      confirm: true,
    });
    assert.equal(again.job.id, j.id);
    await waitJob(j.id);
    ws = await req("GET", url + "/workspace");
    assert.equal(ws.images.length, 2);
    assert.ok(ws.images.every((i) => i.design_version_id === v2.id));
    assert.equal(ws.template.cover_generation_id, null);
    assert.equal(ws.template.work_version_id, v2.id);
    assert.equal(ws.jobs[0].status, "succeeded");
    await req('GET',`/api/studio/explore/${j.batch_id}`,undefined,404);
    const listed = await req("GET", "/api/studio/explore");
    assert.ok(!listed.batches.some((b) => b.id === j.batch_id));
  });
  const image = ws.images[0];
  await test("cover explicit, archive retains file, fork references original bytes", async () => {
    await req("POST", url + "/cover", { generation_id: image.id });
    await req("POST", `/api/studio/generations/${image.id}/archive`, {
      archived: true,
    });
    assert.ok(fs.existsSync(path.join(process.env.DATA_DIR, image.image_path)));
    await req("POST", `/api/studio/generations/${image.id}/archive`, {
      archived: false,
    });
    const fork = await req("POST", url + "/fork", {
      version_id: v2.id,
      generation_id: image.id,
    });
    assert.equal(
      (await req("GET", `/api/studio/templates/${fork.id}/workspace`)).template
        .source_image_path,
      image.image_path,
    );
  });
  await test("capability gating and no cross-style base source", async () => {
    await req(
      "POST",
      url + "/quote",
      {
        ...body,
        op: "scene",
        mode: "image",
        source: image.id,
        instruction: "室内背景",
        model_id: "text-model",
      },
      422,
    );
    await req(
      "POST",
      url + "/quote",
      { ...body, op: "scene", mode: "text", instruction: "室内背景" },
      400,
    );
    const other = await req("POST", "/api/studio/templates", {
      name: "其他款",
      preset_id: "suit",
      dna_json: dna,
    });
    const otherWs = await req(
      "GET",
      `/api/studio/templates/${other.id}/workspace`,
    );
    await req(
      "POST",
      `/api/studio/templates/${other.id}/quote`,
      {
        ...body,
        version_id: otherWs.versions[0].id,
        mode: "image",
        source: image.id,
      },
      404,
    );
  });
  await test("six distinct prompts and source lineage", async () => {
    const prompts = [];
    for (const op of [
      "create",
      "recolor",
      "detail_modify",
      "detail_shot",
      "scene",
      "variant",
    ]) {
      const detailVersion =
        op === "detail_modify"
          ? (
              await req("POST", url + "/versions", {
                parent_id: v2.id,
                dna: {
                  ...JSON.parse(v2.dna_json),
                  details: { value: ["袖口双扣"] },
                },
                request_key: randomUUID(),
              })
            ).version
          : null;
      const r = await req("POST", url + "/quote", {
        ...body,
        ...(detailVersion ? { version_id: detailVersion.id } : {}),
        op,
        mode: "image",
        source: image.id,
        instruction: "左袖口细节保持，背景改为浅灰",
        camera:
          op === "detail_shot"
            ? { ...DEFAULT_CAMERA, framing: "detail", detail: "左袖口" }
            : DEFAULT_CAMERA,
      });
      prompts.push(r.quote.prompts[0]);
      assert.equal(r.quote.style.source_generation_id, image.id);
    }
    assert.equal(new Set(prompts).size, 6);
  });
  await test("original source and auxiliary upload preserve full image bytes", async () => {
    const r = await req("POST", "/api/studio/references", {
      image_base64: raw,
    });
    const bytes = fs.readFileSync(
      path.join(process.env.DATA_DIR, r.image_path),
    );
    assert.equal(bytes.toString("base64"), raw);
    const q = (
      await req("POST", url + "/quote", {
        ...body,
        mode: "image",
        source: "original",
        references: [{ source: `ref:${r.id}`, role: "color" }],
      })
    ).quote;
    assert.equal(q.style.references.length, 1);
  });
  await test("new version without images is not populated by previous images", async () => {
    const next = { ...dna, primary_color: { value: "绿" } };
    const v = (
      await req("POST", url + "/versions", {
        parent_id: root.id,
        dna: next,
        request_key: randomUUID(),
      })
    ).version;
    ws = await req("GET", url + "/workspace");
    assert.equal(
      ws.images.filter((i) => i.design_version_id === v.id).length,
      0,
    );
  });
  await test("expired quote does not start or duplicate tasks", async () => {
    const q = (await req("POST", url + "/quote", body)).quote;
    db.prepare("UPDATE explore_quotes SET expires_at=0 WHERE id=?").run(q.id);
    await req(
      "POST",
      url + "/jobs",
      { quote_id: q.id, request_key: randomUUID(), confirm: true },
      409,
    );
  });
  await test('camera overrides and composition conflicts are persisted and validated',async()=>{
    const camera={...DEFAULT_CAMERA,view:'back',scope:'set'};
    const quoted=(await req('POST',url+'/quote',{...body,count:1,camera})).quote;
    assert.match(quoted.prompts[0],/straight back view/);assert.match(quoted.prompts[0],/matching trousers/);assert.equal(quoted.effective_prompt_extend,false);
    const started=(await req('POST',url+'/jobs',{quote_id:quoted.id,request_key:randomUUID(),confirm:true})).job;await waitJob(started.id);
    const current=await req('GET',url+'/workspace');assert.deepEqual(current.jobs[0].snapshot.camera,camera);
    await req('POST',url+'/quote',{...body,camera:{...DEFAULT_CAMERA,framing:'detail'}},400);
    await req('POST',url+'/quote',{...body,instruction:'要求近景特写'},400);
    await req('POST',url+'/quote',{...body,visual_style:'constructor'},400);
  });
  await test("restart recovery preserves uncertain results and does not auto resend", async () => {
    const q = (await req("POST", url + "/quote", body)).quote;
    const { job } = await req("POST", url + "/jobs", {
      quote_id: q.id,
      request_key: randomUUID(),
      confirm: true,
    });
    await waitJob(job.id);
    db.prepare(
      "UPDATE explore_jobs SET status='running',lease_until=0 WHERE id=?",
    ).run(job.id);
    db.prepare(
      "UPDATE explore_items SET status='running' WHERE job_id=? AND proposal_idx=0",
    ).run(job.id);
    recoverExploreJobs();
    const ws = await req("GET", url + "/workspace");
    assert.equal(ws.jobs[0].status, "interrupted");
    await req("POST", url + "/quote", body, 409);
  });
  console.log(`Style integration: ${count}/${count} passed`);
} finally {
  await new Promise((resolve) => server.close(resolve));
  closeDb();
  fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
}
