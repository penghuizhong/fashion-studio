// Opt-in comparison runner. Dry runs never call image models. No credentials are written to reports.
import fs from "node:fs";
import crypto from "node:crypto";
import { PRODUCT_CHECKS } from "../../shared/productImagePolicy.js";
const args = process.argv.slice(2),
  flag = (k) => args.includes(k),
  option = (k, f) => (args.includes(k) ? args[args.indexOf(k) + 1] : f);
if (flag("--help") || !option("--manifest")) {
  console.log(
    "node scripts/benchmark-product-images.js --manifest comparison.json --output report.json [--base-url http://localhost:3100] [--execute --max-points 100] [--resume]\n默认只创建无费用的测试规划和报价。实际调用必须同时指定 --execute 和总积分上限。多用户会话使用 BENCHMARK_COOKIE 或 BENCHMARK_TOKEN 环境变量。",
  );
  process.exit(flag("--help") ? 0 : 1);
}
const base = option("--base-url", "http://127.0.0.1:3100").replace(/\/$/, ""),
  output = option("--output", "product-image-comparison.json");
if (fs.existsSync(output) && !flag("--resume"))
  throw new Error("报告已存在，请使用 --resume 续跑或另选输出文件");
const execute = flag("--execute"),
  limit = Number(option("--max-points", NaN));
if (execute && (!Number.isSafeInteger(limit) || limit < 0))
  throw new Error("实际测试必须明确指定 --max-points 总积分上限");
const manifest = JSON.parse(fs.readFileSync(option("--manifest"), "utf8"));
if (
  !Array.isArray(manifest.fixtures) ||
  manifest.fixtures.length !== 3 ||
  !Array.isArray(manifest.configurations) ||
  !manifest.configurations.length
)
  throw new Error("请提供3个固定样本和至少1个模型配置");
if (new Set(manifest.configurations.map((c) => c.size)).size !== 1)
  throw new Error("同组比较必须使用相同尺寸；尺寸比较请另建测试组");
async function api(method, url, body) {
  const response = await fetch(base + url, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(process.env.BENCHMARK_COOKIE
        ? { Cookie: process.env.BENCHMARK_COOKIE }
        : {}),
      ...(process.env.BENCHMARK_TOKEN
        ? { Authorization: "Bearer " + process.env.BENCHMARK_TOKEN }
        : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await response.json();
  if (!response.ok) throw new Error(json.error || `HTTP ${response.status}`);
  return json;
}
const manifestHash = crypto
  .createHash("sha256")
  .update(JSON.stringify(manifest))
  .digest("hex");
let report = flag("--resume")
  ? JSON.parse(fs.readFileSync(output, "utf8"))
  : {
      created_at: new Date().toISOString(),
      manifest_hash: manifestHash,
      base_url: base,
      manifest,
      checks: PRODUCT_CHECKS,
      runs: [],
    };
if (report.manifest_hash !== manifestHash || report.base_url !== base)
  throw new Error("续跑的样本、配置和服务地址必须与原报告一致");
const save = () =>
  fs.writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
for (const [f, fixture] of manifest.fixtures.entries())
  for (const [c, configuration] of manifest.configurations.entries())
    for (let n = 0; n < 3; n++) {
      const key = `${f}:${c}:${n}`;
      if (report.runs.some((r) => r.key === key)) continue;
      const workspace = await api(
        "GET",
        `/api/studio/templates/${fixture.template_id}/workspace`,
      );
      if (!workspace.template.source_available)
        throw new Error(`样本${fixture.name}缺少有效原图`);
      const refs = [
        { id: "benchmark-garment", source: "original", role: "garment" },
        ...(fixture.model_source
          ? [
              {
                id: "benchmark-model",
                source: fixture.model_source,
                role: "model",
              },
            ]
          : []),
      ];
      let plan = (
        await api(
          "POST",
          `/api/studio/templates/${fixture.template_id}/plans`,
          {
            version_id:
              fixture.version_id || workspace.template.work_version_id,
            request_key: crypto.randomUUID(),
            input: {
              modules: { main: 1 },
              generation_mode: "product",
              references: refs,
              requirements:
                manifest.instruction ||
                "完整展示同款服装，保留商品原有结构、颜色和图案；自然站姿，简洁背景，无新增文字和拼图。",
              model_id: configuration.model_id,
              size: configuration.size,
              quality: configuration.quality || "",
            },
          },
        )
      ).plan;
      plan.content.items[0].manual_confirmed = true;
      plan.content.items[0].description_prompt = manifest.instruction ||
        "主图展示：一位模特自然站立，完整展示商品，保持原图裙摆形态，简洁背景，无新增文字或拼图。商品图约束服装，模特图仅约束人物。";
      plan.content.items[0].attributes_prompt =
        "保留商品参考图可见的结构、颜色、图案、褶皱和面料外观；不根据文字重新设计或补造不可见细节。";
      plan = (
        await api(
          "PUT",
          `/api/studio/templates/${fixture.template_id}/plans/${plan.id}`,
          { expected_revision: plan.revision, content: plan.content },
        )
      ).plan;
      const quote = (
        await api(
          "POST",
          `/api/studio/templates/${fixture.template_id}/plans/${plan.id}/quote`,
          { expected_revision: plan.revision },
        )
      ).quote;
      report.runs.push({
        key,
        fixture: fixture.name,
        critical_points: fixture.critical_points,
        template_id: fixture.template_id,
        plan_id: plan.id,
        plan_revision: plan.revision,
        configuration,
        estimated_points: quote.total,
        source_manifest: quote.style.item_contexts[0].source_manifest,
        prompt: quote.prompts[0],
        request_key: crypto.randomUUID(),
        status: "prepared",
        checks: {},
        repair_notes: "",
        repair_minutes: null,
      });
      save();
    }
report.estimated_total = report.runs.reduce(
  (sum, r) => sum + r.estimated_points,
  0,
);
save();
console.log(
  `已准备 ${report.runs.length} 次对照，预计 ${report.estimated_total} 积分；报告：${output}`,
);
if (!execute) {
  console.log("仅准备规划和报价，未调用付费图像模型。");
  process.exit(0);
}
if (report.estimated_total > limit)
  throw new Error("总预计积分超过上限，未开始新调用；调整配置或总预算后续跑");
let reserved = report.runs
  .filter((r) => r.submission)
  .reduce((sum, r) => sum + (r.submitted_points || 0), 0);
for (const run of report.runs) {
  if (
    run.status === "succeeded" ||
    run.status === "failed" ||
    run.status === "uncertain"
  )
    continue;
  if (!run.job_id) {
    if (!run.submission) {
      const quote = (
        await api(
          "POST",
          `/api/studio/templates/${run.template_id}/plans/${run.plan_id}/quote`,
          { expected_revision: run.plan_revision },
        )
      ).quote;
      if (reserved + quote.total > limit)
        throw new Error("最新报价超过剩余预算，已保存进度");
      run.submission = {
        quote_id: quote.id,
        request_key: run.request_key,
        confirm: true,
      };
      run.submitted_points = quote.total;
      reserved += quote.total;
      save();
    }
    const started = await api(
      "POST",
      `/api/studio/templates/${run.template_id}/jobs`,
      run.submission,
    );
    run.job_id = started.job.id;
    run.started_at = new Date().toISOString();
    save();
  }
  const deadline = Date.now() + 12 * 60 * 1000;
  while (Date.now() < deadline) {
    const { job } = await api(
      "GET",
      `/api/studio/templates/${run.template_id}/jobs/${run.job_id}`,
    );
    if (!["running", "queued"].includes(job.status)) {
      run.status = job.status;
      run.actual_points = job.cost_actual;
      run.elapsed_seconds = (Date.now() - Date.parse(run.started_at)) / 1000;
      run.results = job.renders.map((r) => ({
        image_path: r.image_path,
        code: r.code,
        request_trace: r.request_trace,
        generation_id: r.generation_id,
      }));
      save();
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  if (!["succeeded", "failed"].includes(run.status)) {
    save();
    throw new Error(
      "结果待核对，停止后续调用；报告保留原任务ID，禁止盲目重复调用",
    );
  }
  console.log(`${run.fixture} ${run.configuration.model_id}: ${run.status}`);
}
console.log(
  "生成完成。请对照原图填写逐项验收、返修原因与返修时间；不得以API成功替代质量验收。",
);
