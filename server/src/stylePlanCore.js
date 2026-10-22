import {
  generationMode,
  isProductTask,
  renderMode,
  imagePolicyIssues,
  riskyInstructions,
} from "../../shared/productImagePolicy.js";
import { normalizeLayout } from "./productLayoutSchema.js";
import {
  assembleModulePrompt,
  assembleExecutionPrompt,
  promptLength,
} from "../../shared/stylePrompt.js";
import crypto from "node:crypto";
import {
  DETAIL_MODULES,
  FACT_FIELDS,
  PLAN_LIMITS,
  DEFAULT_STANDARD,
  SPEC_FIELDS,
  REFERENCE_ROLES,
  EDITABLE_PROMPT_PARTS,
  defaultPlanCamera,
  isNoTextLanguage,
  moduleCounts,
  normalizeStandard,
} from "../../shared/stylePlan.js";
import {
  normalizeCamera,
  validateCameraIntent,
} from "../../shared/photography.js";
import { canonical, parse } from "./styleVersions.js";
import { imageFor } from "./styleWorkspace.js";
import { problem } from "./exploreErrors.js";
import { getDb } from "./db.js";
const object = (v) => v && typeof v === "object" && !Array.isArray(v);
export function text(value, max = 2000) {
  if (typeof value !== "string" || value.length > max)
    throw problem("INVALID_PLAN", `文字格式无效或超过${max}字`);
  return value.trim();
}
export function shortPrompt(value = "") {
  if (typeof value !== "string" || promptLength(value) > 200)
    throw problem("INVALID_PROMPT", "主要描述与基本属性分别不得超过200字");
  if (/\b\d{3,5}\s*[x×*]\s*\d{3,5}\b/i.test(value))
    throw problem("INVALID_PROMPT", "图片尺寸请在第二步设置，不要写入提示词");
  return value.trim();
}
const idPattern = /^[a-zA-Z0-9_-]{8,100}$/;
export function validKey(key) {
  if (!idPattern.test(key || ""))
    throw problem("INVALID_REQUEST_KEY", "需要有效请求标识");
  return key;
}
export const hash = (value) =>
  crypto.createHash("sha256").update(canonical(value)).digest("hex");
export function normalizePlanInput(b = {}) {
  if (!object(b)) throw problem("INVALID_PLAN", "规划输入格式无效");
  const counts = b.modules ?? { main: 1 };
  if (
    !object(counts) ||
    Object.keys(counts).some((k) => !DETAIL_MODULES.some((m) => m.id === k))
  )
    throw problem("INVALID_MODULE", "内容模块无效");
  let total = 0;
  for (const n of Object.values(counts)) {
    if (!Number.isInteger(n) || n < 0 || n > PLAN_LIMITS.per_module)
      throw problem(
        "INVALID_COUNT",
        `每类图片数量为0–${PLAN_LIMITS.per_module}`,
      );
    total += n;
  }
  if (total < 1 || total > PLAN_LIMITS.total)
    throw problem("INVALID_COUNT", `图片总数须为1–${PLAN_LIMITS.total}`);
  const refs = b.references ?? [];
  if (!Array.isArray(refs) || refs.length > 16)
    throw problem("INVALID_REFERENCE", "参考图最多16张");
  const references = refs.map((r, i) => {
    // Legacy scene-style references fold into the model group (role retired).
    const role = r?.role === "scene" ? "model" : r?.role;
    if (
      !object(r) ||
      !idPattern.test(r.id || "") ||
      !Object.hasOwn(REFERENCE_ROLES, role) ||
      typeof r.source !== "string" ||
      !/^(original|\d+|ref:\d+)$/.test(r.source)
    )
      throw problem("INVALID_REFERENCE", "参考图角色或来源无效");
    if (i === 0 && role !== "garment")
      throw problem("INVALID_REFERENCE", "图1必须是款式主体");
    return { id: r.id, source: r.source, role };
  });
  if (
    new Set(references.map((r) => r.id)).size !== references.length ||
    new Set(references.map((r) => r.source)).size !== references.length
  )
    throw problem("DUPLICATE_REFERENCE", "同一参考图只能添加一次");
  const facts = {};
  if (b.facts && !object(b.facts))
    throw problem("INVALID_FACTS", "商品资料格式无效");
  for (const [k, v] of Object.entries(b.facts || {})) {
    if (
      ![
        "brand",
        "sizes",
        "colors",
        "promotion",
        "specs",
        "care",
        "service",
        "faq",
      ].includes(k)
    )
      throw problem("INVALID_FACTS", "未知商品资料字段");
    facts[k] = text(v, 3000);
  }
  const op = b.op || "create";
  if (
    ![
      "create",
      "free_design",
      "recolor",
      "detail_modify",
      "detail_shot",
      "scene",
      "white",
      "variant",
    ].includes(op)
  )
    throw problem("INVALID_OPERATION", "衍生方向无效");
  if (b.thinking !== undefined && typeof b.thinking !== "boolean")
    throw problem("INVALID_THINKING", "思考开关须为布尔值");
  if (
    b.generation_mode !== undefined &&
    !["product", "creative"].includes(b.generation_mode)
  )
    throw problem("INVALID_MODE", "生成模式无效");
  const result = {
    generation_mode: generationMode(b),
    modules: Object.fromEntries(Object.entries(counts).filter(([, n]) => n)),
    requirements: text(b.requirements || "", 3000),
    keep: text(b.keep || "", 1000),
    explore_variation: b.explore_variation === true,
    ...(b.camera ? { camera: normalizeCamera(b.camera) } : {}),
    facts,
    references,
    model_id: text(b.model_id || "", 100),
    size: text(b.size || "", 40),
    quality: text(b.quality || "", 32),
    analysis_model_id: text(b.analysis_model_id || "", 100),
    thinking: b.thinking === true,
    language: text(b.language || "简体中文", 40),
    style: text(b.style || "auto", 80),
    op,
  };
  if (b.delivery_views) {
    if (
      !Array.isArray(b.delivery_views) ||
      !b.delivery_views.length ||
      b.delivery_views.length > 5 ||
      new Set(b.delivery_views).size !== b.delivery_views.length ||
      b.delivery_views.some(
        (k) => !["front", "back", "side", "side_right", "detail"].includes(k),
      )
    )
      throw problem("INVALID_CAMERA", "交付视角无效");
    result.delivery_views = b.delivery_views;
  }
  return result;
}
export function seedItems(input, old = []) {
  const result = [];
  for (const m of DETAIL_MODULES) {
    // Transition cards are text-only; a no-text language skips the module.
    if (m.id === "transition" && isNoTextLanguage(input.language)) continue;
    const count = input.modules[m.id] || 0,
      previous = old.filter((i) => i.module_id === m.id);
    for (let n = 0; n < count; n++)
      result.push(
        previous[n] || {
          id: crypto.randomUUID(),
          module_id: m.id,
          title: `${m.name}${count > 1 ? ` ${n + 1}` : ""}`,
          requirement: `${m.description}。${n ? `采用第${n + 1}种构图，区别于本组其他图片。` : ""}`,
          render_mode: renderMode(input, { module_id: m.id }),
          copy: "",
          description_prompt: "",
          attributes_prompt: "",
          prompt_override: "",
          spec: {},
          camera:
            m.id === "main" && input.camera
              ? input.camera
              : defaultPlanCamera(m.id, n, input.op),
          reference_ids:
            m.id === "transition" ? [] : input.references.map((r) => r.id),
          prompt_overrides: {},
          selected: !m.required || !!input.facts[m.required],
          analyzed: false,
          manual_confirmed: false,
        },
      );
  }
  if (input.delivery_views)
    for (let n = 0; n < result.length; n++) {
      const slot = input.delivery_views[n];
      if (slot) {
        result[n] = {
          ...result[n],
          delivery_slot: slot,
          camera: {
            ...defaultPlanCamera("main"),
            view:
              slot === "side_right"
                ? "side"
                : slot === "detail"
                  ? "front"
                  : slot,
            framing: slot === "detail" ? "detail" : "garment",
            detail: slot === "detail" ? "用户指定细节" : "",
          },
        };
      }
    }
  return result;
}
export function normalizeContent(raw, input, old) {
  if (
    !object(raw) ||
    !object(raw.standard) ||
    !Array.isArray(raw.items) ||
    raw.items.length < 1 ||
    raw.items.length > PLAN_LIMITS.total
  )
    throw problem("INVALID_PLAN", "规划内容格式无效");
  const rawStandard = {};
  for (const [k, v] of Object.entries(raw.standard))
    if (typeof v === "string") rawStandard[k] = text(v, 4000);
  const standard = normalizeStandard(rawStandard);
  const existing = new Map((old?.items || []).map((i) => [i.id, i]));
  const sourceItems =
    isNoTextLanguage(input.language) &&
    raw.items.some((i) => i?.module_id !== "transition")
      ? raw.items.filter((i) => i?.module_id !== "transition")
      : raw.items;
  const items = sourceItems.map((i) => {
    if (
      !object(i) ||
      !idPattern.test(i.id || "") ||
      !DETAIL_MODULES.some((m) => m.id === i.module_id)
    )
      throw problem("INVALID_PLAN", "图片规划标识无效");
    const prior = existing.get(i.id);
    if (prior && prior.module_id !== i.module_id)
      throw problem("INVALID_PLAN", "图片的模块归属不可更改，请添加新图片");
    const reference_ids = i.reference_ids ?? input.references.map((r) => r.id);
    if (
      !Array.isArray(reference_ids) ||
      new Set(reference_ids).size !== reference_ids.length ||
      reference_ids.some((id) => !input.references.some((r) => r.id === id))
    )
      throw problem("INVALID_REFERENCE", "图片引用不属于本规划");
    const overrides = {};
    if (i.prompt_overrides && !object(i.prompt_overrides))
      throw problem("INVALID_PROMPT", "手工提示词格式无效");
    for (const [k, v] of Object.entries(i.prompt_overrides || {})) {
      if (!EDITABLE_PROMPT_PARTS.includes(k))
        throw problem(
          "INVALID_PROMPT",
          "服装版本、参考及输出约束由已确认设置维护",
        );
      overrides[k] = text(v, 6000);
    }
    if (i.spec && !object(i.spec))
      throw problem("INVALID_PLAN", "图片规格格式无效");
    const spec = {};
    for (const [k] of SPEC_FIELDS)
      spec[k] =
        i.spec === undefined
          ? prior?.spec?.[k] || ""
          : i.spec?.[k] === undefined
            ? ""
            : text(i.spec[k], 2000);
    const item = {
      id: i.id,
      module_id: i.module_id,
      title: text(i.title || "", 200),
      requirement: text(i.requirement || "", 3000),
      copy: text(i.copy || "", 3000),
      description_prompt: shortPrompt(i.description_prompt ?? prior?.description_prompt ?? ""),
      attributes_prompt: shortPrompt(i.attributes_prompt ?? prior?.attributes_prompt ?? ""),
      prompt_override:
        i.prompt_override === undefined
          ? prior?.prompt_override || ""
          : text(i.prompt_override, 12000),
      prompt_override_basis: text(
        i.prompt_override_basis ?? prior?.prompt_override_basis ?? "",
        64,
      ),
      edited:
        i.edited === true ||
        prior?.edited === true ||
        !!(
          prior &&
          ((i.description_prompt !== undefined && i.description_prompt !== prior.description_prompt) ||
            (i.attributes_prompt !== undefined && i.attributes_prompt !== prior.attributes_prompt) ||
            (i.title !== undefined && i.title !== prior.title) ||
            (i.requirement !== undefined &&
              i.requirement !== prior.requirement))
        ),
      render_mode: i.render_mode || prior?.render_mode || renderMode(input, i),
      layout:
        i.layout !== undefined || prior?.layout || i.module_id === "selling"
          ? normalizeLayout(
              i.layout ?? prior?.layout,
              input.references.find((r) => r.role === "garment")?.id || "",
            )
          : undefined,
      spec,
      camera: normalizeCamera(i.camera),
      reference_ids,
      size: text(i.size || "", 40),
      quality: text(i.quality || "", 32),
      prompt_overrides: overrides,
      selected: i.selected !== false,
      observation: prior?.observation || "",
      analyzed: prior?.analyzed || false,
      manual_confirmed: i.manual_confirmed === true,
    };
    if (
      !["image", "composition"].includes(item.render_mode) ||
      (item.render_mode === "composition" && i.module_id !== "selling")
    )
      throw problem("INVALID_LAYOUT", "当前模块不支持该输出方式");
    if (prior?.delivery_slot) item.delivery_slot = prior.delivery_slot;
    return item;
  });
  if (new Set(items.map((i) => i.id)).size !== items.length)
    throw problem("INVALID_PLAN", "图片规划ID不能重复");
  const counts = moduleCounts(items);
  if (Object.values(counts).some((n) => n > PLAN_LIMITS.per_module))
    throw problem("INVALID_COUNT", "单模块图片过多");
  return {
    reference_paths: old?.reference_paths || [],
    reference_conflicts: old?.reference_conflicts || "",
    standard,
    standard_edited:
      raw.standard_edited === true ||
      canonical(standard) !==
        canonical(old ? normalizeStandard(old.standard) : DEFAULT_STANDARD),
    items,
  };
}
export function resolvePlanReferences(t, input, req) {
  const refs = input.references.map((r) => ({
    ...r,
    ...imageFor(t, r.source, req),
  }));
  if (new Set(refs.map((r) => r.path)).size !== refs.length)
    throw problem("DUPLICATE_REFERENCE", "同一图片不可通过不同来源重复添加");
  return refs;
}
export function itemReferences(item, refs) {
  const selected = refs.filter((r) => item.reference_ids.includes(r.id));
  if (selected.length && selected[0].role !== "garment")
    throw problem("INVALID_REFERENCE", "每张图的首个参考必须为款式主体");
  return selected;
}
export function compilePlanItem(plan, item, t) {
  const input = plan.input,
    standard = plan.content.standard,
    module = DETAIL_MODULES.find((m) => m.id === item.module_id);
  const missing =
    module.required && !input.facts[module.required] ? [module.required] : [];
  const camera = normalizeCamera(item.camera);
  const intent = item.description_prompt || item.requirement;
  validateCameraIntent(camera, intent);
  if (
    input.op === "white" &&
    /海滩|海岛|街道|森林|沙滩|非白|黑色背景|beach|forest|street|black background/i.test(
      intent,
    )
  )
    throw problem("CONFLICTING_BACKGROUND", "白底商品图与场景要求冲突");
  const refs = input.references.filter((r) =>
    item.reference_ids.includes(r.id),
  );
  const renderer = renderMode(input, item);
  const policyIssues = imagePolicyIssues(input, item);
  const warnings = isProductTask(input, item)
    ? riskyInstructions(
        {
          ...item,
          requirement: [input.requirements, intent, item.attributes_prompt]
            .filter(Boolean)
            .join("\n"),
        },
        standard,
      )
    : [];
  // Legacy long prompts must be reanalyzed; never silently send a different prompt.
  const description = item.description_prompt || "";
  const attributes = item.attributes_prompt || "";
  shortPrompt(description);
  shortPrompt(attributes);
  const assembled = assembleModulePrompt(description, attributes);
  const prompt = assembleExecutionPrompt(assembled, standard);
  const parts = { description, attributes };
  const base = parts;
  return {
    render_mode: renderer,
    request_mode:
      renderer === "composition"
        ? "source_composition"
        : refs.length
          ? "image_edit"
          : "text_to_image",
    policy_issues: policyIssues,
    quality_warnings: warnings,
    parts,
    automatic_parts: base,
    automatic_prompt: assembled,
    automatic_signature: hash(assembled),
    prompt_stale: false,
    module_prompt: assembled,
    prompt,
    missing,
    status: policyIssues.length
      ? "needs_info"
      : missing.length
        ? "needs_info"
        : (renderer !== "composition" && !description) || (!item.analyzed && !item.manual_confirmed)
          ? "needs_analysis"
          : "ready",
  };
}
export function readPlan(row, t) {
  const input = parse(row.input_json),
    content = parse(row.content_json),
    plan = {
      id: row.id,
      template_id: row.template_id,
      version_id: row.version_id,
      revision: row.revision,
      input,
      content,
      status: row.status,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  const issues = [];
  plan.content = {
    ...content,
    standard: normalizeStandard(content.standard),
  };
  plan.content = {
    ...plan.content,
    items: (content.items || []).map((i) => {
      try {
        return { ...i, ...compilePlanItem(plan, i, t) };
      } catch (e) {
        issues.push({
          item_id: i.id,
          code: e.code,
          message: e.publicMessage || e.message,
        });
        return {
          ...i,
          prompt: "",
          parts: {},
          automatic_parts: {},
          missing: [],
          status: "invalid",
          error: e.publicMessage || e.message,
        };
      }
    }),
  };
  plan.issues = issues;
  return plan;
}
export function ownedPlan(t, id) {
  const row = getDb()
    .prepare(
      "SELECT * FROM style_plans WHERE id=? AND template_id=? AND user_id=?",
    )
    .get(id, t.id, t.user_id);
  if (!row) throw problem("PLAN_NOT_FOUND", "图片规划不存在", 404);
  return row;
}
export function savePlanRevision(row, input, content, status = "draft") {
  const db = getDb(),
    now = new Date().toISOString();
  const changed = db
    .prepare(
      "UPDATE style_plans SET revision=revision+1,input_json=?,content_json=?,status=?,updated_at=? WHERE id=? AND revision=?",
    )
    .run(
      JSON.stringify(input),
      JSON.stringify(content),
      status,
      now,
      row.id,
      row.revision,
    );
  if (!changed.changes)
    throw problem(
      "PLAN_CONFLICT",
      "规划已在其他窗口更新，当前草稿保留，请载入最新内容后合并",
      409,
    );
  db.prepare("INSERT INTO style_plan_revisions VALUES(?,?,?,?,?)").run(
    row.id,
    row.revision + 1,
    JSON.stringify(input),
    JSON.stringify(content),
    now,
  );
  return db.prepare("SELECT * FROM style_plans WHERE id=?").get(row.id);
}
