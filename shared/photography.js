export const CAMERA_OPTIONS = {
  display: [
    ["model", "真人穿着"],
    ["mannequin", "人台展示"],
    ["hanger", "挂架展示"],
    ["flat", "平铺展示"],
  ],
  view: [
    ["front", "正面"],
    ["three_quarter", "四分之三"],
    ["side", "侧面"],
    ["back", "背面"],
  ],
  angle: [
    ["level", "平视"],
    ["overhead", "正上方俯拍"],
  ],
  framing: [
    ["garment", "完整单品"],
    ["outfit", "全身穿搭"],
    ["detail", "局部特写"],
  ],
  scale: [
    ["balanced", "适中，四周留白"],
    ["large", "较大，保留边缘"],
  ],
  scope: [
    ["single", "单件服装"],
    ["set", "整套服装"],
  ],
};
export const DEFAULT_CAMERA = {
  display: "model",
  view: "front",
  angle: "level",
  framing: "garment",
  scale: "balanced",
  scope: "single",
  detail: "",
};
const invalid = (message) => {
  throw Object.assign(new Error(message), {
    code: "INVALID_CAMERA",
    statusCode: 400,
    publicMessage: message,
  });
};
export function normalizeCamera(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    invalid("视角与取景参数格式不正确");
  const c = { ...DEFAULT_CAMERA, ...input };
  for (const key of Object.keys(input))
    if (!Object.hasOwn(DEFAULT_CAMERA, key)) invalid("存在不支持的拍摄参数");
  for (const [key, options] of Object.entries(CAMERA_OPTIONS))
    if (!options.some(([value]) => value === c[key]))
      invalid("请选择有效的视角与取景");
  if (typeof c.detail !== "string" || c.detail.length > 160)
    invalid("特写部位限 160 字");
  c.detail = c.detail.trim();
  if (
    c.display === "flat" &&
    (c.angle !== "overhead" || c.view !== "front" || c.framing === "outfit")
  )
    invalid("平铺请使用正上方俯拍、正面和单品或局部取景");
  if (c.display !== "flat" && c.angle === "overhead")
    invalid("正上方俯拍仅用于平铺展示");
  if (c.framing === "detail" && !c.detail) invalid("请填写局部特写部位");
  if (c.framing !== "detail" && c.detail)
    invalid("完整取景不能同时指定局部特写");
  return c;
}
export function photographyPrompt(input, presetId = "") {
  const c = normalizeCamera(input);
  const completeness = /pant|trouser|jean|short/.test(presetId)
    ? "include the entire waistband and all leg hems"
    : /dress|skirt/.test(presetId)
      ? "include the entire neckline or waistband and the complete skirt hem"
      : "include the whole garment, neckline, both sleeve cuffs and the entire bottom hem";
  const view = {
    front: "straight front view",
    back: "straight back view",
    side: "true side view",
    three_quarter: "three-quarter view",
  }[c.view];
  return [
    "COMPOSITION REQUIREMENTS (apply to every image in this batch):",
    c.display === "flat"
      ? "flat lay, camera directly overhead"
      : c.display === "mannequin"
        ? "garment on a neutral mannequin, camera level"
        : c.display === "hanger"
          ? "garment hanging naturally on a clothes hanger, no mannequin and no person, camera level"
          : "garment worn by a model in a neutral standing pose, camera level, arms not obscuring garment structure",
    view,
    c.framing === "detail"
      ? `intentional close-up of ${c.detail}; this is an AI interpretation, do not invent product specifications`
      : c.framing === "outfit"
        ? "head-to-toe full outfit; entire clothing and footwear inside the frame"
        : `complete ${c.scope === "set" ? "coordinated clothing set, all garments fully visible" : "single garment"}; ${c.view === "side" ? "keep the full visible side silhouette, sleeve and garment hem; do not invent hidden geometry" : completeness}; full garment does not require full-body portrait`,
    c.framing === "detail"
      ? "focus only on the requested area"
      : "center the subject, keep all garment edges inside the image; no cropped sleeves, hems or waist; no foreground occlusion",
    c.scale === "large"
      ? "large subject with a safe border on every side"
      : "consistent medium subject scale, comfortable margin on every side; avoid extreme distant shots",
    "Do not combine multiple camera angles in one image. Back construction may be described in the design but should only be visible when the chosen view permits it.",
  ].join(". ");
}

// Detect explicit photographic requests only; structural descriptions such as back vents
// remain design attributes and must not force the camera to show the back.
export function validateCameraIntent(camera, text = "") {
  const clean = String(text).replace(
    /(?:不要|避免|不需要|无需|不做)[^，。；\n]{0,12}(?:特写|近景|背面|正面)/g,
    "",
  );
  if (
    camera.framing !== "detail" &&
    /(?:必须|只要|要求|拍摄|生成|镜头|画面)[^，。；\n]{0,8}(?:特写|近景)/.test(
      clean,
    )
  )
    invalid("要求中包含局部近景，请切换局部特写或修改要求，与完整取景保持一致");
  if (
    camera.framing === "detail" &&
    /(?:必须|只要|要求|拍摄|生成)[^，。；\n]{0,6}(?:完整全身|完整服装|全景)/.test(
      clean,
    )
  )
    invalid("局部特写与完整全景要求冲突，请调整取景或要求");
  if (
    camera.view === "front" &&
    /(?:只要|必须|拍摄|镜头)[^，。；\n]{0,4}背面/.test(clean)
  )
    invalid("正面视角与明确的背面拍摄要求冲突，请选择背面或修改要求");
  if (
    camera.view === "back" &&
    /(?:只要|必须|拍摄|镜头)[^，。；\n]{0,4}正面/.test(clean)
  )
    invalid("背面视角与明确的正面拍摄要求冲突，请选择正面或修改要求");
}
