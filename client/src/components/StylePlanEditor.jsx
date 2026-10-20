import { useEffect, useState } from "react";
import {
  DETAIL_MODULES,
  FACT_FIELDS,
  STANDARD_SECTIONS,
} from "../../../shared/stylePlan.js";
import StudioImage from "./StudioImage.jsx";
const STATUS_TEXT = {
  ready: "可生成",
  needs_info: "待补充资料",
  invalid: "需要调整",
  needs_analysis: "待分析或确认",
};
function PromptText({ item, index, disabled, onCommit }) {
  const auto = item.prompt || "",
    [draft, setDraft] = useState(item.prompt_override || auto),
    [dirty, setDirty] = useState(false);
  useEffect(() => {
    if (!dirty) setDraft(item.prompt_override || auto);
  }, [item.prompt, item.prompt_override]);
  return (
    <label className="style-field">
      提示词模块
      <textarea
        aria-label={`图片${index + 1}提示词`}
        rows={10}
        disabled={disabled}
        placeholder="正在编译，保存后显示"
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
          setDirty(true);
        }}
        onBlur={() => {
          if (!dirty) return;
          setDirty(false);
          onCommit(draft.trim() === auto.trim() ? "" : draft);
        }}
      />
    </label>
  );
}
function assembleStandardText(standard = {}) {
  return STANDARD_SECTIONS.map(
    ([key, label]) => `${label}：${standard[key] || ""}`,
  ).join("\n");
}
function parseStandardText(textValue, fallback = {}) {
  const out = { ...fallback },
    labels = STANDARD_SECTIONS.map(([key, label]) => [key, label]);
  let currentKey = null;
  for (const line of String(textValue || "").split("\n")) {
    const hit = labels.find(([, label]) => line.startsWith(`${label}：`) || line.startsWith(`${label}:`));
    if (hit) {
      currentKey = hit[0];
      out[currentKey] = line.slice(hit[1].length + 1).trim();
    } else if (currentKey) {
      out[currentKey] = `${out[currentKey]}\n${line}`.trim();
    }
  }
  return out;
}
function StandardText({ content, setContent, disabled }) {
  const [draft, setDraft] = useState(() => assembleStandardText(content.standard)),
    [dirty, setDirty] = useState(false);
  useEffect(() => {
    if (!dirty) setDraft(assembleStandardText(content.standard));
  }, [content.standard]);
  return (
    <textarea
      aria-label="整体设计规范"
      rows={10}
      disabled={disabled}
      value={draft}
      onChange={(e) => {
        setDraft(e.target.value);
        setDirty(true);
      }}
      onBlur={() => {
        if (!dirty) return;
        setDirty(false);
        setContent((c) => ({
          ...c,
          standard: parseStandardText(draft, c.standard),
          standard_edited: true,
        }));
      }}
    />
  );
}
export default function StylePlanEditor({ w, choices, disabled, onPreview }) {
  const { content, setContent, input } = w;
  const [view, setView] = useState("plan"),
    [focused, setFocused] = useState(null),
    [expanded, setExpanded] = useState(null);
  if (!content)
    return <p className="wizard-empty">先分析商品以生成图片规划。</p>;
  const patch = (id, updates) =>
    setContent((c) => ({
      ...c,
      items: c.items.map((i) => (i.id === id ? { ...i, ...updates } : i)),
    }));
  const current =
    content.items.find((i) => i.id === focused) || content.items[0];
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
  const quote = w.quote,
    generateCount = quote?.indexes.length ?? w.selected?.length ?? 0,
    generateDisabled =
      disabled || !quote || w.quoteBusy || w.changed || w.busy;
  return (
    <div className="wizard-plan-editor">
      <div className="wizard-section-head">
        <div>
          <h3>图片规划</h3>
          <p className="dim small">
            共{content.items.length}张图片，点击可编辑标题和描述
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
              <span>图内文案：{current.copy || current.spec?.text || "未添加"}</span>
            </div>
          </div>
          <p>
            {current.spec?.strategy || current.spec?.composition || "待分析"}{" "}
            · {current.size || input.size}
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
                      {STATUS_TEXT[status] || STATUS_TEXT.needs_analysis}
                    </small>
                    <small>{item.requirement.slice(0, 110)}</small>
                  </span>
                  <span aria-hidden="true">{open ? "⌃" : "⌄"}</span>
                </button>
              </div>
              {open && (
                <div className="wizard-plan-content">
                  <fieldset disabled={disabled}>
                    <p className="dim small">
                      改过的内容会作为这张图的要求一起生成。
                    </p>
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
                      画面描述
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
                    <PromptText
                      item={item}
                      index={index}
                      disabled={disabled}
                      onCommit={(prompt_override) =>
                        patch(item.id, { prompt_override })
                      }
                    />
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
                  </fieldset>
                </div>
              )}
            </article>
          );
        })
      )}
      <details className="wizard-section wizard-standard wizard-module-card">
        <summary>
          <strong>整体设计规范</strong>
          <span className="dim small">所有图片遵循的统一视觉标准</span>
        </summary>
        <fieldset disabled={disabled}>
          <StandardText
            content={content}
            setContent={setContent}
            disabled={disabled}
          />
        </fieldset>
      </details>
      <section className="wizard-section wizard-module-card wizard-gen-card">
        <div>
          <h3>生成图片</h3>
          <p className="dim small">
            {quote
              ? `继续生成 ${generateCount} 张图需消耗 ${quote.total} 积分`
              : w.quoteBusy
                ? "正在计算生成费用…"
                : generateCount
                  ? `已选 ${generateCount} 张图，费用待重新报价`
                  : "先在上方选择可生成的图片"}
          </p>
        </div>
        <button
          className="btn primary wizard-gen-button"
          disabled={generateDisabled}
          onClick={() => w.startGeneration()}
        >
          生成图片
        </button>
      </section>
    </div>
  );
}
