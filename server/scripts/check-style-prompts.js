import assert from "node:assert/strict";
import {
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
