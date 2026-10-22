import ProductLayoutEditor from "./ProductLayoutEditor.jsx";
import { renderMode } from "../../../shared/productImagePolicy.js";
import {
  assembleStandardText,
  parseStandardText,
} from "../../../shared/stylePrompt.js";
import { useEffect, useState } from "react";
import { DETAIL_MODULES, FACT_FIELDS } from "../../../shared/stylePlan.js";
import StudioImage from "./StudioImage.jsx";
const STATUS_TEXT = {
  ready: "可生成",
  needs_info: "待补充资料",
  invalid: "需要调整",
  needs_analysis: "待分析或确认",
};
function PromptText({ item, index, disabled, onCommit, onEditing }) {
  return (
    <label className="style-field">
      提示词模块
      <textarea
        aria-label={`图片${index + 1}提示词`}
        rows={10}
        maxLength={12000}
        disabled={disabled}
        placeholder="正在编排，保存后显示"
        value={
          item.prompt_override || item.automatic_prompt || item.prompt || ""
        }
        onChange={(e) => {
          onEditing(true);
          onCommit(e.target.value);
        }}
        onBlur={() => onEditing(false)}
      />
    </label>
  );
}
function StandardText({ content, setContent, disabled, onEditing }) {
  const [draft, setDraft] = useState(() =>
    assembleStandardText(content.standard),
  );
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    if (!dirty) setDraft(assembleStandardText(content.standard));
  }, [content.standard, dirty]);
  return (
    <textarea
      aria-label="整体设计规范"
      rows={10}
      disabled={disabled}
      value={draft}
      onChange={(e) => {
        const value = e.target.value;
        setDraft(value);
        setDirty(true);
        onEditing(true);
        setContent((c) => ({
          ...c,
          standard: parseStandardText(value),
          standard_edited: true,
        }));
      }}
      onBlur={() => {
        setDirty(false);
        onEditing(false);
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
      items: c.items.map((i) =>
        i.id === id
          ? {
              ...i,
              ...updates,
              ...(updates.title !== undefined ||
              updates.requirement !== undefined
                ? { edited: true }
                : {}),
            }
          : i,
      ),
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
      disabled ||
      !quote ||
      w.quoteBusy ||
      w.changed ||
      w.busy ||
      w.editingPrompt ||
      !!w.readiness;
  return (
    <div className="wizard-plan-editor">
      {content.reference_conflicts && (
        <section className="wizard-section">
          <p role="alert">商品事实冲突：{content.reference_conflicts}</p>
        </section>
      )}
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
              <span>
                图内文案：{current.copy || current.spec?.text || "未添加"}
              </span>
            </div>
          </div>
          <p>
            {current.spec?.strategy || current.spec?.composition || "待分析"} ·{" "}
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
                    <p className="dim small wizard-request-summary">
                      本张：{name} · 仅输出1张 ·{" "}
                      {renderMode(input, item) === "composition"
                        ? "原图排版"
                        : item.reference_ids.length
                          ? "图生图"
                          : "文生图"}{" "}
                      · 商品/细节图
                      {
                        input.references.filter(
                          (r) =>
                            item.reference_ids.includes(r.id) &&
                            r.role !== "model",
                        ).length
                      }
                      张 · 模特图
                      {
                        input.references.filter(
                          (r) =>
                            item.reference_ids.includes(r.id) &&
                            r.role === "model",
                        ).length
                      }
                      张
                    </p>
                    <label className="style-field">
                      图片标题（功能卡名称，不作为图内文字）
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
                      画面描述（识别依据与本图任务）
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
                    {renderMode(input, item) === "composition" ? (
                      <ProductLayoutEditor
                        w={w}
                        item={item}
                        choices={choices}
                        disabled={disabled}
                        patch={(updates) => patch(item.id, updates)}
                      />
                    ) : (
                      <>
                        <PromptText
                          item={item}
                          index={index}
                          disabled={disabled}
                          onEditing={w.setEditingPrompt}
                          onCommit={(prompt_override) =>
                            patch(item.id, {
                              prompt_override,
                              prompt_override_basis:
                                item.automatic_signature || "",
                            })
                          }
                        />
                      </>
                    )}
                    <div className="wizard-inline">
                      {input.references
                        .filter((r) => item.reference_ids.includes(r.id))
                        .map((r, n) => {
                          const image = choices.find((c) => c.key === r.source);
                          return (
                            <figure key={r.id}>
                              <StudioImage
                                thumbnail={image?.thumb_path}
                                original={image?.image_path}
                                alt={`本张参考图${n + 1}`}
                              />
                              <figcaption>
                                图{n + 1} ·{" "}
                                {r.role === "model"
                                  ? "参考模特"
                                  : r.role === "fabric"
                                    ? "面料细节"
                                    : "商品原图"}
                              </figcaption>
                            </figure>
                          );
                        })}
                    </div>
                    {(item.policy_issues || []).map((issue) => (
                      <p className="wizard-pending" key={issue}>
                        {issue}
                      </p>
                    ))}
                    {item.quality_warnings?.length > 0 && (
                      <p className="dim small">
                        {item.quality_warnings.join("；")}
                      </p>
                    )}
                    {item.prompt_override && (
                      <details>
                        <summary>完整执行提示词（含商品展示边界）</summary>
                        <textarea readOnly rows={5} value={item.prompt || ""} />
                      </details>
                    )}
                    {item.prompt_override && (
                      <div className="wizard-inline">
                        <span className="dim small">
                          已手动编辑
                          {item.prompt_stale
                            ? " · 上游内容已变化，需要同步"
                            : ""}
                        </span>
                        <button
                          className="btn secondary small"
                          disabled={disabled}
                          onClick={() =>
                            patch(item.id, {
                              prompt_override: "",
                              prompt_override_basis: "",
                              prompt_overrides: {},
                            })
                          }
                        >
                          重新编排提示词
                        </button>
                        {item.prompt_stale && (
                          <button
                            className="btn secondary small"
                            disabled={disabled}
                            onClick={() =>
                              patch(item.id, {
                                prompt_override_basis: item.automatic_signature,
                              })
                            }
                          >
                            确认保留手工提示词
                          </button>
                        )}
                      </div>
                    )}
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
            onEditing={w.setEditingPrompt}
          />
        </fieldset>
      </details>
      {w.readiness && (
        <p role="status" className="dim small">
          {w.readiness}
        </p>
      )}
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
