import {
  defaultLayout,
  validateCrop,
} from "../../shared/productImagePolicy.js";
import { problem } from "./exploreErrors.js";
export function normalizeLayout(raw, fallbackRef = "") {
  const source = raw || defaultLayout(fallbackRef);
  const str = (v, max) => {
    if (
      typeof v !== "string" ||
      v.length > max ||
      /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(v)
    )
      throw problem("INVALID_LAYOUT", "排版文字无效或超出长度");
    return v.trim();
  };
  const crop = (c) => {
    if (!validateCrop(c)) throw problem("INVALID_CROP", "裁切范围必须在原图内");
    return Object.fromEntries(
      ["x", "y", "width", "height"].map((k) => [k, c[k]]),
    );
  };
  const color = (c) => {
    if (!/^#[0-9a-f]{6}$/i.test(c || ""))
      throw problem("INVALID_LAYOUT", "颜色需为六位十六进制");
    return c;
  };
  if (!Array.isArray(source.details) || source.details.length > 4)
    throw problem("INVALID_LAYOUT", "最多4个卖点");
  const font = source.font_size ?? 22;
  if (!Number.isInteger(font) || font < 16 || font > 30)
    throw problem("INVALID_LAYOUT", "正文字号需为16–30");
  const gap = source.gap ?? 24;
  if (
    !Number.isInteger(gap) ||
    gap < 12 ||
    gap > 40 ||
    !["left", "right"].includes(source.main_position || "left")
  )
    throw problem("INVALID_LAYOUT", "主图位置或留白设置无效");
  return {
    headline: str(source.headline ?? "款式特点", 24),
    subtitle: str(source.subtitle || "", 48),
    background: color(source.background || "#F5F3EF"),
    color: color(source.color || "#303436"),
    accent: color(source.accent || "#55727D"),
    font_size: font,
    gap,
    main_position: source.main_position || "left",
    main_reference_id: str(source.main_reference_id || fallbackRef, 100),
    main_crop: crop(source.main_crop || { x: 0, y: 0, width: 1, height: 1 }),
    details: source.details.map((d) => ({
      title: str(d.title || "", 24),
      body: str(d.body || "", 90),
      reference_id: str(d.reference_id || "", 100),
      crop: crop(d.crop || { x: 0, y: 0, width: 1, height: 1 }),
      confirmed: d.confirmed === true,
    })),
  };
}
