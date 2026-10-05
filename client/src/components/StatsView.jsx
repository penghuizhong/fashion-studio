// 用量统计（管理员）：总览 / 30天趋势 / 模型分布 / 消费排行
import { useEffect, useState } from 'react';
import { api } from '../api.js';

function TrendChart({ data }) {
  const W = 640;
  const H = 200;
  const P = 30;
  if (!data.length) return <p className="key-desc small">暂无数据</p>;
  const max = Math.max(1, ...data.map((d) => d.consumed));
  const n = data.length;
  const xs = (i) => P + (n === 1 ? 0 : (i / (n - 1)) * (W - 2 * P));
  const ys = (v) => H - P - (v / max) * (H - 2 * P);
  const line = data.map((d, i) => `${i ? 'L' : 'M'}${xs(i).toFixed(1)},${ys(d.consumed).toFixed(1)}`).join(' ');
  const area = `${line} L${xs(n - 1).toFixed(1)},${H - P} L${xs(0).toFixed(1)},${H - P} Z`;
  // x 轴日期标签：最多 6 个
  const step = Math.max(1, Math.floor(n / 6));
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="trend-chart" role="img">
      {[0.25, 0.5, 0.75, 1].map((f) => (
        <line
          key={f}
          x1={P}
          x2={W - P}
          y1={ys(max * f)}
          y2={ys(max * f)}
          stroke="var(--border)"
          strokeWidth="1"
        />
      ))}
      <path d={area} fill="#5b8def" opacity="0.15" />
      <path d={line} fill="none" stroke="#5b8def" strokeWidth="2.5" strokeLinejoin="round" />
      {data.map((d, i) =>
        i % step === 0 ? (
          <text
            key={d.day}
            x={xs(i)}
            y={H - 8}
            fontSize="11"
            fill="var(--text-secondary)"
            textAnchor="middle"
          >
            {d.day.slice(5)}
          </text>
        ) : null
      )}
      <text x={P} y={18} fontSize="11" fill="var(--text-secondary)">
        max {max}
      </text>
    </svg>
  );
}

export default function StatsView({ onOpenSidebar, showToast }) {
  const [overview, setOverview] = useState(null);
  const [daily, setDaily] = useState([]);
  const [models, setModels] = useState([]);
  const [topUsers, setTopUsers] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [ov, da, mo, tu] = await Promise.all([
          api.adminStatsOverview(),
          api.adminStatsDaily(30),
          api.adminStatsModels(),
          api.adminStatsTopUsers(10),
        ]);
        if (cancelled) return;
        setOverview(ov);
        setDaily(da || []);
        setModels(mo || []);
        setTopUsers(tu || []);
      } catch (e) {
        showToast((e && e.message) || '读取统计失败', 2600);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const maxModelPts = Math.max(1, ...models.map((m) => m.points));

  return (
    <div className="page stats-page">
      <div className="page-head">
        <button className="menu-btn" onClick={onOpenSidebar} title="菜单">
          ☰
        </button>
        <h2>用量统计</h2>
      </div>

      <div className="page-body">
        {loading ? (
          <p className="key-desc">加载中…</p>
        ) : (
          <>
            <section className="stat-cards">
              <div className="stat-card">
                <div className="stat-num">{overview ? overview.totalUsers : '…'}</div>
                <div className="stat-label">总用户</div>
              </div>
              <div className="stat-card">
                <div className="stat-num">{overview ? overview.totalConsumed : '…'}</div>
                <div className="stat-label">累计消耗积分</div>
              </div>
              <div className="stat-card">
                <div className="stat-num">{overview ? overview.totalBalance : '…'}</div>
                <div className="stat-label">用户剩余积分</div>
              </div>
              <div className="stat-card">
                <div className="stat-num">${overview ? overview.estCostUsd : '…'}</div>
                <div className="stat-label">平台花费估算</div>
              </div>
              <div className="stat-card">
                <div className="stat-num">{overview ? overview.todayConsumed : '…'}</div>
                <div className="stat-label">今日消耗</div>
              </div>
              <div className="stat-card">
                <div className="stat-num">{overview ? overview.todayActiveUsers : '…'}</div>
                <div className="stat-label">今日活跃用户</div>
              </div>
            </section>

            <section className="card">
              <div className="card-title">30 天积分消耗趋势</div>
              <TrendChart data={daily} />
            </section>

            <section className="card">
              <div className="card-title">模型分布</div>
              {models.length ? (
                <div className="model-bars">
                  {models.map((m) => (
                    <div className="model-bar-row" key={m.model}>
                      <span className="model-bar-name" title={m.model}>
                        {m.model}
                      </span>
                      <div className="model-bar-track">
                        <div
                          className="model-bar-fill"
                          style={{ width: `${Math.max(2, (m.points / maxModelPts) * 100)}%` }}
                        />
                      </div>
                      <span className="model-bar-val">
                        {m.points} 积分 · {m.calls} 次
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="key-desc small">暂无数据</p>
              )}
            </section>

            <section className="card">
              <div className="card-title">消费 Top 10</div>
              {topUsers.length ? (
                <table className="stat-table">
                  <thead>
                    <tr>
                      <th>用户</th>
                      <th>消耗</th>
                      <th>获赠</th>
                      <th>余额</th>
                    </tr>
                  </thead>
                  <tbody>
                    {topUsers.map((u) => (
                      <tr key={u.username}>
                        <td>{u.username}</td>
                        <td>{u.consumed}</td>
                        <td>{u.granted}</td>
                        <td>{u.balance}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <p className="key-desc small">暂无数据</p>
              )}
            </section>
          </>
        )}
      </div>
    </div>
  );
}
