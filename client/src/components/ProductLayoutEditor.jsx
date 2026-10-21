import { useState } from "react";
import { api } from "../api.js";
import {
  defaultCrop,
  defaultLayout,
} from "../../../shared/productImagePolicy.js";
import StudioImage from "./StudioImage.jsx";

function CropEditor({ value, onChange, reference, disabled, label }) {
  const crop = value || defaultCrop();
  return (
    <fieldset disabled={disabled} className="wizard-section">
      <legend>{label}</legend>
      {reference && (
        <div className="product-crop-source">
          <StudioImage
            original={reference.image_path}
            thumbnail={reference.thumb_path}
            alt={label + "来源图"}
          />
          <div
            className="product-crop-outline"
            style={{
              left: `${crop.x * 100}%`,
              top: `${crop.y * 100}%`,
              width: `${crop.width * 100}%`,
              height: `${crop.height * 100}%`,
            }}
          />
        </div>
      )}
      <div className="wizard-inline">
        {[
          ["x", "左侧"],
          ["y", "顶部"],
          ["width", "宽度"],
          ["height", "高度"],
        ].map(([key, name]) => (
          <label key={key} className="style-field">
            {name}%
            <input
              type="number"
              aria-label={`${label}${name}`}
              min={key === "width" || key === "height" ? 1 : 0}
              max="100"
              step="1"
              value={Math.round(crop[key] * 100)}
              onChange={(e) => {
                const n =
                  Math.max(0, Math.min(100, Number(e.target.value))) / 100;
                const next = { ...crop, [key]: n };
                if (key === "x") next.width = Math.min(next.width, 1 - n);
                if (key === "y") next.height = Math.min(next.height, 1 - n);
                if (key === "width") next.width = Math.min(n, 1 - next.x);
                if (key === "height") next.height = Math.min(n, 1 - next.y);
                onChange(next);
              }}
            />
          </label>
        ))}
      </div>
      <small>
        框内区域取自原图；过小或越界的范围会阻止预览。请放大核对真实细节。
      </small>
    </fieldset>
  );
}
export default function ProductLayoutEditor({
  w,
  item,
  choices,
  patch,
  disabled,
}) {
  const refs = w.input.references.filter(
    (r) => item.reference_ids.includes(r.id) && r.role !== "model",
  );
  const layout =
    item.layout ||
    defaultLayout(refs.find((r) => r.role === "garment")?.id || "");
  const [preview, setPreview] = useState(null),
    [previewSignature, setPreviewSignature] = useState("");
  const set = (updates) => {
    setPreview(null);
    patch({ layout: { ...layout, ...updates }, edited: true });
  };
  const choice = (id) =>
    choices.find((c) => c.key === refs.find((r) => r.id === id)?.source);
  const details = layout.details || [];
  const detail = (index, updates) =>
    set({
      details: details.map((d, n) =>
        n === index
          ? {
              ...d,
              ...updates,
              ...(updates.confirmed === undefined ? { confirmed: false } : {}),
            }
          : d,
      ),
    });
  const select = (value, onChange, label, onlyGarment = false) => (
    <label className="style-field">
      {label}
      <select
        aria-label={label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
      >
        <option value="">请选择来源图</option>
        {refs
          .filter((r) => !onlyGarment || r.role === "garment")
          .map((r, n) => (
            <option key={r.id} value={r.id}>
              图{n + 1} · {choice(r.id)?.name || r.role}
            </option>
          ))}
      </select>
    </label>
  );
  return (
    <section className="wizard-section">
      <h4>原图细节与中文排版</h4>
      <p className="dim small">
        局部来自选择的图片，文字使用真实字体。排版本身不调用生图模型，不收模型生成积分。上方提示词用于说明，实际内容由这里的图片和文字决定。
      </p>
      <fieldset disabled={disabled}>
        <label className="style-field">
          页面标题
          <input
            maxLength={24}
            value={layout.headline}
            onChange={(e) => set({ headline: e.target.value })}
          />
        </label>
        <label className="style-field">
          副标题
          <input
            maxLength={48}
            value={layout.subtitle}
            onChange={(e) => set({ subtitle: e.target.value })}
          />
        </label>
        <div className="wizard-inline">
          {[
            ["background", "底色"],
            ["color", "字色"],
            ["accent", "强调色"],
          ].map(([key, name]) => (
            <label key={key}>
              {name}
              <input
                type="color"
                aria-label={name}
                value={layout[key]}
                onChange={(e) => set({ [key]: e.target.value })}
              />
            </label>
          ))}
          <label>
            正文字号（1024像素画布基准）
            <input
              type="number"
              min="16"
              max="30"
              value={layout.font_size}
              onChange={(e) => set({ font_size: Number(e.target.value) })}
            />
          </label>
        </div>
        <div className="wizard-inline">
          <label className="style-field">
            主展示位置
            <select
              aria-label="主展示位置" value={layout.main_position || "left"}
              onChange={(e) => set({ main_position: e.target.value })}
            >
              <option value="left">左侧</option>
              <option value="right">右侧</option>
            </select>
          </label>
          <label className="style-field">
            区域留白
            <input
              type="number"
              min="12"
              max="40"
              value={layout.gap ?? 24}
              onChange={(e) => set({ gap: Number(e.target.value) })}
            />
          </label>
        </div>
        {select(
          layout.main_reference_id,
          (id) => set({ main_reference_id: id }),
          "主展示来源",
          true,
        )}
        <CropEditor
          label="主展示裁切"
          value={layout.main_crop}
          reference={choice(layout.main_reference_id)}
          onChange={(main_crop) => set({ main_crop })}
        />
        {details.map((d, n) => (
          <article key={n} className="wizard-section">
            <h4>卖点{n + 1}</h4>
            <label className="style-field">
              卖点标题
              <input
                aria-label={`卖点${n + 1}标题`}
                maxLength={24}
                value={d.title}
                onChange={(e) => detail(n, { title: e.target.value })}
              />
            </label>
            <label className="style-field">
              逐字说明
              <textarea
                aria-label={`卖点${n + 1}说明`}
                maxLength={90}
                rows={2}
                value={d.body}
                onChange={(e) => detail(n, { body: e.target.value })}
              />
            </label>
            {select(
              d.reference_id,
              (id) => detail(n, { reference_id: id }),
              "卖点" + (n + 1) + "来源",
            )}
            <CropEditor
              label={`卖点${n + 1}裁切`}
              value={d.crop}
              reference={choice(d.reference_id)}
              onChange={(crop) => detail(n, { crop })}
            />
            <label className="inline-check">
              <input
                type="checkbox"
                checked={d.confirmed === true}
                onChange={(e) => detail(n, { confirmed: e.target.checked })}
              />
              已核对来源、裁切和文案
            </label>
            <button
              type="button"
              className="btn secondary small"
              onClick={() =>
                set({ details: details.filter((_, i) => i !== n) })
              }
            >
              移除此卖点
            </button>
          </article>
        ))}
        <button
          type="button"
          className="btn secondary small"
          disabled={details.length >= 4}
          onClick={() =>
            set({
              details: [
                ...details,
                {
                  title: "",
                  body: "",
                  reference_id: layout.main_reference_id,
                  crop: defaultCrop(),
                  confirmed: false,
                },
              ],
            })
          }
        >
          添加原图卖点（最多4项）
        </button>
      </fieldset>
      <button
        type="button"
        className="btn secondary"
        disabled={disabled || w.busy}
        onClick={() =>
          w.work(async () => {
            const p = await w.flush();
            const result = await api.studio.planCompositionPreview(
              w.data.template.id,
              p.id,
              item.id,
              { expected_revision: p.revision },
            );
            setPreview("data:image/png;base64," + result.image_base64);
            setPreviewSignature(JSON.stringify(layout));
          })
        }
      >
        预览排版（不调用模型）
      </button>
      {preview && previewSignature === JSON.stringify(layout) && (
        <img
          className="product-layout-preview"
          src={preview}
          alt="原图细节与中文排版预览"
        />
      )}
    </section>
  );
}
