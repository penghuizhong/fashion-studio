import ProductLayoutEditor from "./ProductLayoutEditor.jsx";
import { renderMode } from "../../../shared/productImagePolicy.js";
import {
  assembleStandardText,
  parseStandardText,
} from "../../../shared/stylePrompt.js";
import { useEffect, useState } from "react";
import { DETAIL_MODULES, FACT_FIELDS, SPEC_FIELDS, isNoTextLanguage } from "../../../shared/stylePlan.js";
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
        <p className="dim small">先统一整套视觉，再逐张核对描述、设计内容与参考图。仅勾选且可生成的图片计入本次费用。</p>
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
          <label className="inline-check">
            <input
              type="checkbox"
              disabled={disabled}
              checked={
                content.conflict_ack === content.items[0]?.conflict_signature
              }
              onChange={(e) =>
                setContent((c) => ({
                  ...c,
                  conflict_ack: e.target.checked
                    ? content.items[0].conflict_signature
                    : "",
                }))
              }
            />
            已对照原图与保存属性核对，确认按已核对商品事实执行
          </label>
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
              {status !== "ready" && (
                <div className="wizard-card-blocker" role="status">
                  <p>{item.missing?.length
                    ? `待补充：${item.missing.map((key) => FACT_FIELDS[key] || key).join("、")}`
                    : item.error || item.policy_issues?.[0] || "本图尚未分析，请先分析或核对后确认。"}；本次不会生成此图。</p>
                  <button className="btn secondary small" disabled={disabled} onClick={onAdjust}>
                    {item.missing?.length ? "补充资料" : "调整需求"}
                  </button>
                </div>
              )}
              {open && (
                <div className="wizard-plan-content">
                  <fieldset disabled={disabled}>
                    <p className="dim small">
                      改过的内容会作为这张图的要求一起生成。
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
                    <section className="wizard-image-design" aria-label={`图片${index + 1}设计内容`}>
                      <h4>本图设计内容</h4>
                      <p className="dim small">模块规则与整体规范自动应用；以下参数决定这张图的具体画面。</p>
                      <div className="wizard-design-grid">
                        {SPEC_FIELDS.map(([key, label]) => (
                          <label className="style-field" key={key}>
                            {label}
                            <textarea
                              aria-label={`图片${index + 1}${label}`}
                              rows={2}
                              maxLength={2000}
                              disabled={disabled || (key === "text" && (item.module_id === "main" || isNoTextLanguage(input.language)))}
                              placeholder={key === "text" && (item.module_id === "main" || isNoTextLanguage(input.language)) ? "本图不新增文字" : "待补充具体设计参数"}
                              value={key === "text" && (item.module_id === "main" || isNoTextLanguage(input.language)) ? "" : (key === "text" ? item.copy || item.spec?.[key] : item.spec?.[key]) || ""}
                              onChange={(e) => patch(item.id, { spec: { ...item.spec, [key]: e.target.value }, ...(key === "text" ? { copy: e.target.value } : {}) })}
                            />
                          </label>
                        ))}
                      </div>
                    </section>
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
                        <details className="wizard-execution-layers">
                          <summary>查看自动编排的六层提示词</summary>
                          {(item.prompt_layers || []).map((layer, layerIndex) => (
                            <section key={layer.id}>
                              <h4>{layerIndex + 1}. {layer.label}</h4>
                              <pre>{layer.text}</pre>
                            </section>
                          ))}
                          {item.prompt_override && <p className="dim small">当前采用手工提示词。自动编排内容供核对，重新编排后生效。</p>}
                        </details>
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
                      <label className="inline-check">
                        <input
                          type="checkbox"
                          checked={item.risk_ack === item.risk_signature}
                          disabled={disabled}
                          onChange={(e) =>
                            patch(item.id, {
                              risk_ack: e.target.checked
                                ? item.risk_signature
                                : "",
                            })
                          }
                        />
                        已对照原图核对以下要求：
                        {item.quality_warnings.join("；")}
                      </label>
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
