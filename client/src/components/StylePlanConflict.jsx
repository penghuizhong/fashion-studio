import { useEffect, useRef } from "react";
import { mergeStylePlanDrafts } from "./mergeStylePlanDrafts.js";
export default function StylePlanConflict({
  conflict,
  busy,
  onResolve,
  onClose,
}) {
  const ref = useRef(null),
    result = mergeStylePlanDrafts(
      conflict.base,
      conflict.local,
      conflict.remote,
    );
  useEffect(() => {
    const dialog = ref.current;
    dialog.showModal();
    return () => dialog.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className="wizard-conflict-dialog"
      aria-label="合并规划草稿"
      onCancel={(e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!busy) onClose();
      }}
    >
      <h3>规划已在其他窗口更新</h3>
      <p>本机草稿已另存。合并会保留服务器上未被本机修改的字段。</p>
      {result.conflicts.length ? (
        <>
          <p>
            以下{result.conflicts.length}
            处同时修改，请选择冲突内容以哪一方为准。
          </p>
          {result.conflicts.map((c, n) => (
            <section className="wizard-section" key={n}>
              <strong>{c.path}</strong>
              <div className="wizard-conflict-values">
                <p>本机：{JSON.stringify(c.local) ?? "已移除"}</p>
                <p>服务器：{JSON.stringify(c.remote) ?? "已移除"}</p>
              </div>
            </section>
          ))}
        </>
      ) : (
        <p>未发现同字段冲突，可以合并双方修改。</p>
      )}
      <div className="wizard-inline">
        <button className="btn secondary" disabled={busy} onClick={onClose}>
          继续保留草稿
        </button>
        <button
          className="btn secondary"
          disabled={busy}
          onClick={() => onResolve("remote")}
        >
          冲突以服务器为准并合并
        </button>
        <button
          className="btn primary"
          disabled={busy}
          onClick={() => onResolve("local")}
        >
          {result.conflicts.length ? "冲突以本机为准并合并" : "合并双方修改"}
        </button>
      </div>
    </dialog>
  );
}
