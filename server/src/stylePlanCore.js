import crypto from "node:crypto";
import {
  DETAIL_MODULES,
  PLAN_LIMITS,
  DEFAULT_STANDARD,
  GLOBAL_MODULE_RULES,
  SPEC_FIELDS,
  REFERENCE_ROLES,
  EDITABLE_PROMPT_PARTS,
  PROMPT_PARTS,
  defaultPlanCamera,
  isNoTextLanguage,
  moduleCounts,
  normalizeStandard,
} from "../../shared/stylePlan.js";
import {
  normalizeCamera,
  photographyPrompt,
  validateCameraIntent,
} from "../../shared/photography.js";
import { canonical, parse, styleVersion } from "./styleVersions.js";
import { imageFor } from "./styleWorkspace.js";
import { problem } from "./exploreErrors.js";
import { getDb } from "./db.js";
const object = (v) => v && typeof v === "object" && !Array.isArray(v);
export function text(value, max = 2000) {
  if (typeof value !== "string" || value.length > max)
    throw problem("INVALID_PLAN", `文字格式无效或超过${max}字`);
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
  const result = {
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
          copy: "",
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
      spec[k] = i.spec?.[k] === undefined ? "" : text(i.spec[k], 2000);
    const item = {
      id: i.id,
      module_id: i.module_id,
      title: text(i.title || "", 200),
      requirement: text(i.requirement || "", 3000),
      copy: text(i.copy || "", 3000),
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
    v = styleVersion(t, plan.version_id),
    module = DETAIL_MODULES.find((m) => m.id === item.module_id);
  const missing =
    module.required && !input.facts[module.required] ? [module.required] : [];
  const camera = normalizeCamera(item.camera);
  validateCameraIntent(camera, item.requirement);
  if (
    input.op === "white" &&
    /海滩|海岛|街道|森林|沙滩|非白|黑色背景|beach|forest|street|black background/i.test(
      item.requirement,
    )
  )
    throw problem("CONFLICTING_BACKGROUND", "白底商品图与场景要求冲突");
  const refs = input.references.filter((r) =>
    item.reference_ids.includes(r.id),
  );
  const spec = item.spec || {};
  const specLine = (key, label) => (spec[key] ? `${label}：${spec[key]}` : "");
  const worn = module.subject === "worn";
  const base = {
    goal: `模块：${module.name}\n模块画面指引：${module.guide}\n图片目标：${item.requirement}\n任务：${input.op}；风格：${input.style}`,
    design: [
      `设计版本：V${v.number}`,
      `已保存属性：${v.dna_json}`,
      `已保存设计说明：${v.design_note || "无"}`,
      `服装基础特征：${standard.garment}`,
      `主体识别摘要：${standard.subject}`,
      specLine("garment", "本图服装识别"),
      specLine("subject", "本图主体识别"),
      `必须保留：${input.keep || "保存版本的设计特征"}`,
      "保持服装本身配色和结构；展示风格不能改写设计。",
    ]
      .filter(Boolean)
      .join("\n"),
    references: refs.length
      ? refs
          .map(
            (r) =>
              `图${input.references.indexOf(r) + 1} / 引用${r.id}：${REFERENCE_ROLES[r.role]}。仅采用其指定角色；款式主体以图1和保存版本为准。`,
          )
          .join("\n")
      : "无参考图片，使用已保存属性。",
    composition: [
      `核心视觉基调：${standard.tone}`,
      `全局摄影参数：${standard.photography}`,
      specLine("strategy", "试穿策略"),
      specLine("composition", "构图方案"),
      specLine("lighting", "光影方案"),
      specLine("background", "背景描述"),
      specLine("palette", "配色方案"),
      specLine("mood", "视觉氛围关键词"),
      module.subject === "text"
        ? "纯文字与装饰元素的章节过渡卡；允许无服装、无人物，不要求全身或露脸。"
        : "",
      item.delivery_slot
        ? photographyPrompt(camera, v.preset_id)
        : "",
      item.delivery_slot === "side_right" ? "展示服装另一侧（右侧）。" : "",
    ]
      .filter(Boolean)
      .join("\n"),
    copy: [
      standard.typography
        ? `文字系统规范：${standard.typography}`
        : "本图不叠加成段文字；如需少量标签，简洁清晰，不遮挡服装。",
      `新增文字使用${input.language}。管理标题不是图内文字。`,
      `本图文案：${item.copy || spec.text || "不添加未经确认的文字"}`,
      `商品资料：${JSON.stringify(input.facts)}`,
      "商品原有logo、标识及技术单位保持原样。",
    ].join("\n"),
    limits: [
      ...(worn
        ? [
            GLOBAL_MODULE_RULES.mandatory,
            GLOBAL_MODULE_RULES.subjectFirst,
            GLOBAL_MODULE_RULES.detailContext,
          ]
        : [
            module.subject === "text"
              ? "本模块为纯文字过渡卡，不出现模特与商品。"
              : "本模块为展示型画面，不出现模特；服装完整、轮廓清楚。",
          ]),
      GLOBAL_MODULE_RULES.antiCopy,
      standard.facts,
      ["buyer", "blogger"].includes(item.module_id)
        ? "AI模拟穿搭，不代表真实买家评价或人物背书。"
        : "",
      input.op === "white" ? "纯白商品背景，不添加促销文字或图形。" : "",
      worn ? "完整单品图不得裁断服装；局部图仅按明确部位取景。" : "",
    ]
      .filter(Boolean)
      .join("\n"),
    output: `尺寸：${item.size || input.size || "待选择"}；质量：${item.quality || input.quality || "模型默认"}。`,
  };
  const parts = { ...base, ...item.prompt_overrides };
  // Immutable source/reference/output constraints remain visible in the final prompt.
  const prompt = Object.entries(parts)
    .map(([k, value]) => `## ${PROMPT_PARTS[k]}\n${value}`)
    .join("\n\n");
  return {
    parts,
    automatic_parts: base,
    prompt,
    missing,
    status: missing.length
      ? "needs_info"
      : !item.analyzed && !item.manual_confirmed
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
