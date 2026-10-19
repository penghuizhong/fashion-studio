import StyleLayoutEditor from "./StyleLayoutEditor.jsx";
import { useEffect, useRef, useState, useCallback } from "react";
import { api } from "../api.js";
import { useAuth } from "../auth.jsx";
import { DEFAULT_CAMERA } from "../../../shared/photography.js";
import CameraSettings from "./CameraSettings.jsx";
import OriginalImageLink from "./OriginalImageLink.jsx";
import OriginalImageViewer from "./OriginalImageViewer.jsx";
import { fmtDnaValue } from "./DnaFields.js";
const parse = (s, f = {}) => {
  try {
    return JSON.parse(s);
  } catch {
    return f;
  }
};
const actions = [
  ["create", "生成基础图", "按已保存设计生成或参考图片重绘"],
  ["recolor", "换色", "指定部位与目标颜色，保存为新版本"],
  ["detail_modify", "改细节", "选择部位与添加、替换或移除"],
  ["detail_shot", "出细节图", "指定局部取景，AI 推演不代表真实工艺"],
  ["scene", "换场景", "保留服装，调整背景和展示环境"],
  ["variant", "再生成", "同条件再生成或探索呈现变化"],
];
const states = {
  running: "生成中",
  queued: "等待中",
  succeeded: "已完成",
  partial: "部分完成",
  uncertain: "结果待核对",
  failed: "失败",
  interrupted: "中断",
};
const defaultForm = {
  op: "create",
  mode: "text",
  source: "",
  model_id: "",
  size: "",
  count: 1,
  camera: { ...DEFAULT_CAMERA },
  visual_style: "product",
  purpose: "free",
  instruction: "",
  keep: "",
  references: [],
  consistent: true,
  explore_variation: false,
};
export default function StyleWorkspace({
  templateId,
  initialImage,
  initialPanel,
  onClose,
  onChanged,
  showToast,
}) {
  const { user, multiUser } = useAuth();
  const draftKey = `style-draft-v1:${multiUser ? user?.id || user?.username : "local"}:${templateId}`;
  const dialog = useRef(null),
    restored = useRef(false),
    saveRequest = useRef({ signature: "", key: "" });
  const [data, setData] = useState(null),
    [models, setModels] = useState([]),
    [presetFields, setFields] = useState([]),
    [references, setReferences] = useState([]),
    [assets, setAssets] = useState([]);
  const [versionId, setVersionId] = useState(null),
    [panel, setPanel] = useState(initialPanel || null),
    [tab, setTab] = useState(initialPanel || "derive");
  const [form, setForm] = useState({
      ...defaultForm,
      camera: { ...DEFAULT_CAMERA },
    }),
    [preview, setPreview] = useState(initialImage || null),
    [actual, setActual] = useState(false),
    [large, setLarge] = useState(null);
  const [draft, setDraft] = useState(null),
    [editParent, setEditParent] = useState(null),
    [part, setPart] = useState("primary_color"),
    [target, setTarget] = useState(""),
    [detailAction, setDetailAction] = useState("替换");
  const [deleteConfirm, setDeleteConfirm] = useState({ id: null, text: "" });
  const [notice, setNotice] = useState("");
  const notifiedJobs = useRef(new Map());
  const notify = (message) => {
    setNotice(message);
    showToast?.(message);
  };
  const [assist, setAssist] = useState(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [quote, setQuote] = useState(null),
    [quoteBusy, setQuoteBusy] = useState(false),
    [quoteNonce, setQuoteNonce] = useState(0),
    [requestKey, setRequestKey] = useState(""),
    [retryJob, setRetryJob] = useState(null);
  const [previewCollapsed, setPreviewCollapsed] = useState(false);
  const [compare, setCompare] = useState(false),
    [mobileCompare, setMobileCompare] = useState("after"),
    [closing, setClosing] = useState(false),
    [showArchived, setShowArchived] = useState(false),
    [showHistory, setShowHistory] = useState(true);
  const version = data?.versions.find((v) => v.id === versionId),
    dna = parse(version?.dna_json),
    editVersion = data?.versions.find((v) => v.id === editParent);
  const snapshotFields = parse(version?.schema_json, []);
  const schemaFields = snapshotFields.length ? snapshotFields : presetFields;
  const fields = [
    ...schemaFields.filter((f) => f.key in dna),
    ...Object.keys(dna)
      .filter((key) => !schemaFields.some((f) => f.key === key))
      .map((key) => ({ key, label: key })),
  ];
  const dirty =
    draft &&
    JSON.stringify(draft) !==
      JSON.stringify(
        Object.fromEntries(
          Object.entries(parse(editVersion?.dna_json)).map(([k, f]) => [
            k,
            Array.isArray(f.value) ? f.value.join("、") : String(f.value ?? ""),
          ]),
        ),
      );
  const active = data?.jobs.some((j) => j.status === "running");
  const fail = (e) => {
    setError(e.message || "操作失败");
  };
  const load = useCallback(async () => {
    const r = await api.studio.workspace(templateId);
    setData(r);
    setVersionId((id) =>
      id && r.versions.some((v) => v.id === id)
        ? id
        : r.template.work_version_id,
    );
    return r;
  }, [templateId]);
  useEffect(() => {
    const element = dialog.current,
      opener = document.activeElement,
      old = document.body.style.overflow;
    element.showModal();
    document.body.style.overflow = "hidden";
    return () => {
      element.close();
      document.body.style.overflow = old;
      opener?.focus();
    };
  }, []);
  useEffect(() => {
    let alive = true;
    Promise.all([
      api.studio.workspace(templateId),
      api.studio.imageModels(),
      api.studio.dnaPresets(),
      api.studio.references(),
      api.studio.assets({ limit: 100 }),
    ])
      .then(([r, m, p, refs, assets]) => {
        if (!alive) return;
        setData(r);
        setModels(m.models || []);
        setFields(
          p.presets?.find((p) => p.id === r.template.preset_id)?.fields || [],
        );
        setReferences(refs.references || []);
        setAssets(assets.assets || []);
        let saved;
        try {
          saved = parse(sessionStorage.getItem(draftKey), "");
        } catch {}
        if (saved && Date.now() - saved.savedAt < 86400000) {
          setVersionId(
            r.versions.some((v) => v.id === saved.versionId)
              ? saved.versionId
              : r.template.work_version_id,
          );
          setForm({ ...defaultForm, ...saved.form });
          if (r.versions.some((v) => v.id === saved.editParent)) {
            setDraft(saved.draft);
            setEditParent(saved.editParent);
          }
          setPreview(saved.preview || initialImage || null);
        } else {
          setVersionId(r.template.work_version_id);
          const model = m.models?.find((m) => m.price_per_call !== null);
          setForm((f) => ({
            ...f,
            model_id: model?.id || "",
            size: model?.sizes?.[0] || "",
          }));
        }
        restored.current = true;
      })
      .catch(fail);
    return () => {
      alive = false;
    };
  }, [templateId]);
  useEffect(() => {
    if (!restored.current) return;
    try {
      sessionStorage.setItem(
        draftKey,
        JSON.stringify({
          savedAt: Date.now(),
          versionId,
          form,
          draft,
          editParent,
          preview,
        }),
      );
    } catch {}
  }, [versionId, form, draft, editParent, preview]);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => load().catch(fail), 1500);
    return () => clearInterval(timer);
  }, [active, load]);
  useEffect(() => {
    if (!data) return;
    for (const j of data.jobs) {
      if (
        notifiedJobs.current.get(j.id) === "running" &&
        j.status !== "running"
      )
        notify(
          `${states[j.status] || j.status}：已处理 ${j.completed}/${j.total} 张，可查看最新任务结果`,
        );
      notifiedJobs.current.set(j.id, j.status);
    }
  }, [data?.jobs]);
  const signature = JSON.stringify({ versionId, ...form, retryJob, dirty });
  useEffect(() => {
    setQuote(null);
    setRequestKey("");
    if (
      !data ||
      !versionId ||
      !form.model_id ||
      !form.size ||
      dirty ||
      active ||
      tab !== "derive"
    )
      return;
    let alive = true;
    setQuoteBusy(true);
    const timer = setTimeout(async () => {
      try {
        const r = retryJob
          ? await api.studio.styleRetry(templateId, retryJob)
          : await api.studio.styleQuote(templateId, {
              ...form,
              version_id: versionId,
            });
        if (alive) {
          setQuote(r.quote);
          setRequestKey(crypto.randomUUID());
          setError("");
        }
      } catch (e) {
        if (alive) fail(e);
      } finally {
        if (alive) setQuoteBusy(false);
      }
    }, 400);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [signature, active, tab, quoteNonce, !!data]);
  useEffect(() => {
    if (!quote) return;
    const timer = setTimeout(
      () => {
        setQuote(null);
        setQuoteNonce((n) => n + 1);
      },
      Math.max(0, quote.expires_at - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [quote]);
  const update = (key, value) => {
    setRetryJob(null);
    setForm((f) => ({ ...f, [key]: value }));
  };
  const run = async (fn) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };
  const close = () => {
    if (dirty) {
      setClosing(true);
      return;
    }
    onClose();
  };
  const beginEdit = () => {
    setEditParent(versionId);
    setDraft(
      Object.fromEntries(
        Object.entries(dna).map(([k, f]) => [
          k,
          Array.isArray(f.value) ? f.value.join("、") : String(f.value ?? ""),
        ]),
      ),
    );
    setTab("attributes");
    setPanel("attributes");
  };
  const save = () =>
    run(async () => {
      const before = parse(editVersion.dna_json);
      const next = Object.fromEntries(
        Object.entries(draft).map(([k, value]) => [
          k,
          {
            ...before[k],
            value: Array.isArray(before[k]?.value)
              ? value
                  .split(/[、,，]/)
                  .map((v) => v.trim())
                  .filter(Boolean)
              : value,
          },
        ]),
      );
      const signature = JSON.stringify({ parent_id: editParent, dna: next });
      if (saveRequest.current.signature !== signature)
        saveRequest.current = { signature, key: crypto.randomUUID() };
      const r = await api.studio.saveVersion(templateId, {
        parent_id: editParent,
        dna: next,
        request_key: saveRequest.current.key,
      });
      await load();
      setVersionId(r.version.id);
      if (r.version.id !== editParent) setPreview(null);
      setDraft(null);
      setEditParent(null);
      notify(
        r.version.id === editParent
          ? "属性未变化，未创建新版本"
          : "已保存为设计版本，原版本和图片保持不变",
      );
    });
  const selectVersion = (id) => {
    setVersionId(Number(id));
    const image = data.images.find(
      (i) =>
        i.design_version_id === Number(id) &&
        !i.archived &&
        i.user_rating !== "deleted",
    );
    setPreview(image ? { ...image, path: image.image_path } : null);
    setCompare(false);
    setRetryJob(null);
  };
  const saveActionDesign = () =>
    run(async () => {
      if (dirty) throw new Error("请先保存或取消属性草稿");
      if (!target.trim()) throw new Error("请填写设计修改");
      const original = parse(version.dna_json),
        key = form.op === "recolor" ? part : "details";
      if (!(key in original))
        throw new Error("当前类目不支持此字段，请在款式属性中修改");
      let value = target.trim();
      if (key === "details") {
        const old = Array.isArray(original.details?.value)
          ? original.details.value
          : [];
        value =
          detailAction === "添加"
            ? [...old, value]
            : detailAction === "移除"
              ? old.filter((v) => v !== value)
              : value.split(/[、,，]/).filter(Boolean);
      }
      const next = { ...original, [key]: { ...original[key], value } };
      const sig = JSON.stringify({ parent_id: versionId, dna: next });
      if (saveRequest.current.signature !== sig)
        saveRequest.current = { signature: sig, key: crypto.randomUUID() };
      const r = await api.studio.saveVersion(templateId, {
        parent_id: versionId,
        dna: next,
        request_key: saveRequest.current.key,
      });
      if (r.version.id === versionId)
        throw new Error("本次修改没有产生属性变化，请调整目标");
      await load();
      setVersionId(r.version.id);
      update(
        "instruction",
        `${form.op === "recolor" ? fields.find((f) => f.key === part)?.label || part : detailAction + "细节"}：${target}`,
      );
      notify(`设计已保存为 V${r.version.number}，生成前请确认报价`);
      setTarget("");
    });
  const start = () =>
    run(async () => {
      if (!quote || dirty || active) return;
      const r = await api.studio.styleStart(templateId, {
        quote_id: quote.id,
        request_key: requestKey,
        confirm: true,
      });
      setData((d) => ({
        ...d,
        jobs: [r.job, ...d.jobs.filter((j) => j.id !== r.job.id)],
      }));
      setQuote(null);
      notify("生成任务已提交，关闭面板也会继续");
    });
  const chooseSource = (img) => {
    update("source", String(img.id));
    update("mode", "image");
    selectVersion(img.design_version_id || versionId);
    setPreview({ ...img, path: img.image_path });
    setTab("derive");
    setPanel("derive");
  };
  const upload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    await run(async () => {
      if (file.size > 15 * 1024 * 1024) throw new Error("图片不能超过 15MB");
      const base64 = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result.split(",")[1]);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      const r = await api.studio.uploadReference({ image_base64: base64 });
      setReferences((old) => [r, ...old]);
      notify("参考图已上传，请选择其用途后添加");
    });
    e.target.value = "";
  };
  const file = preview?.path || preview?.image_path;
  const previewVersionId =
    preview?.design_version_id ||
    data?.images.find((i) => i.image_path === file)?.design_version_id;
  const sourceImage =
    form.source === "original"
      ? data?.template.source_image_path
      : data?.images.find((i) => String(i.id) === form.source)?.image_path;
  const selectedModel = models.find((m) => m.id === form.model_id);
  const visibleImages =
    data?.images.filter(
      (i) =>
        (i.design_version_id === versionId || i.design_version_id == null) &&
        i.user_rating !== "deleted" &&
        (showArchived || !i.archived),
    ) || [];
  return (
    <dialog
      ref={dialog}
      className={`style-workspace${panel ? " has-panel" : ""}`}
      aria-label="款式详情"
      onCancel={(e) => {
        e.preventDefault();
        if (e.target === dialog.current) close();
      }}
    >
      <header className="style-workspace-head">
        <div>
          <strong>{data?.template.name || "款式详情"}</strong>
          {version && (
            <span className="tag">
              V{version.number} ·{" "}
              {version.status === "final" ? "已定稿" : "设计中"}
            </span>
          )}
        </div>
        <div className="style-toolbar">
          <OriginalImageLink path={file} />
          <button
            className="btn secondary small"
            onClick={() => {
              setPanel((p) => (p ? null : "derive"));
              if (!panel) setTab("derive");
            }}
          >
            {panel ? "收起面板" : "款式衍生"}
          </button>
          <button
            className="btn secondary small"
            onClick={() => {
              setPanel("attributes");
              setTab("attributes");
            }}
          >
            款式属性
          </button>
          <button
            className="icon-btn"
            aria-label="关闭款式详情"
            onClick={close}
          >
            ×
          </button>
        </div>
      </header>
      {!data ? (
        <div className="style-loading" role="status">
          正在加载款式…
          {error && (
            <p role="alert">
              {error}
              <button onClick={() => load().catch(fail)}>重试</button>
            </p>
          )}
        </div>
      ) : (
        <>
          <div className="style-workspace-main">
            <section
              className={`style-preview${actual ? " actual" : ""}${previewCollapsed ? " collapsed" : ""}`}
              aria-label="款式图片预览"
            >
              <div className="style-preview-toolbar">
                <button
                  className="btn secondary small style-collapse-preview"
                  onClick={() => setPreviewCollapsed((v) => !v)}
                >
                  {previewCollapsed ? "展开预览" : "收起预览"}
                </button>
                <span>
                  {file === data.template.source_image_path && file
                    ? "原始参考图"
                    : previewVersionId == null && file
                      ? "历史图片（属性版本未记录）"
                      : file
                        ? `图片所属版本：V${data.versions.find((v) => v.id === previewVersionId)?.number || version?.number}`
                        : `V${version?.number} 尚未生成图片`}
                </span>
                {file && (
                  <>
                    <button
                      className="btn secondary small style-actual-toggle"
                      onClick={() => setActual((a) => !a)}
                    >
                      {actual ? "适应窗口" : "实际尺寸"}
                    </button>
                    <button
                      className="btn secondary small"
                      onClick={() =>
                        setLarge({ path: file, name: data.template.name })
                      }
                    >
                      放大原图
                    </button>
                  </>
                )}
              </div>
              {compare && sourceImage && file ? (
                <>
                  <div className="style-mobile-compare">
                    <button onClick={() => setMobileCompare("before")}>
                      底图
                    </button>
                    <button onClick={() => setMobileCompare("after")}>
                      新图
                    </button>
                  </div>
                  <div className="style-comparison">
                    <figure
                      className={mobileCompare === "before" ? "selected" : ""}
                    >
                      <img src={`/${sourceImage}`} alt="本次底图" />
                      <figcaption>本次底图</figcaption>
                    </figure>
                    <figure
                      className={mobileCompare === "after" ? "selected" : ""}
                    >
                      <img src={`/${file}`} alt="生成结果" />
                      <figcaption>生成结果</figcaption>
                    </figure>
                  </div>
                </>
              ) : file ? (
                <div className="style-preview-image">
                  <img src={`/${file}`} alt={data.template.name} />
                </div>
              ) : (
                <div className="style-empty">
                  <p>此设计版本尚未生成图片</p>
                  {data.template.source_image_path && (
                    <button
                      className="btn secondary"
                      onClick={() =>
                        setPreview({ path: data.template.source_image_path })
                      }
                    >
                      查看原始参考图
                    </button>
                  )}
                </div>
              )}
              <div className="style-preview-footer">
                <span>
                  工作版本：V
                  {
                    data.versions.find(
                      (v) => v.id === data.template.work_version_id,
                    )?.number
                  }{" "}
                  · 展示图：
                  {data.template.cover_generation_id
                    ? `#${data.template.cover_generation_id} · ${data.images.find((i) => i.id === data.template.cover_generation_id)?.design_version_id ? "V" + data.versions.find((v) => v.id === data.images.find((i) => i.id === data.template.cover_generation_id)?.design_version_id)?.number : "历史属性未记录"}`
                    : "原始参考图"}
                </span>
                <span>预览不裁切 · 原图按需加载</span>
              </div>
            </section>
            {panel && (
              <aside className="style-panel">
                <nav aria-label="款式详情功能">
                  {[
                    ["derive", "款式衍生"],
                    ["attributes", "款式属性"],
                    ["versions", "版本记录"],
                    ["layout", "图文排版"],
                  ].map(([key, label]) => (
                    <button
                      key={key}
                      className={tab === key ? "active" : ""}
                      onClick={() => setTab(key)}
                    >
                      {label}
                    </button>
                  ))}
                </nav>
                <div className="style-panel-body">
                  <label className="style-field">
                    正在查看的设计版本
                    <select
                      aria-label="设计版本"
                      value={versionId || ""}
                      onChange={(e) => selectVersion(e.target.value)}
                    >
                      {data.versions.map((v) => (
                        <option key={v.id} value={v.id}>
                          V{v.number}
                          {v.parent_id
                            ? ` · 基于 V${data.versions.find((p) => p.id === v.parent_id)?.number}`
                            : ""}
                          {v.status === "final" ? " · 已定稿" : ""}
                        </option>
                      ))}
                    </select>
                  </label>
                  {notice && (
                    <p role="status" className="style-notice">
                      {notice}
                    </p>
                  )}
                  {error && (
                    <p role="alert" className="style-error">
                      {error}
                    </p>
                  )}
                  {dirty && (
                    <p role="status" className="style-notice">
                      有未保存属性，生成前请保存为新版本或取消修改。
                    </p>
                  )}
                  {tab === "attributes" && (
                    <>
                      <div className="style-section-title">
                        <h3>款式属性</h3>
                        {!draft && (
                          <button
                            className="btn secondary small"
                            onClick={beginEdit}
                          >
                            编辑属性
                          </button>
                        )}
                      </div>
                      {version.status === "final" && (
                        <p className="dim">
                          本版已定稿，编辑将创建新的设计版本，原版不变。
                        </p>
                      )}
                      {draft && editParent !== versionId && (
                        <p>
                          正在编辑 V{editVersion?.number}{" "}
                          的草稿，切换查看不会改变草稿来源。
                        </p>
                      )}
                      {["结构版型", "面料与配色", "风格与细节"].map(
                        (group, index) => (
                          <section
                            className="style-attribute-group"
                            key={group}
                          >
                            <h4>{group}</h4>
                            {fields
                              .filter((f) => {
                                const kind = /fabric|color|pattern/.test(f.key)
                                  ? 1
                                  : /style|scene|details/.test(f.key)
                                    ? 2
                                    : 0;
                                return kind === index;
                              })
                              .map((f) => (
                                <label className="style-field" key={f.key}>
                                  <span>
                                    {f.label}
                                    {dna[f.key]?.confirmed ? (
                                      <small> · 已人工确认</small>
                                    ) : dna[f.key]?.value == null ||
                                      dna[f.key]?.value === "" ? (
                                      <small> · 未填写</small>
                                    ) : Number(dna[f.key]?.confidence) <
                                      0.75 ? (
                                      <small> · 待核对</small>
                                    ) : null}
                                  </span>
                                  {draft ? (
                                    <textarea
                                      rows={f.key === "details" ? 3 : 1}
                                      maxLength={2000}
                                      aria-label={`属性${f.label}`}
                                      value={draft[f.key] || ""}
                                      onChange={(e) =>
                                        setDraft((d) => ({
                                          ...d,
                                          [f.key]: e.target.value,
                                        }))
                                      }
                                    />
                                  ) : (
                                    <span className="style-value">
                                      {fmtDnaValue(dna[f.key]?.value)}
                                    </span>
                                  )}
                                </label>
                              ))}
                          </section>
                        ),
                      )}
                      {draft && (
                        <div className="style-notice">
                          <strong>修改摘要</strong>
                          {Object.keys(draft)
                            .filter(
                              (k) =>
                                draft[k] !==
                                fmtDnaValue(
                                  parse(editVersion?.dna_json)[k]?.value,
                                ).replaceAll("、", "、"),
                            )
                            .map((k) => (
                              <p key={k}>
                                {fields.find((f) => f.key === k)?.label || k}：
                                {fmtDnaValue(
                                  parse(editVersion?.dna_json)[k]?.value,
                                )}{" "}
                                → {draft[k] || "未填写"}
                              </p>
                            ))}
                        </div>
                      )}
                      <details>
                        <summary>识别信息</summary>
                        <p>
                          识别置信度是模型估计，人工确认与其分开记录。旧数据未记录来源时无法还原人工确认历史。
                        </p>
                        {fields.map((f) => (
                          <p key={f.key}>
                            {f.label}：
                            {dna[f.key]?.confidence == null
                              ? "未记录"
                              : `${Math.round(dna[f.key].confidence * 100)}%`}
                          </p>
                        ))}
                      </details>
                    </>
                  )}
                  {tab === "derive" && (
                    <>
                      <h3>本次衍生</h3>
                      <div className="style-action-grid">
                        {actions.map(([op, label, desc]) => (
                          <button
                            key={op}
                            className={form.op === op ? "selected" : ""}
                            aria-pressed={form.op === op}
                            onClick={() => {
                              update("op", op);
                              update("instruction", "");
                              if (op !== "create") update("mode", "image");
                              if (op === "detail_shot")
                                update("camera", {
                                  ...form.camera,
                                  framing: "detail",
                                  detail: form.camera.detail || "",
                                });
                              else if (form.camera.framing === "detail")
                                update("camera", {
                                  ...form.camera,
                                  framing: "garment",
                                  detail: "",
                                });
                            }}
                          >
                            <strong>{label}</strong>
                            <small>{desc}</small>
                          </button>
                        ))}
                      </div>
                      <label className="style-field">
                        生成方式
                        <select
                          aria-label="生成方式"
                          value={form.mode}
                          onChange={(e) => update("mode", e.target.value)}
                        >
                          <option value="text" disabled={form.op !== "create"}>
                            按已保存属性生成
                          </option>
                          <option value="image">基于图片修改</option>
                        </select>
                      </label>
                      {form.mode === "image" && (
                        <label className="style-field">
                          本次衍生底图
                          <select
                            aria-label="本次衍生底图"
                            value={form.source}
                            onChange={(e) => update("source", e.target.value)}
                          >
                            <option value="">请选择，不自动使用最新图片</option>
                            {data.template.source_image_path && (
                              <option value="original">原始参考图</option>
                            )}
                            {data.images
                              .filter((i) => i.user_rating !== "deleted")
                              .map((i) => (
                                <option key={i.id} value={String(i.id)}>
                                  图片 #{i.id} ·{" "}
                                  {i.design_version_id
                                    ? `V${data.versions.find((v) => v.id === i.design_version_id)?.number}`
                                    : "历史属性未记录"}
                                </option>
                              ))}
                          </select>
                        </label>
                      )}
                      {["recolor", "detail_modify"].includes(form.op) && (
                        <div className="style-notice">
                          <h4>先保存设计变化</h4>
                          {form.op === "recolor" ? (
                            <label className="style-field">
                              颜色字段
                              <select
                                value={part}
                                onChange={(e) => setPart(e.target.value)}
                              >
                                {fields
                                  .filter((f) => /color/.test(f.key))
                                  .map((f) => (
                                    <option key={f.key} value={f.key}>
                                      {f.label}
                                    </option>
                                  ))}
                              </select>
                            </label>
                          ) : (
                            <label className="style-field">
                              细节操作
                              <select
                                value={detailAction}
                                onChange={(e) =>
                                  setDetailAction(e.target.value)
                                }
                              >
                                {["替换", "添加", "移除"].map((v) => (
                                  <option key={v}>{v}</option>
                                ))}
                              </select>
                            </label>
                          )}
                          <label className="style-field">
                            {form.op === "recolor"
                              ? "目标颜色（名称或色号）"
                              : "设计细节（写明部位）"}
                            <input
                              value={target}
                              onChange={(e) => setTarget(e.target.value)}
                              placeholder={
                                form.op === "recolor"
                                  ? "例如：衣身酒红色 #722F37"
                                  : "例如：左袖口添加双排扣"
                              }
                            />
                          </label>
                          <button
                            className="btn secondary"
                            onClick={saveActionDesign}
                            disabled={busy || !target.trim()}
                          >
                            保存变化为新版本
                          </button>
                        </div>
                      )}
                      <label className="style-field">
                        本次要求
                        <textarea
                          aria-label="本次要求"
                          readOnly={["recolor", "detail_modify"].includes(
                            form.op,
                          )}
                          rows={3}
                          maxLength={1200}
                          value={form.instruction}
                          onChange={(e) =>
                            update("instruction", e.target.value)
                          }
                          placeholder="例如：换成简洁的室内背景，服装配色和结构保持不变"
                        />
                      </label>
                      <button
                        className="btn secondary small"
                        onClick={() =>
                          setAssist(
                            `基于设计 V${version.number}，${fields
                              .slice(0, 6)
                              .map(
                                (f) =>
                                  `${f.label}：${fmtDnaValue(dna[f.key]?.value)}`,
                              )
                              .join(
                                "；",
                              )}。请按已选视角与取景呈现，保留未要求修改的服装结构。`,
                          )
                        }
                      >
                        从当前属性整理要求
                      </button>
                      {assist && (
                        <div className="style-notice">
                          <textarea
                            aria-label="要求建议"
                            value={assist}
                            onChange={(e) => setAssist(e.target.value)}
                          />
                          <p>
                            仅整理已保存属性，不调用模型；请确认后加入，不会覆盖原文。
                          </p>
                          <button
                            className="btn secondary"
                            onClick={() => {
                              update(
                                "instruction",
                                [form.instruction, assist]
                                  .filter(Boolean)
                                  .join("\n")
                                  .slice(0, 1200),
                              );
                              setAssist(null);
                            }}
                          >
                            追加到要求
                          </button>
                          <button onClick={() => setAssist(null)}>取消</button>
                        </div>
                      )}
                      <label className="style-field">
                        必须保留
                        <input
                          value={form.keep}
                          maxLength={1000}
                          onChange={(e) => update("keep", e.target.value)}
                          placeholder="例如：驳头、扣型、面料纹理"
                        />
                      </label>
                      {form.op === "variant" && (
                        <label>
                          <input
                            type="checkbox"
                            checked={form.explore_variation}
                            onChange={(e) =>
                              update("explore_variation", e.target.checked)
                            }
                          />
                          探索呈现变化（保留设计版本）
                        </label>
                      )}
                      <h3>图片呈现</h3>
                      <CameraSettings
                        value={form.camera}
                        onChange={(c) => update("camera", c)}
                      />
                      <label className="style-field">
                        出图用途
                        <select
                          value={form.purpose}
                          onChange={(e) => update("purpose", e.target.value)}
                        >
                          {[
                            ["free", "自由主图"],
                            ["white", "白底商品图"],
                            ["scene", "场景展示"],
                            ["detail", "细节特写"],
                          ].map(([v, l]) => (
                            <option key={v} value={v}>
                              {l}
                            </option>
                          ))}
                        </select>
                      </label>
                      <div className="style-preset-grid">
                        {[
                          ["auto", "自动推荐"],
                          ["preserve", "沿用底图"],
                          ["natural", "自然实拍"],
                          ["product", "商品展示"],
                          ["editorial", "品牌大片"],
                        ].map(([v, l]) => (
                          <button
                            className={
                              form.visual_style === v ? "selected" : ""
                            }
                            key={v}
                            aria-pressed={form.visual_style === v}
                            onClick={() => update("visual_style", v)}
                          >
                            <svg
                              aria-hidden="true"
                              viewBox="0 0 180 100"
                              className="presentation-sample"
                            >
                              <rect
                                width="180"
                                height="100"
                                rx="8"
                                fill={
                                  v === "editorial"
                                    ? "#36424e"
                                    : v === "natural"
                                      ? "#e6dcc9"
                                      : "#f1f1f1"
                                }
                              />
                              <circle
                                cx="145"
                                cy="22"
                                r="14"
                                fill={v === "natural" ? "#e8c886" : "#d7dfe5"}
                              />
                              <path
                                d="M69 18 L48 29 L36 74 L54 79 L64 48 L62 94 L118 94 L116 48 L126 79 L144 74 L132 29 L111 18 L90 30 Z"
                                fill={v === "editorial" ? "#b7c3cc" : "#3c5266"}
                              />
                              <path
                                d="M69 18 L90 61 L111 18 L90 30 Z"
                                fill="#263a4b"
                              />
                            </svg>
                            <strong>{l}</strong>
                            <small>
                              {
                                {
                                  auto: "按用途推荐呈现方式",
                                  preserve: "尽量沿用参考图表现",
                                  natural: "自然光线、适度修饰",
                                  product: "清晰展示服装结构",
                                  editorial: "强调光影与视觉氛围",
                                }[v]
                              }
                            </small>
                          </button>
                        ))}
                      </div>
                      <p className="dim small">
                        卡片为风格示意，并非当前款式的生成预览。视角与完整取景优先。
                      </p>
                      <div className="style-field">
                        套图约束
                        <label className="style-option">
                          <input
                            type="checkbox"
                            checked={form.consistent}
                            onChange={(e) =>
                              update("consistent", e.target.checked)
                            }
                          />
                          同批沿用设计、视角、风格及参考条件
                        </label>
                      </div>
                      <p className="dim small">
                        约束能减少漂移，但不能保证每张图片完全一致。
                      </p>
                      <details>
                        <summary>辅助参考图片</summary>
                        <p>
                          第一张底图定义服装。辅助图仅提供指定特征参考，实际效果取决于模型。当前模型
                          {selectedModel?.capabilities?.multi_reference
                            ? "支持"
                            : "未确认支持"}
                          多图参考。
                        </p>
                        <label className="style-field">
                          上传辅助图
                          <input
                            type="file"
                            accept="image/*"
                            onChange={upload}
                            disabled={busy}
                          />
                        </label>
                        <div className="style-reference-list">
                          {references.map((r) => (
                            <div key={r.id}>
                              <img src={`/${r.thumb_path}`} alt="辅助参考" />
                              <select
                                aria-label={`参考图${r.id}用途`}
                                value={
                                  form.references.find(
                                    (x) => x.source === `ref:${r.id}`,
                                  )?.role || ""
                                }
                                onChange={(e) =>
                                  update("references", [
                                    ...form.references.filter(
                                      (x) => x.source !== `ref:${r.id}`,
                                    ),
                                    ...(e.target.value
                                      ? [
                                          {
                                            source: `ref:${r.id}`,
                                            role: e.target.value,
                                          },
                                        ]
                                      : []),
                                  ])
                                }
                              >
                                <option value="">不使用</option>
                                {[
                                  ["color", "配色"],
                                  ["fabric", "面料"],
                                  ["detail", "细节"],
                                  ["presentation", "画面风格"],
                                ].map(([v, l]) => (
                                  <option key={v} value={v}>
                                    {l}
                                  </option>
                                ))}
                              </select>
                            </div>
                          ))}
                        </div>
                        <label className="style-field">
                          从资产库添加
                          <select
                            value=""
                            onChange={(e) => {
                              const generation_id = Number(e.target.value);
                              if (generation_id)
                                run(async () => {
                                  const r = await api.studio.uploadReference({
                                    generation_id,
                                  });
                                  setReferences((old) => [r, ...old]);
                                  update("references", [
                                    ...form.references,
                                    {
                                      source: `ref:${r.id}`,
                                      role: "presentation",
                                    },
                                  ]);
                                });
                            }}
                          >
                            <option value="">选择有权限的资产图片</option>
                            {assets
                              .filter((i) => i.user_rating !== "deleted")
                              .map((i) => (
                                <option key={i.id} value={i.id}>
                                  {i.template_name || "款式"} · 图片 #{i.id}
                                </option>
                              ))}
                          </select>
                        </label>
                        {form.references.map((r, i) => (
                          <p key={i}>
                            {r.source} · {r.role}
                            <button
                              onClick={() =>
                                update(
                                  "references",
                                  form.references.filter((_, n) => n !== i),
                                )
                              }
                            >
                              移除
                            </button>
                          </p>
                        ))}
                      </details>
                      <h3>模型与输出</h3>
                      <label className="style-field">
                        图片模型
                        <select
                          aria-label="款式图片模型"
                          value={form.model_id}
                          onChange={(e) => {
                            const m = models.find(
                              (m) => m.id === e.target.value,
                            );
                            update("model_id", e.target.value);
                            if (m?.sizes?.includes(form.size))
                              update("size", form.size);
                            else {
                              update("size", m?.sizes?.[0] || "");
                              notify(
                                "新模型不支持原尺寸，已调整尺寸，请重新确认报价",
                              );
                            }
                          }}
                        >
                          <option value="">请选择</option>
                          {models.map((m) => (
                            <option
                              key={m.id}
                              value={m.id}
                              disabled={
                                m.price_per_call === null ||
                                (form.mode === "image" &&
                                  !m.capabilities?.image_edit)
                              }
                            >
                              {m.provider_name} · {m.name} ·{" "}
                              {m.price_per_call ?? "未配置"} 积分/张
                              {m.capabilities?.image_edit ? " · 图片编辑" : ""}
                            </option>
                          ))}
                        </select>
                      </label>
                      {form.mode === "image" &&
                        !selectedModel?.capabilities?.image_edit && (
                          <p className="style-error">
                            当前模型未确认支持图片编辑，请更换模型或由管理员验证能力。
                          </p>
                        )}
                      <label className="style-field">
                        原生图片尺寸
                        <select
                          aria-label="款式图片尺寸"
                          value={form.size}
                          onChange={(e) => update("size", e.target.value)}
                        >
                          {selectedModel?.sizes.map((s) => (
                            <option key={s}>{s}</option>
                          ))}
                        </select>
                      </label>
                      <label className="style-field">
                        生成张数
                        <input
                          type="number"
                          aria-label="款式生成张数"
                          min={1}
                          max={16}
                          step={1}
                          value={form.count}
                          onChange={(e) =>
                            update("count", Number(e.target.value))
                          }
                        />
                      </label>
                      <p className="dim small">
                        不提供未经模型适配器验证的蒙版、参考强度或高清翻倍选项。原图完整保存，不做生成后强裁切。
                      </p>
                      {quote && (
                        <div className="style-notice">
                          <strong>生成确认</strong>
                          <p>
                            设计 V{quote.style?.version_number} ·{" "}
                            {actions.find((a) => a[0] === quote.style?.op)?.[1]}{" "}
                            ·{" "}
                            {quote.style?.source_generation_id
                              ? `底图 #${quote.style.source_generation_id}`
                              : quote.style?.source_path
                                ? "原始参考图"
                                : "按属性生成"}
                          </p>
                          <p>
                            {quote.style?.instruction || "沿用已保存设计"} ·{" "}
                            {quote.style?.camera?.view} /{" "}
                            {quote.style?.camera?.framing}
                          </p>
                          <p>
                            {quote.model.name} · {quote.size} ·{" "}
                            {quote.indexes.length} 张 · {quote.total} 积分
                          </p>
                        </div>
                      )}
                    </>
                  )}
                  {tab === "versions" && (
                    <>
                      <h3>设计版本</h3>
                      {data.versions.map((v) => (
                        <div className="style-version-row" key={v.id}>
                          <strong>
                            V{v.number}
                            {v.parent_id
                              ? ` ← V${data.versions.find((p) => p.id === v.parent_id)?.number}`
                              : ""}
                          </strong>
                          <span>
                            {v.status === "final" ? "已定稿" : "设计中"} ·{" "}
                            {v.created_at}
                          </span>
                          <p>
                            {Array.isArray(parse(v.summary, null))
                              ? parse(v.summary)
                                  .map(
                                    (c) =>
                                      `${fields.find((f) => f.key === c.key)?.label || c.key}：${fmtDnaValue(c.before)} → ${fmtDnaValue(c.after)}`,
                                  )
                                  .join("；")
                              : v.summary}
                          </p>
                          <button
                            className="btn secondary small"
                            onClick={() => selectVersion(v.id)}
                          >
                            查看版本
                          </button>
                        </div>
                      ))}
                      <button
                        className="btn secondary"
                        onClick={() =>
                          run(async () => {
                            await api.studio.setWorking(templateId, {
                              version_id: versionId,
                              expected_version_id:
                                data.template.work_version_id,
                            });
                            await load();
                            onChanged();
                          })
                        }
                      >
                        设为当前工作版本
                      </button>
                      <button
                        className="btn secondary"
                        onClick={() =>
                          run(async () => {
                            await api.studio.versionStatus(
                              templateId,
                              versionId,
                              version.status === "final" ? "draft" : "final",
                            );
                            await load();
                          })
                        }
                      >
                        {version.status === "final"
                          ? "取消本版定稿"
                          : "定稿此版本"}
                      </button>
                    </>
                  )}
                  {tab === "layout" && (
                    <StyleLayoutEditor
                      templateId={templateId}
                      versionId={versionId}
                      images={data.images}
                      layouts={data.layouts || []}
                      onSaved={load}
                      onSelectVersion={selectVersion}
                    />
                  )}
                  <section className="style-results">
                    <div className="style-section-title">
                      <h3>生成结果与历史</h3>
                      <button
                        className="btn secondary small"
                        onClick={() => setShowHistory((h) => !h)}
                      >
                        {showHistory ? "收起" : "展开"}
                      </button>
                    </div>
                    {showHistory && (
                      <>
                        <label>
                          <input
                            type="checkbox"
                            checked={showArchived}
                            onChange={(e) => setShowArchived(e.target.checked)}
                          />
                          显示归档
                        </label>
                        {data.jobs.map((j) => (
                          <details
                            className="style-job"
                            key={j.id}
                            open={j.status === "running"}
                          >
                            <summary>
                              {states[j.status] || j.status} · V
                              {j.snapshot.style?.version_number} · {j.completed}
                              /{j.total} · 已结算 {j.cost_actual} 积分
                            </summary>
                            <p>
                              {j.created_at} · {j.snapshot.model.name}
                            </p>
                            {j.renders.map((r) => (
                              <p key={r.proposal_idx}>
                                {r.proposal_idx + 1}：{states[r.status]}{" "}
                                {r.error}
                              </p>
                            ))}
                            {j.renders.some((r) => r.status === "failed") && (
                              <button
                                className="btn secondary small"
                                disabled={busy || active}
                                onClick={() => {
                                  setRetryJob(j.id);
                                  setTab("derive");
                                  notify(
                                    "已恢复原任务快照，确认新报价后重试明确失败项",
                                  );
                                }}
                              >
                                按原设置重试失败项
                              </button>
                            )}
                          </details>
                        ))}
                        <div className="style-result-grid">
                          {visibleImages.map((i) => (
                            <article key={i.id}>
                              <button
                                className="style-image-button"
                                onClick={() =>
                                  setPreview({ ...i, path: i.image_path })
                                }
                              >
                                <img
                                  src={`/${i.thumb_path || i.image_path}`}
                                  alt={`图片 ${i.id}`}
                                  loading="lazy"
                                />
                              </button>
                              <p>
                                #{i.id} ·{" "}
                                {i.design_version_id
                                  ? `V${data.versions.find((v) => v.id === i.design_version_id)?.number}`
                                  : "历史属性未记录"}
                                {data.template.cover_generation_id === i.id
                                  ? " · 展示图"
                                  : ""}
                                {i.archived ? " · 已归档" : ""}
                              </p>
                              <OriginalImageLink path={i.image_path} />
                              <button
                                className="btn secondary small"
                                onClick={() => {
                                  setPreview({ ...i, path: i.image_path });
                                  setCompare(true);
                                }}
                              >
                                与本次底图比较
                              </button>
                              <button
                                className="btn secondary small"
                                onClick={() => chooseSource(i)}
                              >
                                以此继续衍生
                              </button>
                              <details>
                                <summary>更多操作</summary>
                                <button
                                  onClick={() =>
                                    run(async () => {
                                      await api.studio.setCover(
                                        templateId,
                                        i.id,
                                      );
                                      await load();
                                      onChanged();
                                    })
                                  }
                                >
                                  设为展示图
                                </button>
                                <button
                                  onClick={() =>
                                    run(async () => {
                                      await api.studio.archiveImage(
                                        i.id,
                                        !i.archived,
                                      );
                                      await load();
                                    })
                                  }
                                >
                                  {i.archived ? "恢复归档" : "归档（保留原图）"}
                                </button>
                                <button
                                  onClick={() =>
                                    run(async () => {
                                      await api.studio.forkStyle(templateId, {
                                        version_id:
                                          i.design_version_id || versionId,
                                        generation_id: i.id,
                                      });
                                      onChanged();
                                      notify("已另存为新款式");
                                    })
                                  }
                                >
                                  另存新款式
                                </button>
                                {i.archived && (
                                  <div>
                                    <input
                                      aria-label={`永久删除确认${i.id}`}
                                      placeholder="输入永久删除"
                                      value={
                                        deleteConfirm.id === i.id
                                          ? deleteConfirm.text
                                          : ""
                                      }
                                      onChange={(e) =>
                                        setDeleteConfirm({
                                          id: i.id,
                                          text: e.target.value,
                                        })
                                      }
                                    />
                                    <button
                                      disabled={
                                        busy ||
                                        deleteConfirm.id !== i.id ||
                                        deleteConfirm.text !== "永久删除"
                                      }
                                      onClick={() =>
                                        run(async () => {
                                          await api.studio.permanentDelete(
                                            i.id,
                                            deleteConfirm.text,
                                          );
                                          await load();
                                          setDeleteConfirm({
                                            id: null,
                                            text: "",
                                          });
                                          notify("已永久删除未被引用的图片");
                                        })
                                      }
                                    >
                                      永久删除原文件
                                    </button>
                                  </div>
                                )}
                                <details>
                                  <summary>生成参数</summary>
                                  <pre>
                                    {JSON.stringify(
                                      parse(i.settings_json),
                                      null,
                                      2,
                                    )}
                                  </pre>
                                </details>
                              </details>
                            </article>
                          ))}
                        </div>
                        {!visibleImages.length && <p>此版本暂无生成结果。</p>}
                      </>
                    )}
                  </section>
                </div>
              </aside>
            )}
          </div>
          <footer className="style-workspace-footer">
            {!closing && !draft && data.jobs.length > 0 && panel && (
              <button
                className="btn secondary"
                onClick={() => {
                  const latest = data.jobs[0];
                  setVersionId(latest.snapshot.style.version_id);
                  setTab("derive");
                  setPanel("derive");
                  requestAnimationFrame(() =>
                    dialog.current
                      .querySelector(".style-results")
                      ?.scrollIntoView({ block: "start" }),
                  );
                }}
              >
                查看最新任务结果
              </button>
            )}
            {closing ? (
              <>
                <span>有未保存的修改，草稿仍会保留在此浏览器标签页。</span>
                <button
                  className="btn secondary"
                  onClick={() => setClosing(false)}
                >
                  继续编辑
                </button>
                <button className="btn secondary" onClick={onClose}>
                  保留草稿并关闭
                </button>
                <button
                  className="btn secondary"
                  onClick={() => {
                    try {
                      sessionStorage.removeItem(draftKey);
                    } catch {}
                    onClose();
                  }}
                >
                  放弃草稿并关闭
                </button>
              </>
            ) : draft ? (
              <>
                <span>基于 V{editVersion?.number} 的属性草稿</span>
                <button
                  className="btn secondary"
                  onClick={() => {
                    setDraft(null);
                    setEditParent(null);
                  }}
                >
                  取消修改
                </button>
                <button
                  className="btn primary"
                  disabled={busy || !dirty}
                  onClick={save}
                >
                  保存为新版本
                </button>
              </>
            ) : tab === "derive" && panel ? (
              <>
                <span role="status">
                  {active
                    ? `生成中 ${data.jobs.find((j) => j.status === "running")?.completed || 0}/${data.jobs.find((j) => j.status === "running")?.total || 0}，可安全关闭`
                    : quoteBusy
                      ? "正在更新报价…"
                      : quote
                        ? `${quote.indexes.length} 张 · 预计 ${quote.total} 积分`
                        : "请完成生成设置"}
                </span>
                {!quote && !quoteBusy && (
                  <button
                    className="btn secondary"
                    onClick={() => setQuoteNonce((n) => n + 1)}
                  >
                    重新报价
                  </button>
                )}
                <button
                  className="btn primary"
                  disabled={
                    busy || active || quoteBusy || !quote || !!target.trim()
                  }
                  onClick={start}
                >
                  确认费用并生成
                </button>
              </>
            ) : (
              <span>
                查看历史不会修改当前款式 · 新结果默认保留，不自动设为封面
              </span>
            )}
          </footer>
        </>
      )}
      {large && (
        <OriginalImageViewer image={large} onClose={() => setLarge(null)} />
      )}
    </dialog>
  );
}
