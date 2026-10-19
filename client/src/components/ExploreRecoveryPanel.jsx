import { useEffect, useState } from 'react';
import { api } from '../api.js';

export default function ExploreRecoveryPanel({ showToast }) {
  const [items, setItems] = useState([]),
    [notes, setNotes] = useState({}),
    [busy, setBusy] = useState(false);
  const load = async () => {
    try {
      const r = await api.studio.exploreRecovery();
      setItems(r.items || []);
    } catch (e) {
      showToast(e.message);
    }
  };
  useEffect(() => {
    load();
  }, []);
  const resolve = async (item) => {
    const note = (notes[item.id] || '').trim();
    if (note.length < 10) {
      showToast('请先核对供应商结果，填写至少 10 字处理依据');
      return;
    }
    if (
      !window.confirm(
        item.type === 'legacy'
          ? '确认已核对旧版生成请求？本操作仅恢复批次状态，不自动变更旧版账本。'
          : '请确认已核对供应商且无法恢复结果。本操作将退回预留额度并允许重新生成；上游可能已产生的费用由平台承担。'
      )
    )
      return;
    setBusy(true);
    try {
      await api.studio.exploreResolve(item.type, item.id, {
        confirmed_failed: true,
        note,
      });
      showToast('已记录处理依据并退回额度');
      await load();
    } catch (e) {
      showToast(e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section style={{ marginTop: 24 }}>
      <div className="card-title">
        创意任务费用核对{' '}
        <button className="btn secondary small" disabled={busy} onClick={load}>
          刷新
        </button>
      </div>
      <p className="small dim">
        中断请求可能已在供应商完成。先核对供应商记录，再处理；系统不会自动重发。每次最多显示
        100 个图片任务和 100 个发散任务。
      </p>
      {!items.length && <p className="small dim">暂无待核对任务。</p>}
      {items.map((item) => (
        <div key={item.id} className="card" style={{ marginBottom: 12 }}>
          <p>
            {item.type === 'image'
              ? '图片生成'
              : item.type === 'legacy'
                ? '旧版生成批次'
                : '创意发散'}{' '}
            · 预留 {item.reserved} 积分
          </p>
          <p className="small dim">
            用户 {item.user_id} · 任务 {item.id}
            {item.seed !== undefined ? ` · seed ${item.seed}` : ''}
          </p>
          {item.prompt && (
            <details>
              <summary>查看提示词</summary>
              <p>{item.prompt}</p>
            </details>
          )}
          <label>
            核对依据
            <textarea
              className="text-input"
              rows={2}
              value={notes[item.id] || ''}
              maxLength={1000}
              onChange={(e) =>
                setNotes((n) => ({ ...n, [item.id]: e.target.value }))
              }
            />
          </label>
          <button
            className="btn secondary"
            disabled={busy}
            onClick={() => resolve(item)}
          >
            {item.type === 'legacy' ? '核对后恢复批次' : '核对后退款并允许重试'}
          </button>
        </div>
      ))}
    </section>
  );
}
