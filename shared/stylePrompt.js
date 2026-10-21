import {
  DETAIL_MODULES,
  STANDARD_SECTIONS,
  normalizeStandard,
} from "./stylePlan.js";
import { PRESENTATION_STYLES } from "./presentationStyles.js";

const parse = (value, fallback) => {
  if (typeof value !== "string") return value ?? fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
};
const FIELD_LABELS = {
  silhouette: "版型",
  lapel: "驳领",
  collar: "领型",
  buttons: "门襟纽扣",
  vent: "后开衩",
  fabric: "面料外观",
  pattern: "图案",
  style: "款式风格",
  scene: "适用场景",
  details: "设计细节",
  primary_color: "主色",
  secondary_color: "辅色",
  sleeve: "袖型",
  length: "衣长",
  waist: "腰部设计",
  neckline: "领口",
  closure: "闭合方式",
};
function readableValue(value) {
  if (Array.isArray(value))
    return value.map(readableValue).filter(Boolean).join("、");
  if (!["string", "number"].includes(typeof value)) return "";
  const s = String(value).trim();
  return /^(未知|不确定|无法识别|待确认|未提供|unknown|null|undefined|n\/a|none)$/i.test(
    s,
  )
    ? ""
    : s;
}
// The immutable version's schema supplies labels; model metadata never reaches image prompts.
export function describeStyleVersion(version = {}) {
  const dna = parse(version.dna_json, {}),
    schema = parse(version.schema_json, []);
  const labels = new Map(
    (Array.isArray(schema) ? schema : []).map((f) => [f.key, f.label]),
  );
  const lines = Object.entries(dna || {}).flatMap(([key, field]) => {
    const label = labels.get(key) || FIELD_LABELS[key];
    const value = readableValue(
      field && typeof field === "object" && !Array.isArray(field)
        ? field.value
        : field,
    );
    return label && value ? [`${label}为${value}`] : [];
  });
  return lines.length
    ? `本款服装${lines.join("，")}。`
    : "本款尚无可用的明确属性，请按商品参考图可见特征展示，不推测未知参数。";
}
export function stylePresetPrompt(style = "auto") {
  const preset = PRESENTATION_STYLES.find(([id]) => id === style);
  return preset
    ? `${preset[1]}：${preset[2]} 仅调整展示环境与摄影，不改变服装原有颜色、结构与模特身份。`
    : "根据本款服装与所选模块选择协调的摄影风格，整套图片保持一致；不改变服装原有颜色与结构。";
}
export function modulePromptTemplate(moduleId) {
  const module = DETAIL_MODULES.find((m) => m.id === moduleId);
  if (!module) return "";
  return [
    `你正在制作「${module.name}」图片。表达目标：${module.description}。`,
    `专用画面规则：${module.guide}`,
    module.subject === "text"
      ? "内容层级：标题、辅助短句、留白；不出现商品或模特。"
      : "内容层级：服装主体优先，模块信息次之，背景与装饰辅助；商品细节清晰，避免元素遮挡核心展示区域。",
    module.text
      ? "文字仅使用已确认的本图文案；管理标题不自动上图。未提供品牌、价格或承诺时不得虚构。"
      : "优先用画面表达卖点；没有明确文案要求时不叠加宣传文字。",
    "同模块多图分别展示不同重点、姿态或构图，避免重复。不得照抄参考图水印与平台界面。",
  ].join("\n");
}
export function assembleStandardText(standard = {}) {
  return STANDARD_SECTIONS.map(
    ([key, label]) => `${label}：${standard[key] || ""}`,
  ).join("\n");
}
export function parseStandardText(value) {
  const out = Object.fromEntries(STANDARD_SECTIONS.map(([key]) => [key, ""]));
  let key = "tone";
  for (const line of String(value || "").split("\n")) {
    const trimmed = line.trim();
    const hit = STANDARD_SECTIONS.find(
      ([, label]) =>
        trimmed.startsWith(`${label}：`) || trimmed.startsWith(`${label}:`),
    );
    if (hit) {
      key = hit[0];
      out[key] = trimmed.slice(hit[1].length + 1).trim();
    } else out[key] = [out[key], line].filter(Boolean).join("\n").trim();
  }
  return out;
}
export function cleanPlanContent(content) {
  return content
    ? {
        standard: content.standard,
        conflict_ack: content.conflict_ack || "",
        standard_edited: content.standard_edited || false,
        items: content.items.map((i) => ({
          id: i.id,
          render_mode: i.render_mode,
          layout: i.layout,
          risk_ack: i.risk_ack || "",
          module_id: i.module_id,
          title: i.title,
          requirement: i.requirement,
          copy: i.copy || "",
          camera: i.camera,
          reference_ids: i.reference_ids,
          prompt_overrides: i.prompt_overrides || {},
          prompt_override: i.prompt_override || "",
          prompt_override_basis: i.prompt_override_basis || "",
          edited: i.edited === true,
          spec: i.spec || {},
          selected: i.selected,
          manual_confirmed: i.manual_confirmed,
          size: i.size || "",
          quality: i.quality || "",
        })),
      }
    : null;
}
export function hasManualPlanEdits(
  content,
  ids = content.items.map((i) => i.id),
) {
  return (
    !!content.standard_edited ||
    content.items.some(
      (i) =>
        ids.includes(i.id) &&
        (i.edited ||
          i.layout?.details?.some((d) => d.confirmed) ||
          i.prompt_override ||
          i.manual_confirmed ||
          Object.keys(i.prompt_overrides || {}).length),
    )
  );
}
// Used for successful and partial analyses. An explicit user choice is required to replace edits.
export function applyAnalysisContent(
  content,
  progress,
  { replaceManual = false, full = false } = {},
) {
  const candidates = new Map((progress.items || []).map((i) => [i.id, i]));
  return {
    ...content,
    ...(progress.conflicts !== undefined
      ? { reference_conflicts: progress.conflicts, conflict_ack: "" }
      : {}),
    standard:
      full && progress.standard && (replaceManual || !content.standard_edited)
        ? normalizeStandard(progress.standard)
        : content.standard,
    standard_edited: full && replaceManual ? false : content.standard_edited,
    items: content.items.map((item) => {
      const next = candidates.get(item.id);
      if (!next) return item;
      if (!replaceManual && hasManualPlanEdits({ items: [item] })) return item;
      return {
        ...item,
        ...next,
        prompt_override: "",
        prompt_override_basis: "",
        prompt_overrides: {},
        edited: false,
        manual_confirmed: false,
        analyzed: true,
      };
    }),
  };
}
