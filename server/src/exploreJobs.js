import fs from "node:fs";
import path from "node:path";
import { recordStyleImage } from "./styleVersions.js";
import {
  normalizeCamera,
  validateCameraIntent,
} from "../../shared/photography.js";
import { randomUUID } from "node:crypto";
import { getDb } from "./db.js";
import { getConfig } from "./config.js";
import { addLedger } from "./points.js";
import { renderDnaPrompt, generateImage, saveStudioImage } from "./image.js";
import { resolveExploreModel, publicModel } from "./exploreModels.js";
import { problem, upstreamProblem } from "./exploreErrors.js";

export function parseIndexes(input, length) {
  if (!Array.isArray(input) || !input.length)
    throw problem("INVALID_SELECTION", "请至少选择一个候选");
  if (
    input.some((i) => !Number.isInteger(i) || i < 0 || i >= length) ||
    new Set(input).size !== input.length
  )
    throw problem(
      "INVALID_SELECTION",
      "候选序号必须唯一、为有效整数且不能越界",
    );
  return [...input].sort((a, b) => a - b);
}
const stamp = () => new Date().toISOString();
const owner = (req) => req.userId || "local";
export function requireBatch(id, req) {
  const db = getDb();
  const b = getConfig().multiUser
    ? db
        .prepare("SELECT * FROM exploration_batches WHERE id=? AND user_id=?")
        .get(id, owner(req))
    : db.prepare("SELECT * FROM exploration_batches WHERE id=?").get(id);
  if (!b || b.workflow_kind === "style")
    throw problem("BATCH_NOT_FOUND", "批次不存在", 404);
  return b;
}
function items(jobId) {
  return getDb()
    .prepare("SELECT * FROM explore_items WHERE job_id=? ORDER BY proposal_idx")
    .all(jobId);
}
export function jobView(id) {
  const j = getDb().prepare("SELECT * FROM explore_jobs WHERE id=?").get(id);
  if (!j) return null;
  const rows = items(id);
  return {
    id: j.id,
    batch_id: j.batch_id,
    status: j.status,
    created_at: j.created_at,
    snapshot: JSON.parse(j.snapshot_json),
    renders: rows.map((i) => ({
      ...JSON.parse(i.result_json),
      status: i.status,
      item_id: i.id,
    })),
    completed: rows.filter((i) => !["queued", "running"].includes(i.status))
      .length,
    total: rows.length,
    reserved_total: rows.reduce((n, i) => n + i.reserved, 0),
    cost_actual: rows.reduce(
      (n, i) =>
        n +
        (i.status === "succeeded" ? JSON.parse(i.result_json).price || 0 : 0),
      0,
    ),
  };
}
export function syncBatch(batchId) {
  const db = getDb();
  const all = db
    .prepare(
      "SELECT i.* FROM explore_items i JOIN explore_jobs j ON j.id=i.job_id WHERE j.batch_id=? ORDER BY j.created_at,j.rowid",
    )
    .all(batchId);
  const latest = new Map();
  for (const i of all) {
    const r = { ...JSON.parse(i.result_json), status: i.status, item_id: i.id };
    // A failed new attempt must not erase an earlier usable image.
    if (
      !latest.has(i.proposal_idx) ||
      i.status === "succeeded" ||
      latest.get(i.proposal_idx).status !== "succeeded"
    )
      latest.set(i.proposal_idx, r);
  }
  const active = db
    .prepare("SELECT 1 FROM explore_jobs WHERE batch_id=? AND status='running'")
    .get(batchId);
  const results = [...latest.values()];
  db.prepare(
    "UPDATE exploration_batches SET renders_json=?,status=?,cost_actual=?,updated_at=? WHERE id=?",
  ).run(
    JSON.stringify(results),
    active ? "rendering" : "rendered",
    all.reduce(
      (n, i) =>
        n +
        (i.status === "succeeded" ? JSON.parse(i.result_json).price || 0 : 0),
      0,
    ),
    stamp(),
    batchId,
  );
}
function release(item, job) {
  if (item.reserved > 0)
    addLedger(
      job.user_id,
      item.reserved,
      "explore_release",
      "explore_item",
      item.id,
    );
}
// Never retry an interrupted upstream request automatically: the provider may have charged it.
export function recoverExploreJobs() {
  const db = getDb();
  db.transaction(() => {
    db.prepare(
      "DELETE FROM explore_quotes WHERE expires_at<? AND NOT EXISTS (SELECT 1 FROM explore_jobs WHERE quote_id=explore_quotes.id)",
    ).run(Date.now() - 86400000);
    db.prepare(
      "UPDATE explore_expansions SET status='uncertain' WHERE status='running' AND lease_until<?",
    ).run(Date.now());
    for (const j of db
      .prepare(
        "SELECT * FROM explore_jobs WHERE status='running' AND lease_until<?",
      )
      .all(Date.now())) {
      for (const i of items(j.id)) {
        if (!["queued", "running"].includes(i.status)) continue;
        const uncertain = i.status === "running";
        if (!uncertain) release(i, j);
        const r = {
          ...JSON.parse(i.result_json),
          error: uncertain
            ? "任务中断，供应商结果待确认，请联系管理员核对"
            : "任务中断，未执行项已释放额度",
          code: uncertain ? "RESULT_UNCERTAIN" : "INTERRUPTED",
        };
        db.prepare(
          "UPDATE explore_items SET status=?,result_json=?,reserved=? WHERE id=?",
        ).run(
          uncertain ? "uncertain" : "failed",
          JSON.stringify(r),
          uncertain ? i.reserved : 0,
          i.id,
        );
      }
      db.prepare("UPDATE explore_jobs SET status='interrupted' WHERE id=?").run(
        j.id,
      );
      syncBatch(j.batch_id);
    }
  })();
}
export function makeQuote(batch, req, b, context = null) {
  if (batch.workflow_kind === "style" && !context)
    throw problem("STYLE_CONTEXT_REQUIRED", "请从款式衍生工作区生成");
  recoverExploreJobs();
  const db = getDb(),
    proposals = JSON.parse(batch.proposals_json);
  const indexes = parseIndexes(b.indexes, proposals.length);
  if (
    batch.status === "rendering" &&
    !db.prepare("SELECT 1 FROM explore_jobs WHERE batch_id=?").get(batch.id)
  )
    throw problem(
      "LEGACY_RESULT_UNCERTAIN",
      "旧版生成任务结果待核对，请联系管理员恢复",
      409,
    );
  if (
    db
      .prepare(
        "SELECT 1 FROM explore_jobs WHERE batch_id=? AND status='running'",
      )
      .get(batch.id)
  )
    throw problem("BATCH_BUSY", "该批次仍在生成，请等待完成", 409);
  const unresolved = db
    .prepare(
      "SELECT i.proposal_idx FROM explore_items i JOIN explore_jobs j ON i.job_id=j.id WHERE j.batch_id=? AND i.status='uncertain'",
    )
    .all(batch.id);
  if (unresolved.some((i) => indexes.includes(i.proposal_idx)))
    throw problem(
      "RESULT_UNCERTAIN",
      "所选方案有待确认的生成结果，不能自动重试",
      409,
    );
  const source = b.source_job_id ? jobView(b.source_job_id) : null;
  if (
    b.source_job_id &&
    (!source ||
      source.batch_id !== batch.id ||
      indexes.some(
        (i) =>
          !source.renders.some(
            (r) => r.proposal_idx === i && r.status === "failed",
          ),
      ))
  )
    throw problem("INVALID_RETRY", "只能重试该批次已明确失败的项目");
  const model = resolveExploreModel(
    req,
    b.render_model_id || source?.snapshot.model.id || batch.render_model_id,
    "image",
  );
  const size = b.render_size || source?.snapshot.size || model.sizes[0];
  if (!model.sizes.includes(size))
    throw problem("INVALID_SIZE", "所选模型不支持该尺寸");
  const camera = source ? source.snapshot.camera : normalizeCamera(b.camera);
  if (
    source &&
    b.camera &&
    JSON.stringify(normalizeCamera(b.camera)) !== JSON.stringify(camera)
  )
    throw problem("INVALID_RETRY", "重试沿用原取景设置，调整取景请新建生成");
  if (camera && !source && !context)
    validateCameraIntent(camera, batch.intent_text);
  const unit = model.billable ? model.price_per_call : 0;
  const payload = {
    indexes,
    ...(context?.style ? { style: context.style } : {}),
    ...(camera ? { camera } : {}),
    model: publicModel(model),
    size,
    unit_price: unit,
    total: indexes.length * unit,
    pricing_version: JSON.stringify(model.pricing),
    effective_prompt_extend:
      source?.snapshot.effective_prompt_extend ??
      (camera ? false : model.prompt_extend),
    prompt_version: source?.snapshot.prompt_version || "explore-v2",
    source_job_id: source?.id || null,
    seeds: indexes.map(
      (i) =>
        source?.renders.find((r) => r.proposal_idx === i)?.seed ??
        Math.floor(Math.random() * 2147483647),
    ),
    prompts:
      context?.prompts ||
      indexes.map(
        (i) =>
          source?.renders.find((r) => r.proposal_idx === i)?.prompt_snapshot ||
          renderDnaPrompt({
            dna: proposals[i].dna,
            presetId: batch.preset_id,
            intentText: batch.intent_text,
            camera,
          }),
      ),
    billing_mode: model.billable ? "platform" : "local_mock",
    expires_at: Date.now() + 5 * 60 * 1000,
  };
  const id = randomUUID();
  db.prepare("INSERT INTO explore_quotes VALUES(?,?,?,?,?)").run(
    id,
    batch.id,
    owner(req),
    JSON.stringify(payload),
    payload.expires_at,
  );
  return { id, ...payload };
}
const running = new Map();
export async function executeJob(id, model) {
  const db = getDb(),
    job = db.prepare("SELECT * FROM explore_jobs WHERE id=?").get(id),
    q = JSON.parse(job.snapshot_json);
  const heartbeat = setInterval(
    () =>
      db
        .prepare(
          "UPDATE explore_jobs SET lease_until=? WHERE id=? AND status='running'",
        )
        .run(Date.now() + 600000, id),
    30000,
  );
  heartbeat.unref();
  const runItem = async (item) => {
    // Database guard also limits multiple processes sharing the same SQLite database.
    while (true) {
      const claimed = db
        .prepare(
          `UPDATE explore_items SET status='running' WHERE id=? AND status='queued' AND
        (SELECT COUNT(*) FROM explore_items i JOIN explore_jobs j ON j.id=i.job_id
         WHERE i.status='running' AND j.status='running' AND json_extract(j.snapshot_json,'$.model.provider_id')=?)<2`,
        )
        .run(item.id, model.provider_id).changes;
      if (claimed) break;
      if (
        db.prepare("SELECT status FROM explore_items WHERE id=?").get(item.id)
          ?.status !== "queued"
      )
        return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    let result = JSON.parse(item.result_json),
      status = "succeeded",
      generatedComplete = false;
    try {
      const generated = await generateImage({
        userId: job.user_id,
        modelId: model.id,
        prompt: result.prompt_snapshot,
        size: q.size,
        seed: result.seed,
        executionModel: {
          ...model,
          prompt_extend: q.effective_prompt_extend ?? model.prompt_extend,
          provider:
            model.provider === "dashscope" ? "dashscope" : "openai_compatible",
        },
        deferBilling: true,
        sourceImageBase64: q.style?.source_path
          ? fs
              .readFileSync(
                path.join(getConfig().dataDir || "./data", q.style.source_path),
              )
              .toString("base64")
          : null,
        referenceImages:
          q.style?.references?.map((r) =>
            fs
              .readFileSync(path.join(getConfig().dataDir || "./data", r.path))
              .toString("base64"),
          ) || [],
      });
      generatedComplete = true;
      const files = await saveStudioImage(
        generated.imageBase64,
        `ex_${item.id}.jpg`,
      );
      result = {
        ...result,
        ...files,
        model: model.model_id,
        size: q.size,
        price: q.unit_price,
      };
    } catch (e) {
      const error = generatedComplete
        ? problem("IMAGE_SAVE_FAILED", "图片保存失败，本次预留额度已退回", 500)
        : upstreamProblem(e, "图片生成");
      // Disk failures are refunded; an explicit retry may incur a fresh upstream cost to the platform.
      // Network timeouts remain unresolved instead of triggering duplicate calls.
      status = error.code === "RESULT_UNCERTAIN" ? "uncertain" : "failed";
      result = { ...result, error: error.publicMessage, code: error.code };
    }
    db.transaction(() => {
      if (
        db.prepare("SELECT status FROM explore_items WHERE id=?").get(item.id)
          ?.status !== "running" ||
        db.prepare("SELECT status FROM explore_jobs WHERE id=?").get(id)
          ?.status !== "running"
      )
        return;
      if (status === "succeeded" && q.style)
        result.generation_id = recordStyleImage(q.style, result, item.id);
      if (status === "failed") release(item, job);
      if (status === "succeeded" && item.reserved > 0)
        addLedger(job.user_id, 0, "explore_settle", "explore_item", item.id, {
          model: model.model_id,
          accountingDelta: -item.reserved,
        });
      db.prepare(
        "UPDATE explore_items SET status=?,result_json=?,reserved=? WHERE id=?",
      ).run(
        status,
        JSON.stringify(result),
        status === "uncertain" ? item.reserved : 0,
        item.id,
      );
      syncBatch(job.batch_id);
    })();
  };
  try {
    const queue = items(id).filter((i) => i.status === "queued");
    let cursor = 0;
    await Promise.all(
      Array.from({ length: Math.min(2, queue.length) }, async () => {
        while (cursor < queue.length) await runItem(queue[cursor++]);
      }),
    );
    const rows = items(id);
    db.prepare(
      "UPDATE explore_jobs SET status=? WHERE id=? AND status='running'",
    ).run(
      rows.some((i) => i.status === "uncertain")
        ? "uncertain"
        : rows.every((i) => i.status === "succeeded")
          ? "succeeded"
          : rows.some((i) => i.status === "succeeded")
            ? "partial"
            : "failed",
      id,
    );
    syncBatch(job.batch_id);
  } finally {
    clearInterval(heartbeat);
    running.delete(id);
  }
}
export function startJob(batch, req, b) {
  recoverExploreJobs();
  const db = getDb(),
    key = String(b.request_key || "");
  if (!/^[A-Za-z0-9_-]{8,100}$/.test(key))
    throw problem("INVALID_REQUEST_KEY", "需要有效的请求标识");
  const existing = db
    .prepare("SELECT * FROM explore_jobs WHERE user_id=? AND request_key=?")
    .get(owner(req), key);
  if (existing) {
    if (existing.batch_id !== batch.id || existing.quote_id !== b.quote_id)
      throw problem("IDEMPOTENCY_CONFLICT", "请求标识已用于其他报价", 409);
    return { job: jobView(existing.id), reused: true };
  }
  const row = db
    .prepare(
      "SELECT * FROM explore_quotes WHERE id=? AND batch_id=? AND user_id=?",
    )
    .get(b.quote_id, batch.id, owner(req));
  if (!row || row.expires_at < Date.now())
    throw problem("QUOTE_EXPIRED", "报价已过期，请重新获取", 409);
  const q = JSON.parse(row.payload_json),
    model = resolveExploreModel(req, q.model.id, "image");
  if (JSON.stringify(publicModel(model)) !== JSON.stringify(q.model))
    throw problem("QUOTE_CHANGED", "模型配置或价格已变更，请重新报价", 409);
  if (b.confirm !== true) throw problem("CONFIRM_REQUIRED", "请确认费用后重试");
  const id = randomUUID();
  db.transaction(() => {
    if (
      db
        .prepare(
          "SELECT 1 FROM explore_jobs WHERE batch_id=? AND status='running'",
        )
        .get(batch.id)
    )
      throw problem("BATCH_BUSY", "批次正在生成，请勿重复确认", 409);
    if (db.prepare("SELECT 1 FROM explore_jobs WHERE quote_id=?").get(row.id))
      throw problem("QUOTE_USED", "报价已用于生成任务，请查看已有结果", 409);
    const unknown = db
      .prepare(
        "SELECT i.proposal_idx FROM explore_items i JOIN explore_jobs j ON i.job_id=j.id WHERE j.batch_id=? AND i.status='uncertain'",
      )
      .all(batch.id);
    if (unknown.some((i) => q.indexes.includes(i.proposal_idx)))
      throw problem("RESULT_UNCERTAIN", "生成结果待确认，不能重复生成", 409);
    db.prepare("INSERT INTO explore_jobs VALUES(?,?,?,?,?,?,?,?,?)").run(
      id,
      batch.id,
      owner(req),
      key,
      row.id,
      "running",
      row.payload_json,
      Date.now() + 600000,
      stamp(),
    );
    q.indexes.forEach((idx, n) => {
      const itemId = randomUUID();
      if (q.unit_price > 0) {
        try {
          addLedger(
            owner(req),
            -q.unit_price,
            "explore_reserve",
            "explore_item",
            itemId,
            { model: model.model_id },
          );
        } catch {
          throw problem(
            "INSUFFICIENT_POINTS",
            "积分不足，请充值或减少生成数量",
            402,
          );
        }
      }
      db.prepare("INSERT INTO explore_items VALUES(?,?,?,?,?,?)").run(
        itemId,
        id,
        idx,
        "queued",
        JSON.stringify({
          proposal_idx: idx,
          prompt_snapshot: q.prompts[n],
          seed: q.seeds[n],
        }),
        q.unit_price,
      );
    });
    db.prepare(
      "UPDATE exploration_batches SET selected_json=?,status='rendering',cost_estimate=?,updated_at=? WHERE id=?",
    ).run(JSON.stringify(q.indexes), q.total, stamp(), batch.id);
  })();
  const promise = new Promise((resolve) => setImmediate(resolve)).then(() =>
    executeJob(id, model),
  );
  running.set(id, promise);
  promise.catch((e) => console.error("[explore-job]", id, e.code || e.name));
  return { job: jobView(id), reused: false };
}
export async function waitJob(id) {
  if (running.has(id)) await running.get(id);
  return jobView(id);
}
export function batchJobs(id) {
  recoverExploreJobs();
  return getDb()
    .prepare("SELECT id FROM explore_jobs WHERE batch_id=? ORDER BY rowid DESC")
    .all(id)
    .map((j) => jobView(j.id));
}
