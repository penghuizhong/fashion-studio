// Product accuracy is a separate task from creative redesign.
export const PRODUCT_CHECKS = {
  structure: "领口、腰部、门襟等关键结构",
  color: "商品配色",
  material: "面料外观",
  pattern: "图案、标识与细节位置",
  identity: "人物一致性（无人像时视为不适用并通过）",
  composition: "完整性、构图与模块任务",
  text: "中文逐字核对（无文字时通过）",
};
export const generationMode = (input) =>
  input.generation_mode ||
  (["free_design", "recolor", "detail_modify"].includes(input.op)
    ? "creative"
    : "product");
export const isProductTask = (input, item) =>
  generationMode(input) === "product" && item.module_id !== "transition";
export const renderMode = (input, item) =>
  item.render_mode ||
  (isProductTask(input, item) && item.module_id === "selling"
    ? "composition"
    : "image");
export const defaultCrop = () => ({ x: 0, y: 0, width: 1, height: 1 });
export function validateCrop(crop) {
  return (
    crop &&
    ["x", "y", "width", "height"].every((k) => Number.isFinite(crop[k])) &&
    crop.x >= 0 &&
    crop.y >= 0 &&
    crop.width >= 0.01 &&
    crop.height >= 0.01 &&
    crop.x + crop.width <= 1.000001 &&
    crop.y + crop.height <= 1.000001
  );
}
export function defaultLayout(ref = "") {
  return {
    headline: "款式特点",
    subtitle: "",
    background: "#F5F3EF",
    color: "#303436",
    accent: "#55727D",
    font_size: 22,
    main_position: "left",
    gap: 24,
    main_reference_id: ref,
    main_crop: defaultCrop(),
    details: [],
  };
}
export function layoutIssue(layout, refs = []) {
  if (
    !layout ||
    !refs.some((r) => r.id === layout.main_reference_id && r.role === "garment")
  )
    return "请选择主展示商品图";
  if (!validateCrop(layout.main_crop)) return "主展示裁切范围无效";
  if (
    !Array.isArray(layout.details) ||
    layout.details.length < 1 ||
    layout.details.length > 4
  )
    return "请添加1–4个有图片依据的卖点";
  for (const d of layout.details) {
    if (
      !refs.some(
        (r) =>
          r.id === d.reference_id && ["garment", "fabric"].includes(r.role),
      )
    )
      return "卖点必须绑定商品或细节图";
    if (!validateCrop(d.crop)) return "卖点裁切范围无效";
    if (!d.title?.trim()) return "请填写每个卖点标题";
    if (!d.confirmed) return "请核对并确认每个卖点的裁切与文案";
  }
  return "";
}
export function imagePolicyIssues(input, item) {
  if (!isProductTask(input, item)) return [];
  const issues = [];
  const refs = (input.references || []).filter((r) =>
    item.reference_ids?.includes(r.id),
  );
  if (!refs.some((r) => r.role === "garment"))
    issues.push("商品保真任务缺少商品原图，请在需求分析中添加");
  if (renderMode(input, item) === "composition") {
    const issue = layoutIssue(item.layout, refs);
    if (issue) issues.push(issue);
  }
  return issues;
}
export const CORE_IMAGE_RULES = {
  main: "单幅商品照片：一位模特、同一件服装、自然静态姿势、简洁背景。完整呈现本款服装，长裙必须展示领口、腰部、鱼尾及拖地裙摆。不添加新文字、标签、拼图、放大圈、参数表或装饰卡。保留商品原有标识。",
  selling:
    "商品结构说明页：主展示图配1–4个有来源的局部图和短文案，按领口、腰部、裙摆等真实设计组织信息。允许人台、平铺或已验收的模特主图，不要求露脸，不重复生成人物。局部优先裁取原图，不凭空生成织纹与工艺。",
};
export const FIDELITY_RULES =
  "优先级：经用户核对的商品事实与原图结构 > 本模块展示任务 > 整体视觉风格 > 背景和装饰。事实与图片冲突须先核对，不擅自改款。禁止在无图像依据时加入薄纱、透明、动态模糊、裙摆飞扬或虚构工艺；不以高级感为理由改变结构、配色、图案和面料外观。模特图只约束人物，不借用其服装。";
export function riskyInstructions(item, standard = {}) {
  const text = [
    item.requirement,
    item.observation,
    item.prompt_override,
    ...Object.values(item.spec || {}),
    ...Object.values(standard),
  ]
    .join("\n")
    .split(/[。！？\n]/)
    .filter((line) => !/禁止|不得|不使用|避免/.test(line))
    .join("\n");
  const warnings = [];
  if (/动态模糊|裙摆飞扬|穿透薄纱|强化.*通透|透明薄纱/.test(text))
    warnings.push("包含可能改变服装外观的动态或透光要求，请核对原图依据");
  if (/model_[\w-]+/.test(text))
    warnings.push("模特编号不是图片，请核对实际模特参考图");
  if (/盘起或|亚洲或混血|自然站姿.*动态抓拍/.test(text))
    warnings.push("人物描述含未确定分支，请固定本次人物特征");
  return warnings;
}
