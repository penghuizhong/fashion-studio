import ProductLayoutEditor from "./ProductLayoutEditor.jsx";
import { renderMode } from "../../../shared/productImagePolicy.js";
import {
  promptLength,
  assembleStandardText,
  parseStandardText,
} from "../../../shared/stylePrompt.js";
import { useEffect, useState } from "react";
import { DETAIL_MODULES, FACT_FIELDS, SPEC_FIELDS } from "../../../shared/stylePlan.js";
import StudioImage from "./StudioImage.jsx";
const STATUS_TEXT = {
  ready: "可生成",
  needs_info: "待补充资料",
  invalid: "需要调整",
  needs_analysis: "待分析",
};
function PromptText({ item, index, disabled, onCommit, onEditing }) {
  return (
    <div className="style-field">
      <span>提示词模块</span>
      {[
        ["description_prompt", "主要描述"],
        ["attributes_prompt", "基本属性"],
      ].map(([key, label]) => (
        <label className="style-field" key={key}>
          {label}（{promptLength(item[key] || "")}/200字）
          <textarea
            aria-label={`图片${index + 1}${label}`}
            rows={4}
            disabled={disabled}
            value={item[key] || ""}
            placeholder="分析商品后生成"
            onChange={(e) => {
              if (promptLength(e.target.value) > 200) return;
              onEditing(true);
              onCommit({ [key]: e.target.value, edited: true });
            }}
            onBlur={() => onEditing(false)}
          />
        </label>
      ))}
    </div>
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
export default function StylePlanEditor({ w, choices, disabled, onPreview, onAdjust }) {
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
              updates.requirement !== undefined || updates.spec !== undefined || updates.copy !== undefined
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
    blocked = content.items.filter((item) => item.status !== "ready");
  return (
    <div className="wizard-plan-editor">
      <section className="wizard-section wizard-plan-overview" aria-label="方案核对">
        <h3>核对本次图片方案</h3>
        <p className="dim small">先核对整体规范，再逐张编辑主要描述与基本属性。仅勾选且可生成的图片计入本次费用。</p>
        <div className="wizard-plan-counts">
          <span>共 {content.items.length} 张</span>
          <span>本次生成 {generateCount} 张</span>
          <span>待完善 {blocked.length} 张</span>
        </div>
      </section>
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
              <p>{current.description_prompt || current.requirement}</p>
              <span>
                图内文案：{current.copy || current.spec?.text || "未添加"}
              </span>
            </div>
          </div>
          <p>
            {current.spec?.strategy || current.spec?.composition || "待分析"} ·{" "}
            {input.size}
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
                      {name} · {input.size} ·{" "}
                      {STATUS_TEXT[status] || STATUS_TEXT.needs_analysis}
                    </small>
                    <small>{item.requirement.slice(0, 110)}</small>
                  </span>
                  <span aria-hidden="true">{open ? "⌃" : "⌄"}</span>
                </button>
              </div>
              {status !== "ready" && (
                <div className="wizard-card-blocker" role="status">
                  <p>{item.missing?.length
                    ? `待补充：${item.missing.map((key) => FACT_FIELDS[key] || key).join("、")}`
                    : item.error || item.policy_issues?.[0] || "本图尚未分析，请先完成商品分析。"}；本次不会生成此图。</p>
                  <button className="btn secondary small" disabled={disabled} onClick={onAdjust}>
                    {item.missing?.length ? "补充资料" : "调整需求"}
                  </button>
                </div>
              )}
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
                    <details className="wizard-design-reference">
                      <summary>查看九维分析参考</summary>
                      <p className="dim small">以下为分析时的设计资料。生图以本图两段提示词和整体规范为准；修改画面请编辑下方主要描述与基本属性。</p>
                      <dl className="wizard-design-grid" aria-label={`图片${index + 1}设计参考`}>
                        {SPEC_FIELDS.map(([key, label]) => (
                          <div key={key}><dt>{label}</dt><dd>{item.spec?.[key] || "未提供"}</dd></div>
                        ))}
                      </dl>
                    </details>
                    <PromptText item={item} index={index} disabled={disabled}
                      onEditing={w.setEditingPrompt}
                      onCommit={(updates) => patch(item.id, updates)} />
                    {renderMode(input, item) === "composition" && (
                      <ProductLayoutEditor w={w} item={item} choices={choices}
                        disabled={disabled} patch={(updates) => patch(item.id, updates)} />
                    )}
                    <details className="wizard-execution-layers">
                      <summary>查看实际执行提示词</summary>
                      <pre>{item.prompt || "尚未生成执行提示词"}</pre>
                      <p className="dim small">由本图两段提示词与非空整体规范组成；尺寸、质量和真实参考图片通过独立参数发送。</p>
                    </details>
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
      {w.readiness && (
        <p role="status" className="dim small">
          {w.readiness}
        </p>
      )}
      <section className="wizard-section wizard-module-card" aria-label="本次生成费用">
        <h3>本次生成</h3>
        <p className="dim small">
          {quote ? `${generateCount} 张 · ${quote.total} 积分，核对后在底部确认费用并生成。`
            : w.quoteBusy ? "正在计算生成费用…"
              : generateCount ? `已选 ${generateCount} 张图，费用待重新报价` : "先选择可生成的图片"}
        </p>
        {blocked.length > 0 && <p className="dim small">另有 {blocked.length} 张待完善，可补充资料后再生成；不计入本次费用。</p>}
      </section>
    </div>
  );
}
