import {
  generationMode,
  renderMode,
} from "../../../shared/productImagePolicy.js";
import { useState } from "react";
import {
  DETAIL_MODULES,
  PLAN_LIMITS,
  FACT_FIELDS,
  MODULE_SETS,
  defaultPlanCamera,
  isNoTextLanguage,
} from "../../../shared/stylePlan.js";
import {
  imageTaskAllowed,
  imageReferenceLimit,
} from "../../../shared/imageOptions.js";
import { PRESENTATION_STYLES } from "../../../shared/presentationStyles.js";
import ReferenceImages from "./ReferenceImages.jsx";
import ImageOutputOptions from "./ImageOutputOptions.jsx";
export function reconcileItems(input, old = []) {
  const result = [];
  for (const m of DETAIL_MODULES) {
    if (m.id === "transition" && isNoTextLanguage(input.language)) continue;
    const previous = old.filter((i) => i.module_id === m.id),
      count = input.modules[m.id] || 0;
    for (let n = 0; n < count; n++)
      result.push(
        previous[n]
          ? { spec: {}, ...previous[n] }
          : {
              id: crypto.randomUUID(),
              module_id: m.id,
              title: `${m.name}${count > 1 ? ` ${n + 1}` : ""}`,
              requirement: m.description,
              render_mode: renderMode(input, { module_id: m.id }),
              copy: "",
              prompt_override: "",
              spec: {},
              camera: defaultPlanCamera(m.id, n, input.op),
              reference_ids:
                m.id === "transition" ? [] : input.references.map((r) => r.id),
              prompt_overrides: {},
              selected: !m.required || !!input.facts[m.required],
              analyzed: false,
              manual_confirmed: false,
              status: "needs_analysis",
            },
      );
  }
  return result;
}
const GARMENT_ROLES = [
  ["garment", "款式主体"],
  ["fabric", "面料细节"],
];
export default function StylePlanInputs({
  w,
  choices,
  onUploaded,
  onResolved,
  disabled,
}) {
  const { input, setInput, content, setContent, models, chatModels } = w;
  const [all, setAll] = useState(false),
    [styles, setStyles] = useState(false);
  const model = models.find((m) => m.id === input.model_id),
    analysis = chatModels.find((m) => m.id === input.analysis_model_id);
  const update = (patch) => {
    setInput((f) => ({ ...f, ...patch }));
    w.setError("");
  };
  const setCounts = (modules) => {
    const total = Object.values(modules).reduce((n, v) => n + v, 0);
    if (total > PLAN_LIMITS.total) {
      w.setError(`一次最多规划${PLAN_LIMITS.total}张`);
      return;
    }
    if (
      content &&
      content.items.some(
        (i) =>
          (modules[i.module_id] || 0) <
            content.items.filter((a) => a.module_id === i.module_id).length &&
          (i.prompt_override ||
            i.edited ||
            Object.keys(i.prompt_overrides || {}).length ||
            i.manual_confirmed),
      ) &&
      !window.confirm(
        "减少数量可能移除已编辑图片；将优先保留人工修改项。继续？",
      )
    )
      return;
    const next = { ...input, modules };
    if (content) {
      const ordered = [...content.items].sort(
        (a, b) =>
          Number(
            !!b.prompt_override ||
              !!b.edited ||
              !!b.manual_confirmed ||
              Object.keys(b.prompt_overrides || {}).length > 0,
          ) -
          Number(
            !!a.prompt_override ||
              !!a.edited ||
              !!a.manual_confirmed ||
              Object.keys(a.prompt_overrides || {}).length > 0,
          ),
      );
      setContent((c) => ({ ...c, items: reconcileItems(next, ordered) }));
    }
    update({ modules });
  };
  const garmentRefs = input.references.filter(
      (r) => r.role === "garment" || r.role === "fabric",
    ),
    modelRefs = input.references.filter((r) => r.role === "model");
  const setBoardRefs = (board, keys) => {
    const isGarment = board === "garment",
      mine = isGarment ? garmentRefs : modelRefs,
      others = isGarment ? modelRefs : garmentRefs;
    if (keys.some((k) => others.some((r) => r.source === k))) {
      w.setError("同一图片已在另一组参考图中，不能重复添加");
      return;
    }
    const previous = input.references.map((r) => r.source),
      nextSources = isGarment
        ? [...keys, ...others.map((r) => r.source)]
        : [...others.map((r) => r.source), ...keys];
    if (
      previous.length &&
      previous.some((s, i) => nextSources[i] !== s) &&
      /图\s*\d/.test(input.requirements) &&
      !window.confirm("参考图顺序或数量已改变，请重新核对要求中的图号。继续？")
    )
      return;
    const built = keys.map((source) => {
      const old = mine.find((r) => r.source === source);
      return (
        old || {
          id: crypto.randomUUID(),
          source,
          role: isGarment ? "garment" : "model",
        }
      );
    });
    const refs = isGarment ? [...built, ...others] : [...others, ...built];
    update({ references: refs });
    if (content)
      setContent((c) => ({
        ...c,
        items: c.items.map((i) => ({
          ...i,
          reference_ids: refs.map((r) => r.id),
          manual_confirmed: false,
          status: "needs_analysis",
        })),
      }));
  };
  const setRefRole = (id, role) =>
    update({
      references: input.references.map((r) =>
        r.id === id ? { ...r, role } : r,
      ),
    });
  const total = Object.values(input.modules).reduce((n, v) => n + v, 0),
    required = DETAIL_MODULES.filter((m) => input.modules[m.id] && m.required),
    noText = isNoTextLanguage(input.language);
  const referenceLimit = Math.max(
    0,
    ...models.map((m) => imageReferenceLimit(m.capabilities)),
  );
  return (
    <fieldset className="wizard-inputs" disabled={disabled}>
      <section className="wizard-section">
        <label className="style-field">
          生成目标
          <select
            aria-label="生成目标"
            value={generationMode(input)}
            onChange={(e) => {
              const nextMode = e.target.value;
              update({ generation_mode: nextMode });
              if (content)
                setContent((c) => ({
                  ...c,
                  items: c.items.map((i) => ({
                    ...i,
                    render_mode:
                      i.module_id === "selling"
                        ? nextMode === "product"
                          ? "composition"
                          : "image"
                        : i.render_mode,
                  })),
                }));
            }}
          >
            <option value="product">同款商品保真（必须提供商品图）</option>
            <option value="creative">创意设计（允许重新设计）</option>
          </select>
        </label>
        <p className="dim small">
          商品主图默认无文字、无拼图；卖点图使用原图细节和真实字体排版。创意设计不保证与原商品结构一致。
        </p>
        <h3>商品图</h3>
        <p className="dim small">
          服装本体依据：第一张为款式主体，其余可标注为面料细节。
        </p>
        <ReferenceImages
          strictLimit
          uploadLabel="上传商品图"
          templateId={w.data.template.id}
          items={garmentRefs.map((r) => r.source)}
          choices={choices}
          model={model}
          availableLimit={referenceLimit}
          onUploaded={onUploaded}
          onResolved={onResolved}
          disabled={disabled}
          onChange={(keys) => setBoardRefs("garment", keys)}
        />
        {garmentRefs.map((r, n) => (
          <label className="style-field" key={r.id}>
            商品图{n + 1}用途
            <select
              aria-label={`商品图${n + 1}用途`}
              value={r.role}
              disabled={disabled}
              onChange={(e) => setRefRole(r.id, e.target.value)}
            >
              {GARMENT_ROLES.map(([key, label]) => (
                <option value={key} key={key}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        ))}
      </section>
      <section className="wizard-section">
        <h3>模特图</h3>
        <p className="dim small">
          主体依据：模特的身份、肤色、体型与发型以这里为准，整体规范的主体识别摘要来自模特图。
        </p>
        <ReferenceImages
          strictLimit
          uploadLabel="上传模特图"
          templateId={w.data.template.id}
          items={modelRefs.map((r) => r.source)}
          choices={choices}
          model={model}
          availableLimit={referenceLimit}
          onUploaded={onUploaded}
          onResolved={onResolved}
          disabled={disabled}
          onChange={(keys) => setBoardRefs("model", keys)}
        />
      </section>
      <section className="wizard-section">
        <h3>生成要求</h3>
        <label className="style-field">
          商品卖点与想要的画面
          <textarea
            aria-label="生成要求"
            rows={4}
            maxLength={3000}
            placeholder="例如：突出肩线和垂坠感，商品图作为款式主体，模特图作为模特参考"
            value={input.requirements}
            onChange={(e) => update({ requirements: e.target.value })}
          />
        </label>
        <p className="dim small">
          颜色、面料和结构变化请先在步骤1另存新版本；本次按该版本执行。
        </p>
      </section>
      <section className="wizard-section">
        <div className="wizard-section-head">
          <h3>服装详情内容模块</h3>
          <span className="tag">
            已选{Object.values(input.modules).filter((n) => n > 0).length}类，共
            {total}张
          </span>
        </div>
        <p className="dim small">
          每个模块是一个流水线工位，每张图会按模块指引生成独立画面规格。
        </p>
        <div className="wizard-inline">
          {Object.entries(MODULE_SETS).map(([name, counts]) => (
            <button
              className="btn secondary small"
              key={name}
              onClick={() => {
                if (
                  content &&
                  !window.confirm(
                    "将调整模块数量，保留可复用的已编辑规划。继续？",
                  )
                )
                  return;
                setCounts(counts);
              }}
            >
              {name}
            </button>
          ))}
        </div>
        <div className="wizard-module-grid">
          {(all ? DETAIL_MODULES : DETAIL_MODULES.slice(0, 6)).map((m) => {
            const count = input.modules[m.id] || 0;
            return (
              <article
                key={m.id}
                className={`wizard-module${count ? " selected" : ""}`}
              >
                <button
                  type="button"
                  className="wizard-module-select"
                  aria-label={`选择${m.name}`}
                  aria-pressed={count > 0}
                  onClick={() => {
                    if (!count) setCounts({ ...input.modules, [m.id]: 1 });
                  }}
                >
                  <strong>{m.name}</strong>
                  <small>{m.description}</small>
                  {count > 0 && (
                    <span className="wizard-count-badge">{count}</span>
                  )}
                </button>
                <div
                  className="wizard-stepper"
                  role="group"
                  aria-label={`${m.name}数量`}
                >
                  <button
                    className="btn secondary small"
                    aria-label={`减少${m.name}`}
                    disabled={disabled || count === 0}
                    onClick={() =>
                      setCounts({
                        ...input.modules,
                        [m.id]: Math.max(0, count - 1),
                      })
                    }
                  >
                    −
                  </button>
                  <output>{count}</output>
                  <button
                    className="btn secondary small"
                    aria-label={`增加${m.name}`}
                    disabled={
                      disabled ||
                      count >= PLAN_LIMITS.per_module ||
                      total >= PLAN_LIMITS.total
                    }
                    onClick={() =>
                      setCounts({ ...input.modules, [m.id]: count + 1 })
                    }
                  >
                    +
                  </button>
                </div>
              </article>
            );
          })}
        </div>
        <button
          className="btn secondary small"
          aria-expanded={all}
          onClick={() => setAll(!all)}
        >
          {all ? "收起其他模块" : "全部19类模块"}
        </button>
        {noText && (input.modules.transition || 0) > 0 && (
          <p className="dim small">
            当前图片文字语言为「无」，章节过渡卡不会生成。
          </p>
        )}
        {required.length > 0 && (
          <div className="wizard-facts">
            <h4>补充商品资料</h4>
            {required.map((m) => (
              <label className="style-field" key={m.id}>
                {FACT_FIELDS[m.required]}
                <textarea
                  rows={2}
                  maxLength={3000}
                  value={input.facts[m.required] || ""}
                  onChange={(e) =>
                    update({
                      facts: { ...input.facts, [m.required]: e.target.value },
                    })
                  }
                  placeholder="仅填写已确认的真实资料；留空时对应图片标为待补充"
                />
              </label>
            ))}
          </div>
        )}
      </section>
      <section className="wizard-section">
        <h3>生成参数</h3>
        {w.modelError && (
          <p role="alert">
            {w.modelError}
            <button className="btn secondary small" onClick={w.retryModels}>
              重试加载模型
            </button>
          </p>
        )}
        <label className="style-field">
          图片模型
          <select
            aria-label="图片模型"
            value={input.model_id}
            onChange={(e) => {
              const m = models.find((m) => m.id === e.target.value);
              update({ model_id: m.id, size: m.sizes[0], quality: "" });
            }}
          >
            <option value="">请选择模型</option>
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name} · {m.provider_name}
              </option>
            ))}
          </select>
        </label>
        {model &&
          !imageTaskAllowed(model.capabilities, input.references.length) && (
            <p className="dim small">
              请更换支持所选参考数量的模型，或在每张规划中调整参考。
            </p>
          )}
        <ImageOutputOptions
          model={model}
          size={input.size}
          quality={input.quality}
          onChange={update}
        />
        <h4>风格预设</h4>
        <div className="wizard-inline">
          {[
            ["auto", "自动"],
            ...PRESENTATION_STYLES.map(([id, name]) => [id, name]),
          ]
            .slice(0, styles ? undefined : 6)
            .map(([id, name]) => (
              <button
                className="btn secondary small"
                key={id}
                aria-pressed={input.style === id}
                onClick={() => update({ style: id })}
              >
                {name}
              </button>
            ))}
          <button
            className="btn secondary small"
            onClick={() => setStyles(!styles)}
          >
            {styles ? "收起" : "更多风格"}
          </button>
        </div>
        <label className="style-field">
          图片文字语言
          <input
            maxLength={40}
            value={input.language || "简体中文"}
            onChange={(e) => update({ language: e.target.value })}
          />
        </label>
        <label className="style-field">
          商品分析模型
          <select
            aria-label="商品分析模型"
            value={input.analysis_model_id}
            onChange={(e) => update({ analysis_model_id: e.target.value })}
          >
            <option value="">请选择模型</option>
            {chatModels.map((m) => (
              <option
                key={m.id}
                value={m.id}
                disabled={input.references.length > 0 && !m.vision}
              >
                {m.name} · {m.provider_name}
                {m.vision ? " · 可识图" : ""}
              </option>
            ))}
          </select>
        </label>
        {["toggle", "best_effort"].includes(analysis?.thinking_control) ? (
          <label className="inline-check">
            <input
              type="checkbox"
              checked={input.thinking}
              onChange={(e) => update({ thinking: e.target.checked })}
            />
            思考模式{" "}
            <small>
              {analysis?.thinking_control === "best_effort"
                ? "向供应商传递此偏好，是否生效由供应商决定"
                : input.thinking
                  ? "已开启，分析可能更慢"
                  : "关闭，优先快速规划"}
            </small>
          </label>
        ) : (
          <p className="dim small">
            {analysis?.thinking_control === "forced_on"
              ? "此模型固定启用思考，分析可能较慢。"
              : "当前分析模型不提供思考切换。"}
          </p>
        )}
        <label className="style-field">
          必须保留的设计条件
          <textarea
            maxLength={1000}
            rows={2}
            value={input.keep || ""}
            onChange={(e) => update({ keep: e.target.value })}
          />
        </label>
        <p className="dim small">
          分析与生成图片分别确认费用。看图、修改规划和构图示意不调用模型。
        </p>
      </section>
    </fieldset>
  );
}
