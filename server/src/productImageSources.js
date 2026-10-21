import fs from "node:fs";
import crypto from "node:crypto";
import sharp from "sharp";
import { localImage } from "./styleWorkspace.js";
import { problem } from "./exploreErrors.js";
export const sourceDigest = (file) =>
  crypto
    .createHash("sha256")
    .update(fs.readFileSync(localImage(file)))
    .digest("hex");
export async function freezeImageSources(refs) {
  return Promise.all(
    refs.map(async (r) => {
      const bytes = fs.readFileSync(localImage(r.path));
      const meta = await sharp(bytes, {
        limitInputPixels: 40000000,
      }).metadata();
      if (!meta.width || !meta.height)
        throw problem("SOURCE_MISSING", "商品参考图无法读取", 422);
      return {
        ...r,
        sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
        width: meta.width,
        height: meta.height,
      };
    }),
  );
}
export function assertImageSources(refs = []) {
  for (const r of refs)
    if (!r.sha256 || sourceDigest(r.path) !== r.sha256)
      throw problem("SOURCE_CHANGED", "参考图片已变化，请重新核对并报价", 409);
}
export function frozenJobSources(style) {
  return Object.values(style?.item_contexts || {}).flatMap(
    (i) => i.source_manifest || [],
  );
}
