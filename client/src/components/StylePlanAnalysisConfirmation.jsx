import { useEffect, useRef } from "react";
export default function StylePlanAnalysisConfirmation({
  estimate,
  busy,
  onClose,
  onConfirm,
}) {
  const ref = useRef(null);
  useEffect(() => {
    const dialog = ref.current,
      opener = document.activeElement;
    dialog.showModal();
    return () => {
      dialog.close();
      opener?.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className="wizard-analysis-confirmation"
      aria-label="确认商品分析费用"
      onCancel={(e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!busy) onClose();
      }}
    >
      <h3>确认商品分析</h3>
      <p>
        分析{estimate.count}张规划，预留{estimate.estimated_reserve}
        积分，按实际用量结算，未使用额度释放。
      </p>
      <p className="dim small">
        本次只分析并生成提示词，不生成图片。模型固定思考行为以所选模型为准。
      </p>
      <div className="wizard-inline">
        <button className="btn secondary" disabled={busy} onClick={onClose}>
          取消
        </button>
        <button className="btn primary" disabled={busy} onClick={onConfirm}>
          确认并分析
        </button>
      </div>
    </dialog>
  );
}
