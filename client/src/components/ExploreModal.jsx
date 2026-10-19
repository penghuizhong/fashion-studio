// 创意衍生：发散 → 筛选 → 渲染设置 → 结果收卡，支持历史恢复
// P5: 类目预设动态字段（废弃旧 11 字段定死）
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import Icon from './icons.jsx';
import { fmtDnaValue } from './DnaFields.js';

const imgUrl = (p) => (p ? `/${p}` : '');

function DnaCard({ dna, rationale, checked, onToggle, fields }) {
  const list = Array.isArray(fields) && fields.length ? fields : [];
  return (
    <div
      className={`explore-dna-card${checked ? ' checked' : ''}`}
      onClick={onToggle}
    >
      <label className="explore-check" onClick={e=>e.stopPropagation()}>
        <input
          type="checkbox"
          checked={!!checked}
          onChange={onToggle}
          onClick={(e) => e.stopPropagation()}
        />
      </label>
      <div className="explore-dna-fields">
        {list.map(({ key, label }) => {
          const f = (dna || {})[key] || {};
          const low =
            Number(f.confidence) < 0.75 && f.value !== '' && f.value != null;
          return (
            <div className="explore-dna-row" key={key}>
              <span className="dim">{label}</span>
              <span className={low ? 'low-conf' : ''}>
                {fmtDnaValue(f.value)}
              </span>
            </div>
          );
        })}
      </div>
      {rationale && <div className="explore-rationale">{rationale}</div>}
    </div>
  );
}

const defaultAxes = (fields) => {
  const keys = fields.map((f) => f.key),
    prefer = [
      'silhouette',
      'fabric',
      'style',
      'details',
      'scene',
      'pattern',
      'collar',
      'neckline',
    ];
  return [
    ...new Set([...prefer.filter((k) => keys.includes(k)), ...keys]),
  ].slice(0, 5);
};
const json = (s, fallback) => {
  try {
    return JSON.parse(s);
  } catch {
    return fallback;
  }
};
const modelName = (m) =>
  `${m.provider_name || '供应商'} · ${m.name || m.model_id}`;
const stateName = (s) =>
  ({
    queued: '等待中',
    running: '生成中',
    succeeded: '已完成',
    failed: '失败',
    uncertain: '结果待确认',
    interrupted: '已中断',
    partial: '部分完成',
    rendering: '生成中',
    rendered: '已生成',
    expanded: '已发散',
    selected: '已筛选',
    adopted: '已收卡',
  })[s] || s;
export default function ExploreModal({ onClose, onAdopt, showToast }) {
  const [tab, setTab] = useState('new'),
    [step, setStep] = useState('intent');
  const [presets, setPresets] = useState([]),
    [presetId, setPresetId] = useState(''),
    [intent, setIntent] = useState('');
  const [axes, setAxes] = useState([]),
    [count, setCount] = useState(6),
    [locked, setLocked] = useState({});
  const [expandModels, setExpandModels] = useState([]),
    [expandId, setExpandId] = useState('');
  const [imgModels, setImgModels] = useState([]),
    [renderId, setRenderId] = useState(''),
    [size, setSize] = useState('');
  const [batch, setBatch] = useState(null),
    [selected, setSelected] = useState([]),
    [job, setJob] = useState(null),
    [jobs, setJobs] = useState([]);
  const [quote, setQuote] = useState(null),
    [requestKey, setRequestKey] = useState(''),
    [adoptSel, setAdoptSel] = useState([]);
  const expansionRequest = useRef({ signature: '', key: '' });
  const [retrySource, setRetrySource] = useState(null),
    [moreHistory, setMoreHistory] = useState(false);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [batches, setBatches] = useState([]),
    [loading, setLoading] = useState(true);
  const preset = presets.find((p) => p.id === presetId),
    fields = batch?.snapshot?.preset?.fields || preset?.fields || [];
  const proposals = batch?.proposals || [],
    images = job?.renders || [],
    active = job?.status === 'running';
  const selectedModel = imgModels.find((m) => m.id === renderId);
  const fail = (e) => {
    const msg =
      (e.message || '请求失败') +
      (e.requestId ? `（请求编号 ${e.requestId}）` : '');
    setError(msg);
    showToast(msg);
  };
  const loadInitial = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [p, m] = await Promise.all([
        api.studio.dnaPresets(),
        api.studio.exploreModels(),
      ]);
      setPresets(p.presets || []);
      setExpandModels(m.models || []);
      setExpandId(m.recommended_id || m.models?.[0]?.id || '');
      if (p.presets?.length) {
        setPresetId(p.presets[0].id);
        setAxes(defaultAxes(p.presets[0].fields));
      }
    } catch (e) {
      fail(e);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    loadInitial();
  }, [loadInitial]);
  useEffect(() => {
    if (step !== 'render') return;
    let alive = true;
    api.studio
      .imageModels()
      .then((r) => {
        if (!alive) return;
        setImgModels(r.models || []);
        const m =
          (r.models || []).find((x) => x.id === renderId) ||
          (r.models || []).find((x) => x.price_per_call !== null);
        setRenderId(m?.id || '');
        setSize(previous=>m?.sizes?.includes(previous)?previous:m?.sizes?.[0] || '');
      })
      .catch(fail);
    return () => {
      alive = false;
    };
  }, [step]);
  useEffect(() => {
    setQuote(null);
    setRequestKey('');
  }, [renderId, size, selected.join(',')]);
  useEffect(() => {
    if (tab !== 'history') return;
    api.studio
      .exploreList()
      .then((r) => {
        setBatches(r.batches || []);
        setMoreHistory((r.batches || []).length === 20);
      })
      .catch(fail);
  }, [tab]);
  useEffect(() => {
    if (!active || !batch) return;
    let alive = true;
    const poll = async () => {
      try {
        const r = await api.studio.exploreJobs(batch.id);
        if (!alive) return;
        setJobs(r.jobs || []);
        const current = r.jobs.find((j) => j.id === job.id);
        if (current) {
          setJob(current);
          if (current.status !== 'running')
            setAdoptSel(
              current.renders
                .filter((x) => x.status === 'succeeded')
                .map((x) => x.proposal_idx)
            );
        }
      } catch (e) {
        if (alive) fail(e);
      }
    };
    const timer = setInterval(poll, 1500);
    poll();
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [active, batch?.id, job?.id]);
  const changePreset = (id) => {
    const p = presets.find((x) => x.id === id);
    setPresetId(id);
    setAxes(defaultAxes(p?.fields || []));
    setLocked({});
  };
  const startExplore = async () => {
    setBusy(true);
    setError('');
    try {
      const locked_fields = Object.fromEntries(
        Object.entries(locked)
          .filter(([, v]) => v.trim())
          .map(([k, v]) => [
            k,
            k === 'details'
              ? v
                  .split(/[、,，]/)
                  .map((x) => x.trim())
                  .filter(Boolean)
              : v.trim(),
          ])
      );
      const params = {
        intent_text: intent,
        axes,
        count,
        preset_id: presetId,
        expand_model_id: expandId,
        locked_fields,
      };
      const signature = JSON.stringify(params);
      if (expansionRequest.current.signature !== signature)
        expansionRequest.current = { signature, key: crypto.randomUUID() };
      const r = await api.studio.exploreCreate({
        ...params,
        request_key: expansionRequest.current.key,
      });
      setRetrySource(null);
      setBatch(r);
      setSelected(r.proposals.map((_, i) => i));
      setJob(null);
      setJobs([]);
      setQuote(null);
      setStep('proposals');
    } catch (e) {
      fail(e);
      if (e.code && !['RESULT_UNCERTAIN', 'EXPANSION_EXISTS'].includes(e.code))
        expansionRequest.current = { signature: '', key: '' };
    } finally {
      setBusy(false);
    }
  };
  const loadBatch = async (id) => {
    setBusy(true);
    setError('');
    try {
      const [r, j] = await Promise.all([
          api.studio.exploreGet(id),
          api.studio.exploreJobs(id),
        ]),
        b = r.batch;
      const snapshot = json(b.snapshot_json, {});
      // Old batches have no schema snapshot: derive labels without changing new-form state.
      if (!snapshot.preset)
        snapshot.preset = {
          fields: Object.keys(json(b.proposals_json, [])[0]?.dna || {}).map(
            (key) => ({ key, label: key })
          ),
        };
      setBatch({ ...b, proposals: json(b.proposals_json, []), snapshot });
      setSelected(json(b.selected_json, []));
      setJobs(j.jobs || []);
      const latest = j.jobs?.[0];
      if (latest) {
        setJob(latest);
        setStep('results');
        setAdoptSel(
          latest.renders
            .filter((x) => x.status === 'succeeded')
            .map((x) => x.proposal_idx)
        );
      } else if (json(b.renders_json, []).length) {
        setJob({
          id: 'legacy',
          status: 'succeeded',
          renders: json(b.renders_json, []).map((x) => ({
            ...x,
            status: x.error ? 'failed' : 'succeeded',
          })),
        });
        setStep('results');
      } else {
        setJob(null);
        setStep('proposals');
      }
      setQuote(null);
      setRequestKey('');
      setRetrySource(null);
      setTab('new');
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };
  const getQuote = async () => {
    setBusy(true);
    setError('');
    try {
      const r = await api.studio.exploreQuote(batch.id, {
        indexes: selected,
        render_model_id: renderId,
        render_size: size,
        source_job_id: retrySource,
      });
      setQuote(r.quote);
      setRequestKey(crypto.randomUUID());
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };
  const render = async () => {
    if (!quote) return;
    setBusy(true);
    setError('');
    try {
      const r = await api.studio.exploreStart(batch.id, {
        quote_id: quote.id,
        request_key: requestKey,
        confirm: true,
        async: true,
      });
      setJob(r.job);
      setJobs((previous) => [
        r.job,
        ...previous.filter((j) => j.id !== r.job.id),
      ]);
      setAdoptSel([]);
      setStep('results');
    } catch (e) {
      fail(e);
      if (['QUOTE_CHANGED', 'QUOTE_EXPIRED'].includes(e.code)) setQuote(null);
    } finally {
      setBusy(false);
    }
  };
  const adopt = async () => {
    setBusy(true);
    setError('');
    try {
      const r = await api.studio.exploreAdopt(
        batch.id,
        adoptSel,
        job?.id === 'legacy' ? undefined : job?.id
      );
      showToast(
        `已收 ${r.template_ids.length} 张为款式卡（重复操作不会重复创建）`
      );
      setAdoptSel([]);
      onAdopt();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };
  const toggle = (setter, i) =>
    setter((a) => (a.includes(i) ? a.filter((x) => x !== i) : [...a, i]));
  const retry = () => {
    setRetrySource(job.id);
    setRenderId(job.snapshot.model.id);
    setSize(job.snapshot.size);
    setSelected(
      images.filter((r) => r.status === 'failed').map((r) => r.proposal_idx)
    );
    setQuote(null);
    setStep('render');
  };
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal-box studio-modal explore-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <span>创意衍生</span>
          <div className="explore-tabs">
            <button
              className={tab === 'new' ? 'active' : ''}
              onClick={() => setTab('new')}
            >
              新发散
            </button>
            <button
              className={tab === 'history' ? 'active' : ''}
              onClick={() => setTab('history')}
            >
              历史批次
            </button>
          </div>
          <button className="icon-btn" onClick={onClose}>
            <Icon name="x" size={20} />
          </button>
        </div>
        <div className="modal-body">
          {error && (
            <div role="alert" className="explore-render-err">
              {error}
            </div>
          )}
          {tab === 'history' ? (
            <>
              {!batches.length && <p>还没有发散批次</p>}
              {batches.map((b) => (
                <button
                  key={b.id}
                  className="explore-batch-row"
                  disabled={busy}
                  onClick={() => loadBatch(b.id)}
                >
                  <span>
                    {b.intent_text || '随机灵感'}
                    <small className="dim">
                      {' '}
                      · {b.proposal_count} 个方案 · {stateName(b.status)}
                    </small>
                  </span>
                  <Icon name="chevronRight" size={18} />
                </button>
              ))}
              {moreHistory && (
                <button
                  className="btn secondary"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      const r = await api.studio.exploreList({
                        offset: batches.length,
                        limit: 20,
                      });
                      setBatches((x) => [...x, ...r.batches]);
                      setMoreHistory(r.batches.length === 20);
                    } catch (e) {
                      fail(e);
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  加载更多
                </button>
              )}
            </>
          ) : (
            <>
              <div className="explore-stepbar">
                <span>
                  {
                    {
                      intent: '1 · 创意发散',
                      proposals: '2 · 筛选方案',
                      render: '3 · 渲染设置',
                      results: '4 · 查看与收卡',
                    }[step]
                  }
                </span>
                {step !== 'intent' && (
                  <button
                    className="btn secondary small"
                    disabled={busy || active}
                    onClick={() => {
                      setStep('intent');
                      setBatch(null);
                      setJob(null);
                      setQuote(null);
                      setRetrySource(null);
                      expansionRequest.current = { signature: '', key: '' };
                    }}
                  >
                    新建发散
                  </button>
                )}
              </div>
              {step === 'intent' && (
                <>
                  <label className="key-label">
                    服装类目
                    <select
                      aria-label="服装类目"
                      className="text-input"
                      value={presetId}
                      onChange={(e) => changePreset(e.target.value)}
                    >
                      {presets.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="key-label">
                    灵感
                    <textarea
                      className="explore-intent"
                      aria-label="灵感"
                      rows={3}
                      maxLength={500}
                      value={intent}
                      onChange={(e) => setIntent(e.target.value)}
                      placeholder="写下必须保留的要求和希望探索的方向；可留空"
                    />
                  </label>
                  <label className="key-label">
                    发散轴（方案在这些字段上拉开差异）
                  </label>
                  <div className="explore-axes">
                    {(preset?.fields || []).map((f) => (
                      <label
                        key={f.key}
                        className={`explore-axis${axes.includes(f.key) ? ' checked' : ''}`}
                      >
                        <input
                          type="checkbox"
                          disabled={!!locked[f.key]?.trim()}
                          checked={axes.includes(f.key)}
                          onChange={() => toggle(setAxes, f.key)}
                        />
                        {f.label}
                      </label>
                    ))}
                  </div>
                  <details>
                    <summary>必须保留的字段（可选）</summary>
                    <p className="small dim">
                      填写后会锁定该字段，并移出发散轴。自然语言要求仍会传给模型，结构化锁定可逐字段验证。
                    </p>
                    {(preset?.fields || []).map((f) => (
                      <label className="key-input-row" key={f.key}>
                        {f.label}
                        <input
                          className="text-input"
                          aria-label={`锁定${f.label}`}
                          value={locked[f.key] || ''}
                          placeholder={
                            f.key === 'details' ? '多个细节用顿号分隔' : f.hint
                          }
                          onChange={(e) => {
                            setLocked((x) => ({
                              ...x,
                              [f.key]: e.target.value,
                            }));
                            if (e.target.value.trim())
                              setAxes((x) => x.filter((k) => k !== f.key));
                          }}
                        />
                      </label>
                    ))}
                  </details>
                  <div className="key-input-row">
                    <span>候选数量</span>
                    {[2, 4, 6, 8].map((n) => (
                      <button
                        key={n}
                        className={`btn small ${count === n ? 'primary' : 'secondary'}`}
                        onClick={() => setCount(n)}
                      >
                        {n} 个方案
                      </button>
                    ))}
                  </div>
                  <label className="key-label">
                    发散模型
                    <select
                      aria-label="发散模型"
                      className="text-input"
                      value={expandId}
                      onChange={(e) => setExpandId(e.target.value)}
                    >
                      {expandModels.map((m) => (
                        <option key={m.id} value={m.id}>
                          {modelName(m)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <p className="small dim">
                    只生成文字方案，不调用图片模型。本次选择不会更改全局后台模型。平台按实际
                    token
                    计费，最多一次格式修复；明确失败发散不扣积分；中断且结果未知时，预留额度待管理员核对。自带
                    Key 由供应商计费。
                  </p>
                  {expandModels.find((m) => m.id === expandId) && (
                    <p className="small dim">
                      输入 / 输出：
                      {expandModels.find((m) => m.id === expandId).pricing
                        .input_per_1m ?? '未配置'}{' '}
                      /{' '}
                      {expandModels.find((m) => m.id === expandId).pricing
                        .output_per_1m ?? '未配置'}{' '}
                      积分 / 百万 token
                    </p>
                  )}
                  {!expandModels.length && !loading && (
                    <p>暂无可用发散模型，请在模型管理中配置。</p>
                  )}
                  <div className="save-row">
                    <button
                      className="btn primary"
                      disabled={
                        loading ||
                        busy ||
                        !expandId ||
                        !axes.length ||
                        !presetId
                      }
                      onClick={startExplore}
                    >
                      {busy ? '正在发散…' : '开始发散'}
                    </button>
                    {error && (
                      <button className="btn secondary" onClick={loadInitial}>
                        重新加载配置
                      </button>
                    )}
                  </div>
                </>
              )}
              {step === 'proposals' && (
                <>
                  <p>
                    {selected.length}/{proposals.length} 个已选 · 发散模型：
                    {batch?.snapshot?.expand_model?.name || '历史记录'}
                  </p>
                  <div className="key-input-row">
                    <button
                      className="btn secondary small"
                      onClick={() => setSelected(proposals.map((_, i) => i))}
                    >
                      全选
                    </button>
                    <button
                      className="btn secondary small"
                      onClick={() => setSelected([])}
                    >
                      清空
                    </button>
                  </div>
                  <div className="explore-grid">
                    {proposals.map((p, i) => (
                      <DnaCard
                        key={i}
                        {...p}
                        fields={fields}
                        checked={selected.includes(i)}
                        onToggle={() => toggle(setSelected, i)}
                      />
                    ))}
                  </div>
                  <div className="save-row">
                    <button
                      className="btn primary"
                      disabled={!selected.length}
                      onClick={() => setStep('render')}
                    >
                      下一步：渲染设置（{selected.length} 张）
                    </button>
                  </div>
                </>
              )}
              {step === 'render' && (
                <>
                  {retrySource && (
                    <p className="small dim">
                      重试明确失败项，保留原提示词和随机种子，按本次报价执行。
                    </p>
                  )}
                  <p>
                    已选择 {selected.length} 个方案，将生成 {selected.length}{' '}
                    张图片。
                  </p>
                  <label className="key-label">
                    图片模型
                    <select
                      className="text-input"
                      aria-label="图片模型"
                      value={renderId}
                      onChange={(e) => {
                        setRenderId(e.target.value);
                        setSize(
                          imgModels.find((x) => x.id === e.target.value)
                            ?.sizes?.[0] || ''
                        );
                      }}
                    >
                      <option value="">请选择</option>
                      {imgModels.map((m) => (
                        <option
                          key={m.id}
                          value={m.id}
                          disabled={m.price_per_call === null}
                        >
                          {modelName(m)}（
                          {m.price_per_call === null
                            ? '价格未配置'
                            : `${m.price_per_call} 积分/张`}
                          ）
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="key-label">
                    图片尺寸
                    <select
                      className="text-input"
                      aria-label="图片尺寸"
                      value={size}
                      onChange={(e) => setSize(e.target.value)}
                    >
                      {selectedModel?.sizes.map((s) => (
                        <option key={s} value={s}>
                          {s}
                        </option>
                      ))}
                    </select>
                  </label>
                  {!imgModels.length && (
                    <p>暂无可用图片模型，请先在模型管理中配置。</p>
                  )}
                  {quote && (
                    <div className="explore-estimate" role="status">
                      服务端报价：{quote.indexes.length} 张 × {quote.unit_price}{' '}
                      积分 = {quote.total} 积分
                      {quote.billing_mode === 'local_mock'
                        ? '（本地或模拟模式，不扣积分）'
                        : ''}
                      。明确失败退回额度；中断且结果未知的任务需核对后处理。
                    </div>
                  )}
                  <div className="save-row">
                    <button
                      className="btn secondary"
                      disabled={busy}
                      onClick={() => {
                        setRetrySource(null);
                        setStep('proposals');
                      }}
                    >
                      返回筛选
                    </button>
                    <button
                      className="btn secondary"
                      disabled={busy || !renderId || !size || !selected.length}
                      onClick={getQuote}
                    >
                      获取报价
                    </button>
                    <button
                      className="btn primary"
                      disabled={busy || !quote}
                      onClick={render}
                    >
                      {busy ? '提交中…' : '确认费用并生成'}
                    </button>
                  </div>
                </>
              )}
              {step === 'results' && (
                <>
                  <p role="status">
                    {stateName(job?.status)}
                    {job?.total
                      ? ` · ${job.completed}/${job.total} 张已处理`
                      : ''}{' '}
                    · 已结算 {job?.cost_actual || 0} 积分
                    {job?.reserved_total
                      ? ` · 待结算 / 核对额度 ${job.reserved_total} 积分`
                      : ''}
                  </p>
                  <p className="small dim">
                    关闭弹窗不会取消已提交任务，可从历史批次继续查看。
                  </p>
                  {jobs.length > 1 && (
                    <label>
                      生成记录
                      <select
                        value={job?.id}
                        onChange={(e) => {
                          setJob(jobs.find((j) => j.id === e.target.value));
                          setAdoptSel([]);
                        }}
                      >
                        {jobs.map((j) => (
                          <option key={j.id} value={j.id}>
                            {j.created_at} · {j.snapshot.model.name} ·{' '}
                            {stateName(j.status)}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                  <div className="explore-render-grid">
                    {images.map((r) => (
                      <div
                        key={r.proposal_idx}
                        className={`explore-render-card${adoptSel.includes(r.proposal_idx) ? ' checked' : ''}`}
                        onClick={() =>
                          r.status === 'succeeded' &&
                          toggle(setAdoptSel, r.proposal_idx)
                        }
                      >
                        {r.status === 'succeeded' ? (
                          <>
                            <img
                              src={imgUrl(r.thumb_path || r.image_path)}
                              alt={`候选 ${r.proposal_idx + 1}`}
                            />
                            <label className="explore-check" onClick={e=>e.stopPropagation()}>
                              <input
                                type="checkbox"
                                aria-label={`收取候选${r.proposal_idx + 1}`}
                                checked={adoptSel.includes(r.proposal_idx)}
                                onClick={(e) => e.stopPropagation()}
                                onChange={() =>
                                  toggle(setAdoptSel, r.proposal_idx)
                                }
                              />
                            </label>
                          </>
                        ) : (
                          <div className="explore-render-err">
                            候选 {r.proposal_idx + 1} · {stateName(r.status)}
                            <br />
                            {r.error}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                  <div className="save-row">
                    <button
                      className="btn primary"
                      disabled={busy || active || !adoptSel.length}
                      onClick={adopt}
                    >
                      收为款式卡（{adoptSel.length}）
                    </button>
                    <button
                      className="btn secondary"
                      disabled={
                        busy ||
                        active ||
                        !images.some((r) => r.status === 'failed')
                      }
                      onClick={retry}
                    >
                      只重试失败项
                    </button>
                    <button
                      className="btn secondary"
                      disabled={busy || active}
                      onClick={() => {
                        setRetrySource(null);
                        setSelected([]);
                        setStep('proposals');
                      }}
                    >
                      选择方案重新渲染
                    </button>
                  </div>
                </>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
