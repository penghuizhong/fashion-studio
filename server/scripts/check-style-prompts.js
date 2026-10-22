import assert from "node:assert/strict";
import {
  describeStyleVersion,
  stylePresetPrompt,
  modulePromptTemplate,
  cleanPlanContent,
  parseStandardText,
  assembleStandardText,
  applyAnalysisContent,
  imageSystemPrompt,
  moduleDesignText,
  imagePromptLayers,
} from "../../shared/stylePrompt.js";
import { DETAIL_MODULES, DEFAULT_STANDARD } from "../../shared/stylePlan.js";

const description = describeStyleVersion({
  dna_json: JSON.stringify({
    primary_color: { value: "黑色", confidence: 0.9 },
    lapel: { value: "平驳头", confirmed: true },
    details: { value: ["贴兜", "未知"] },
    fabric: { value: "未知" },
    internal_only: { value: "不要泄漏" },
  }),
  schema_json: JSON.stringify([{ key: "primary_color", label: "主色" }]),
});
assert.match(description, /主色为黑色.*驳领为平驳头.*设计细节为贴兜/);
assert.doesNotMatch(description, /confidence|confirmed|不要泄漏|未知|\{|\}/);
assert.match(stylePresetPrompt("luxury"), /refined materials/);
for (const module of DETAIL_MODULES) {
  assert.match(modulePromptTemplate(module.id), new RegExp(module.name));
  assert.ok(modulePromptTemplate(module.id).includes(module.guide));
}
assert.notEqual(modulePromptTemplate("main"), modulePromptTemplate("brand"));
const blank = parseStandardText("");
assert.ok(Object.values(blank).every((value) => value === ""));
assert.equal(parseStandardText("暖光、灰色背景。").tone, "暖光、灰色背景。");
assert.equal(
  parseStandardText(" 全局摄影参数：柔光\n补充镜头规则").photography,
  "柔光\n补充镜头规则",
);
assert.deepEqual(
  parseStandardText(assembleStandardText(DEFAULT_STANDARD)),
  DEFAULT_STANDARD,
);
const content = {
  standard: DEFAULT_STANDARD,
  items: [
    {
      id: "item-one",
      module_id: "main",
      prompt_override: "手工完整提示词",
      spec: { lighting: "柔光" },
      edited: true,
    },
  ],
};
const payload = cleanPlanContent(content);
assert.equal(payload.items[0].prompt_override, "手工完整提示词");
assert.equal(payload.items[0].spec.lighting, "柔光");
assert.notEqual(
  JSON.stringify(payload),
  JSON.stringify(
    cleanPlanContent({
      ...content,
      items: [{ ...content.items[0], prompt_override: "另一个提示词" }],
    }),
  ),
);
const progress = {
  standard: { ...DEFAULT_STANDARD, tone: "新基调" },
  items: [{ id: "item-one", requirement: "新方案" }],
};
assert.equal(
  applyAnalysisContent(content, progress).items[0].prompt_override,
  "手工完整提示词",
);
assert.equal(
  applyAnalysisContent(content, progress, { replaceManual: true }).items[0]
    .prompt_override,
  "",
);
assert.equal(
  applyAnalysisContent({ ...content, standard_edited: true }, progress, {
    full: true,
  }).standard.tone,
  DEFAULT_STANDARD.tone,
);
assert.equal(
  applyAnalysisContent(content, progress, { full: true, replaceManual: true })
    .standard.tone,
  "新基调",
);
console.log(
  "Style prompt contracts passed: natural language, 19 templates, serialization, standard deletion and manual-edit preservation.",
);

// Module exceptions and six-layer ordering must survive compilation without
// leaking arbitrary table cells into extra rows or inventing source identities.
assert.match(imageSystemPrompt(), /平铺、挂架和纯文字模块/);
assert.match(imageSystemPrompt({ creative: true }), /新设计建议/);
const design = moduleDesignText({ module_id: "fabric", spec: { lighting: "左前45°柔光|5500K\n阴影柔和" } }, { index: 2, total: 3 });
assert.match(design, /当前张数：2\/3/);
assert.match(design, /左前45°柔光／5500K；阴影柔和/);
assert.equal(design.split("\n").filter((line) => /^\| (主体识别|服装识别|试穿策略|构图方案|光影方案|背景描述|配色方案|文字内容|视觉氛围关键词) \|/.test(line)).length, 9);
const layers = imagePromptLayers({ system: "执行边界", standard: "米白背景", goal: design, description: "自然站立", requirements: "全身", output: "1024x1024" });
assert.deepEqual(layers.map((layer) => layer.id), ["system", "standard", "module", "description", "requirements", "output"]);
assert.match(layers[3].text, /自然站立/);
assert.doesNotMatch(layers[4].text, /自然站立/);
console.log("Six-layer prompt contracts passed: module exceptions, nine dimensions and source boundaries.");
