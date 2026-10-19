import { useAuth } from "../auth.jsx";
import { useEffect, useRef, useState } from "react";
import { api } from "../api.js";
const parse = (s) => {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
};
const initial = {
  type: "selling",
  title: "",
  text: "",
  promotion: "",
  language: "zh",
  width: 1000,
  height: 1000,
  measurements: [{ label: "", cm: "" }],
  selected: [],
  labels: {},
  confirmed: false,
};
const lines = (text, n = 25) =>
  Array.from(
    String(text || "")
      .replace(/\r/g, "")
      .split("\n"),
  ).flatMap((line) => {
    const chars = Array.from(line);
    return Array.from({ length: Math.ceil(chars.length / n) || 1 }, (_, i) =>
      chars.slice(i * n, (i + 1) * n).join(""),
    );
  });
export default function StyleLayoutEditor({
  templateId,
  versionId,
  images,
  layouts = [],
  onSaved,
  onSelectVersion,
  onResolveImages,
}) {
  const { user, multiUser } = useAuth();
  const draftKey = `style-draft-layout-v1:${multiUser ? user?.id || user?.username : "local"}:${templateId}:${versionId}`;
  const restoring = useRef(false);
  const [form, setForm] = useState(initial),
    [embedded, setEmbedded] = useState({}),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const svg = useRef(null),
    request = useRef({ signature: "", key: "" });
  useEffect(() => {
    restoring.current = true;
    try {
      const saved = JSON.parse(sessionStorage.getItem(draftKey) || "null");
      if (
        saved &&
        Date.now() - saved.savedAt < 86400000 &&
        saved.form &&
        Array.isArray(saved.form.selected)
      ) {
        setForm({ ...initial, ...saved.form });
      } else setForm(initial);
    } catch {
      setForm(initial);
    }
  }, [draftKey]);
  useEffect(() => {
    if (restoring.current) {
      restoring.current = false;
      return;
    }
    try {
      sessionStorage.setItem(
        draftKey,
        JSON.stringify({ savedAt: Date.now(), form }),
      );
    } catch {}
  }, [form, draftKey]);
  useEffect(()=>{
    const missing=form.selected.filter(id=>!images.some(i=>i.id===id));
    if(missing.length)onResolveImages?.(missing).catch(e=>setError(e.message));
  },[JSON.stringify(form.selected)]);
  const set = (key, value) => setForm((f) => ({ ...f, [key]: value }));
  const selected = images.filter(
    (i) => form.selected.includes(i.id) && i.user_rating !== "deleted",
  );
  useEffect(() => {
    let alive = true;const controller=new AbortController();
    Promise.all(
      selected.map(async (i) => {
        if (embedded[i.id]) return [i.id, embedded[i.id]];
        const r = await fetch(`/${i.image_path}`, {
          credentials: "same-origin",signal:controller.signal,
        });
        if (!r.ok) throw new Error("原图读取失败");
        const blob = await r.blob();
        const data = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = reject;
          reader.readAsDataURL(blob);
        });
        return [i.id, data];
      }),
    )
      .then((entries) => {
        if (alive)
          setEmbedded((e) => ({ ...e, ...Object.fromEntries(entries) }));
      })
      .catch((e) => {
        if (alive) setError(e.message);
      });
    return () => {
      alive = false;controller.abort();
    };
  }, [JSON.stringify(form.selected)]);
  const width = Math.min(2400, Math.max(600, Number(form.width) || 1000)),
    height = Math.min(3200, Math.max(600, Number(form.height) || 1000));
  const measurements = form.measurements.filter(
    (r) => r.label.trim() && r.cm !== "" && Number(r.cm) > 0,
  );
  const complete =
    selected.length > 0 && selected.length === form.selected.length &&
    form.confirmed &&
    (form.type !== "spec" || measurements.length > 0) &&
    selected.every((i) => i.image_available!==false && embedded[i.id]);
  const save = async () => {
    setBusy(true);
    setError("");
    try {
      const config = { ...form, width, height };
      const signature = JSON.stringify({ version_id: versionId, config });
      if (request.current.signature !== signature)
        request.current = { signature, key: crypto.randomUUID() };
      await api.studio.saveLayout(templateId, {
        version_id: versionId,
        config,
        request_key: request.current.key,
      });
      await onSaved();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  const download = (blob, name) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const exportFile = async (png) => {
    setBusy(true);
    setError("");
    try {
      const xml = new XMLSerializer().serializeToString(svg.current);
      if (!png) {
        download(
          new Blob([xml], { type: "image/svg+xml" }),
          `style-${templateId}-v${versionId}-layout.svg`,
        );
        return;
      }
      // The application CSP allows data images, but deliberately excludes blob images.
      const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(xml)}`;
      const img = await new Promise((resolve, reject) => {
        const i = new Image();
        i.onload = () => resolve(i);
        i.onerror = () => reject(new Error("排版图像加载失败，请检查所选图片"));
        i.src = url;
      });
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      canvas.getContext("2d").drawImage(img, 0, 0);
      const blob = await new Promise((resolve) =>
        canvas.toBlob(resolve, "image/png"),
      );
      if (!blob) throw new Error("导出失败");
      download(blob, `style-${templateId}-layout.png`);
    } catch (e) {
      setError(e.message || "导出失败");
    } finally {
      setBusy(false);
    }
  };
  const imageHeight = form.type === "collection" ? height - 160 : height * 0.52;
  return (
    <section className="style-layout">
      <h3>图文排版</h3>
      <p className="dim small">
        组合已确认图片与您提供的资料。本地排版不调用生图模型，导出新文件，原图保持不变。
      </p>
      <label className="style-field">
        排版用途
        <select value={form.type} onChange={(e) => set("type", e.target.value)}>
          <option value="selling">卖点信息图</option>
          <option value="spec">尺寸规格图</option>
          <option value="collection">多色 / 多款集合图</option>
        </select>
      </label>
      <label className="style-field">
        输出文字语言
        <select
          value={form.language}
          onChange={(e) => set("language", e.target.value)}
        >
          <option value="zh">中文</option>
          <option value="en">English</option>
        </select>
      </label>
      <p className="dim small">
        语言影响表头；正文请自行核对，系统不自动翻译或编造商品事实。
      </p>
      <label className="style-field">
        标题
        <input
          value={form.title}
          maxLength={100}
          onChange={(e) => set("title", e.target.value)}
        />
      </label>
      {form.type === "selling" && (
        <>
          <label className="style-field">
            已确认的商品卖点
            <textarea
              rows={3}
              maxLength={800}
              value={form.text}
              onChange={(e) => set("text", e.target.value)}
            />
          </label>
          <label className="style-field">
            促销信息（仅营销图使用）
            <input
              value={form.promotion}
              maxLength={150}
              onChange={(e) => set("promotion", e.target.value)}
            />
          </label>
          <p className="dim small">
            请核对目标渠道规则；促销内容不会自动加入白底主图。
          </p>
        </>
      )}
      {form.type === "spec" && (
        <>
          <p>
            输入实测厘米数，自动并列显示英寸（1 in = 2.54
            cm）。没有数据时不能导出规格图。
          </p>
          {form.measurements.map((row, index) => (
            <div className="style-measurement" key={index}>
              <input
                aria-label={`测量项目${index + 1}`}
                placeholder="例如：衣长"
                value={row.label}
                maxLength={40}
                onChange={(e) =>
                  set(
                    "measurements",
                    form.measurements.map((r, i) =>
                      i === index ? { ...r, label: e.target.value } : r,
                    ),
                  )
                }
              />
              <input
                aria-label={`厘米数${index + 1}`}
                type="number"
                min="0.01"
                max="1000"
                step="0.1"
                placeholder="cm"
                value={row.cm}
                onChange={(e) =>
                  set(
                    "measurements",
                    form.measurements.map((r, i) =>
                      i === index ? { ...r, cm: e.target.value } : r,
                    ),
                  )
                }
              />
              <button
                onClick={() =>
                  set(
                    "measurements",
                    form.measurements.filter((_, i) => i !== index),
                  )
                }
              >
                移除
              </button>
            </div>
          ))}
          <button
            className="btn secondary small"
            disabled={form.measurements.length >= 8}
            onClick={() =>
              set("measurements", [...form.measurements, { label: "", cm: "" }])
            }
          >
            添加测量项
          </button>
        </>
      )}
      <div className="style-layout-size">
        <label className="style-field">
          输出宽度
          <input
            type="number"
            min={600}
            max={2400}
            value={form.width}
            onChange={(e) => set("width", e.target.value)}
          />
        </label>
        <label className="style-field">
          输出高度
          <input
            type="number"
            min={600}
            max={3200}
            value={form.height}
            onChange={(e) => set("height", e.target.value)}
          />
        </label>
      </div>
      {form.selected.some(id=>!images.some(i=>i.id===id&&i.user_rating!=='deleted'))&&<p role="alert">部分已选图片尚未加载或已不可用，加载完成前不能导出。<button className="btn secondary small" onClick={()=>set('selected',form.selected.filter(id=>images.some(i=>i.id===id&&i.user_rating!=='deleted')))}>移除不可用选择</button></p>}
      <h4>选择已确认图片（最多 4 张）</h4>
      <div className="style-layout-images">
        {images
          .filter((i) => i.user_rating !== "deleted" && !["trash","deleted"].includes(i.lifecycle))
          .map((i) => (
            <label key={i.id}>
              <img
                src={`/${i.thumb_path || i.image_path}`}
                alt={`排版候选 ${i.id}`}
                loading="lazy"
              />
              <input
                type="checkbox"
                checked={form.selected.includes(i.id)}
                disabled={
                  !form.selected.includes(i.id) && form.selected.length >= 4
                }
                onChange={() =>
                  set(
                    "selected",
                    form.selected.includes(i.id)
                      ? form.selected.filter((id) => id !== i.id)
                      : [...form.selected, i.id],
                  )
                }
              />
              #{i.id}
              {i.design_version_id
                ? ` · 设计 #${i.design_version_id}`
                : " · 历史版本未知"}
            </label>
          ))}
      </div>
      {form.type === "collection" &&
        selected.map((i) => (
          <label className="style-field" key={i.id}>
            图片 #{i.id} 的款式 / 颜色标签
            <input
              value={form.labels[i.id] || ""}
              maxLength={50}
              onChange={(e) =>
                set("labels", { ...form.labels, [i.id]: e.target.value })
              }
            />
          </label>
        ))}
      <label className="style-option">
        <input
          type="checkbox"
          checked={form.confirmed}
          onChange={(e) => set("confirmed", e.target.checked)}
        />
        我已核对图片、文字及尺寸资料
      </label>
      {error && <p role="alert">{error}</p>}
      <div className="style-layout-preview" aria-label="排版预览">
        <svg
          ref={svg}
          xmlns="http://www.w3.org/2000/svg"
          width={width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-label="可编辑图文排版"
        >
          <rect width={width} height={height} fill="white" />
          <text
            x={40}
            y={65}
            fontSize={Math.round(width * 0.036)}
            fill="#151515"
            fontFamily="sans-serif"
          >
            {form.title.slice(0, 35)}
          </text>
          {selected.map((i, index) => {
            const cols = selected.length > 1 ? 2 : 1,
              rows = Math.ceil(selected.length / cols),
              cellW = (width - 80) / cols,
              cellH = imageHeight / rows,
              x = 40 + (index % cols) * cellW,
              y = 100 + Math.floor(index / cols) * cellH;
            return (
              <g key={i.id}>
                {embedded[i.id] && (
                  <image
                    href={embedded[i.id]}
                    x={x + 10}
                    y={y}
                    width={cellW - 20}
                    height={cellH - (form.type === "collection" ? 55 : 10)}
                    preserveAspectRatio="xMidYMid meet"
                  />
                )}
                {form.type === "collection" && (
                  <text
                    x={x + 15}
                    y={y + cellH - 15}
                    fontSize={Math.round(width * 0.025)}
                    fill="#151515"
                  >
                    {(form.labels[i.id] || `#${i.id}`).slice(0, 28)}
                  </text>
                )}
              </g>
            );
          })}
          {form.type === "selling" && (
            <g fill="#151515" fontFamily="sans-serif">
              {lines(form.text, Math.floor(width / 30))
                .slice(0, 8)
                .map((line, i) => (
                  <text
                    key={i}
                    x={40}
                    y={height * 0.68 + i * height * 0.035}
                    fontSize={Math.round(width * 0.026)}
                  >
                    {line}
                  </text>
                ))}
              <text x={40} y={height - 40} fontSize={Math.round(width * 0.03)}>
                {form.promotion.slice(0, 42)}
              </text>
            </g>
          )}
          {form.type === "spec" && (
            <g fill="#151515" fontFamily="sans-serif">
              <text
                x={40}
                y={height * 0.68}
                fontSize={Math.round(width * 0.026)}
              >
                {form.language === "en" ? "Measurement" : "测量项目"} · cm / in
              </text>
              {measurements.slice(0, 8).map((r, i) => (
                <text
                  key={i}
                  x={40}
                  y={height * 0.73 + i * height * 0.027}
                  fontSize={Math.round(width * 0.024)}
                >
                  {r.label} · {Number(r.cm).toFixed(1)} cm /{" "}
                  {(Number(r.cm) / 2.54).toFixed(2)} in
                </text>
              ))}
            </g>
          )}
        </svg>
      </div>
      <div className="style-layout-actions">
        <button
          className="btn secondary"
          disabled={busy || !complete}
          onClick={save}
        >
          保存可编辑排版
        </button>
        <button
          className="btn secondary"
          disabled={busy || !complete}
          onClick={() => exportFile(false)}
        >
          下载 SVG
        </button>
        <button
          className="btn secondary"
          disabled={busy || !complete}
          onClick={() => exportFile(true)}
        >
          下载 PNG
        </button>
      </div>
      {layouts.length > 0 && (
        <details>
          <summary>已保存排版（{layouts.length}）</summary>
          {layouts.map((l) => (
            <button
              className="btn secondary small"
              key={l.id}
              onClick={() => {
                const restoredForm={...initial,...parse(l.config_json)};
                try{sessionStorage.setItem(`style-draft-layout-v1:${multiUser?user?.id||user?.username:'local'}:${templateId}:${l.version_id}`,JSON.stringify({savedAt:Date.now(),form:restoredForm}));}catch{}
                onSelectVersion?.(l.version_id);
                setForm(restoredForm);
              }}
            >
              恢复排版 #{l.id} · 设计 #{l.version_id}
            </button>
          ))}
        </details>
      )}
    </section>
  );
}
