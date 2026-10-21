import { getDb } from "./db.js";
import { styleTemplate } from "./styleVersions.js";
import { problem } from "./exploreErrors.js";
import { ah } from "./asyncHandler.js";
import { PRODUCT_CHECKS } from "../../shared/productImagePolicy.js";
export function imageReview(generationId) {
  const row = getDb()
    .prepare(
      "SELECT * FROM style_image_reviews WHERE generation_id=? ORDER BY revision DESC LIMIT 1",
    )
    .get(generationId);
  return row
    ? { ...row, checks: JSON.parse(row.checks_json), checks_json: undefined }
    : { revision: 0, status: "pending", checks: {}, note: "" };
}
export function requireReviewedImage(reference) {
  if (
    reference?.generation_id &&
    imageReview(reference.generation_id).status !== "accepted"
  )
    throw problem(
      "REVIEW_REQUIRED",
      "生成的主图需先逐项验收，再作为卖点页主展示图",
      422,
    );
}
export function mountImageReview(app) {
  const endpoint = "/api/studio/templates/:id/images/:generationId/review";
  function owned(req) {
    const t = styleTemplate(req.params.id, req);
    const g = getDb()
      .prepare(
        "SELECT * FROM dna_generations WHERE id=? AND template_id=? AND user_id=? AND lifecycle NOT IN ('trash','deleted')",
      )
      .get(req.params.generationId, t.id, t.user_id);
    if (!g) throw problem("IMAGE_NOT_FOUND", "图片不存在", 404);
    return g;
  }
  app.get(
    endpoint,
    ah(async (req, res) => {
      const g = owned(req);
      res.json({ review: imageReview(g.id), fields: PRODUCT_CHECKS });
    }),
  );
  app.post(
    endpoint,
    ah(async (req, res) => {
      const g = owned(req),
        b = req.body || {},
        db = getDb();
      if (
        !b.checks ||
        Object.keys(b.checks).some((k) => !Object.hasOwn(PRODUCT_CHECKS, k)) ||
        Object.values(b.checks).some((v) => typeof v !== "boolean")
      )
        throw problem("INVALID_REVIEW", "请逐项填写验收结果");
      if (typeof b.note !== "string" || b.note.length > 1500)
        throw problem("INVALID_REVIEW", "验收备注限1500字");
      const accepted = Object.keys(PRODUCT_CHECKS).every(
        (k) => b.checks[k] === true,
      );
      if (!accepted && !b.note.trim())
        throw problem("INVALID_REVIEW", "未通过时请说明具体部位或问题");
      db.transaction(() => {
        const prior = imageReview(g.id);
        if (b.expected_revision !== prior.revision)
          throw problem("REVIEW_CONFLICT", "验收记录已更新，请重新加载", 409);
        db.prepare(
          "INSERT INTO style_image_reviews(generation_id,revision,status,checks_json,note,created_at) VALUES(?,?,?,?,?,?)",
        ).run(
          g.id,
          prior.revision + 1,
          accepted ? "accepted" : "rejected",
          JSON.stringify(b.checks),
          b.note.trim(),
          new Date().toISOString(),
        );
      })();
      res.json({ review: imageReview(g.id) });
    }),
  );
}
