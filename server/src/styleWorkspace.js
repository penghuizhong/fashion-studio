import fs from "node:fs";
import path from "node:path";
import { getDb } from "./db.js";
import { getConfig } from "./config.js";
import { ah } from "./asyncHandler.js";
import { problem } from "./exploreErrors.js";
import {
  styleTemplate,
  ensureStyle,
  styleVersion,
  saveVersion,
  setWorking,
  parse,
  canonical,
} from "./styleVersions.js";
import { makeQuote, startJob, batchJobs, jobView } from "./exploreJobs.js";
import { resolveExploreModel } from "./exploreModels.js";
import { renderDnaPrompt, saveStudioImage } from "./image.js";
import {
  normalizeCamera,
  validateCameraIntent,
} from "../../shared/photography.js";
const stamp = () => new Date().toISOString();
const styles = {
  preserve:
    "Preserve the photographic presentation of the source image where compatible with the explicit camera settings.",
  natural:
    "Natural realistic product photography, restrained retouching, soft natural light.",
  product:
    "Clean accurate product presentation, neutral studio background, clear garment construction.",
  editorial:
    "Editorial fashion lighting and deliberate composition; do not redesign the garment.",
};
export function localImage(file) {
  const root = path.resolve(getConfig().dataDir || "./data", "uploads/studio");
  const abs = path.resolve(getConfig().dataDir || "./data", file || "");
  if (!abs.startsWith(root + path.sep) || !fs.existsSync(abs))
    throw problem("SOURCE_MISSING", "参考图片不存在，请重新选择", 404);
  return abs;
}
function imageFor(t, ref, req) {
  const db = getDb();
  if (ref === "original") {
    if (!t.source_image_path)
      throw problem("SOURCE_MISSING", "款式没有原始参考图");
    localImage(t.source_image_path);
    return { path: t.source_image_path, kind: "original" };
  }
  if (
    typeof ref === "number" ||
    (typeof ref === "string" && /^\d+$/.test(ref))
  ) {
    const g = db
      .prepare("SELECT * FROM dna_generations WHERE id=? AND template_id=?")
      .get(Number(ref), t.id);
    if (!g || g.user_rating === "deleted")
      throw problem("SOURCE_MISSING", "底图记录不存在", 404);
    localImage(g.image_path);
    return {
      path: g.image_path,
      generation_id: g.id,
      version_id: g.design_version_id,
    };
  }
  if (typeof ref === "string" && ref.startsWith("ref:")) {
    const r = db
      .prepare("SELECT * FROM style_references WHERE id=? AND user_id=?")
      .get(Number(ref.slice(4)), t.user_id);
    if (!r) throw problem("SOURCE_MISSING", "辅助参考不存在", 404);
    localImage(r.image_path);
    return { path: r.image_path, reference_id: r.id };
  }
  throw problem("SOURCE_REQUIRED", "请选择本次底图");
}
function internalBatch(t) {
  const db = getDb();
  if (t.style_batch_id) return t.style_batch_id;
  return db.transaction(() => {
    const latest = db
      .prepare("SELECT style_batch_id FROM style_dna_templates WHERE id=?")
      .get(t.id);
    if (latest.style_batch_id) return latest.style_batch_id;
    const r = db
      .prepare(
        "INSERT INTO exploration_batches(user_id,intent_text,count,proposals_json,created_at,updated_at,preset_id,workflow_kind) VALUES(?,?,16,?,?,?,?, 'style')",
      )
      .run(
        t.user_id,
        `款式衍生 #${t.id}`,
        JSON.stringify(
          Array.from({ length: 16 }, () => ({ dna: parse(t.dna_json) })),
        ),
        stamp(),
        stamp(),
        t.preset_id,
      );
    db.prepare(
      "UPDATE style_dna_templates SET style_batch_id=? WHERE id=?",
    ).run(r.lastInsertRowid, t.id);
    return Number(r.lastInsertRowid);
  })();
}
export function mountStyleWorkspace(app) {
  const db = getDb();
  app.get(
    "/api/studio/templates/:id/workspace",
    ah(async (req, res) => {
      const t = styleTemplate(req.params.id, req);
      res.json({
        template: t,
        layouts: db
          .prepare(
            "SELECT * FROM style_layouts WHERE template_id=? ORDER BY id DESC",
          )
          .all(t.id),
        versions: db
          .prepare(
            "SELECT * FROM style_versions WHERE template_id=? ORDER BY number DESC",
          )
          .all(t.id),
        images: db
          .prepare(
            "SELECT * FROM dna_generations WHERE template_id=? ORDER BY id DESC",
          )
          .all(t.id),
        jobs: t.style_batch_id ? batchJobs(t.style_batch_id) : [],
      });
    }),
  );
  app.post(
    "/api/studio/templates/:id/versions",
    ah(async (req, res) => {
      const t = styleTemplate(req.params.id, req);
      res.json({ ok: true, version: saveVersion(t, req.body || {}) });
    }),
  );
  app.post(
    "/api/studio/templates/:id/working-version",
    ah(async (req, res) => {
      const t = styleTemplate(req.params.id, req);
      if (req.body.expected_version_id !== t.work_version_id)
        throw problem(
          "VERSION_CONFLICT",
          "工作版本已变化，请刷新后选择；您的分支仍保留",
          409,
        );
      res.json({ ok: true, version: setWorking(t, req.body.version_id) });
    }),
  );
  app.post(
    "/api/studio/templates/:id/versions/:versionId/status",
    ah(async (req, res) => {
      const t = styleTemplate(req.params.id, req),
        v = styleVersion(t, Number(req.params.versionId));
      if (!["draft", "final"].includes(req.body.status))
        throw problem("INVALID_STATUS", "版本状态不正确");
      db.transaction(() => {
        db.prepare("UPDATE style_versions SET status=? WHERE id=?").run(
          req.body.status,
          v.id,
        );
        db.prepare(
          "INSERT INTO style_version_events(version_id,action,created_at) VALUES(?,?,?)",
        ).run(v.id, req.body.status, stamp());
        if (t.work_version_id === v.id)
          db.prepare("UPDATE style_dna_templates SET status=? WHERE id=?").run(
            req.body.status,
            t.id,
          );
      })();
      res.json({ ok: true });
    }),
  );
  app.post(
    "/api/studio/templates/:id/cover",
    ah(async (req, res) => {
      const t = styleTemplate(req.params.id, req);
      const image = imageFor(t, req.body.generation_id, req);
      if (!image.generation_id)
        throw problem("INVALID_SOURCE", "请选择生成图片");
      db.prepare(
        "UPDATE style_dna_templates SET cover_generation_id=?,updated_at=? WHERE id=?",
      ).run(image.generation_id, stamp(), t.id);
      res.json({ ok: true });
    }),
  );
  app.post(
    "/api/studio/templates/:id/fork",
    ah(async (req, res) => {
      const t = styleTemplate(req.params.id, req),
        v = styleVersion(t, req.body.version_id);
      const source = req.body.generation_id
        ? imageFor(t, req.body.generation_id, req)
        : null;
      const name = String(req.body.name || `${t.name} · 衍生款`)
        .trim()
        .slice(0, 100);
      const id = db.transaction(() => {
        const r = db
          .prepare(
            "INSERT INTO style_dna_templates(user_id,name,source_image_path,category,preset_id,dna_json,gen_params_json,status,version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'draft',1,?,?)",
          )
          .run(
            t.user_id,
            name,
            source?.path || t.source_image_path || "",
            v.category,
            v.preset_id,
            v.dna_json,
            JSON.stringify({
              parent_template_id: t.id,
              parent_version_id: v.id,
            }),
            stamp(),
            stamp(),
          );
        ensureStyle(
          db
            .prepare("SELECT * FROM style_dna_templates WHERE id=?")
            .get(r.lastInsertRowid),
        );
        return Number(r.lastInsertRowid);
      })();
      res.json({ ok: true, id });
    }),
  );
  app.post(
    "/api/studio/templates/:id/quote",
    ah(async (req, res) => {
      const t = styleTemplate(req.params.id, req),
        b = req.body || {},
        v = styleVersion(t, b.version_id);
      const op = b.op;
      if (
        ![
          "create",
          "recolor",
          "detail_modify",
          "detail_shot",
          "scene",
          "variant",
        ].includes(op)
      )
        throw problem("INVALID_OPERATION", "请选择有效的衍生动作");
      const count = b.count ?? 1;
      if (!Number.isInteger(count) || count < 1 || count > 16)
        throw problem("INVALID_COUNT", "生成张数为 1–16");
      const model = resolveExploreModel(req, b.model_id, "image");
      const camera = normalizeCamera(b.camera);
      const mode = b.mode || "text";
      if (!["text", "image"].includes(mode))
        throw problem("INVALID_MODE", "生成模式无效");
      if (op !== "create" && mode !== "image")
        throw problem(
          "SOURCE_REQUIRED",
          "款式修改和展示衍生需要明确选择底图及图片编辑模型",
        );
      const source = mode === "image" ? imageFor(t, b.source, req) : null;
      if (source && !model.capabilities.image_edit)
        throw problem(
          "UNSUPPORTED_EDIT",
          "此模型尚未确认支持图片编辑，请更换模型或在模型管理中确认能力",
          422,
        );
      const refs = b.references || [];
      if (!Array.isArray(refs) || refs.length > 3)
        throw problem("INVALID_REFERENCE", "辅助参考最多 3 张");
      if (refs.length && (!source || !model.capabilities.multi_reference))
        throw problem(
          "UNSUPPORTED_REFERENCE",
          "当前模式或模型不支持多图参考",
          422,
        );
      const references = refs.map((r) => {
        if (!["color", "fabric", "detail", "presentation"].includes(r.role))
          throw problem("INVALID_REFERENCE", "请指定参考图作用");
        return { ...imageFor(t, r.source, req), role: r.role };
      });
      let instruction = String(b.instruction || "").trim();
      if (["recolor", "detail_modify"].includes(op)) {
        const delta = parse(v.summary, []);
        const relevant = Array.isArray(delta)
          ? delta.filter((d) =>
              op === "recolor" ? /color/.test(d.key) : d.key === "details",
            )
          : [];
        if (!v.parent_id || !relevant.length)
          throw problem(
            "DESIGN_VERSION_REQUIRED",
            "请先保存颜色或细节变化为新设计版本",
          );
        instruction = relevant
          .map(
            (d) =>
              `${d.key}: ${JSON.stringify(d.before)} -> ${JSON.stringify(d.after)}`,
          )
          .join("; ");
      }
      if (instruction.length > 1200)
        throw problem("INVALID_INSTRUCTION", "要求限 1200 字");
      if (["recolor", "detail_modify", "scene"].includes(op) && !instruction)
        throw problem("MISSING_INSTRUCTION", "请填写本次修改目标");
      if (op === "detail_shot" && camera.framing !== "detail")
        throw problem("INVALID_CAMERA", "细节图请选择局部特写及具体部位");
      if (
        op !== "detail_shot" &&
        camera.framing === "detail" &&
        op === "recolor"
      )
        throw problem("INVALID_CAMERA", "换色请使用完整单品或全身取景");
      const requestedVisual = b.visual_style || "product";
      validateCameraIntent(camera, instruction);
      const visual =
        requestedVisual === "auto"
          ? b.purpose === "scene"
            ? "natural"
            : "product"
          : requestedVisual;
      if (typeof visual !== "string" || !Object.hasOwn(styles, visual))
        throw problem("INVALID_STYLE", "呈现风格无效");
      const purpose = b.purpose || "free";
      if (!["free", "white", "scene", "detail"].includes(purpose))
        throw problem("INVALID_PURPOSE", "出图用途无效");
      if (purpose === "detail" && camera.framing !== "detail")
        throw problem("INVALID_CAMERA", "细节用途需要局部取景");
      const dna = parse(v.dna_json);
      const ops = {
        create: "Generate this saved design accurately.",
        recolor:
          "Recolor ONLY the requested garment area using the saved version colors; preserve all other construction.",
        detail_modify:
          "Modify ONLY the requested design detail; preserve all other construction.",
        detail_shot:
          "Show a close-up of the selected garment area. Do not represent inferred stitching as verified product construction.",
        scene:
          "Change ONLY the photographic background/presentation. Preserve garment design and colors.",
        variant: b.explore_variation
          ? "Explore an alternative rendering of this same saved design; retain its defining construction."
          : "Generate another candidate of the same saved design and presentation.",
      };
      const prompt = [
        renderDnaPrompt({ dna, presetId: v.preset_id, camera }),
        ops[op],
        instruction ? `Specific requested change: ${instruction}` : "",
        String(b.keep || "").trim()
          ? `Preserve: ${String(b.keep).slice(0, 1000)}`
          : "",
        styles[visual],
        b.consistent
          ? "Keep garment identity, color, visual presentation and lighting consistent across this batch. Camera constraints take precedence over presentation style."
          : "",
        purpose === "white"
          ? "Pure white product background, no promotional text or graphics."
          : "",
        ...references.map(
          (r, i) =>
            `Additional reference ${i + 2}: use ONLY as ${r.role} guidance; the first image is the garment base.`,
        ),
      ]
        .filter(Boolean)
        .join("\n");
      const context = {
        template_id: t.id,
        user_id: t.user_id,
        version_id: v.id,
        version_number: v.number,
        dna,
        preset_id: v.preset_id,
        op,
        mode,
        source_path: source?.path || null,
        source_generation_id: source?.generation_id || null,
        source_version_id: source?.version_id || null,
        references,
        camera,
        visual_style: visual,
        requested_visual_style: requestedVisual,
        purpose,
        instruction,
        keep: String(b.keep || "").slice(0, 1000),
        explore_variation: !!b.explore_variation,
        consistent: !!b.consistent,
      };
      const batchId = internalBatch(t),
        batch = db
          .prepare("SELECT * FROM exploration_batches WHERE id=?")
          .get(batchId);
      const quote = makeQuote(
        batch,
        req,
        {
          indexes: Array.from({ length: count }, (_, i) => i),
          render_model_id: b.model_id,
          render_size: b.size,
          camera,
        },
        { style: context, prompts: Array(count).fill(prompt) },
      );
      res.json({ ok: true, quote });
    }),
  );
  app.post(
    "/api/studio/templates/:id/jobs",
    ah(async (req, res) => {
      const t = styleTemplate(req.params.id, req);
      if (!t.style_batch_id)
        throw problem("QUOTE_EXPIRED", "请先获取报价", 409);
      const batch = db
        .prepare("SELECT * FROM exploration_batches WHERE id=?")
        .get(t.style_batch_id);
      const row = db
        .prepare(
          "SELECT payload_json FROM explore_quotes WHERE id=? AND batch_id=? AND user_id=?",
        )
        .get(req.body.quote_id, batch.id, t.user_id);
      if (!row || parse(row.payload_json).style?.template_id !== t.id)
        throw problem("QUOTE_EXPIRED", "报价不存在", 409);
      const context = parse(row.payload_json).style;
      styleVersion(t, context.version_id);
      if (context.source_path) localImage(context.source_path);
      for (const r of context.references) localImage(r.path);
      res.status(202).json({ ok: true, ...startJob(batch, req, req.body) });
    }),
  );
  app.post(
    "/api/studio/templates/:id/retry-quote",
    ah(async (req, res) => {
      const t = styleTemplate(req.params.id, req);
      const job = jobView(req.body.job_id);
      if (!job || job.batch_id !== t.style_batch_id || !job.snapshot.style)
        throw problem("INVALID_RETRY", "原任务不存在", 404);
      const failed = job.renders
        .filter((r) => r.status === "failed")
        .map((r) => r.proposal_idx);
      if (!failed.length) throw problem("INVALID_RETRY", "没有明确失败项");
      const batch = db
        .prepare("SELECT * FROM exploration_batches WHERE id=?")
        .get(t.style_batch_id);
      res.json({
        ok: true,
        quote: makeQuote(
          batch,
          req,
          {
            indexes: failed,
            source_job_id: job.id,
            render_model_id: job.snapshot.model.id,
            render_size: job.snapshot.size,
          },
          {
            style: job.snapshot.style,
            prompts: failed.map(
              (i) =>
                job.renders.find((r) => r.proposal_idx === i).prompt_snapshot,
            ),
          },
        ),
      });
    }),
  );
  app.post(
    "/api/studio/templates/:id/layouts",
    ah(async (req, res) => {
      const t = styleTemplate(req.params.id, req),
        v = styleVersion(t, req.body.version_id),
        c = req.body.config;
      if (!/^[\w-]{8,100}$/.test(req.body.request_key || ""))
        throw problem("INVALID_REQUEST_KEY", "保存排版需要请求标识");
      if (
        !c ||
        !["selling", "spec", "collection"].includes(c.type) ||
        c.confirmed !== true ||
        !["zh", "en"].includes(c.language) ||
        !Number.isInteger(c.width) ||
        c.width < 600 ||
        c.width > 2400 ||
        !Number.isInteger(c.height) ||
        c.height < 600 ||
        c.height > 3200 ||
        !Array.isArray(c.selected) ||
        c.selected.some((id) => !Number.isSafeInteger(id) || id <= 0) ||
        c.selected.length < 1 ||
        c.selected.length > 4 ||
        new Set(c.selected).size !== c.selected.length
      )
        throw problem("INVALID_LAYOUT", "请核对排版、资料及输出尺寸");
      for (const id of c.selected) imageFor(t, id, req);
      for (const [key, max] of [
        ["title", 100],
        ["text", 800],
        ["promotion", 150],
      ])
        if (typeof c[key] !== "string" || c[key].length > max)
          throw problem("INVALID_LAYOUT", "排版文字过长或格式不正确");
      if (
        !Array.isArray(c.measurements) ||
        c.measurements.length > 8 ||
        c.measurements.some(
          (r) =>
            typeof r.label !== "string" ||
            r.label.length > 40 ||
            (r.cm !== "" &&
              (!Number.isFinite(Number(r.cm)) ||
                Number(r.cm) <= 0 ||
                Number(r.cm) > 1000)),
        )
      )
        throw problem("INVALID_LAYOUT", "请填写有效的测量数据");
      if (
        c.type === "spec" &&
        !c.measurements.some((r) => r.label.trim() && Number(r.cm) > 0)
      )
        throw problem("INVALID_LAYOUT", "规格图需要真实测量数据");
      if (
        !c.labels ||
        typeof c.labels !== "object" ||
        Array.isArray(c.labels) ||
        Object.entries(c.labels).some(
          ([id, label]) =>
            !c.selected.includes(Number(id)) ||
            typeof label !== "string" ||
            label.length > 50,
        )
      )
        throw problem("INVALID_LAYOUT", "图片标签格式不正确");
      const config = canonical(c),
        prior = db
          .prepare(
            "SELECT * FROM style_layouts WHERE template_id=? AND request_key=?",
          )
          .get(t.id, req.body.request_key);
      if (prior) {
        if (prior.config_json !== config || prior.version_id !== v.id)
          throw problem("IDEMPOTENCY_CONFLICT", "请求标识已用于其他排版", 409);
        return res.json({ ok: true, id: prior.id });
      }
      const r = db
        .prepare(
          "INSERT INTO style_layouts(template_id,version_id,request_key,config_json,created_at) VALUES(?,?,?,?,?)",
        )
        .run(t.id, v.id, req.body.request_key, config, stamp());
      res.json({ ok: true, id: Number(r.lastInsertRowid) });
    }),
  );
  app.get(
    "/api/studio/references",
    ah(async (req, res) => {
      res.json({
        references: db
          .prepare(
            "SELECT id,image_path,thumb_path,created_at FROM style_references WHERE user_id=? ORDER BY id DESC LIMIT 100",
          )
          .all(req.userId || "local"),
      });
    }),
  );
  app.post(
    "/api/studio/references",
    ah(async (req, res) => {
      let files;
      const assetId = req.body?.generation_id;
      if (assetId) {
        const g = db
          .prepare("SELECT * FROM dna_generations WHERE id=? AND user_id=?")
          .get(assetId, req.userId || "local");
        if (!g || g.user_rating === "deleted")
          throw problem("SOURCE_NOT_OWNED", "资产不存在", 404);
        localImage(g.image_path);
        files = {
          image_path: g.image_path,
          thumb_path: g.thumb_path || g.image_path,
        };
      } else {
        const base64 = req.body?.image_base64;
        if (typeof base64 !== "string" || base64.length > 20 * 1024 * 1024)
          throw problem("INVALID_IMAGE", "请上传不超过 15MB 的图片");
        files = await saveStudioImage(
          base64,
          `reference_${crypto.randomUUID()}.jpg`,
        );
      }
      const r = db
        .prepare(
          "INSERT INTO style_references(user_id,image_path,thumb_path,created_at) VALUES(?,?,?,?)",
        )
        .run(
          req.userId || "local",
          files.image_path,
          files.thumb_path,
          stamp(),
        );
      res.json({ id: Number(r.lastInsertRowid), ...files });
    }),
  );
  app.post(
    "/api/studio/generations/:id/permanent-delete",
    ah(async (req, res) => {
      const g = db
        .prepare("SELECT * FROM dna_generations WHERE id=?")
        .get(req.params.id);
      if (!g) throw problem("IMAGE_NOT_FOUND", "图片不存在", 404);
      styleTemplate(g.template_id, req);
      if (req.body.confirm !== "永久删除" || !g.archived)
        throw problem(
          "DELETE_CONFIRM_REQUIRED",
          "请先归档，并输入“永久删除”确认",
        );
      if (g.user_rating === "deleted")
        return res.json({ ok: true, reused: true });
      const referenced = db
        .prepare(
          `SELECT 1 FROM style_dna_templates WHERE source_image_path=? OR cover_generation_id=?
      UNION ALL SELECT 1 FROM dna_generations WHERE id!=? AND (image_path=? OR source_generation_id=?)
      UNION ALL SELECT 1 FROM style_references WHERE image_path=?
      UNION ALL SELECT 1 FROM style_layouts,json_each(json_extract(config_json,'$.selected')) WHERE value=?
      UNION ALL SELECT 1 FROM explore_jobs WHERE json_extract(snapshot_json,'$.style.source_path')=?
      UNION ALL SELECT 1 FROM explore_jobs,json_each(json_extract(snapshot_json,'$.style.references')) WHERE json_extract(value,'$.path')=?
      UNION ALL SELECT 1 FROM exploration_batches b,json_each(b.renders_json) r WHERE b.workflow_kind='explore' AND json_extract(r.value,'$.image_path')=? LIMIT 1`,
        )
        .get(
          g.image_path,
          g.id,
          g.id,
          g.image_path,
          g.id,
          g.image_path,
          g.id,
          g.image_path,
          g.image_path,
          g.image_path,
        );
      if (referenced)
        throw problem(
          "IMAGE_IN_USE",
          "图片仍被封面、底图、参考或排版引用，请保留归档",
          409,
        );
      const moves = [];
      const trash = path.join(getConfig().dataDir || "./data", ".style-trash");
      fs.mkdirSync(trash, { recursive: true });
      try {
        for (const relative of [g.image_path, g.thumb_path]) {
          const from = localImage(relative);
          const to = path.join(trash, crypto.randomUUID());
          fs.renameSync(from, to);
          moves.push([from, to]);
        }
        db.prepare(
          "UPDATE dna_generations SET user_rating='deleted',archived=1,rated_at=? WHERE id=?",
        ).run(stamp(), g.id);
      } catch (e) {
        for (const [from, to] of moves.reverse())
          if (fs.existsSync(to)) fs.renameSync(to, from);
        throw e;
      }
      for (const [, to] of moves)
        try {
          fs.unlinkSync(to);
        } catch {
          /* Not served; later disk maintenance may remove it. */
        }
      res.json({ ok: true });
    }),
  );
  app.post(
    "/api/studio/generations/:id/archive",
    ah(async (req, res) => {
      const g = db
        .prepare("SELECT * FROM dna_generations WHERE id=?")
        .get(req.params.id);
      if (!g) throw problem("IMAGE_NOT_FOUND", "图片不存在", 404);
      styleTemplate(g.template_id, req);
      db.prepare("UPDATE dna_generations SET archived=? WHERE id=?").run(
        req.body.archived === false ? 0 : 1,
        g.id,
      );
      res.json({ ok: true });
    }),
  );
}
