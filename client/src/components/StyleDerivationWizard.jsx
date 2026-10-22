import StylePlanConflict from "./StylePlanConflict.jsx";
import StylePlanAnalysisConfirmation from "./StylePlanAnalysisConfirmation.jsx";
import "./styleWizard.css";
import { useEffect, useRef, useState } from "react";
import { api } from "../api.js";
import {
  PLAN_STEPS,
  DETAIL_MODULES,
  DEFAULT_STANDARD,
  moduleCounts,
  defaultPlanCamera,
} from "../../../shared/stylePlan.js";
import useStylePlanWizard from "./useStylePlanWizard.js";
import StylePlanAttributes from "./StylePlanAttributes.jsx";
import StylePlanInputs from "./StylePlanInputs.jsx";
import StylePlanEditor from "./StylePlanEditor.jsx";
import StylePlanResults from "./StylePlanResults.jsx";
import ProgressiveStudioImage from "./ProgressiveStudioImage.jsx";
import OriginalImageViewer from "./OriginalImageViewer.jsx";
import OriginalImageLink from "./OriginalImageLink.jsx";
import { mergeRecords } from "./useWorkspaceCollections.jsx";
export default function StyleDerivationWizard(props) {
  const { templateId, initialImage, onClose, onChanged, onViewImage } = props;
  const [viewerOnly, setViewerOnly] = useState(!props.initialPanel),
    [actual, setActual] = useState(false);
  const w = useStylePlanWizard({ ...props, enablePlanning: !viewerOnly }),
    dialog = useRef(null),
    leftRef = useRef(null),
    rightRef = useRef(null),
    [large, setLarge] = useState(null),
    [collapsed, setCollapsed] = useState(false),
    [mobile, setMobile] = useState("settings"),
    [dirtyAttributes, setDirtyAttributes] = useState(false),
    [references, setReferences] = useState([]),
    [resolved, setResolved] = useState([]),
    [images, setImages] = useState([]),
    [imageError, setImageError] = useState(""),
    [preview, setPreview] = useState(initialImage),
    [history, setHistory] = useState([]),
    [historyPage, setHistoryPage] = useState(1),
    [historyTotal, setHistoryTotal] = useState(0),
    [showPlans, setShowPlans] = useState(false);
  const analysisRunning = w.analysis?.status === "running",
    locked =
      w.busy ||
      analysisRunning ||
      w.analysis?.status === "uncertain" ||
      !!w.pendingAnalysis,
    active = ["running", "queued"].includes(w.job?.status);
  const version = w.data?.versions.find((v) => v.id === w.versionId);
  useEffect(() => {
    const d = dialog.current,
      opener = document.activeElement,
      overflow = document.body.style.overflow;
    d.showModal();
    document.body.style.overflow = "hidden";
    return () => {
      d.close();
      document.body.style.overflow = overflow;
      opener?.focus();
    };
  }, []);
  useEffect(() => {
    if (viewerOnly || !w.data || !w.versionId) return;
    const c = new AbortController();
    setImageError("");
    api.studio
      .workspaceItems(
        templateId,
        "images",
        { version_id: w.versionId, state: "active", limit: 20 },
        { signal: c.signal },
      )
      .then((r) => {
        if (c.signal.aborted) return;
        setImages((old) => mergeRecords(old, r.items));
        const exact = r.items.filter(
          (i) => i.design_version_id === w.versionId,
        );
        setPreview((current) => {
          const path = current?.path || current?.image_path;
          const image =
            exact.find((i) => i.image_path === path) ||
            exact[0] ||
            r.items.find((i) => !i.design_version_id && i.image_path === path);
          return image ? { ...image, path: image.image_path } : null;
        });
      })
      .catch((e) => {
        if (!c.signal.aborted) setImageError(e.message);
      });
    return () => c.abort();
  }, [templateId, w.versionId, !!w.data, viewerOnly]);
  useEffect(() => {
    const ids = w.input.references
      .map((r) => r.source)
      .filter((s) => s.startsWith("ref:"))
      .map((s) => s.slice(4));
    if (!ids.length) return;
    const c = new AbortController();
    api.studio
      .references({ ids: ids.join(","), limit: 16 }, { signal: c.signal })
      .then((r) => setReferences((old) => mergeRecords(old, [
        ...ids.filter((id) => !r.references.some((ref) => String(ref.id) === id)).map((id) => ({ id: Number(id), image_available: false })),
        ...r.references,
      ])))
      .catch((e) => {
        if (!c.signal.aborted) w.setError(e.message);
      });
    return () => c.abort();
  }, [w.input.references.map((r) => r.source).join(",")]);
  useEffect(() => {
    const ids = w.input.references.map((r) => r.source).filter((source) => /^\d+$/.test(source));
    if (!ids.length || !w.data) return;
    const controller = new AbortController();
    api.studio.workspaceItems(templateId, 'images', { ids: ids.join(','), limit: 20 }, { signal: controller.signal })
      .then((result) => {
        if (controller.signal.aborted) return;
        const missing = ids.filter((id) => !result.items.some((item) => String(item.id) === id))
          .map((id) => ({ id: Number(id), image_available: false }));
        setImages((old) => mergeRecords(old, [...missing, ...result.items]));
      }).catch((error) => { if (!controller.signal.aborted) w.setError(error.message); });
    return () => controller.abort();
  }, [templateId, !!w.data, w.input.references.map((r) => r.source).join(',')]);
  const choices = w.data
    ? [
        ...(w.data.template.source_image_path || w.input.references.some((r) => r.source === "original")
          ? [
              {
                key: "original",
                name: "原始参考图",
                image_path: w.data.template.source_image_path,
                thumb_path: w.data.template.source_thumb_path,
                available: w.data.template.source_available,
              },
            ]
          : []),
        ...(w.data.primary_reference ? [{ ...w.data.primary_reference, key: w.data.primary_reference.source,
          name: w.data.primary_reference.origin === 'version' ? '当前版本款式图' : '款式原图参考' }] : []),
        ...[...images, ...w.data.images].map((i) => ({
          key: String(i.id),
          ...i,
        })),
        ...references.map((r) => ({ key: `ref:${r.id}`, ...r })),
        ...resolved,
      ]
    : [];
  useEffect(() => {
    if (w.step >= 3) setMobile("preview");
  }, [w.step]);
  const source = choices.find((c) => c.key === w.input.references[0]?.source);
  const referencePreview =
    preview?.path || preview?.image_path
      ? preview
      : w.data?.template.source_image_path
        ? {
            path: w.data.template.source_image_path,
            thumb_path: w.data.template.source_thumb_path,
            image_available: w.data.template.source_available,
          }
        : null;
  const goto = (n) => {
    setViewerOnly(false);
    if (n < 3 && w.retryJobId) w.cancelRetry();
    if (dirtyAttributes && n !== 1) {
      w.setError("请先保存为新版本或取消属性修改");
      return;
    }
    if (n > 1 && !w.data) return;
    if (n === 3 && !w.content) {
      w.setError("请先分析商品并生成图片规划");
      return;
    }
    if (n > 3 && !w.job) {
      w.setError("尚未提交生成任务");
      return;
    }
    w.setStep(n);
    w.setError("");
    setMobile(n >= 3 ? "preview" : "settings");
    rightRef.current?.scrollTo({ top: 0 });
    leftRef.current?.scrollTo({ top: 0 });
  };
  const close = () => {
    if (w.changed)
      w.flush()
        .catch(() => {})
        .finally(onClose);
    else onClose();
  };
  const loadHistory = async (page = 1) => {
    try {
      const r = await api.studio.plans(templateId, { page });
      setHistory((old) => (page === 1 ? r.plans : [...old, ...r.plans]));
      setHistoryPage(page);
      setHistoryTotal(r.total);
    } catch (e) {
      w.setError(e.message);
    }
  };
  const continueImage = (i) =>
    w.work(async () => {
      const generationId = i.generation_id || i.id;
      const versionId =
        i.design_version_id || w.job?.snapshot.style.version_id || w.versionId;
      if (versionId !== w.versionId) await w.selectVersion(versionId);
      await w.beginNewPlan({
        ...w.input,
        op: "variant",
        modules: { main: 1 },
        delivery_views: null,
        references: [
          {
            id: crypto.randomUUID(),
            source: String(generationId),
            role: "garment",
          },
        ],
      });
      setPreview({ ...i, path: i.image_path });
      setImages((old) => mergeRecords(old, [{ ...i, id: generationId }]));
    });
  const counts = Object.values(w.input.modules).reduce((n, v) => n + v, 0),
    notReady = w.content?.items.filter((i) => i.status !== "ready").length || 0;
  const mainLabel = w.pending
    ? "核对提交结果"
    : w.pendingAnalysis
      ? "核对分析结果"
      : w.step === 1
        ? "下一步"
        : w.step === 2
          ? w.content
            ? "重新分析商品"
            : "分析商品并生成方案"
          : w.step === 3
            ? `确认费用并生成 ${w.quote?.indexes.length || w.selected.length} 张`
            : w.step === 4
              ? "查看已完成结果"
              : "新一轮生成";
  const primary = () => {
    if (w.pending) return w.startGeneration();
    if (w.pendingAnalysis) return w.recoverAnalysis();
    if (w.step === 1) return goto(2);
    if (w.step === 2) return w.prepareAnalysis();
    if (w.step === 3) return w.startGeneration();
    if (w.step === 4) return goto(5);
    w.newRound();
  };
  const disabled =
    w.busy ||
    (w.step === 1
      ? dirtyAttributes || !w.data
      : w.step === 2
        ? locked || !w.input.model_id || !w.input.analysis_model_id || !counts
        : w.step === 3
          ? !w.quote ||
            w.quoteBusy ||
            w.changed ||
            active ||
            locked ||
            w.editingPrompt ||
            !!w.readiness
          : false);
  const status =
    w.step === 1
      ? `V${version?.number || "—"} · 原属性不覆盖`
      : w.step === 2
        ? analysisRunning
          ? w.analysis.progress.message
          : `共${counts}张 · 分析与生成分别确认费用`
        : w.step === 3
          ? w.quoteBusy
            ? "正在获取报价…"
            : w.changed
              ? "正在保存规划并更新提示词…"
              : w.quote
                ? `${w.quote.indexes.length}张 · 预计${w.quote.total}积分${notReady ? ` · ${notReady}项待补或待分析` : ""}`
                : w.readiness ||
                  `已选${w.selected.length}张${notReady ? ` · ${notReady}项待补或待分析` : ""}`
          : active
            ? "关闭后继续后台生成"
            : "结果已归属当前款式，无需收卡";
  return (
    <dialog
      ref={dialog}
      className={`style-workspace style-wizard${viewerOnly ? " wizard-view-only" : ""}${collapsed ? " wizard-left-collapsed" : ""} mobile-${mobile}`}
      aria-label="款式详情"
      onCancel={(e) => {
        if (e.target !== dialog.current) return;
        e.preventDefault();
        close();
      }}
    >
      <header className="style-workspace-head">
        <div>
          <strong>
            {w.data?.template.name || initialImage?.name || "款式详情"}
          </strong>
          <span className="tag">V{version?.number || "—"}</span>
        </div>
        <div className="style-toolbar">
          {viewerOnly ? (
            <>
              <OriginalImageLink
                path={referencePreview?.path || referencePreview?.image_path}
              />
              <button
                className="btn secondary small"
                aria-expanded="false"
                onClick={() => goto(1)}
              >
                款式衍生
              </button>
              <button
                className="btn secondary small"
                aria-pressed="false"
                onClick={() => goto(1)}
              >
                款式属性
              </button>
            </>
          ) : (
            <>
              <button
                className="btn secondary small"
                onClick={() => setViewerOnly(true)}
              >
                查看图片
              </button>
              <button
                className="btn secondary small"
                aria-expanded={!collapsed}
                onClick={() => setCollapsed(!collapsed)}
              >
                {collapsed ? "展开左侧" : "收起左侧"}
              </button>
            </>
          )}
        </div>
        <button
          className="icon-btn style-workspace-close"
          aria-label="关闭款式详情"
          onClick={close}
        >
          ×
        </button>
      </header>
      {viewerOnly ? (
        <section
          className={`wizard-image-only style-preview${actual ? " actual" : ""}`}
        >
          <div className="style-preview-toolbar">
            <span>款式图片预览</span>
            <button
              className="btn secondary small"
              onClick={() => setActual(!actual)}
            >
              {actual ? "适应窗口" : "实际尺寸"}
            </button>
            <button
              className="btn secondary small"
              disabled={!referencePreview}
              onClick={() =>
                setLarge({
                  path: referencePreview.path || referencePreview.image_path,
                  name:
                    w.data?.template.name || initialImage?.name || "款式图片",
                })
              }
            >
              放大原图
            </button>
          </div>
          <div className="style-preview-image">
            <ProgressiveStudioImage
              original={referencePreview?.path || referencePreview?.image_path}
              thumbnail={referencePreview?.thumb_path}
              available={referencePreview?.image_available}
              actual={actual}
              alt={w.data?.template.name || initialImage?.name || "款式图片"}
            />
          </div>
          {w.data && (
            <div className="style-preview-footer">
              当前查看 V{version?.number} · 原图按需加载，查看不改变工作版本
            </div>
          )}
        </section>
      ) : (
        <>
          <nav className="wizard-steps" aria-label="款式衍生步骤">
            {PLAN_STEPS.map((name, index) => (
              <button
                className="btn secondary"
                key={name}
                aria-current={w.step === index + 1 ? "step" : undefined}
                aria-pressed={w.step === index + 1}
                disabled={(index === 2 && !w.content) || (index > 2 && !w.job)}
                onClick={() => goto(index + 1)}
              >
                <span>{index + 1}</span>
                {name}
              </button>
            ))}
          </nav>
          <div
            className="wizard-mobile-tabs"
            role="group"
            aria-label="面板视图"
          >
            <button
              className="btn secondary"
              aria-pressed={mobile === "settings"}
              onClick={() => setMobile("settings")}
            >
              设置
            </button>
            <button
              className="btn secondary"
              aria-pressed={mobile === "preview"}
              onClick={() => setMobile("preview")}
            >
              预览
            </button>
          </div>
          <div className="wizard-body">
            <aside ref={leftRef} className="wizard-left" aria-label="款式设置">
              {w.step === 1 && w.data ? (
                <fieldset
                  className="wizard-transparent-fieldset"
                  disabled={w.busy || analysisRunning}
                >
                  <StylePlanAttributes
                    w={w}
                    onDirty={setDirtyAttributes}
                    onSaved={onChanged}
                  />
                </fieldset>
              ) : w.step === 2 && w.data ? (
                <StylePlanInputs
                  w={w}
                  choices={choices}
                  onUploaded={(r) =>
                    setReferences((old) => mergeRecords(old, [r]))
                  }
                  onResolved={(r) =>
                    setResolved((old) =>
                      mergeRecords(
                        old.map((c) => ({ ...c, id: c.key })),
                        r.map((c) => ({ ...c, id: c.key })),
                      ),
                    )
                  }
                  disabled={locked}
                />
              ) : (
                <section className="wizard-section">
                  <h3>本次设置</h3>
                  <p>设计版本 V{version?.number}</p>
                  <p>{w.input.requirements || "按已保存设计规划商品图片"}</p>
                  <p>
                    {counts}张 ·{" "}
                    {w.models.find((m) => m.id === w.input.model_id)?.name ||
                      w.job?.snapshot.model.name ||
                      "所选模型"}
                  </p>
                  <p>
                    {w.input.size} · {w.input.quality || "默认质量"}
                  </p>
                  <button
                    className="btn secondary"
                    disabled={analysisRunning}
                    onClick={() => goto(2)}
                  >
                    调整需求与参数
                  </button>
                  <details
                    onToggle={(e) => {
                      setShowPlans(e.currentTarget.open);
                      if (e.currentTarget.open) loadHistory(1);
                    }}
                  >
                    <summary>历史图片规划</summary>
                    {showPlans &&
                      history.map((p) => (
                        <button
                          className="btn secondary wizard-history-plan"
                          key={p.id}
                          disabled={locked}
                          onClick={() =>
                            w.work(async () => {
                              await w.flush();
                              await w.loadPlan(p.id);
                              w.setStep(3);
                            })
                          }
                        >
                          {new Date(p.updated_at).toLocaleString()} · 修订
                          {p.revision}
                        </button>
                      ))}
                    {historyPage * 20 < historyTotal && (
                      <button
                        className="btn secondary small"
                        onClick={() => loadHistory(historyPage + 1)}
                      >
                        更多规划
                      </button>
                    )}
                  </details>
                  {w.job?.snapshot.style && (
                    <details>
                      <summary>生成设置快照</summary>
                      <p>
                        本任务采用 V{w.job.snapshot.style.version_number}
                        ，规划修订
                        {w.job.snapshot.style.plan_revision || "历史未记录"}。
                      </p>
                      <p>查看和编辑其他设置不会改变已提交任务。</p>
                    </details>
                  )}
                </section>
              )}
              {!w.ready && <p role="status">正在加载款式资料…</p>}
            </aside>
            <main
              ref={rightRef}
              className="wizard-right"
              aria-label="图片规划与预览"
            >
              {w.step === 1 ? (
                <section className="wizard-property-preview">
                  <div className="wizard-section-head">
                    <h3>预览图</h3>
                    <span className="dim small">
                      {preview?.design_version_id === w.versionId
                        ? "当前版本关联图片"
                        : "当前版本尚未生成 · 下图仅供参考"}
                    </span>
                  </div>
                  {referencePreview ? (
                    <>
                      <div className="wizard-preview-toolbar">
                        <OriginalImageLink
                          path={
                            referencePreview.path || referencePreview.image_path
                          }
                        />
                        <button
                          className="btn secondary small"
                          onClick={() =>
                            setLarge({
                              path:
                                referencePreview.path ||
                                referencePreview.image_path,
                              name: "款式原图",
                            })
                          }
                        >
                          放大原图
                        </button>
                      </div>
                      <ProgressiveStudioImage
                        original={
                          referencePreview.path || referencePreview.image_path
                        }
                        thumbnail={referencePreview.thumb_path}
                        available={referencePreview.image_available}
                        alt="款式预览图"
                      />
                      {imageError && <p role="alert">{imageError}</p>}
                    </>
                  ) : (
                    <div className="wizard-empty">
                      此版本尚未生成图片，可在下一步规划。
                    </div>
                  )}
                </section>
              ) : w.step === 2 ? (
                <section className="wizard-analysis">
                  <h3>
                    {analysisRunning ? "正在分析商品" : "商品分析与图片规划"}
                  </h3>
                  {w.analysis ? (
                    <>
                      <p role="status">{w.analysis.progress.message}</p>
                      <p>
                        已规划 {w.analysis.progress.completed || 0}/
                        {w.analysis.progress.total || counts} 张
                      </p>
                      {w.analysis.request_trace && (
                        <details className="wizard-section">
                          <summary>
                            本次实际识图：{w.analysis.request_trace.image_count}
                            张
                          </summary>
                          <p className="dim small">
                            图片以真实图片数据附件发送，下面按实际发送顺序列出来源。
                          </p>
                          <div className="wizard-inline wizard-analysis-sources">
                            {w.analysis.request_trace.source_manifest.map(
                              (r) => (
                                <figure key={r.id}>
                                  <ProgressiveStudioImage
                                    original={r.path}
                                    alt={`识图来源图${r.number}`}
                                  />
                                  <figcaption>
                                    图{r.number} ·{" "}
                                    {r.role === "model"
                                      ? "模特图"
                                      : r.role === "fabric"
                                        ? "细节图"
                                        : "商品图"}
                                  </figcaption>
                                  <OriginalImageLink path={r.path} />
                                </figure>
                              ),
                            )}
                          </div>
                        </details>
                      )}
                      {w.analysis.progress.references?.map((r) => (
                        <p key={r.number}>
                          图{r.number}识别：{r.observation}
                        </p>
                      ))}
                      {w.analysis.progress.conflicts && (
                        <p role="alert">
                          参考冲突：{w.analysis.progress.conflicts}
                        </p>
                      )}
                      {w.analysis.progress.standard && (
                        <article className="wizard-section">
                          <strong>整体规范已形成</strong>
                          {Object.entries(w.analysis.progress.standard).map(
                            ([key, value]) => value && <p key={key}>{value}</p>,
                          )}
                        </article>
                      )}
                      {w.analysis.progress.items?.map((i, n) => (
                        <article className="wizard-section" key={i.id}>
                          <strong>
                            {n + 1}. {i.title}
                          </strong>
                          <p>{i.requirement}</p>
                        </article>
                      ))}
                      {(w.analysis.status === "failed" ||
                        w.analysis.progress.review_required) &&
                        w.analysis.progress.items?.length > 0 && (
                          <button
                            className="btn secondary"
                            disabled={locked}
                            onClick={() =>
                              w.work(async () => {
                                const r = await api.studio.applyPlanAnalysis(
                                  templateId,
                                  w.plan.id,
                                  {
                                    analysis_id: w.analysis.id,
                                    expected_revision: w.plan.revision,
                                  },
                                );
                                w.adopt(r.plan);
                                w.setAnalysis((a) => ({
                                  ...a,
                                  progress: {
                                    ...a.progress,
                                    review_required: false,
                                  },
                                }));
                                w.setStep(3);
                              })
                            }
                          >
                            {w.analysis.progress.review_required
                              ? "采用新结果，保留手工修改"
                              : "采用已完成项，继续补齐其余规划"}
                          </button>
                        )}
                      {w.analysis.progress.review_required && (
                        <div className="wizard-section">
                          <p>
                            新方案为候选结果，原有手工内容尚未替换。上方可核对新画面描述和整体规范。
                          </p>
                          <button
                            className="btn secondary"
                            disabled={locked}
                            onClick={() =>
                              w.work(async () => {
                                await w.flush();
                                const r = await api.studio.applyPlanAnalysis(
                                  templateId,
                                  w.plan.id,
                                  {
                                    analysis_id: w.analysis.id,
                                    expected_revision: w.plan.revision,
                                    replace_manual: true,
                                  },
                                );
                                w.adopt(r.plan);
                                w.setAnalysis((a) => ({
                                  ...a,
                                  progress: {
                                    ...a.progress,
                                    review_required: false,
                                  },
                                }));
                                w.setStep(3);
                              })
                            }
                          >
                            采用新方案，替换手工修改
                          </button>
                        </div>
                      )}
                      {w.analysis.status === "succeeded" &&
                        !w.analysis.progress.review_required && (
                          <button
                            className="btn secondary"
                            onClick={() => goto(3)}
                          >
                            查看已生成方案
                          </button>
                        )}
                    </>
                  ) : (
                    <>
                      <p className="dim">
                        左侧条件会用于生成整套规范和逐张图片要求。分析结果将显示在这里。
                      </p>
                      <div className="wizard-analysis-outline">
                        {DETAIL_MODULES.filter(
                          (m) => w.input.modules[m.id],
                        ).map((m) => (
                          <article className="wizard-section" key={m.id}>
                            <strong>
                              {m.name} · {w.input.modules[m.id]}张
                            </strong>
                            <p className="dim small">
                              待分析 · {m.description}
                            </p>
                          </article>
                        ))}
                      </div>
                    </>
                  )}
                  {w.plan && w.content && (
                    <button
                      className="btn secondary"
                      disabled={locked}
                      onClick={() => goto(3)}
                    >
                      查看 / 手工完善规划
                    </button>
                  )}
                </section>
              ) : w.step === 3 && w.retryJobId ? (
                <section className="wizard-section">
                  <h3>重试明确失败项</h3>
                  <p>
                    沿用原任务的设计版本、参考图、提示词和输出规格；仅对失败图片重新报价。
                  </p>
                  {w.quote?.prompts.map((prompt, n) => (
                    <details key={n}>
                      <summary>失败图片{n + 1} · 原提示词</summary>
                      <p className="wizard-prompt-readonly">{prompt}</p>
                    </details>
                  ))}
                  <button className="btn secondary" onClick={w.cancelRetry}>
                    取消重试，返回当前规划
                  </button>
                </section>
              ) : w.step === 3 ? (
                <StylePlanEditor
                  w={w}
                  choices={choices}
                  disabled={locked || !!w.pending}
                  onPreview={setLarge}
                  onAdjust={() => { setMobile("settings"); goto(2); }}
                />
              ) : (
                <StylePlanResults
                  w={w}
                  onPreview={setLarge}
                  onContinue={continueImage}
                  onChanged={onChanged}
                />
              )}
            </main>
          </div>
          <footer className="style-workspace-footer wizard-footer">
            <button
              className="btn secondary"
              disabled={w.step === 1 || w.busy}
              onClick={() => goto(w.step - 1)}
            >
              上一步
            </button>
            <div className="wizard-footer-status">
              <span role="status">{status}</span>
              {w.saving && <small>正在保存…</small>}
              {w.error && (
                <p role="alert">
                  {w.error}
                  <button
                    className="btn secondary small"
                    onClick={() => w.setError("")}
                  >
                    知道了
                  </button>
                </p>
              )}
              {w.saveError && (
                <p role="alert">
                  {w.saveError}
                  <button
                    className="btn secondary small"
                    onClick={() => w.work(w.flush)}
                  >
                    重试保存
                  </button>
                  <button
                    className="btn secondary small"
                    onClick={w.openConflict}
                  >
                    查看并合并草稿
                  </button>
                </p>
              )}
            </div>
            {w.step === 3 && !w.quote && !w.quoteBusy && (
              <button
                className="btn secondary small"
                disabled={w.changed || locked}
                onClick={w.refreshQuote}
              >
                重新报价
              </button>
            )}
            <button
              className="btn primary wizard-primary"
              disabled={
                w.busy || (!w.pending && !w.pendingAnalysis && disabled)
              }
              onClick={primary}
            >
              {w.busy ? "处理中…" : mainLabel}
            </button>
          </footer>
        </>
      )}
      {w.estimate && (
        <StylePlanAnalysisConfirmation
          estimate={w.estimate}
          busy={w.busy || w.changed}
          onClose={() => w.setEstimate(null)}
          onConfirm={w.startAnalysis}
        />
      )}
      {w.conflict && (
        <StylePlanConflict
          conflict={w.conflict}
          busy={w.busy}
          onClose={w.closeConflict}
          onResolve={w.resolveConflict}
        />
      )}
      {large && (
        <OriginalImageViewer image={large} onClose={() => setLarge(null)} />
      )}
    </dialog>
  );
}
