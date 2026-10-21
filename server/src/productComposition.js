import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { create } from "fontkit";
import sharp from "sharp";
import { problem } from "./exploreErrors.js";
import { localImage } from "./styleWorkspace.js";
import { layoutIssue } from "../../shared/productImagePolicy.js";

const require = createRequire(import.meta.url);
const fontRoot = path.dirname(
  require.resolve("@fontsource/noto-sans-sc/400.css"),
);
const faces = [
  ...fs
    .readFileSync(path.join(fontRoot, "400.css"), "utf8")
    .matchAll(/@font-face\s*\{([\s\S]*?)\}/g),
].map((m) => ({
  file: path.join(fontRoot, m[1].match(/url\(\.\/(.*?)\)/)[1]),
  ranges: m[1]
    .match(/unicode-range:\s*([^;]+)/)[1]
    .split(",")
    .map((r) =>
      r
        .trim()
        .slice(2)
        .split("-")
        .map((h) => parseInt(h, 16)),
    ),
}));
const loaded = new Map(),
  glyphs = new Map();
function character(char) {
  if (glyphs.has(char)) return glyphs.get(char);
  const cp = char.codePointAt(0);
  const face = faces.find((f) =>
    f.ranges.some(([a, b = a]) => cp >= a && cp <= b),
  );
  if (!face)
    throw problem(
      "UNSUPPORTED_CHARACTER",
      `字体不支持字符“${char}”，请更换为中文或拉丁文字`,
    );
  if (!loaded.has(face.file))
    loaded.set(face.file, create(fs.readFileSync(face.file)));
  const font = loaded.get(face.file),
    glyph = font.glyphForCodePoint(cp);
  if (!glyph.id)
    throw problem("UNSUPPORTED_CHARACTER", `字体缺少字符“${char}”`);
  const value = {
    width: glyph.advanceWidth / font.unitsPerEm,
    path: glyph.path.toSVG(),
    scale: 1 / font.unitsPerEm,
  };
  glyphs.set(char, value);
  return value;
}
function wrap(text, width, size) {
  const lines = [];
  let line = "",
    used = 0;
  for (const c of String(text || "")) {
    if (c === "\n") {
      lines.push(line);
      line = "";
      used = 0;
      continue;
    }
    const advance = character(c).width * size;
    if (used + advance > width && line) {
      lines.push(line);
      line = "";
      used = 0;
    }
    line += c;
    used += advance;
  }
  if (line) lines.push(line);
  return lines;
}
export function textPaths(
  text,
  { x, y, width, height, size = 22, color = "#303436" },
) {
  let lines;
  for (; size >= 16; size--) {
    lines = wrap(text, width, size);
    if (lines.length * size * 1.5 <= height) break;
  }
  if (size < 16)
    throw problem(
      "TEXT_OVERFLOW",
      "文案超过可读排版空间，请缩短说明或减少卖点数量",
    );
  const paths = [];
  for (const [row, line] of lines.entries()) {
    let pen = x;
    for (const c of line) {
      const g = character(c),
        scale = g.scale * size;
      if (g.path)
        paths.push(
          `<path d="${g.path}" transform="translate(${pen} ${y + size + row * size * 1.5}) scale(${scale} ${-scale})" fill="${color}"/>`,
        );
      pen += g.width * size;
    }
  }
  return paths.join("");
}
export async function croppedImage(file, crop, width, height, background) {
  const original = await sharp(fs.readFileSync(localImage(file)))
    .rotate()
    .toBuffer();
  const meta = await sharp(original).metadata();
  const left = Math.min(meta.width - 1, Math.floor(crop.x * meta.width));
  const top = Math.min(meta.height - 1, Math.floor(crop.y * meta.height));
  const w = Math.max(
    1,
    Math.min(meta.width - left, Math.round(crop.width * meta.width)),
  );
  const h = Math.max(
    1,
    Math.min(meta.height - top, Math.round(crop.height * meta.height)),
  );
  return sharp(original)
    .extract({ left, top, width: w, height: h })
    .resize(width, height, { fit: "contain", background })
    .png()
    .toBuffer();
}
function contrast(a, b) {
  const luminance = (hex) => {
    const channels = hex
      .slice(1)
      .match(/../g)
      .map((v) => parseInt(v, 16) / 255)
      .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  };
  const x = luminance(a),
    y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
// All product pixels are derived from the frozen source files; only typography and layout are drawn.
export async function composeProduct({
  layout,
  references,
  size = "1024x1024",
  noText = false,
}) {
  const issue = layoutIssue(layout, references);
  if (issue) throw problem("LAYOUT_NOT_READY", issue, 422);
  if (
    !noText &&
    (contrast(layout.color, layout.background) < 4.5 ||
      contrast(layout.accent, layout.background) < 3)
  )
    throw problem(
      "LOW_TEXT_CONTRAST",
      "文字与背景对比不足，请加深字色或调整底色",
    );
  const [width, height] = String(size).split("x").map(Number);
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 512 ||
    height < 512 ||
    width > 4096 ||
    height > 4096 ||
    width * height > 8500000
  )
    throw problem(
      "INVALID_SIZE",
      "排版尺寸需为512–4096像素，且不超过850万像素",
    );
  const baseW = 1024,
    baseH = Math.round((1024 * height) / width),
    margin = 32,
    gap = layout.gap ?? 24;
  const header = noText ? 32 : 132,
    mainW = Math.round((baseW - margin * 2) * 0.43);
  const bodyH = baseH - header - margin;
  if (bodyH < 380)
    throw problem("INVALID_LAYOUT", "此版式需要方形或竖向画布，请调整尺寸");
  const rightW = baseW - margin * 2 - mainW - gap,
    rightX = layout.main_position === "right" ? margin : margin + mainW + gap;
  const mainX =
    layout.main_position === "right" ? baseW - margin - mainW : margin;
  const count = layout.details.length,
    rowH = Math.floor((bodyH - gap * (count - 1)) / count);
  const pictureW = noText ? rightW : Math.round(rightW * 0.53),
    copyX = rightX + pictureW + gap,
    copyW = rightW - pictureW - gap;
  const layers = [];
  const ref = (id) => references.find((r) => r.id === id);
  layers.push({
    input: await croppedImage(
      ref(layout.main_reference_id).path,
      layout.main_crop,
      mainW,
      bodyH,
      layout.background,
    ),
    left: mainX,
    top: header,
  });
  let svg = "";
  if (!noText) {
    svg += textPaths(layout.headline, {
      x: margin,
      y: 22,
      width: 960,
      height: 64,
      size: 42,
      color: layout.color,
    });
    svg += textPaths(layout.subtitle, {
      x: margin,
      y: 87,
      width: 960,
      height: 35,
      size: 20,
      color: layout.color,
    });
  }
  for (const [n, d] of layout.details.entries()) {
    const top = header + n * (rowH + gap);
    layers.push({
      input: await croppedImage(
        ref(d.reference_id).path,
        d.crop,
        pictureW,
        rowH,
        layout.background,
      ),
      left: rightX,
      top,
    });
    if (!noText) {
      svg += textPaths(String(n + 1).padStart(2, "0"), {
        x: copyX,
        y: top,
        width: copyW,
        height: 38,
        size: 24,
        color: layout.accent,
      });
      svg += textPaths(d.title, {
        x: copyX,
        y: top + 40,
        width: copyW,
        height: Math.min(76, rowH * 0.35),
        size: 26,
        color: layout.color,
      });
      svg += textPaths(d.body, {
        x: copyX,
        y: top + Math.min(120, rowH * 0.55),
        width: copyW,
        height: rowH - Math.min(120, rowH * 0.55),
        size: layout.font_size,
        color: layout.color,
      });
    }
  }
  layers.push({
    input: Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${baseW}" height="${baseH}">${svg}</svg>`,
    ),
    left: 0,
    top: 0,
  });
  const base = await sharp({
    create: {
      width: baseW,
      height: baseH,
      channels: 4,
      background: layout.background,
    },
  })
    .composite(layers)
    .png()
    .toBuffer();
  const image = await sharp(base).resize(width, height).png().toBuffer();
  return {
    imageBase64: image.toString("base64"),
    provenance: {
      renderer: "source-crop-font-path-v1",
      font: "Noto Sans SC (SIL OFL 1.1)",
      layout,
      no_text: noText,
      sources: references.map((r) => ({
        id: r.id,
        role: r.role,
        path: r.path,
        sha256: r.sha256,
      })),
      details: layout.details.map((d) => ({
        reference_id: d.reference_id,
        crop: d.crop,
      })),
      text_checked: !noText,
    },
  };
}
