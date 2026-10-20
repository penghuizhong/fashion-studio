// Shared product-image vocabulary and bounds; unrelated creative counts stay unchanged.
export const PLAN_LIMITS = Object.freeze({ per_module: 16, total: 64 });
// Module pipeline definitions. Each selected module is a pipeline station that
// produces image results (count stays multi-select per user decision 2026-10-20).
// guide: the module's own framing instruction from the user's module-prompt doc.
// subject: "worn" modules must show the model wearing the SKU; "display"
// (flat/hanger) and "text" (transition) are exempt from the worn-subject rules.
// text: modules whose images carry primary overlay text/cards; drives whether
// the plan standard generates a typography section.
export const DETAIL_MODULES = [
  ["main", "主图展示", "首屏主视觉，完整展示服装", "商品展示", null,
    "试穿主图：默认半身或全身镜头，主体正脸与眼神可见，自信自然的姿态，服装版型与关键细节完整可读。", "worn", true],
  ["brand", "品牌介绍", "品牌定位与视觉印象", "品牌与服务", "brand",
    "品牌介绍：编辑式半身或 3/4 镜头，主体正脸与坚定眼神可见，把穿着中的服装作为品牌封面主角，构图克制有质感。", "worn", true],
  ["selling", "款式卖点", "突出本款独有的设计亮点", "设计细节", null,
    "款式卖点：模特以富有表达力的姿态展现服装的核心卖点，构图允许时保留正脸与眼神；可在穿着部位叠加轻量的卖点标签或引线注释。", "worn", false],
  ["fabric", "面料工艺", "面料质感与局部工艺展示", "设计细节", null,
    "面料工艺：必须采用「可见正脸的穿着主画面 + 小型放大圆/嵌入图」组合，主画面保留模特正脸/眼神和被穿着的主 SKU；局部放大或引线注释指向穿着部位的面料、织纹、缝线、印花或工艺。严禁单独商品特写、无人脸纯宏观材质镜头或平铺图。", "worn", false],
  ["cut", "版型裁剪", "展示轮廓、肩线与垂坠", "设计细节", null,
    "版型剪裁：半身或 3/4 镜头，正面或 3/4 视角展示版型、垂坠与剪裁，保留正脸；可在角落附同一模特的侧面或背面小型嵌入图，但绝不替代主镜头。", "worn", false],
  ["color_size", "颜色尺码", "颜色与已确认尺码资料", "商品信息", "sizes",
    "颜色尺码：以模特穿着该 SKU 为主体，画面侧边或下方叠加色卡条、尺码徽章或小型卡片；构图允许时保留正脸；禁止把整张画面变成纯色卡或纯尺码图。", "worn", true],
  ["colors", "多色组合", "同款真实颜色并排对比", "商品展示", "colors",
    "多色组合：以模特穿着主色 SKU 为主体画面，侧边或下方以小窗并排展示同款其他颜色，主次分明；保留正脸，禁止把整张画面变成纯色卡墙。", "worn", true],
  ["promotion", "价格优惠", "已确认价格与活动信息", "品牌与服务", "promotion",
    "价格优惠：模特穿着该 SKU 为主，价格/促销徽章作为辅助元素，构图允许时保留正脸；徽章不得遮挡服装主体。", "worn", true],
  ["specs", "规格参数", "准确展示已确认商品参数", "商品信息", "specs",
    "规格参数：穿着中的主体 + 1-2 条指向穿着部位（领口/袖口/下摆/内长等）的引线注释或小型规格卡；构图允许时保留正脸。", "worn", true],
  ["care", "洗护说明", "按真实材质提供已确认洗护资料", "商品信息", "care",
    "洗护说明：模特穿着该 SKU，画面叠加小型养护图标条或贴纸式注释；保留正脸可见。", "worn", true],
  ["service", "售后保障", "清楚展示实际服务承诺", "品牌与服务", "service",
    "售后保障：模特正面镜头穿着该 SKU，画面附小型售后/退换徽章或简短承诺；编辑式上身构图，正脸可见。", "worn", true],
  ["faq", "常见问题", "解答用户提供的常见问题", "品牌与服务", "faq",
    "常见问题：模特穿着该 SKU，旁边或下方附整洁的问答信息卡或注释；编辑式肖像构图，正脸可见。", "worn", true],
  ["buyer", "买家秀", "AI 模拟穿搭，展示日常效果", "穿搭展示", null,
    "买家秀：模特穿着该 SKU 呈现真实生活感，画面附小型评价/星级卡或简短引言；保留正脸可见；禁止编造具体用户姓名或抄录无关评论。", "worn", true],
  ["outfit", "搭配推荐", "突出服装与配饰的搭配", "穿搭展示", null,
    "搭配推荐：全身或 3/4 镜头，该 SKU 作为主角配合低调搭配辅助；保留正脸可见，禁止让搭配件喧宾夺主或替换主 SKU。", "worn", true],
  ["scene", "场景穿搭", "服装在指定环境中的穿着展示", "穿搭展示", null,
    "场景穿搭：模特穿着该 SKU 置身匹配场景中，姿态自然；构图允许时保留正脸与眼神；场景层次应衬托而非淹没服装。", "worn", false],
  ["blogger", "博主穿搭", "AI 风格穿搭，不代表真实人物背书", "穿搭展示", null,
    "博主穿搭：街拍式半身至七分身镜头，模特穿着该 SKU 呈现真实日常穿搭氛围，表情自然亲和；背景为生活化场景并轻微虚化，禁止出现博主账号名、水印或平台 UI。", "worn", false],
  ["flat", "平铺图", "完整平铺，突出轮廓与配件关系", "商品展示", null,
    "平铺图：服装完整平铺、正上方俯拍，轮廓与配件关系清楚，不出现模特，不悬浮摆拍。", "display", false],
  ["hanger", "挂架展示", "完整悬挂，展示服装廓形", "商品展示", null,
    "挂架展示：服装悬挂于衣架，完整显示轮廓，服装店式真实陈列感，不使用真人。", "display", false],
  ["transition", "章节过渡卡", "简洁文案与视觉衔接", "品牌与服务", null,
    "章节过渡卡：唯一允许不出现模特的模块。纯文字过渡，底色取服装同色系深一档或浅一档；中央一句拉丁小标题 + 一句中文副标题，共 ≤ 12 字；仅一根极细横线；大量留白；禁止任何图形、模特、商品；图片文字语言为「无」时不生成此模块。", "text", true],
].map(([id, name, description, group, required, guide, subject, text]) => ({
  id,
  name,
  description,
  group,
  required,
  guide,
  subject,
  text,
}));
// Global rules from the user's module-prompt doc, injected at compile time for
// every image instead of being pasted into each item (user: 精简，不逐图重复).
export const GLOBAL_MODULE_RULES = {
  mandatory:
    "服装必须自然穿在参考主体身上，保持参考主体身份/物种/体态一致，保持服装颜色/材质/版型/细节一致。",
  subjectFirst:
    "主体优先：默认必须看到模特，且优先呈现正脸、眼神与主 SKU 的穿着效果；只有当模块本身要求局部细节（袖口/下摆/腰线等）且全身镜头不可行时，才允许收紧到仍包含面部和主 SKU 可见穿着区域的半身或 3/4 镜头；下装、裙装、鞋履也必须用带脸的全身/3/4 主画面配合局部放大，禁止纯无脸躯干、纯下半身或纯腿部裁切。",
  detailContext:
    "详情模块约束：即使是面料、工艺、尺码或参数特写，也必须保留穿着中的身体上下文与可识别面部或上半身，并通过小型放大圈/嵌入图/引线注释承载细节，禁止平铺图、悬浮衣服、纯商品细节图或完全看不到主体的画面。",
  antiCopy:
    "反抄录约束：禁止照搬上传图中的水印、社交平台 UI（点赞/评论/分享）、海报文字、二维码、与本 SKU 无关的 logo 或参考图里的随机文字。",
};
// Per-image instantiated spec fields (the doc's 10 fields minus 图片类型,
// which is the module itself). Analysis fills these per pipeline station.
export const SPEC_FIELDS = [
  ["subject", "主体识别"],
  ["garment", "服装识别"],
  ["strategy", "试穿策略"],
  ["composition", "构图方案"],
  ["lighting", "光影方案"],
  ["background", "背景描述"],
  ["palette", "配色方案"],
  ["text", "文字内容"],
  ["mood", "视觉氛围关键词"],
];
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
// Plan standard: the doc's five sections plus the kept facts guardrail.
export const STANDARD_SECTIONS = [
  ["tone", "核心视觉基调"],
  ["photography", "全局摄影参数"],
  ["subject", "主体识别摘要"],
  ["garment", "服装基础特征"],
  ["typography", "文字系统规范"],
  ["facts", "资料真实性"],
];
export const DEFAULT_STANDARD = {
  tone: "高级、简约、干净，突出服装质感与主体轮廓。",
  photography: "自然柔和光线，色温中性，阴影柔和，主体与服装细节清晰。",
  subject: "保持参考模特的身份、肤色、体型与发型一致，姿态自然自信。",
  garment: "保持本次已保存设计的颜色、结构、图案和标识。",
  typography:
    "图内文字使用简体中文，字体清晰易读、层级分明，与背景高对比，留白充足，不遮挡服装。",
  facts: "只使用已确认资料；未知成分、尺码、价格和服务信息不编造。",
};
export const LIGHT_TEXT_TYPOGRAPHY =
  "少量标签文字，简洁清晰，不遮挡服装主体。";
export function isNoTextLanguage(language = "") {
  return /^\s*(无|none|no\s*text|不加文字|无文字)\s*$/i.test(language || "");
}
// Map a pre-0.13 standard ({garment, photography, layout, language, facts})
// onto the new six sections without dropping what the user already had.
export function normalizeStandard(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const out = {};
  for (const [k] of STANDARD_SECTIONS)
    out[k] =
      typeof source[k] === "string" ? source[k] : DEFAULT_STANDARD[k];
  // Legacy standards (pre-0.13) have no tone/subject/typography keys; their
  // layout + language fold into typography, shared keys carry over above.
  const isLegacy =
    typeof source.tone !== "string" &&
    typeof source.subject !== "string" &&
    typeof source.typography !== "string";
  if (isLegacy) {
    const legacyText = [
      typeof source.layout === "string" ? source.layout : "",
      typeof source.language === "string" && source.language
        ? `图内文字语言：${source.language}。`
        : "",
    ]
      .filter(Boolean)
      .join("\n");
    if (legacyText) out.typography = legacyText;
  }
  return out;
}
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
