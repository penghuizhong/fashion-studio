import { useState } from "react";
import {
  DETAIL_MODULES,
  PLAN_LIMITS,
  FACT_FIELDS,
  PROMPT_PARTS,
  EDITABLE_PROMPT_PARTS,
} from "../../../shared/stylePlan.js";
import { imageTaskAllowed } from "../../../shared/imageOptions.js";
import CameraSettings from "./CameraSettings.jsx";
import ImageOutputOptions from "./ImageOutputOptions.jsx";
import StudioImage from "./StudioImage.jsx";
const labels = {
  garment: "服装一致性",
  photography: "拍摄一致性",
  layout: "版面一致性",
  language: "新增文案语言",
  facts: "商品事实约束",
};
export default function StylePlanEditor({ w, choices, disabled, onPreview }) {
  const { content, setContent, input, setInput } = w;
  const [view, setView] = useState("plan"),
    [focused, setFocused] = useState(null),
    [expanded, setExpanded] = useState(null),
    [copyStatus, setCopyStatus] = useState("");
  if (!content)
    return <p className="wizard-empty">先分析商品以生成图片规划。</p>;
  const patch = (id, updates) =>
    setContent((c) => ({
      ...c,
      items: c.items.map((i) => (i.id === id ? { ...i, ...updates } : i)),
    }));
  const changeItems = (items) => {
    setContent((c) => ({ ...c, items }));
    const modules = {};
    for (const i of items)
      modules[i.module_id] = (modules[i.module_id] || 0) + 1;
    setInput((f) => ({ ...f, modules }));
  };
  const duplicate = (item) => {
    if (
      content.items.length >= PLAN_LIMITS.total ||
      content.items.filter((i) => i.module_id === item.module_id).length >=
        PLAN_LIMITS.per_module
    ) {
      w.setError("图片数量已达到规划上限");
      return;
    }
    const index = content.items.indexOf(item),
      items = [...content.items];
    items.splice(index + 1, 0, {
      ...structuredClone(item),
      id: crypto.randomUUID(),
      title: item.title + "（副本）",
      analyzed: false,
      manual_confirmed: false,
      status: "needs_analysis",
      selected: false,
    });
    changeItems(items);
  };
  const reorder = (item, offset) => {
    const items = [...content.items],
      n = items.indexOf(item),
      target = n + offset;
    if (target < 0 || target >= items.length) return;
    [items[n], items[target]] = [items[target], items[n]];
    changeItems(items);
  };
  const current =
    content.items.find((i) => i.id === focused) || content.items[0];
  const model = w.models.find((m) => m.id === input.model_id);
  const selectAll = () =>
    setContent((c) => ({
      ...c,
      items: c.items.map((i) => ({ ...i, selected: i.status === "ready" })),
    }));
  const preview =
    current &&
    choices.find(
      (c) =>
        input.references.find((r) => r.id === current.reference_ids[0])
          ?.source === c.key,
    );
  return (
    <div className="wizard-plan-editor">
      <details className="wizard-section wizard-standard">
        <summary>
          <strong>整体设计规范</strong>
          <span className="dim small">
            {content.standard.photography.slice(0, 55)} ·{" "}
            {content.standard.language}
          </span>
        </summary>
        <p className="dim small">
          用于本计划每一张图；局部取景优先于全局默认景别。商品原配色和已确认事实保持不变。
        </p>
        <fieldset disabled={disabled}>
          {Object.entries(labels).map(([key, label]) => (
            <label className="style-field" key={key}>
              {label}
              <textarea
                aria-label={label}
                rows={key === "language" ? 1 : 3}
                maxLength={key === "language" ? 40 : 4000}
                value={content.standard[key] || ""}
                onChange={(e) =>
                  setContent((c) => ({
                    ...c,
                    standard: { ...c.standard, [key]: e.target.value },
                    standard_edited: true,
                  }))
                }
              />
            </label>
          ))}
        </fieldset>
        <p className="dim small">
          更新公共规范会重新编译提示词并使旧报价失效，手工段保持原样。字体为生成指导，实际文字需核对。
        </p>
      </details>
      <div className="wizard-section-head">
        <div>
          <h3>图片规划</h3>
          <p className="dim small">
            共{content.items.length}张 · 每张图可独立编辑
          </p>
        </div>
        <div className="wizard-inline">
          <button
            className="btn secondary small"
            disabled={disabled}
            onClick={selectAll}
          >
            选择全部可生成项
          </button>
          <button
            className="btn secondary small"
            aria-pressed={view === "plan"}
            onClick={() => setView("plan")}
          >
            图片规划
          </button>
          <button
            className="btn secondary small"
            aria-pressed={view === "preview"}
            onClick={() => setView("preview")}
          >
            构图预览
          </button>
        </div>
      </div>
      {view === "preview" && current ? (
        <section className="wizard-section wizard-composition-preview">
          <div className="wizard-inline">
            {content.items.map((i, n) => (
              <button
                key={i.id}
                className="btn secondary small"
                aria-pressed={current.id === i.id}
                onClick={() => setFocused(i.id)}
              >
                {n + 1}
              </button>
            ))}
          </div>
          <p className="dim small">
            构图示意 · 不调用图片模型，参考图不会模拟成已生成结果。
          </p>
          <div className="wizard-composition">
            <StudioImage
              thumbnail={preview?.thumb_path}
              original={preview?.image_path}
              alt="构图参考图"
            />
            <div>
              <strong>{current.title}</strong>
              <p>{current.requirement}</p>
              <span>图内文案：{current.copy || "未添加"}</span>
            </div>
          </div>
          <p>
            {current.camera.view} · {current.camera.framing} ·{" "}
            {current.size || input.size}
          </p>
          <button
            className="btn secondary"
            onClick={() => {
              setView("plan");
              setExpanded(current.id);
            }}
          >
            编辑此图规划
          </button>
        </section>
      ) : (
        content.items.map((item, index) => {
          const name = DETAIL_MODULES.find(
              (m) => m.id === item.module_id,
            )?.name,
            status = item.status,
            open = expanded === item.id;
          return (
            <article
              className={`wizard-plan-card${item.selected ? " selected" : ""}`}
              key={item.id}
              data-item-id={item.id}
            >
              <div className="wizard-plan-heading">
                <input
                  type="checkbox"
                  aria-label={`选择生成图片${index + 1}`}
                  checked={item.selected && status === "ready"}
                  disabled={disabled || status !== "ready"}
                  onChange={(e) =>
                    patch(item.id, { selected: e.target.checked })
                  }
                />
                <button
                  className="wizard-plan-title"
                  aria-expanded={open}
                  onClick={() => {
                    setExpanded(open ? null : item.id);
                    setFocused(item.id);
                  }}
                >
                  <span className="wizard-item-number">{index + 1}</span>
                  <span>
                    <strong>{item.title || name}</strong>
                    <small>
                      {name} · {item.size || input.size} ·{" "}
                      {status === "ready"
                        ? "可生成"
                        : status === "needs_info"
                          ? "待补充资料"
                          : status === "invalid"
                            ? "需要调整"
                            : "待分析或确认"}
                    </small>
                    <small>{item.requirement.slice(0, 110)}</small>
                  </span>
                  <span aria-hidden="true">{open ? "⌃" : "⌄"}</span>
                </button>
              </div>
              {open && (
                <div className="wizard-plan-content">
                  <fieldset disabled={disabled}>
                    <label className="style-field">
                      图片标题
                      <input
                        aria-label={`图片${index + 1}标题`}
                        maxLength={200}
                        value={item.title}
                        onChange={(e) =>
                          patch(item.id, { title: e.target.value })
                        }
                      />
                    </label>
                    <label className="style-field">
                      画面要求
                      <textarea
                        aria-label={`图片${index + 1}画面要求`}
                        rows={4}
                        maxLength={3000}
                        value={item.requirement}
                        onChange={(e) =>
                          patch(item.id, { requirement: e.target.value })
                        }
                      />
                    </label>
                    <label className="style-field">
                      图内文案
                      <textarea
                        aria-label={`图片${index + 1}图内文案`}
                        rows={2}
                        maxLength={3000}
                        value={item.copy}
                        onChange={(e) =>
                          patch(item.id, { copy: e.target.value })
                        }
                      />
                    </label>
                    {item.missing?.length > 0 && (
                      <p className="wizard-pending">
                        待补充：
                        {item.missing
                          .map((k) => FACT_FIELDS[k] || k)
                          .join("、")}
                        。请在需求分析中填写资料后再生成本图。
                      </p>
                    )}
                    {item.error && <p role="alert">{item.error}</p>}
                    {item.observation && (
                      <p className="dim small">
                        图片观察：{item.observation}；观察不等于真实商品参数。
                      </p>
                    )}
                    <details>
                      <summary>参考图与视角</summary>
                      <div className="wizard-inline">
                        {input.references.map((r, n) => (
                          <label className="inline-check" key={r.id}>
                            <input
                              type="checkbox"
                              checked={item.reference_ids.includes(r.id)}
                              onChange={(e) =>
                                patch(item.id, {
                                  reference_ids: e.target.checked
                                    ? [...item.reference_ids, r.id]
                                    : item.reference_ids.filter(
                                        (id) => id !== r.id,
                                      ),
                                })
                              }
                            />
                            图{n + 1}
                          </label>
                        ))}
                      </div>
                      {!imageTaskAllowed(
                        model?.capabilities,
                        item.reference_ids.length,
                      ) && (
                        <p className="dim small">
                          当前模型不支持本图参考数量。
                        </p>
                      )}
                      <CameraSettings
                        scope="item"
                        value={item.camera}
                        onChange={(camera) => patch(item.id, { camera })}
                        disabled={disabled}
                      />
                    </details>
                    <details>
                      <summary>本图输出规格</summary>
                      <p className="dim small">
                        默认沿用整套参数，可单独调整。
                      </p>
                      <ImageOutputOptions
                        model={model}
                        size={item.size || input.size}
                        quality={item.quality || input.quality}
                        onChange={(value) => patch(item.id, value)}
                      />
                    </details>
                    <details className="wizard-prompts">
                      <summary>
                        模块化提示词 ·{" "}
                        {Object.keys(item.prompt_overrides || {}).length
                          ? "包含手工修改"
                          : "自动编译"}
                      </summary>
                      <p className="dim small">
                        公共规范和服装版本会参与实际请求。可修改各段并核对最终文本，修改内容会使旧报价失效。
                      </p>
                      {Object.entries(PROMPT_PARTS).map(([key, label]) => (
                        <div className="wizard-prompt-section" key={key}>
                          <div className="wizard-section-head">
                            <strong>{label}</strong>
                            {Object.hasOwn(
                              item.prompt_overrides || {},
                              key,
                            ) && (
                              <button
                                className="btn secondary small"
                                onClick={() => {
                                  const overrides = {
                                    ...item.prompt_overrides,
                                  };
                                  delete overrides[key];
                                  patch(item.id, {
                                    prompt_overrides: overrides,
                                  });
                                }}
                              >
                                恢复此段自动内容
                              </button>
                            )}
                          </div>
                          {EDITABLE_PROMPT_PARTS.includes(key) ? (
                            <textarea
                              aria-label={`图片${index + 1}${label}提示词`}
                              rows={3}
                              maxLength={6000}
                              value={
                                item.prompt_overrides?.[key] ??
                                item.automatic_parts?.[key] ??
                                ""
                              }
                              onChange={(e) =>
                                patch(item.id, {
                                  prompt_overrides: {
                                    ...item.prompt_overrides,
                                    [key]: e.target.value,
                                  },
                                })
                              }
                            />
                          ) : (
                            <p className="wizard-prompt-readonly">
                              {item.parts?.[key] || "保存后显示"}
                            </p>
                          )}
                          {Object.hasOwn(item.prompt_overrides || {}, key) && (
                            <details>
                              <summary>对照最新自动内容</summary>
                              <p className="wizard-prompt-readonly">
                                {item.automatic_parts?.[key]}
                              </p>
                            </details>
                          )}
                        </div>
                      ))}
                      <label className="style-field">
                        实际提交的完整提示词
                        <textarea
                          aria-label={`图片${index + 1}完整提示词`}
                          rows={7}
                          readOnly
                          value={item.prompt || "正在编译，保存后显示"}
                        />
                      </label>
                      <button
                        className="btn secondary small"
                        onClick={async () => {
                          try {
                            await navigator.clipboard.writeText(
                              item.prompt || "",
                            );
                            setCopyStatus("提示词已复制");
                          } catch {
                            setCopyStatus("复制不可用，请从文本框手动复制");
                          }
                        }}
                      >
                        复制完整提示词
                      </button>
                      {copyStatus && <p role="status">{copyStatus}</p>}
                    </details>
                    <div className="wizard-inline">
                      <button
                        className="btn secondary small"
                        onClick={() => w.prepareAnalysis([item.id])}
                      >
                        重新分析本图
                      </button>
                      {!["ready", "needs_info"].includes(status) && (
                        <button
                          className="btn secondary small"
                          onClick={() =>
                            patch(item.id, {
                              manual_confirmed: true,
                              selected: true,
                            })
                          }
                        >
                          确认使用手工要求
                        </button>
                      )}
                      <button
                        className="btn secondary small"
                        onClick={() => duplicate(item)}
                      >
                        复制
                      </button>
                      <button
                        className="btn secondary small"
                        disabled={disabled || index === 0}
                        onClick={() => reorder(item, -1)}
                      >
                        上移
                      </button>
                      <button
                        className="btn secondary small"
                        disabled={
                          disabled || index === content.items.length - 1
                        }
                        onClick={() => reorder(item, 1)}
                      >
                        下移
                      </button>
                      <button
                        className="btn secondary small"
                        disabled={disabled || content.items.length === 1}
                        onClick={() => {
                          if (
                            window.confirm(
                              "移除此张图片规划？已有生成结果保留。",
                            )
                          )
                            changeItems(
                              content.items.filter((i) => i.id !== item.id),
                            );
                        }}
                      >
                        删除规划
                      </button>
                    </div>
                  </fieldset>
                </div>
              )}
            </article>
          );
        })
      )}
    </div>
  );
}
