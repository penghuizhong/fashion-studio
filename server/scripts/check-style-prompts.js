import assert from "node:assert/strict";
import {
  assembleModulePrompt,
  standardForReferences,
  descriptionForReferences,
  assembleExecutionPrompt,
  promptLength,
  describeStyleVersion,
  stylePresetPrompt,
  modulePromptTemplate,
  cleanPlanContent,
  parseStandardText,
  assembleStandardText,
  applyAnalysisContent,
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
assert.doesNotMatch(
  modulePromptTemplate("main"),
  /同模块多图|品牌介绍|款式卖点/,
);
assert.match(modulePromptTemplate("main"), /仅输出1张/);
assert.match(
  modulePromptTemplate("main", { phase: "analysis", count: 2, index: 1 }),
  /第2\/2张/,
);
assert.doesNotMatch(modulePromptTemplate("brand"), /主图展示|款式卖点/);

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

assert.equal(promptLength("裙".repeat(200)), 200);
assert.equal(promptLength("👗".repeat(200)), 200);
const concise = assembleModulePrompt("一位模特完整展示商品，无新增文字。", "冰蓝色挂脖长裙，保留原图褶皱。");
assert.equal(assembleExecutionPrompt(concise, {}), concise);
assert.equal(assembleExecutionPrompt(concise, { tone: "米白背景" }), concise + "\n\n核心视觉基调：米白背景");
const conciseContent = cleanPlanContent({ standard: {}, items: [{ id: "concise", description_prompt: "主要描述", attributes_prompt: "基本属性" }] });
assert.equal(conciseContent.items[0].description_prompt, "主要描述");
assert.equal(conciseContent.items[0].attributes_prompt, "基本属性");
console.log("Concise prompts: Unicode counts, two-field persistence and exact backend concatenation passed.");

const boundRefs = [{ role: "garment" }, { role: "model" }];
const oldStandard = { tone: "米白背景", subject: "未提供独立模特参考图，创建新模特。" };
assert.match(standardForReferences(oldStandard, boundRefs).subject, /已提供图2模特参考图/);
assert.equal(standardForReferences(oldStandard, boundRefs).tone, oldStandard.tone);
assert.match(standardForReferences(oldStandard, boundRefs.slice(0, 1)).subject, /未提供/);
assert.equal(descriptionForReferences("新模特穿着商品，无新增文字。", boundRefs), "该模特穿着商品，无新增文字。");
assert.equal(descriptionForReferences("不要生成新模特，保持图2人物一致。", boundRefs), "不要生成新模特，保持图2人物一致。");
assert.equal(descriptionForReferences("创建新模特", []), "创建新模特");
console.log("Reference binding: actual model attachments override stale absence notices without reversing negative constraints.");
assert.equal(promptLength(descriptionForReferences("新模特" + "裙".repeat(197), boundRefs)), 200);
assert.equal(descriptionForReferences(null, boundRefs), null);
