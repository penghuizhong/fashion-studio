import { useEffect, useState } from "react";
import { api } from "../api.js";
import { PRODUCT_CHECKS } from "../../../shared/productImagePolicy.js";
import StudioImage from "./StudioImage.jsx";
export default function ProductImageReview({
  templateId,
  image,
  context,
  onChanged,
}) {
  const [open, setOpen] = useState(false),
    [review, setReview] = useState(
      image.review || { revision: 0, checks: {}, note: "", status: "pending" },
    ),
    [checks, setChecks] = useState({}),
    [note, setNote] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const id = image.generation_id || image.id;
  useEffect(() => {
    if (!open) return;
    setBusy(true);
    api.studio
      .imageReview(templateId, id)
      .then((r) => {
        setReview(r.review);
        setChecks(r.review.checks);
        setNote(r.review.note || "");
      })
      .catch((e) => setError(e.message))
      .finally(() => setBusy(false));
  }, [open, id]);
  const save = async () => {
    setError("");
    setBusy(true);
    try {
      const r = await api.studio.saveImageReview(templateId, id, {
        expected_revision: review.revision,
        checks,
        note,
      });
      setReview(r.review);
      onChanged?.(r.review);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="wizard-section">
      <strong>
        {review.status === "accepted"
          ? "已逐项验收"
          : review.status === "rejected"
            ? "需修改"
            : "已生成 · 待验收"}
      </strong>
      <button
        className="btn secondary small"
        onClick={() => setOpen((v) => !v)}
      >
        {open ? "收起验收" : "对照原图验收"}
      </button>
      {open && (
        <>
          <div className="wizard-inline">
            {(
              image.request_trace?.source_manifest ||
              context?.source_manifest ||
              []
            )
              .filter((r) => r.role !== "model")
              .map((r) => (
                <figure key={r.id}>
                  <StudioImage original={r.path} alt="实际使用的商品参考图" />
                  <figcaption>
                    {r.role === "fabric" ? "细节图" : "商品图"} · {r.width}×
                    {r.height}
                  </figcaption>
                </figure>
              ))}
          </div>
          <p className="dim small">
            请放大核对关键部位；不存在的项目（例如无文字、无人物）可勾选为通过。生成成功不等于已验收。
          </p>
          <fieldset disabled={busy}>
            {Object.entries(PRODUCT_CHECKS).map(([key, label]) => (
              <label className="inline-check" key={key}>
                <input
                  type="checkbox"
                  checked={checks[key] === true}
                  onChange={(e) =>
                    setChecks((c) => ({ ...c, [key]: e.target.checked }))
                  }
                />
                {label}
              </label>
            ))}
            <label className="style-field">
              具体问题与修改备注
              <textarea
                rows={3}
                maxLength={1500}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="例如：领圈过宽；腰部侧褶方向错误；第二条说明有错字"
              />
            </label>
            <button className="btn secondary" onClick={save}>
              {Object.keys(PRODUCT_CHECKS).every((k) => checks[k])
                ? "保存为已验收"
                : "记录未通过项"}
            </button>
          </fieldset>
          {error && <p role="alert">{error}</p>}
        </>
      )}
    </section>
  );
}
