// 记忆事实列表（v1.11）：只读展示 + 可删除
import { useEffect, useState } from 'react';
import { api, formatFullTime } from '../api.js';
import Icon from './icons.jsx';

function importanceStyle(n) {
  if (n >= 5) return { label: '很重要', cls: 'imp-5' };
  if (n === 4) return { label: '重要', cls: 'imp-4' };
  if (n === 3) return { label: '一般', cls: 'imp-3' };
  return { label: '细节', cls: 'imp-low' };
}

export default function MemoryFacts({ characterId, showToast }) {
  const [facts, setFacts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [deletingId, setDeletingId] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const list = await api.getFacts(characterId);
        if (!cancelled) setFacts(Array.isArray(list) ? list : []);
      } catch (err) {
        if (!cancelled) showToast(err.message || '加载记忆失败');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [characterId]);

  const removeFact = async (f) => {
    if (!window.confirm(`确定删除这条记忆吗？\n「${(f.fact || '').slice(0, 40)}${(f.fact || '').length > 40 ? '…' : ''}」`)) return;
    setDeletingId(f.id);
    try {
      await api.deleteFact(f.id);
      setFacts((prev) => prev.filter((x) => x.id !== f.id));
      showToast('已删除');
    } catch (err) {
      showToast(err.message || '删除失败');
    } finally {
      setDeletingId(null);
    }
  };

  if (loading) return <div className="facts-loading">加载中…</div>;

  return (
    <div className="facts-wrap">
      <div className="facts-hint">
        共 {facts.length} 条 · AI 在聊天中自动记录，相关时才会注入对话
      </div>
      {facts.length === 0 ? (
        <div className="facts-empty">
          <div className="facts-empty-title">还没有记忆条目</div>
          <div className="facts-empty-sub">和 AI 聊天时，重要的事会自动记在这里</div>
        </div>
      ) : (
        <div className="facts-list">
          {facts.map((f) => {
            const imp = importanceStyle(Number(f.importance) || 3);
            return (
              <div key={f.id} className="fact-item">
                <div className="fact-main">
                  <div className="fact-text">{f.fact}</div>
                  <div className="fact-meta">
                    <span className={`fact-imp ${imp.cls}`}>{imp.label}</span>
                    <span className="fact-time">{formatFullTime(f.created_at)}</span>
                  </div>
                </div>
                <button
                  className="fact-del"
                  title="删除这条记忆"
                  disabled={deletingId === f.id}
                  onClick={() => removeFact(f)}
                >
                  <Icon name="trash" size={16} />
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
