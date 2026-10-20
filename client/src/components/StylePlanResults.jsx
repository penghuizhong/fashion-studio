import { useEffect, useState } from "react";
import { api } from "../api.js";
import { downloadOriginals } from "./downloadStudioImages.js";
import StudioImage from "./StudioImage.jsx";
import OriginalImageLink from "./OriginalImageLink.jsx";
import { useLifecycleActions, StateTabs } from "./StudioLifecycle.jsx";
const labels = {
  queued: "排队中",
  running: "生成中",
  succeeded: "成功",
  failed: "失败",
  uncertain: "结果待核对",
  interrupted: "已中断",
  partial: "部分完成",
};
export default function StylePlanResults({
  w,
  onPreview,
  onContinue,
  onChanged,
}) {
  const { job, content } = w,
    [history, setHistory] = useState(false),
    [batches, setBatches] = useState([]),
    [batchPage, setBatchPage] = useState(1),
    [batchTotal, setBatchTotal] = useState(0),
    [opened, setOpened] = useState({}),
    [rows, setRows] = useState([]),
    [page, setPage] = useState(1),
    [total, setTotal] = useState(0),
    [loading, setLoading] = useState(false),
    [state, setState] = useState("active"),
    [downloadState, setDownloadState] = useState(""),
    [checked, setChecked] = useState([]),
    [module, setModule] = useState("all");
  const lifecycle = useLifecycleActions({
    onChanged: async () => {
      w.refresh(w.versionId);
      onChanged?.();
      setPage(1);
      if (history) await fetchHistory(1);
    },
    showToast: w.setError,
  });
  const snapshot = job?.snapshot?.style,
    items = job?.renders || [];
  const moduleIds = [
    ...new Set(
      Object.values(snapshot?.item_contexts || {})
        .map((i) => i.module_id)
        .filter(Boolean),
    ),
  ];
  async function fetchHistory(p = 1) {
    setLoading(true);
    try {
      const r = await api.studio.workspaceItems(w.data.template.id, "images", {
        page: p,
        limit: 20,
        state,
        version_id: w.versionId,
      });
      setRows((old) => (p === 1 ? r.items : [...old, ...r.items]));
      setTotal(r.total);
      setPage(p);
    } catch (e) {
      w.setError(e.message);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    if (history) fetchHistory(1);
  }, [history, state, w.versionId]);
  const loadBatches = async (p = 1) => {
    try {
      const r = await api.studio.workspaceItems(w.data.template.id, "jobs", {
        page: p,
        limit: 20,
      });
      setBatches((old) => (p === 1 ? r.items : [...old, ...r.items]));
      setBatchPage(p);
      setBatchTotal(r.total);
    } catch (e) {
      w.setError(e.message);
    }
  };
  const retry = () => w.prepareRetry(job.id);
  const cover = (id) =>
    w.work(async () => {
      await api.studio.setCover(w.data.template.id, id);
      await w.refresh(w.versionId);
      onChanged?.();
    });
  const download = async () => {
    const files = items.filter(
      (i) =>
        checked.includes(i.item_id) && i.status === "succeeded" && i.image_path,
    );
    setDownloadState("正在打包模型原图…");
    try {
      const r = await downloadOriginals(files);
      setDownloadState(
        `已打包${r.count}张原图${r.failed ? `，${r.failed}张文件不可用，可单独重试` : ""}`,
      );
    } catch (e) {
      setDownloadState(e.message);
    }
  };
  const picture = (i, title, number) => {
    const id = i.generation_id || i.id;
    return (
      <article className="wizard-result-card" key={i.item_id || i.id}>
        <button
          className="wizard-result-image"
          disabled={i.image_available === false || !i.image_path}
          onClick={() => onPreview({ path: i.image_path, name: title })}
        >
          <StudioImage
            thumbnail={i.thumb_path}
            original={i.image_path}
            alt={title}
            loading="lazy"
          />
        </button>
        <strong>{title}</strong>
        <small>
          {labels[i.status] || "已生成"}
          {i.error ? ` · ${i.error}` : ""}
        </small>
        {i.image_path && (
          <>
            <label className="inline-check">
              <input
                type="checkbox"
                aria-label={`选择下载${title}`}
                checked={checked.includes(i.item_id)}
                onChange={(e) =>
                  setChecked((old) =>
                    e.target.checked
                      ? [...old, i.item_id]
                      : old.filter((k) => k !== i.item_id),
                  )
                }
                disabled={!i.item_id || i.image_available === false}
              />
              选择下载
            </label>
            <div className="wizard-inline">
              <OriginalImageLink path={i.image_path} />
              <button className="btn secondary small" onClick={() => cover(id)}>
                设为封面
              </button>
              <button
                className="btn secondary small"
                onClick={() => onContinue(i)}
              >
                以此继续衍生
              </button>
              {i.lifecycle === "trash" ? (
                <>
                  <button
                    className="btn secondary small"
                    onClick={() =>
                      lifecycle.perform("generations", { id }, "restore")
                    }
                  >
                    恢复
                  </button>
                  <button
                    className="btn secondary small"
                    onClick={() =>
                      lifecycle.perform("generations", { id }, "delete")
                    }
                  >
                    永久删除
                  </button>
                </>
              ) : (
                <>
                  <button
                    className="btn secondary small"
                    onClick={() =>
                      lifecycle.perform(
                        "generations",
                        { id },
                        i.lifecycle === "archived" ? "restore" : "archive",
                      )
                    }
                  >
                    {i.lifecycle === "archived" ? "恢复" : "归档"}
                  </button>
                  <button
                    className="btn secondary small"
                    onClick={() =>
                      lifecycle.perform("generations", { id }, "trash")
                    }
                  >
                    移到回收站
                  </button>
                </>
              )}
            </div>
          </>
        )}
      </article>
    );
  };
  return (
    <section className="wizard-results">
      <div className="wizard-section-head">
        <h3>
          当前结果
          {snapshot?.version_number ? ` · V${snapshot.version_number}` : ""}
        </h3>
        <span role="status">
          {job
            ? `${labels[job.status] || job.status} · 已结束${job.completed || 0}/${job.total || 0}张 · 成功${items.filter((i) => i.status === "succeeded").length}张`
            : "暂无生成任务"}
        </span>
      </div>
      {moduleIds.length > 0 && (
        <label className="style-field">
          筛选模块
          <select value={module} onChange={(e) => setModule(e.target.value)}>
            <option value="all">全部模块</option>
            {moduleIds.map((id) => (
              <option key={id} value={id}>
                {content?.items.find((i) => i.module_id === id)?.title || id}
              </option>
            ))}
          </select>
        </label>
      )}
      <div className="wizard-result-grid">
        {items
          .filter(
            (i) =>
              module === "all" ||
              snapshot?.item_contexts?.[i.proposal_idx]?.module_id === module,
          )
          .map((i, n) => {
            const context = snapshot?.item_contexts?.[i.proposal_idx];
            return i.status === "succeeded" ? (
              picture(i, context?.title || `图片${i.proposal_idx + 1}`, n)
            ) : (
              <article className="wizard-result-card pending" key={i.item_id}>
                <span className="wizard-status-mark" aria-hidden="true">
                  {i.status === "running" ? "◌" : "◇"}
                </span>
                <strong>{context?.title || `图片${i.proposal_idx + 1}`}</strong>
                <span>{labels[i.status] || i.status}</span>
                {i.error && <p>{i.error}</p>}
              </article>
            );
          })}
      </div>
      <div className="wizard-inline">
        {checked.length > 0 && (
          <button className="btn secondary" onClick={download}>
            下载所选原图（{checked.length}）
          </button>
        )}
        {items.some((i) => i.status === "failed") &&
          !["running", "queued"].includes(job?.status) && (
            <button className="btn secondary" onClick={retry}>
              仅重试明确失败项
            </button>
          )}
        {job && !["running", "queued"].includes(job.status) && (
          <button className="btn secondary" onClick={w.newRound}>
            新一轮生成
          </button>
        )}
      </div>
      {downloadState && <p role="status">{downloadState}</p>}
      {items.some((i) => i.status === "uncertain") && (
        <p className="dim small">
          待核对结果不会自动重发，请联系管理员核对供应商记录。
        </p>
      )}
      <details
        className="wizard-section"
        onToggle={(e) => {
          setHistory(e.currentTarget.open);
          if (e.currentTarget.open) loadBatches(1);
        }}
      >
        <summary>
          历史结果{" "}
          <span className="dim small">按设计版本查看，原图与历史批次保留</span>
        </summary>
        {batches
          .filter((b) => b.snapshot.style.version_id === w.versionId)
          .map((batch) => (
            <details
              className="wizard-section wizard-history-batch"
              key={batch.id}
              onToggle={(e) => {
                if (e.currentTarget.open && !opened[batch.id])
                  api.studio
                    .styleJob(w.data.template.id, batch.id)
                    .then((r) =>
                      setOpened((o) => ({ ...o, [batch.id]: r.job })),
                    )
                    .catch((e) => w.setError(e.message));
              }}
            >
              <summary>
                V{batch.snapshot.style.version_number} ·{" "}
                {new Date(batch.created_at).toLocaleString()} ·{" "}
                {labels[batch.status] || batch.status} · {batch.completed}/
                {batch.total}张
              </summary>
              {opened[batch.id] ? (
                <>
                  <p className="dim small">
                    规划修订
                    {opened[batch.id].snapshot.style.plan_revision ||
                      "历史未记录"}{" "}
                    · {opened[batch.id].snapshot.model.name} ·{" "}
                    {opened[batch.id].cost_actual}积分
                  </p>
                  <div className="wizard-result-grid">
                    {opened[batch.id].renders
                      .filter((i) => i.status === "succeeded")
                      .map((i) =>
                        picture(
                          i,
                          opened[batch.id].snapshot.style.item_contexts?.[
                            i.proposal_idx
                          ]?.title || `图片${i.proposal_idx + 1}`,
                        ),
                      )}
                  </div>
                  <button
                    className="btn secondary"
                    onClick={() => {
                      w.setJob(opened[batch.id]);
                      w.setStep(5);
                    }}
                  >
                    查看此批次
                  </button>
                </>
              ) : (
                <p role="status">加载批次结果…</p>
              )}
            </details>
          ))}
        {batchPage * 20 < batchTotal && (
          <button
            className="btn secondary small"
            onClick={() => loadBatches(batchPage + 1)}
          >
            更多生成批次
          </button>
        )}
        <h4>图片归档与回收站</h4>
        <StateTabs value={state} onChange={setState} />
        {loading && <p role="status">加载历史…</p>}
        <div className="wizard-result-grid">
          {rows.map((i) => picture(i, `历史图片 #${i.id}`))}
        </div>
        {page * 20 < total && (
          <button
            className="btn secondary"
            onClick={() => fetchHistory(page + 1)}
          >
            加载更多历史图片
          </button>
        )}
        {!loading && !rows.length && <p>此状态下暂无图片。</p>}
      </details>
      {lifecycle.modal}
    </section>
  );
}
