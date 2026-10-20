// Shared product-image vocabulary and bounds; unrelated creative counts stay unchanged.
export const PLAN_LIMITS = Object.freeze({ per_module: 16, total: 64 });
export const DETAIL_MODULES = [
  ["main", "主图展示", "首屏主视觉，完整展示服装", "商品展示"],
  ["brand", "品牌介绍", "品牌定位与视觉印象", "品牌与服务", "brand"],
  ["selling", "款式卖点", "突出本款独有的设计亮点", "设计细节"],
  ["fabric", "面料工艺", "面料质感与局部工艺展示", "设计细节"],
  ["cut", "版型裁剪", "展示轮廓、肩线与垂坠", "设计细节"],
  ["color_size", "颜色尺码", "颜色与已确认尺码资料", "商品信息", "sizes"],
  ["colors", "多色组合", "同款真实颜色并排对比", "商品展示", "colors"],
  ["promotion", "价格优惠", "已确认价格与活动信息", "品牌与服务", "promotion"],
  ["specs", "规格参数", "准确展示已确认商品参数", "商品信息", "specs"],
  ["care", "洗护说明", "按真实材质提供已确认洗护资料", "商品信息", "care"],
  ["service", "售后保障", "清楚展示实际服务承诺", "品牌与服务", "service"],
  ["faq", "常见问题", "解答用户提供的常见问题", "品牌与服务", "faq"],
  ["buyer", "买家秀", "AI 模拟穿搭，展示日常效果", "穿搭展示"],
  ["outfit", "搭配推荐", "突出服装与配饰的搭配", "穿搭展示"],
  ["scene", "场景穿搭", "服装在指定环境中的穿着展示", "穿搭展示"],
  ["blogger", "博主穿搭", "AI 风格穿搭，不代表真实人物背书", "穿搭展示"],
  ["flat", "平铺图", "完整平铺，突出轮廓与配件关系", "商品展示"],
  ["hanger", "挂架展示", "完整悬挂，展示服装廓形", "商品展示"],
  ["transition", "章节过渡卡", "简洁文案与视觉衔接", "品牌与服务"],
].map(([id, name, description, group, required]) => ({
  id,
  name,
  description,
  group,
  required,
}));
export const FACT_FIELDS = {
  brand: "品牌资料",
  sizes: "尺码资料",
  colors: "真实颜色/变体",
  promotion: "价格与优惠",
  specs: "规格参数",
  care: "洗护资料",
  service: "售后政策",
  faq: "常见问题",
};
export const MODULE_SETS = {
  基础展示: { main: 1, selling: 1, cut: 1 },
  详情介绍: { main: 1, selling: 2, fabric: 1, cut: 1 },
  穿搭展示: { main: 1, outfit: 1, scene: 1 },
};
export const REFERENCE_ROLES = {
  garment: "款式主体",
  model: "参考模特",
  fabric: "面料细节",
  scene: "场景风格",
};
export const PLAN_STEPS = [
  "款式属性",
  "需求分析",
  "方案预览",
  "生成中",
  "完成",
];
export const PROMPT_PARTS = {
  goal: "图片目标",
  design: "服装约束",
  references: "参考图分工",
  composition: "画面构成",
  copy: "图内文案",
  limits: "本图限制",
  output: "输出规格",
};
export const EDITABLE_PROMPT_PARTS = ["goal", "composition", "copy", "limits"];
export const DEFAULT_STANDARD = {
  garment: "保持本次已保存设计的颜色、结构、图案和标识。",
  photography: "中性背景，柔和棚拍光，服装质感清楚。",
  layout: "留白清晰，文字不遮挡服装；标题、说明层级明确。",
  language: "简体中文",
  facts: "只使用已确认资料；未知成分、尺码、价格和服务信息不编造。",
};
export function moduleCounts(items = []) {
  const counts = {};
  for (const i of items) counts[i.module_id] = (counts[i.module_id] || 0) + 1;
  return counts;
}
export function defaultPlanCamera(moduleId, index = 0, op = "create") {
  const c = {
    display: "model",
    view: ["front", "side", "back", "three_quarter"][index % 4],
    angle: "level",
    framing: "garment",
    scale: "balanced",
    scope: "single",
    detail: "",
  };
  if (moduleId === "flat")
    Object.assign(c, { display: "flat", view: "front", angle: "overhead" });
  if (moduleId === "hanger")
    Object.assign(c, { display: "hanger", view: "front" });
  if (["fabric"].includes(moduleId) || op === "detail_shot")
    Object.assign(c, {
      view: "front",
      framing: "detail",
      detail: moduleId === "fabric" ? "面料纹理和可见缝线" : "领口",
    });
  if (
    op !== "detail_shot" &&
    ["outfit", "scene", "buyer", "blogger"].includes(moduleId)
  )
    c.framing = "outfit";
  return c;
}
