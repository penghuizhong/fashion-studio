import { cleanPlanContent } from "../../shared/stylePrompt.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import sharp from "sharp";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "style-plans-"));
Object.assign(process.env, {
  DATA_DIR: dir,
  MULTI_USER: "true",
  MOCK_LLM: "false",
  MASTER_KEY: crypto.randomBytes(32).toString("hex"),
  SESSION_SECRET: crypto.randomBytes(32).toString("hex"),
  WRITE_LIMIT_MAX: "3000",
});
const { getDb, closeDb } = await import("../src/db.js");
const { createApp } = await import("../src/app.js");
const { createProvider, createModel, updateModel } = await import(
  "../src/registry.js"
);
const { waitPlanAnalysis } = await import("../src/stylePlanAnalysis.js");
const { waitJob } = await import("../src/exploreJobs.js");
const { DETAIL_MODULES } = await import("../../shared/stylePlan.js");
const db = getDb(),
  now = new Date().toISOString(),
  originalFetch = global.fetch,
  png = await sharp({
    create: { width: 256, height: 384, channels: 3, background: "#335566" },
  })
    .png()
    .toBuffer();
let calls = [],
  broken = false,
  usageMissing = false,
  truncate = false;
global.fetch = async (url, opts = {}) => {
  if (!String(url).includes("plan-test.invalid"))
    return originalFetch(url, opts);
  calls.push({ url: String(url), body: opts.body });
  if (String(url).endsWith("/chat/completions")) {
    const body = JSON.parse(opts.body);
    const details = JSON.parse(body.messages[1].content[0].text);
    const lines = [
      {
        type: "recognition",
        references: [{ number: 1, observation: "商品图可见黑色服装与贴兜" }],
        requirements: "完整展示服装",
        conflicts: "",
      },
      { type: "standard", standard: details.standard },
      ...details.items.map((i, n) => ({
        type: "item",
        id: i.id,
        title: `规划${n + 1}`,
        requirement: `${i.requirement} 展示本款第${n + 1}个设计重点`,
        copy: "",
        spec: {
          lighting: "柔光",
          garment: "可见贴兜",
          composition: "居中完整展示",
        },
        observation: "图片可见纹理，实际成分未知",
      })),
    ];
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: broken
                ? "invalid"
                : (truncate ? lines.slice(0, 3) : lines)
                    .map((i) => JSON.stringify(i))
                    .join("\n"),
            },
          },
        ],
        ...(usageMissing
          ? {}
          : { usage: { prompt_tokens: 300, completion_tokens: 500 } }),
      }),
      { headers: { "Content-Type": "application/json" } },
    );
  }
  return new Response(
    JSON.stringify({ data: [{ b64_json: png.toString("base64") }] }),
    { headers: { "Content-Type": "application/json" } },
  );
};
for (const user of ["alice", "bob"]) {
  db.prepare(
    "INSERT INTO users(id,username,password_hash,created_at,points_balance,billing_mode,is_admin) VALUES(?,?,?,?,100000,'points',1)",
  ).run(user, user, "unused", now);
  db.prepare("INSERT INTO sessions VALUES(?,?,?)").run(
    crypto.createHash("sha256").update(user).digest("hex"),
    user,
    Date.now() + 600000,
  );
}
const p = createProvider({
  name: "Plan fixture",
  preset: "custom",
  kind: "both",
  base_url: "https://plan-test.invalid/v1",
  api_key: "fixture",
});
const chat = createModel({
  provider_id: p.id,
  kind: "chat",
  model_id: "test-chat",
  pricing: { input_per_1m: 100, output_per_1m: 200 },
  extra: { vision: true },
});
const image = createModel({
  provider_id: p.id,
  kind: "image",
  model_id: "test-image",
  pricing: {
    per_call: 5,
    image_rates: [
      { size: "*", quality: "*", per_call: 5 },
      { size: "1024x1024", quality: "high", per_call: 9 },
    ],
  },
  extra: {
    sizes: ["512x512", "1024x1024"],
    image_config: {
      protocol: "openai_images",
      text: true,
      edit: true,
      max_images: 4,
      qualities: [{ value: "high", label: "精细" }],
    },
  },
});
const server = await new Promise((r) => {
    const s = createApp().listen(0, "127.0.0.1", () => r(s));
  }),
  base = `http://127.0.0.1:${server.address().port}`;
async function req(method, url, body, status = 200, user = "alice") {
  const r = await originalFetch(base + url, {
    method,
    headers: {
      Cookie: `soulchat_session=${user}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const j = await r.json();
  assert.equal(r.status, status, JSON.stringify(j));
  return j;
}
const plans = (id) =>
  `/api/studio/templates/${template.id}/plans${id ? "/" + id : ""}`;
let n = 0;
async function test(name, fn) {
  await fn();
  console.log(`PASS ${++n}. ${name}`);
}
let template, version, plan;
const newPlan = async (modules = { main: 2 }, extra = {}) =>
  (
    await req("POST", plans(), {
      version_id: version.id,
      request_key: crypto.randomUUID(),
      input: {
        modules,
        generation_mode: "creative",
        requirements: "完整展示服装，保留原色",
        model_id: image.id,
        size: "512x512",
        analysis_model_id: chat.id,
        references: [
          { id: "reference-main", source: "original", role: "garment" },
        ],
        ...extra,
      },
    })
  ).plan;
const save = async (patch = {}) =>
  (
    await req("PUT", plans(plan.id), {
      expected_revision: plan.revision,
      ...patch,
    })
  ).plan;
const analyze = async (item_ids) => {
  const ids = item_ids || plan.content.items.map((i) => i.id),
    estimate = await req("POST", plans(plan.id) + "/analysis-estimate", {
      item_ids: ids,
    });
  const body = {
    expected_revision: plan.revision,
    estimate_signature: estimate.estimate_signature,
    request_key: crypto.randomUUID(),
    confirm: true,
    item_ids: ids,
  };
  const r = await req("POST", plans(plan.id) + "/analyze", body, 202);
  await waitPlanAnalysis(r.analysis.id);
  const result = await req("GET", plans(plan.id));
  plan = result.plan;
  return { body, analysis: result.analyses[0] };
};
try {
  const preset = (await req("GET", "/api/studio/dna-presets")).presets.find(
    (p) => p.id === "suit",
  );
  const dna = Object.fromEntries(
    preset.fields.map((f) => [
      f.key,
      { value: f.key === "details" ? ["贴兜"] : "常规", confidence: 0.8 },
    ]),
  );
  template = await req("POST", "/api/studio/templates", {
    name: "五步回归",
    preset_id: "suit",
    dna_json: dna,
    source_image_base64: png.toString("base64"),
  });
  version = (await req("GET", `/api/studio/templates/${template.id}/workspace`))
    .versions[0];
  await test("planning persists independently of immutable design versions and costs nothing", async () => {
    const count = db.prepare("SELECT COUNT(*) n FROM style_versions").get().n,
      before = calls.length;
    plan = await newPlan();
    assert.equal(plan.content.items.length, 2);
    assert.equal(plan.content.items[0].status, "needs_analysis");
    assert.equal(
      db.prepare("SELECT COUNT(*) n FROM style_versions").get().n,
      count,
    );
    assert.equal(calls.length, before);
  });
  await test("ownership and stale revisions are rejected", async () => {
    await req("GET", plans(plan.id), undefined, 404, "bob");
    await req("PUT", plans(plan.id), { expected_revision: 0 }, 409);
  });
  await test("analysis is explicit, vision aware, billed by usage and produces unique stable items", async () => {
    await req(
      "POST",
      plans(plan.id) + "/analyze",
      { expected_revision: plan.revision, request_key: crypto.randomUUID() },
      400,
    );
    const ids = plan.content.items.map((i) => i.id),
      { analysis } = await analyze();
    assert.equal(analysis.status, "succeeded");
    assert.deepEqual(
      plan.content.items.map((i) => i.id),
      ids,
    );
    assert.equal(plan.content.items[0].status, "ready");
    assert.notEqual(plan.content.items[0].prompt, plan.content.items[1].prompt);
    assert.equal(analysis.cost_actual, 1);
    assert.ok(
      calls.filter((c) => c.url.endsWith("/chat/completions")).length === 1,
    );
  });
  await test("global standards, hand overrides and targeted reanalysis preserve other work", async () => {
    const content = structuredClone(plan.content);
    content.standard.photography = "统一柔光背景";
    content.items[1].prompt_overrides.goal = "人工设定的专属目标";
    plan = await save({ content });
    const other = plan.content.items[1];
    await analyze([plan.content.items[0].id]);
    assert.equal(
      plan.content.items[1].prompt_overrides.goal,
      other.prompt_overrides.goal,
    );
    assert.ok(plan.content.items[1].prompt.includes("人工设定"));
    assert.ok(plan.content.items[0].prompt.includes("统一柔光背景"));
  });
  await test("quote freezes exact per-item prompts; changing plan invalidates unsubmitted quote", async () => {
    const quote = (
      await req("POST", plans(plan.id) + "/quote", {
        expected_revision: plan.revision,
      })
    ).quote;
    assert.deepEqual(
      quote.prompts,
      plan.content.items.map((i) => i.prompt),
    );
    const content = structuredClone(plan.content);
    content.items[0].title = "改标题";
    plan = await save({ content });
    await req(
      "POST",
      `/api/studio/templates/${template.id}/jobs`,
      { quote_id: quote.id, request_key: crypto.randomUUID(), confirm: true },
      409,
    );
  });
  await test("per-item size quality, snapshot identity and duplicate submission are exact", async () => {
    const content = structuredClone(plan.content);
    content.items[1].size = "1024x1024";
    content.items[1].quality = "high";
    plan = await save({ content });
    const quote = (
      await req("POST", plans(plan.id) + "/quote", {
        expected_revision: plan.revision,
      })
    ).quote;
    assert.equal(quote.total, 14);
    const body = {
      quote_id: quote.id,
      request_key: crypto.randomUUID(),
      confirm: true,
    };
    const job = (
      await req("POST", `/api/studio/templates/${template.id}/jobs`, body, 202)
    ).job;
    await waitJob(job.id);
    assert.equal(
      (
        await req(
          "POST",
          `/api/studio/templates/${template.id}/jobs`,
          body,
          202,
        )
      ).job.id,
      job.id,
    );
    const rows = db
      .prepare("SELECT * FROM dna_generations WHERE template_id=? ORDER BY id")
      .all(template.id);
    assert.equal(rows.length, 2);
    const first = rows.find(
        (r) =>
          JSON.parse(r.settings_json).plan_item_id === plan.content.items[0].id,
      ),
      second = rows.find(
        (r) =>
          JSON.parse(r.settings_json).plan_item_id === plan.content.items[1].id,
      );
    assert.equal(second.size, "1024x1024");
    assert.ok(first);
    assert.equal(first.prompt_snapshot, plan.content.items[0].prompt);
  });
  await test("required product facts are pending rather than fabricated; missing selected items cannot quote", async () => {
    plan = await newPlan({ brand: 1, color_size: 1 });
    await analyze();
    assert.equal(plan.content.items[0].status, "needs_info");
    await req(
      "POST",
      plans(plan.id) + "/quote",
      {
        expected_revision: plan.revision,
        item_ids: plan.content.items.map((i) => i.id),
      },
      422,
    );
    plan = await save({
      input: {
        ...plan.input,
        facts: { brand: "用户确认品牌", sizes: "M：胸围100cm" },
      },
    });
    assert.equal(plan.content.items[0].status, "ready");
  });
  await test("flat, hanger and detail templates have compatible distinct composition", async () => {
    plan = await newPlan({ flat: 1, hanger: 1, fabric: 1 });
    await analyze();
    assert.equal(
      plan.content.items.find((i) => i.module_id === "flat").camera.angle,
      "overhead",
    );
    assert.equal(
      plan.content.items.find((i) => i.module_id === "fabric").camera.framing,
      "detail",
    );
    assert.ok(
      plan.content.items
        .find((i) => i.module_id === "hanger")
        .prompt.includes("衣架"),
    );
  });
  await test("nineteen-module plans and sixty-four-item boundary are supported without altering creative caps", async () => {
    plan = await newPlan(
      Object.fromEntries(DETAIL_MODULES.map((m) => [m.id, 1])),
      {
        facts: Object.fromEntries(
          [
            "brand",
            "sizes",
            "colors",
            "promotion",
            "specs",
            "care",
            "service",
            "faq",
          ].map((k) => [k, "用户确认资料"]),
        ),
      },
    );
    await analyze();
    assert.equal(plan.content.items.length, 19);
    const q = (
      await req("POST", plans(plan.id) + "/quote", {
        expected_revision: plan.revision,
      })
    ).quote;
    assert.equal(q.indexes.length, 19);
    plan = await newPlan({ main: 16, selling: 16, cut: 16, scene: 16 });
    await analyze();
    const q64 = (
      await req("POST", plans(plan.id) + "/quote", {
        expected_revision: plan.revision,
      })
    ).quote;
    assert.equal(q64.indexes.length, 64);
    await req(
      "POST",
      plans(),
      {
        version_id: version.id,
        request_key: crypto.randomUUID(),
        input: {
          modules: { main: 16, selling: 16, cut: 16, scene: 16, flat: 1 },
        },
      },
      400,
    );
  });
  await test("failed analysis refunds confirmed failure and retains prior plan", async () => {
    plan = await newPlan();
    broken = true;
    const before = plan.revision,
      { analysis } = await analyze();
    broken = false;
    assert.equal(analysis.status, "failed");
    assert.equal(plan.revision, before);
    assert.equal(analysis.reserved, 0);
  });
  await test("analysis response loss reuses the same request after its revision advances", async () => {
    plan = await newPlan();
    const before = calls.length,
      { body, analysis } = await analyze();
    const reused = (await req("POST", plans(plan.id) + "/analyze", body, 202))
      .analysis;
    assert.equal(reused.id, analysis.id);
    assert.equal(calls.length, before + 1);
  });
  await test("analysis price/configuration changes require reconfirmation before reserving funds", async () => {
    plan = await newPlan();
    const estimate = await req(
        "POST",
        plans(plan.id) + "/analysis-estimate",
        {},
      ),
      before = calls.length;
    updateModel(chat.id, {
      pricing: { input_per_1m: 300, output_per_1m: 400 },
    });
    await req(
      "POST",
      plans(plan.id) + "/analyze",
      {
        expected_revision: plan.revision,
        estimate_signature: estimate.estimate_signature,
        request_key: crypto.randomUUID(),
        confirm: true,
      },
      409,
    );
    assert.equal(calls.length, before);
    updateModel(chat.id, {
      pricing: { input_per_1m: 100, output_per_1m: 200 },
    });
  });
  await test("missing upstream usage stays uncertain until explicit admin reconciliation", async () => {
    plan = await newPlan();
    usageMissing = true;
    const { analysis } = await analyze();
    usageMissing = false;
    assert.equal(analysis.status, "uncertain");
    assert.ok(analysis.reserved > 0);
    await req(
      "PUT",
      plans(plan.id),
      { expected_revision: plan.revision, input: plan.input },
      409,
    );
    await req(
      "POST",
      `/api/admin/explore-expansions/${encodeURIComponent(analysis.id)}/resolve`,
      {
        confirmed_failed: true,
        note: "已人工核对测试供应商记录确认未产生实际收费",
      },
    );
    plan = await save({
      input: { ...plan.input, requirements: "核对后重新规划" },
    });
  });
  await test("partial structured analysis can be adopted and missing items reanalyzed independently", async () => {
    plan = await newPlan();
    truncate = true;
    const { analysis } = await analyze();
    truncate = false;
    assert.equal(analysis.status, "failed");
    assert.equal(analysis.progress.completed, 1);
    const r = await req("POST", plans(plan.id) + "/apply-analysis", {
      analysis_id: analysis.id,
      expected_revision: plan.revision,
    });
    plan = r.plan;
    const first = plan.content.items[0].prompt;
    assert.equal(plan.content.items[0].status, "ready");
    assert.equal(plan.content.items[1].status, "needs_analysis");
    await analyze([plan.content.items[1].id]);
    assert.equal(plan.content.items[0].prompt, first);
  });
  await test("create idempotency, revision snapshots and manual-copy boundaries do not duplicate records", async () => {
    const key = crypto.randomUUID(),
      input = {
        generation_mode: "creative",
        modules: { main: 1 },
        model_id: image.id,
        size: "512x512",
        analysis_model_id: chat.id,
      },
      body = { version_id: version.id, request_key: key, input };
    const created = await req("POST", plans(), body),
      again = await req("POST", plans(), body);
    assert.equal(created.plan.id, again.plan.id);
    await req(
      "POST",
      plans(),
      { ...body, input: { ...input, modules: { main: 2 } } },
      409,
    );
    plan = created.plan;
    const previous = db
      .prepare(
        "SELECT content_json FROM style_plan_revisions WHERE plan_id=? AND revision=1",
      )
      .get(plan.id).content_json;
    const content = structuredClone(plan.content);
    content.items[0].manual_confirmed = true;
    content.items[0].requirement = "人工确认完整正面图";
    plan = await save({ content });
    assert.equal(plan.content.items[0].status, "ready");
    assert.equal(
      db
        .prepare(
          "SELECT content_json FROM style_plan_revisions WHERE plan_id=? AND revision=1",
        )
        .get(plan.id).content_json,
      previous,
    );
    content.items[0].prompt_overrides = { output: "伪造尺寸" };
    await req(
      "PUT",
      plans(plan.id),
      { expected_revision: plan.revision, content },
      400,
    );
  });
  await test("reference ownership and duplicate aliases are rejected before any provider call", async () => {
    const ref = await req(
      "POST",
      "/api/studio/references",
      { image_base64: png.toString("base64") },
      200,
      "bob",
    );
    const before = calls.length;
    await req(
      "POST",
      plans(),
      {
        version_id: version.id,
        request_key: crypto.randomUUID(),
        input: {
          modules: { main: 1 },
          references: [
            { id: "foreign-ref", source: `ref:${ref.id}`, role: "garment" },
          ],
        },
      },
      404,
    );
    await req(
      "POST",
      plans(),
      {
        version_id: version.id,
        request_key: crypto.randomUUID(),
        input: {
          modules: { main: 1 },
          references: [
            { id: "duplicate-one", source: "original", role: "garment" },
            { id: "duplicate-two", source: "original", role: "model" },
          ],
        },
      },
      400,
    );
    assert.equal(calls.length, before);
  });
  await test("a sixty-four-image plan executes through the bounded queue and retains unique item identity", async () => {
    plan = await newPlan({ main: 16, selling: 16, cut: 16, scene: 16 });
    await analyze();
    const quote = (
      await req("POST", plans(plan.id) + "/quote", {
        expected_revision: plan.revision,
      })
    ).quote;
    const job = (
      await req(
        "POST",
        `/api/studio/templates/${template.id}/jobs`,
        { quote_id: quote.id, request_key: crypto.randomUUID(), confirm: true },
        202,
      )
    ).job;
    const finished = await waitJob(job.id);
    assert.equal(finished.status, "succeeded");
    assert.equal(finished.renders.length, 64);
    const rows = db
      .prepare(
        "SELECT settings_json FROM dna_generations WHERE json_extract(settings_json,'$.plan_id')=?",
      )
      .all(plan.id);
    assert.equal(rows.length, 64);
    assert.equal(
      new Set(rows.map((r) => JSON.parse(r.settings_json).plan_item_id)).size,
      64,
    );
  });
  await test("compiled prompts use natural language, dedicated templates, style and confirmed facts", async () => {
    plan = await newPlan(
      { main: 1 },
      { style: "luxury", facts: { brand: "樱紫" } },
    );
    await analyze();
    const item = plan.content.items[0];
    assert.match(item.prompt, /版型为常规/);
    assert.doesNotMatch(item.prompt, /confidence|"value"|dna_json/);
    assert.match(item.prompt, /专用画面规则/);
    assert.match(item.prompt, /refined materials/);
    assert.match(item.prompt, /用户生成需求：完整展示服装/);
    assert.match(item.prompt, /## 整体设计规范/);
    assert.match(item.prompt, /品牌资料：樱紫/);
    assert.ok(!item.prompt.includes(item.id));
    const call = calls
      .filter((c) => c.url.endsWith("/chat/completions"))
      .at(-1);
    const details = JSON.parse(
      JSON.parse(call.body).messages[1].content[0].text,
    );
    assert.match(details.version.garment_description, /版型为常规/);
    assert.ok(details.items[0].prompt_template.includes("主图展示"));
    assert.match(details.style_prompt, /refined materials/);
  });
  await test("browser save payload retains full prompts and analyzed specs; upstream changes require synchronization", async () => {
    const originalSpec = plan.content.items[0].spec;
    const content = cleanPlanContent(plan.content);
    content.items[0].prompt_override = "人工最终提示词：展示黑色西装";
    plan = await save({ content });
    assert.equal(
      plan.content.items[0].prompt,
      content.items[0].prompt_override,
    );
    assert.deepEqual(plan.content.items[0].spec, originalSpec);
    assert.equal(plan.content.items[0].prompt_stale, false);
    const legacy = cleanPlanContent(plan.content);
    delete legacy.items[0].spec;
    plan = await save({ content: legacy });
    assert.deepEqual(plan.content.items[0].spec, originalSpec);
    const next = cleanPlanContent(plan.content);
    next.standard.photography = "修改为侧逆光";
    plan = await save({ content: next });
    assert.equal(plan.content.items[0].prompt_stale, true);
    await req(
      "POST",
      plans(plan.id) + "/quote",
      { expected_revision: plan.revision },
      422,
    );
    const confirmed = cleanPlanContent(plan.content);
    confirmed.items[0].prompt_override_basis =
      plan.content.items[0].automatic_signature;
    plan = await save({ content: confirmed });
    assert.equal(plan.content.items[0].prompt_stale, false);
    const quote = (
      await req("POST", plans(plan.id) + "/quote", {
        expected_revision: plan.revision,
      })
    ).quote;
    assert.deepEqual(quote.prompts, ["人工最终提示词：展示黑色西装"]);
  });
  await test("reanalysis leaves manual drafts untouched until an explicit adoption", async () => {
    const before = structuredClone(plan);
    const { analysis } = await analyze();
    assert.equal(analysis.progress.review_required, true);
    assert.equal(plan.revision, before.revision);
    assert.equal(plan.content.items[0].prompt, before.content.items[0].prompt);
    plan = (
      await req("POST", plans(plan.id) + "/apply-analysis", {
        analysis_id: analysis.id,
        expected_revision: plan.revision,
        replace_manual: true,
      })
    ).plan;
    assert.equal(plan.content.items[0].prompt_override, "");
    assert.match(plan.content.items[0].prompt, /侧逆光/);
    assert.equal(plan.content.items[0].prompt_stale, false);
    const next = cleanPlanContent(plan.content);
    next.items[0].prompt_override = "另一次手工修改";
    plan = await save({ content: next });
    const review = await analyze();
    plan = (
      await req("POST", plans(plan.id) + "/apply-analysis", {
        analysis_id: review.analysis.id,
        expected_revision: plan.revision,
        replace_manual: false,
      })
    ).plan;
    assert.equal(plan.content.items[0].prompt, "另一次手工修改");
  });
  await test("product mode blocks text-only analysis and generation, while creative tasks stay separate", async () => {
    plan = await newPlan(
      { main: 1 },
      { generation_mode: "product", references: [] },
    );
    await req("POST", plans(plan.id) + "/analysis-estimate", {}, 422);
    await req(
      "POST",
      plans(plan.id) + "/quote",
      { expected_revision: plan.revision },
      422,
    );
    assert.match(plan.content.items[0].policy_issues.join(" "), /缺少商品原图/);
    plan = await newPlan(
      { main: 1 },
      { generation_mode: "creative", references: [] },
    );
    await analyze();
    await req("POST", plans(plan.id) + "/quote", {
      expected_revision: plan.revision,
    });
  });
  let productMainGeneration;
  await test("real product bytes, role order and digests reach edits and remain inspectable in results", async () => {
    plan = await newPlan({ main: 1 }, { generation_mode: "product" });
    await analyze();
    assert.match(plan.content.items[0].prompt, /无新增文字|不添加新文字/);
    const quote = (
      await req("POST", plans(plan.id) + "/quote", {
        expected_revision: plan.revision,
      })
    ).quote;
    const manifest = quote.style.item_contexts[0].source_manifest;
    assert.equal(manifest.length, 1);
    assert.equal(
      manifest[0].sha256,
      crypto.createHash("sha256").update(png).digest("hex"),
    );
    const job = (
      await req(
        "POST",
        `/api/studio/templates/${template.id}/jobs`,
        { quote_id: quote.id, request_key: crypto.randomUUID(), confirm: true },
        202,
      )
    ).job;
    const finished = await waitJob(job.id);
    assert.equal(finished.status, "succeeded");
    const imageCall = calls
      .filter((c) => c.url.endsWith("/images/edits"))
      .at(-1);
    const uploaded = imageCall.body.get("image");
    assert.deepEqual(Buffer.from(await uploaded.arrayBuffer()), png);
    assert.equal(
      finished.renders[0].request_trace.source_manifest[0].sha256,
      manifest[0].sha256,
    );
    assert.equal(finished.renders[0].review.status, "pending");
    productMainGeneration = finished.renders[0].generation_id;
  });
  await test("fact conflicts and risky directions require acknowledgement tied to the current source revision", async () => {
    const row = db
      .prepare("SELECT content_json FROM style_plans WHERE id=?")
      .get(plan.id);
    const content = JSON.parse(row.content_json);
    content.reference_conflicts = "已保存颜色与原图不一致，请核对";
    db.prepare("UPDATE style_plans SET content_json=? WHERE id=?").run(
      JSON.stringify(content),
      plan.id,
    );
    plan = (await req("GET", plans(plan.id))).plan;
    assert.ok(
      plan.content.items[0].policy_issues.some((v) => v.includes("冲突")),
    );
    await req(
      "POST",
      plans(plan.id) + "/quote",
      { expected_revision: plan.revision },
      422,
    );
    const fixed = cleanPlanContent(plan.content);
    fixed.conflict_ack = plan.content.items[0].conflict_signature;
    plan = await save({ content: fixed });
    await req("POST", plans(plan.id) + "/quote", {
      expected_revision: plan.revision,
    });
    const stale = cleanPlanContent(plan.content);
    stale.conflict_ack = "old-revision";
    plan = await save({ content: stale });
    await req(
      "POST",
      plans(plan.id) + "/quote",
      { expected_revision: plan.revision },
      422,
    );
    const restored = cleanPlanContent(plan.content);
    restored.conflict_ack = plan.content.items[0].conflict_signature;
    plan = await save({ content: restored });
    const originalRequirements = plan.input.requirements;
    plan = await save({
      input: { ...plan.input, requirements: "裙摆飞扬，增加动态模糊" },
    });
    assert.ok(plan.content.items[0].quality_warnings.length > 0);
    await req(
      "POST",
      plans(plan.id) + "/quote",
      { expected_revision: plan.revision },
      422,
    );
    const risk = cleanPlanContent(plan.content);
    risk.items[0].manual_confirmed = true;
    risk.items[0].risk_ack = plan.content.items[0].risk_signature;
    plan = await save({ content: risk });
    await req("POST", plans(plan.id) + "/quote", {
      expected_revision: plan.revision,
    });
    plan = await save({
      input: { ...plan.input, requirements: originalRequirements },
    });
    const confirmed = cleanPlanContent(plan.content);
    confirmed.items[0].manual_confirmed = true;
    plan = await save({ content: confirmed });
  });
  await test("changed source bytes invalidate a quote before billing or provider calls", async () => {
    const quote = (
      await req("POST", plans(plan.id) + "/quote", {
        expected_revision: plan.revision,
      })
    ).quote;
    const file = path.join(dir, quote.style.source_path),
      before = calls.length;
    fs.writeFileSync(file, await sharp(png).negate().png().toBuffer());
    await req(
      "POST",
      `/api/studio/templates/${template.id}/jobs`,
      { quote_id: quote.id, request_key: crypto.randomUUID(), confirm: true },
      409,
    );
    assert.equal(calls.length, before);
    fs.writeFileSync(file, png);
  });
  await test("source composition renders exact text and source crops without any image-model request or charge", async () => {
    plan = await newPlan({ selling: 1 }, { generation_mode: "product" });
    const content = cleanPlanContent(plan.content);
    content.items[0].manual_confirmed = true;
    content.items[0].layout = {
      headline: "款式特点",
      subtitle: "原图细节",
      main_reference_id: "reference-main",
      main_crop: { x: 0, y: 0, width: 1, height: 1 },
      details: [
        {
          title: "可见纹理",
          body: "仅展示原图可见内容",
          reference_id: "reference-main",
          crop: { x: 0.1, y: 0.1, width: 0.5, height: 0.5 },
          confirmed: true,
        },
      ],
    };
    plan = await save({ content });
    assert.equal(plan.content.items[0].status, "ready");
    const preview = await req(
      "POST",
      plans(plan.id) + `/items/${plan.content.items[0].id}/composition-preview`,
      { expected_revision: plan.revision },
    );
    const before = calls.length,
      quote = (
        await req("POST", plans(plan.id) + "/quote", {
          expected_revision: plan.revision,
        })
      ).quote;
    assert.equal(quote.total, 0);
    const job = (
      await req(
        "POST",
        `/api/studio/templates/${template.id}/jobs`,
        { quote_id: quote.id, request_key: crypto.randomUUID(), confirm: true },
        202,
      )
    ).job;
    const finished = await waitJob(job.id);
    assert.equal(finished.status, "succeeded");
    assert.equal(finished.cost_actual, 0);
    assert.equal(calls.length, before);
    const result = finished.renders[0];
    assert.equal(result.model, "source-compositor-v1");
    assert.equal(
      result.provenance.layout.details[0].body,
      "仅展示原图可见内容",
    );
    assert.deepEqual(
      fs.readFileSync(path.join(dir, result.image_path)),
      Buffer.from(preview.image_base64, "base64"),
    );
  });
  await test("composition requires source confirmation, valid crops and readable typography", async () => {
    const original = cleanPlanContent(plan.content),
      changed = structuredClone(original);
    changed.items[0].layout.details[0].confirmed = false;
    plan = await save({ content: changed });
    await req(
      "POST",
      plans(plan.id) + "/quote",
      { expected_revision: plan.revision },
      422,
    );
    const invalid = structuredClone(original);
    invalid.items[0].layout.details[0].crop.width = 2;
    await req(
      "PUT",
      plans(plan.id),
      { expected_revision: plan.revision, content: invalid },
      400,
    );
    plan = await save({ content: original });
    const lowContrast = cleanPlanContent(plan.content);
    lowContrast.items[0].layout.color = lowContrast.items[0].layout.background;
    plan = await save({ content: lowContrast });
    const unreadable = await req(
      "POST",
      plans(plan.id) + "/quote",
      { expected_revision: plan.revision },
      400,
    );
    assert.equal(unreadable.code, "LOW_TEXT_CONTRAST");
    plan = await save({ content: original });
    const overflow = cleanPlanContent(plan.content);
    overflow.items[0].layout.headline =
      "无法显示的字符" + String.fromCodePoint(0x10ffff);
    plan = await save({ content: overflow });
    await req(
      "POST",
      plans(plan.id) + "/quote",
      { expected_revision: plan.revision },
      400,
    );
    plan = await save({ content: original });
  });
  await test("reviews are private and revisioned, and generated hero reuse requires all checks", async () => {
    const reviewPath = `/api/studio/templates/${template.id}/images/${productMainGeneration}/review`;
    await req("GET", reviewPath, undefined, 404, "bob");
    await req(
      "POST",
      reviewPath,
      { expected_revision: 0, checks: { structure: false }, note: "" },
      400,
    );
    const checks = Object.fromEntries(
      [
        "structure",
        "color",
        "material",
        "pattern",
        "identity",
        "composition",
        "text",
      ].map((k) => [k, true]),
    );
    const rejected = await req("POST", reviewPath, {
      expected_revision: 0,
      checks: { ...checks, structure: false },
      note: "领口需修改",
    });
    assert.equal(rejected.review.status, "rejected");
    const source = {
      id: "reviewed-image-source",
      source: String(productMainGeneration),
      role: "garment",
    };
    plan = await newPlan(
      { selling: 1 },
      {
        generation_mode: "product",
        references: [
          { id: "reference-main", source: "original", role: "garment" },
          source,
        ],
      },
    );
    const content = cleanPlanContent(plan.content);
    content.items[0].manual_confirmed = true;
    content.items[0].layout = {
      headline: "款式特点",
      main_reference_id: source.id,
      main_crop: { x: 0, y: 0, width: 1, height: 1 },
      details: [
        {
          title: "原图局部",
          body: "结构对照",
          reference_id: "reference-main",
          crop: { x: 0, y: 0, width: 0.5, height: 0.5 },
          confirmed: true,
        },
      ],
    };
    plan = await save({ content });
    await req(
      "POST",
      plans(plan.id) + "/quote",
      { expected_revision: plan.revision },
      422,
    );
    const accepted = await req("POST", reviewPath, {
      expected_revision: 1,
      checks,
      note: "原图逐项核对通过",
    });
    assert.equal(accepted.review.status, "accepted");
    await req(
      "POST",
      reviewPath,
      { expected_revision: 1, checks, note: "" },
      409,
    );
    await req("POST", plans(plan.id) + "/quote", {
      expected_revision: plan.revision,
    });
    assert.equal(
      db
        .prepare(
          "SELECT COUNT(*) n FROM style_image_reviews WHERE generation_id=?",
        )
        .get(productMainGeneration).n,
      2,
    );
  });
  await test("benchmark dry run prepares nine comparisons and rejects overspending without invoking providers", async () => {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const run = promisify(execFile),
      manifestFile = path.join(dir, "benchmark-fixtures.json"),
      reportFile = path.join(dir, "benchmark-report.json");
    fs.writeFileSync(
      manifestFile,
      JSON.stringify({
        fixtures: ["fixture-1", "fixture-2", "fixture-3"].map((name) => ({
          name,
          template_id: template.id,
          critical_points: ["领口"],
        })),
        configurations: [{ model_id: image.id, size: "1024x1024" }],
      }),
    );
    const script = new URL("./benchmark-product-images.js", import.meta.url)
      .pathname;
    const args = [
      script,
      "--manifest",
      manifestFile,
      "--output",
      reportFile,
      "--base-url",
      base,
    ];
    const env = { ...process.env, BENCHMARK_COOKIE: "soulchat_session=alice" };
    const before = calls.length,
      jobs = db.prepare("SELECT COUNT(*) n FROM explore_jobs").get().n;
    await run(process.execPath, args, { env });
    const report = JSON.parse(fs.readFileSync(reportFile));
    assert.equal(report.runs.length, 9);
    assert.ok(report.estimated_total > 0);
    assert.ok(
      report.runs.every((r) => r.source_manifest[0].sha256 && r.prompt),
    );
    await assert.rejects(
      () =>
        run(
          process.execPath,
          [...args, "--resume", "--execute", "--max-points", "0"],
          { env },
        ),
      /总预计积分超过上限/,
    );
    assert.equal(calls.length, before);
    assert.equal(
      db.prepare("SELECT COUNT(*) n FROM explore_jobs").get().n,
      jobs,
    );
    assert.ok(
      !fs.readFileSync(reportFile, "utf8").includes("soulchat_session"),
    );
  });
  await test("migration is repeatable and leaves original and historical files intact", async () => {
    const file = getDb()
      .prepare("SELECT source_image_path FROM style_dna_templates WHERE id=?")
      .get(template.id).source_image_path;
    assert.deepEqual(fs.readFileSync(path.join(dir, file)), png);
    const count = db.prepare("SELECT COUNT(*) n FROM style_plans").get().n;
    closeDb();
    assert.equal(
      getDb().prepare("SELECT COUNT(*) n FROM style_plans").get().n,
      count,
    );
    assert.deepEqual(fs.readFileSync(path.join(dir, file)), png);
  });
  console.log(`Style plans: ${n}/${n} passed`);
} finally {
  global.fetch = originalFetch;
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  closeDb();
  fs.rmSync(dir, { recursive: true, force: true });
}
