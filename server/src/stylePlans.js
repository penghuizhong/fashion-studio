import crypto from "node:crypto";
import { getDb } from "./db.js";
import { ah } from "./asyncHandler.js";
import { problem } from "./exploreErrors.js";
import {
  styleTemplate,
  styleVersion,
  parse,
  canonical,
} from "./styleVersions.js";
import { internalBatch, imageFor } from "./styleWorkspace.js";
import { imageTaskAllowed } from "../../shared/imageOptions.js";
import {
  PLAN_LIMITS,
  DETAIL_MODULES,
  DEFAULT_STANDARD,
} from "../../shared/stylePlan.js";
import {
  normalizePlanInput,
  normalizeContent,
  seedItems,
  ownedPlan,
  readPlan,
  savePlanRevision,
  validKey,
  hash,
  resolvePlanReferences,
  itemReferences,
} from "./stylePlanCore.js";
import {
  analysisBudget,
  beginPlanAnalysis,
  analysisView,
  listPlanAnalysis,
  assertAnalysisIdle,
} from "./stylePlanAnalysis.js";
import { resolveExploreModel } from "./exploreModels.js";
import { makeQuote, jobView } from "./exploreJobs.js";
const active = (t) => {
  if (t.lifecycle !== "active")
    throw problem("RESTORE_REQUIRED", "请先恢复款式再操作", 409);
};
export function mountStylePlans(app) {
  const db = getDb();
  const path = "/api/studio/templates/:id/plans";
  app.get(
    path,
    ah(async (req, res) => {
      const t = styleTemplate(req.params.id, req),
        page = Math.max(1, parseInt(req.query.page) || 1),
        limit = 20;
      const rows = db
        .prepare(
          "SELECT id,version_id,revision,status,created_at,updated_at FROM style_plans WHERE template_id=? AND user_id=? ORDER BY updated_at DESC,rowid DESC LIMIT ? OFFSET ?",
        )
        .all(t.id, t.user_id, limit, (page - 1) * limit);
      res.json({
        plans: rows,
        total: db
          .prepare(
            "SELECT COUNT(*) n FROM style_plans WHERE template_id=? AND user_id=?",
          )
          .get(t.id, t.user_id).n,
        page,
        limits: PLAN_LIMITS,
        modules: DETAIL_MODULES,
      });
    }),
  );
  app.post(
    path,
    ah(async (req, res) => {
      const t = styleTemplate(req.params.id, req);
      active(t);
      const b = req.body || {};
      validKey(b.request_key);
      const v = styleVersion(t, b.version_id),
        input = normalizePlanInput(b.input),
        signature = hash({ version_id: v.id, input });
      const existing = db
        .prepare(
          "SELECT * FROM style_plan_requests WHERE user_id=? AND request_key=?",
        )
        .get(t.user_id, b.request_key);
      if (existing) {
        if (existing.template_id !== t.id || existing.signature !== signature)
          throw problem(
            "IDEMPOTENCY_CONFLICT",
            "此请求标识已用于其他规划",
            409,
          );
        return res.json({
          plan: readPlan(ownedPlan(t, existing.plan_id), t),
          reused: true,
        });
      }
      const id = crypto.randomUUID(),
        now = new Date().toISOString(),
        content = {
          reference_paths: resolvePlanReferences(t, input, req).map(
            (r) => r.path,
          ),
          standard: { ...DEFAULT_STANDARD },
          standard_edited: false,
          items: seedItems(input),
        };
      db.transaction(() => {
        db.prepare("INSERT INTO style_plans VALUES(?,?,?,?,?,?,?,?,?,?)").run(
          id,
          t.id,
          t.user_id,
          v.id,
          1,
          JSON.stringify(input),
          JSON.stringify(content),
          "draft",
          now,
          now,
        );
        db.prepare("INSERT INTO style_plan_revisions VALUES(?,?,?,?,?)").run(
          id,
          1,
          JSON.stringify(input),
          JSON.stringify(content),
          now,
        );
        db.prepare("INSERT INTO style_plan_requests VALUES(?,?,?,?,?)").run(
          t.id,
          t.user_id,
          b.request_key,
          signature,
          id,
        );
      })();
      res.json({ plan: readPlan(ownedPlan(t, id), t) });
    }),
  );
  app.get(
    path + "/:planId",
    ah(async (req, res) => {
      const t = styleTemplate(req.params.id, req),
        row = ownedPlan(t, req.params.planId);
      res.json({
        plan: readPlan(row, t),
        analyses: listPlanAnalysis(t, row.id),
      });
    }),
  );
  app.put(
    path + "/:planId",
    ah(async (req, res) => {
      const t = styleTemplate(req.params.id, req);
      active(t);
      const row = ownedPlan(t, req.params.planId),
        b = req.body || {};
      if (b.expected_revision !== row.revision)
        throw problem(
          "PLAN_CONFLICT",
          "规划已更新，草稿保留，请载入最新内容后合并",
          409,
        );
      assertAnalysisIdle(row.id);
      const oldInput = parse(row.input_json),
        oldContent = parse(row.content_json),
        input = normalizePlanInput(b.input ?? oldInput);
      let content = b.content
        ? normalizeContent(b.content, input, oldContent)
        : { ...oldContent, items: seedItems(input, oldContent.items) };
      if (b.content)
        input.modules = Object.fromEntries(
          DETAIL_MODULES.map((m) => [
            m.id,
            content.items.filter((i) => i.module_id === m.id).length,
          ]).filter(([, n]) => n),
        );
      // Reference numbering is not automatically blessed after ordering/removing input.
      if (canonical(oldInput.references) !== canonical(input.references)) {
        content.reference_paths = resolvePlanReferences(t, input, req).map(
          (r) => r.path,
        );
        const available = new Set(input.references.map((r) => r.id));
        content.items = content.items.map((i) => ({
          ...i,
          reference_ids: i.reference_ids.filter((id) => available.has(id)),
          analyzed: false,
          manual_confirmed: false,
        }));
      }
      if (oldInput.requirements !== input.requirements)
        content.items = content.items.map((i) => ({
          ...i,
          analyzed: false,
          manual_confirmed: false,
        }));
      const checked = normalizeContent(content, input, content);
      if (
        canonical(oldInput) === canonical(input) &&
        canonical(oldContent) === canonical(checked)
      )
        return res.json({ plan: readPlan(row, t) });
      const saved = db.transaction(() =>
        savePlanRevision(row, input, checked, "draft"),
      )();
      res.json({ plan: readPlan(saved, t) });
    }),
  );
  app.post(
    path + "/:planId/analysis-estimate",
    ah(async (req, res) => {
      const t = styleTemplate(req.params.id, req);
      active(t);
      const row = ownedPlan(t, req.params.planId),
        plan = readPlan(row, t),
        ids = req.body?.item_ids || plan.content.items.map((i) => i.id);
      if (
        !Array.isArray(ids) ||
        !ids.length ||
        new Set(ids).size !== ids.length ||
        ids.some((id) => !plan.content.items.some((i) => i.id === id))
      )
        throw problem("INVALID_SELECTION", "分析图片选择无效");
      resolvePlanReferences(t, plan.input, req);
      const { model, budget, signature } = analysisBudget(req, plan, ids);
      res.json({
        estimate_signature: signature,
        model_id: model.id,
        revision: plan.revision,
        estimated_reserve: budget,
        count: ids.length,
        billable: model.billable,
        thinking:
          model.thinking_control === "forced_on" ||
          (model.thinking_control !== "unsupported" && plan.input.thinking),
      });
    }),
  );
  app.post(
    path + "/:planId/analyze",
    ah(async (req, res) => {
      const t = styleTemplate(req.params.id, req);
      active(t);
      const plan = readPlan(ownedPlan(t, req.params.planId), t);
      const result = beginPlanAnalysis(t, req, plan, req.body || {});
      res.status(202).json({ analysis: result });
    }),
  );
  app.get(
    path + "/:planId/analyses/:analysisId",
    ah(async (req, res) => {
      const t = styleTemplate(req.params.id, req);
      ownedPlan(t, req.params.planId);
      const analysis = analysisView(t, req.params.analysisId);
      if (analysis.plan_id !== req.params.planId)
        throw problem("ANALYSIS_NOT_FOUND", "分析任务不存在", 404);
      res.json({ analysis });
    }),
  );
  app.post(
    path + "/:planId/apply-analysis",
    ah(async (req, res) => {
      const t = styleTemplate(req.params.id, req);
      active(t);
      const row = ownedPlan(t, req.params.planId);
      assertAnalysisIdle(row.id);
      const analysis = analysisView(t, req.body?.analysis_id);
      if (
        analysis.plan_id !== row.id ||
        analysis.revision !== row.revision ||
        req.body?.expected_revision !== row.revision
      )
        throw problem("PLAN_CONFLICT", "分析结果对应旧规划，请先核对修订", 409);
      const available = new Map(
        (analysis.progress.items || []).map((i) => [i.id, i]),
      );
      if (!available.size)
        throw problem("INVALID_ANALYSIS", "没有可采用的有效分析项");
      const content = parse(row.content_json);
      content.items = content.items.map((i) =>
        available.has(i.id)
          ? {
              ...i,
              ...available.get(i.id),
              analyzed: true,
              analysis_id: analysis.id,
            }
          : i,
      );
      const saved = db.transaction(() =>
        savePlanRevision(row, parse(row.input_json), content, "partial"),
      )();
      res.json({ plan: readPlan(saved, t) });
    }),
  );
  app.post(
    path + "/:planId/quote",
    ah(async (req, res) => {
      const t = styleTemplate(req.params.id, req);
      active(t);
      const row = ownedPlan(t, req.params.planId),
        plan = readPlan(row, t),
        b = req.body || {};
      if (b.expected_revision !== plan.revision)
        throw problem("PLAN_CONFLICT", "规划已更新，请重新报价", 409);
      const ids =
        b.item_ids ||
        plan.content.items.filter((i) => i.selected).map((i) => i.id);
      if (
        !Array.isArray(ids) ||
        !ids.length ||
        new Set(ids).size !== ids.length ||
        ids.some((id) => !plan.content.items.some((i) => i.id === id))
      )
        throw problem("INVALID_SELECTION", "请选择有效规划图片");
      const selected = plan.content.items
        .map((item, index) => ({ item, index }))
        .filter(({ item }) => ids.includes(item.id));
      if (selected.some(({ item }) => item.status !== "ready"))
        throw problem(
          "PLAN_NOT_READY",
          "所选规划尚未分析、缺少资料或存在冲突，请先补齐或确认手工要求",
          422,
        );
      const used = new Set(selected.flatMap(({ item }) => item.reference_ids));
      const refs = resolvePlanReferences(
        t,
        {
          ...plan.input,
          references: plan.input.references.filter((r) => used.has(r.id)),
        },
        req,
      );
      const model = resolveExploreModel(req, plan.input.model_id, "image");
      const v = styleVersion(t, plan.version_id),
        item_contexts = {},
        outputs = {},
        prompts = [];
      for (const { item, index } of selected) {
        const itemRefs = itemReferences(item, refs);
        if (
          !["create", "free_design"].includes(plan.input.op) &&
          item.module_id !== "transition" &&
          !itemRefs.length
        )
          throw problem("SOURCE_REQUIRED", "此衍生方向需要款式主体参考图", 422);
        if (
          ["free_design", "recolor", "detail_modify"].includes(plan.input.op) &&
          !v.parent_id
        )
          throw problem(
            "DESIGN_VERSION_REQUIRED",
            "请先在款式属性中另存设计变化，再生成本次衍生",
            422,
          );
        if (plan.input.op === "scene" && !plan.input.requirements.trim())
          throw problem("MISSING_INSTRUCTION", "请描述想要的场景", 422);
        if (!imageTaskAllowed(model.capabilities, itemRefs.length))
          throw problem(
            "MODEL_CAPABILITY_UNAVAILABLE",
            "图片模型不支持本图参考数量，请更换兼容模型或调整参考",
            422,
          );
        const source = itemRefs[0],
          references = itemRefs.slice(1).map((r) => ({
            path: r.path,
            reference_id: r.reference_id,
            role: r.role,
          }));
        item_contexts[index] = {
          plan_item_id: item.id,
          module_id: item.module_id,
          title: item.title,
          camera: item.camera,
          source_path: source?.path || null,
          source_generation_id: source?.generation_id || null,
          references,
          reference_mapping: itemRefs.map((r) => ({
            id: r.id,
            source: r.source,
            role: r.role,
          })),
          ...(item.delivery_slot ? { delivery_slot: item.delivery_slot } : {}),
        };
        outputs[index] = {
          size: item.size || plan.input.size,
          quality: item.quality || plan.input.quality,
        };
        prompts.push(item.prompt);
      }
      const batchId = internalBatch(t);
      // Style-only placeholder capacity: immutable per-job prompts remain in snapshots.
      const batch = db.transaction(() => {
        const b = db
          .prepare("SELECT * FROM exploration_batches WHERE id=?")
          .get(batchId);
        const proposals = parse(b.proposals_json, []);
        if (proposals.length < PLAN_LIMITS.total)
          db.prepare(
            "UPDATE exploration_batches SET count=?,proposals_json=? WHERE id=?",
          ).run(
            PLAN_LIMITS.total,
            JSON.stringify(
              Array.from({ length: PLAN_LIMITS.total }, () => ({
                dna: parse(v.dna_json),
              })),
            ),
            batchId,
          );
        return db
          .prepare("SELECT * FROM exploration_batches WHERE id=?")
          .get(batchId);
      })();
      const style = {
        template_id: t.id,
        user_id: t.user_id,
        version_id: v.id,
        version_number: v.number,
        preset_id: v.preset_id,
        dna: parse(v.dna_json),
        design_note: v.design_note,
        pending_design: false,
        op: plan.input.op,
        plan_id: plan.id,
        plan_revision: plan.revision,
        standard: plan.content.standard,
        source_path: refs[0]?.path || null,
        references: refs.slice(1).map((r) => ({ path: r.path, role: r.role })),
        item_contexts,
      };
      const quote = makeQuote(
        batch,
        req,
        {
          indexes: selected.map((s) => s.index),
          render_model_id: model.id,
          render_size: plan.input.size,
          quality: plan.input.quality,
          camera: selected[0].item.camera,
        },
        { style, prompts, outputs },
      );
      res.json({ quote });
    }),
  );
}
