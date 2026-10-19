import { sanitizeExploreDraft } from './exploreDraft.js';
import ExploreModalShell from './ExploreModalShell.jsx';
import DnaCard from './ExploreDnaCard.jsx';
import { useAuth } from '../auth.jsx';
import OriginalImageViewer from './OriginalImageViewer.jsx';
import OriginalImageLink from './OriginalImageLink.jsx';
// 创意衍生：发散 → 筛选 → 渲染设置 → 结果收卡，支持历史恢复
// P5: 类目预设动态字段（废弃旧 11 字段定死）
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import Icon from './icons.jsx';
import { fmtDnaValue } from './DnaFields.js';

const adoptedIndexes = (batch, job) => {
  const map = json(batch?.adopted_json || '{}', {});
  return (job?.renders || []).filter(r => map[r.item_id || `proposal_${r.proposal_idx}`]).map(r => r.proposal_idx);
};
const imgUrl = (p) => (p ? `/${p}` : '');

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
  const { user, multiUser } = useAuth();
  const draftKey = `explore-draft-v1:${multiUser ? user?.id || user?.username : 'local'}`;
  const restored = useRef(false), currentTask = useRef(null), batchLoad = useRef(0);
  const inputDraft = () => ({presetId,intent,axes,count,locked,expandId,thinking,renderId,size});
  const restoreInputs = c => {setPresetId(c.presetId);setIntent(c.intent);setAxes(c.axes);setCount(c.count);setLocked(c.locked);setLockKeys(Object.keys(c.locked || {}));setExpandId(expandModels.some(m => m.id === c.expandId) ? c.expandId : expandModels[0]?.id || '');setThinking(c.thinking);setRenderId(c.renderId);setSize(c.size);};
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
  const [viewer, setViewer] = useState(null), [adopted, setAdopted] = useState([]);
  const [onlyDiff, setOnlyDiff] = useState(false), [compare, setCompare] = useState(false);
  const [quoteLoading, setQuoteLoading] = useState(false), [quoteVersion, setQuoteVersion] = useState(0);
  const [lockKeys, setLockKeys] = useState([]);
  const bodyRef = useRef(null);
  const steps = ['intent', 'proposals', 'render', 'results'];
  const titles = ['创意设置', '筛选方案', '生成图片', '查看与收卡'];
  const lastProgress = useRef({stage:'', at:0});
  const receiveProgress = p => {
    if (p.stage !== lastProgress.current.stage || Date.now() - lastProgress.current.at >= 1000) { lastProgress.current = {stage:p.stage,at:Date.now()};setProgress(p); }
  };
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
  const settingsChanged = batch && (batch.preset_id !== presetId || (batch.intent_text || '') !== intent || batch.count !== count || JSON.stringify(json(batch.axes_json, [])) !== JSON.stringify(axes) || batch.snapshot?.expand_model?.id !== expandId || JSON.stringify(batch.snapshot?.locked_fields || {}) !== JSON.stringify(Object.fromEntries(Object.entries(locked).filter(([,v]) => v.trim()).map(([k,v]) => [k, k === 'details' ? v.split(/[、,，]/).map(x => x.trim()).filter(Boolean) : v.trim()]))));
  const fail = (e) => {
    const msg =
      (e.message || '请求失败') +
      (e.requestId ? `（请求编号 ${e.requestId}）` : '');
    setError(msg);
    showToast(msg);
  };
  useEffect(() => { bodyRef.current?.scrollTo(0, 0); bodyRef.current?.focus(); }, [step, tab]);
  const navigate = (next) => { setQuote(null); setStep(next); };
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
      setExpandId(previous => m.models?.some(x => x.id === previous) ? previous : m.recommended_id || m.models?.[0]?.id || '');
      if (p.presets?.length) {
        setPresetId(previous => previous || p.presets[0].id);
        if (!restored.current) setAxes(defaultAxes(p.presets[0].fields));
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
        if (renderId && !r.models?.some(x => x.id === renderId)) setError('原图片模型已不可用，请确认当前模型及尺寸后生成');
        setRenderId(m?.id || '');
        setSize((previous) =>
          m?.sizes?.includes(previous) ? previous : m?.sizes?.[0] || ''
        );
      })
      .catch(fail);
    return () => {
      alive = false;
    };
  }, [step]);
  useEffect(() => {
    setQuote(null); setRequestKey('');
    if (step !== 'render' || !batch || !renderId || !size || !selected.length || active) { setQuoteLoading(false); return; }
    let alive = true;
    setQuoteLoading(true);
    const timer = setTimeout(async () => {
      try {
        const r = await api.studio.exploreQuote(batch.id, { indexes: selected, render_model_id: renderId, render_size: size, source_job_id: retrySource });
        if (alive) { setQuote(r.quote); setRequestKey(crypto.randomUUID()); setError(''); }
      } catch (e) { if (alive) fail(e); }
      finally { if (alive) setQuoteLoading(false); }
    }, 350);
    return () => { alive = false; clearTimeout(timer); };
  }, [step, batch?.id, renderId, size, selected.join(','), retrySource, active, quoteVersion]);
  useEffect(() => {
    if (tab !== 'history') return;
    let alive = true;
    api.studio
      .exploreList()
      .then((r) => {
        if (!alive) return;
        setBatches(r.batches || []);
        setMoreHistory((r.batches || []).length === 20);
      })
      .catch(e => { if(alive) fail(e); });
    return () => { alive = false; };
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
                .filter((x) => x.status === 'succeeded' && !adopted.includes(x.proposal_idx))
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
    setLocked({}); setLockKeys([]);
  };
  const [thinking, setThinking] = useState(false),
    [progress, setProgress] = useState(null),
    [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (loading || restored.current) return;
    restored.current = true;
    try {
      const cached = JSON.parse(sessionStorage.getItem(draftKey) || 'null');
      if (!cached || Date.now() - cached.savedAt > 24 * 3600_000) return;
      const { draft:saved, warnings } = sanitizeExploreDraft(cached,presets,expandModels);
      if (warnings.length) setError(warnings.join('；'));
      if (saved.expansionRequest?.key) expansionRequest.current = saved.expansionRequest;
      if (presets.some(p => p.id === saved.presetId)) { setPresetId(saved.presetId); setAxes(saved.axes || []); setLocked(saved.locked || {});setLockKeys(Object.keys(saved.locked || {})); }
      setIntent(saved.intent || ''); setCount(saved.count || 6); setThinking(!!saved.thinking);
      if (expandModels.some(m => m.id === saved.expandId)) setExpandId(saved.expandId);
      setRenderId(saved.renderId || ''); setSize(saved.size || '');
      if (saved.batchId) loadBatch(saved.batchId, saved.jobId).then(() => {
        restoreInputs(saved);
        setSelected(saved.selected || []);
        setAdopted(saved.adopted || []);
        if (steps.includes(saved.step)) setStep(saved.step);
      });
    } catch { /* storage unavailable: keep the current in-memory form */ }
  }, [loading]);
  useEffect(() => {
    if (!restored.current) return;
    try {
      const c = currentTask.current;
      const saved = c ? {...c.inputs,batchId:c.batch?.id,jobId:c.job?.id,selected:c.selected,adopted:c.adopted,step:c.step} : {presetId,intent,axes,count,locked,expandId,thinking,renderId,size,batchId:batch?.id,jobId:job?.id,selected,adopted,step};
      sessionStorage.setItem(draftKey, JSON.stringify({...saved,expansionRequest:expansionRequest.current,savedAt:Date.now()}));
    } catch { /* private browsing may disable storage */ }
  }, [presetId,intent,axes,count,locked,expandId,thinking,renderId,size,batch?.id,job?.id,selected,adopted,step,busy]);
  useEffect(() => {
    if (!quote) return;
    const timer = setTimeout(() => { setQuote(null); setQuoteVersion(v => v + 1); }, Math.max(0, quote.expires_at - Date.now()));
    return () => clearTimeout(timer);
  }, [quote]);
  const thinkingMode =
    expandModels.find((m) => m.id === expandId)?.thinking_control ||
    'best_effort';
  const effectiveThinking =
    thinkingMode === 'forced_on' ||
    (thinkingMode !== 'unsupported' && thinking);
  useEffect(() => {
    if (!busy || !progress) return;
    const start = Date.now();
    const t = setInterval(
      () => setElapsed(Math.floor((Date.now() - start) / 1000)),
      1000
    );
    return () => clearInterval(t);
  }, [busy, !!progress]);
  const startExplore = async () => {
    if (!Number.isInteger(count) || count < 1 || count > 16) {
      setError('请输入 1–16 的整数候选数量');
      return;
    }
    setProgress({ message: '正在连接发散服务', stage: 'preparing' });
    setElapsed(0);
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
        thinking: effectiveThinking,
      };
      const signature = JSON.stringify(params);
      if (expansionRequest.current.signature !== signature)
        expansionRequest.current = { signature, key: crypto.randomUUID() };
      const r = await api.studio.exploreCreate(
        {
          ...params,
          request_key: expansionRequest.current.key,
        },
        receiveProgress
      );
      // Preserve a completed expansion even if its modal was closed while streaming.
      try {
        const saved = JSON.parse(sessionStorage.getItem(draftKey) || 'null');
        if (saved?.expansionRequest?.key === expansionRequest.current.key) sessionStorage.setItem(draftKey, JSON.stringify({...saved,batchId:r.id,selected:r.proposals.map((_,i)=>i),step:'proposals',expansionRequest:{signature:'',key:''}}));
      } catch { /* storage is optional */ }
      setRetrySource(null);
      setAdopted([]);
      setBatch({...r, preset_id:presetId, intent_text:intent, count, axes_json:JSON.stringify(axes)});
      setSelected(r.proposals.map((_, i) => i));
      setJob(null);
      setJobs([]);
      setQuote(null);
      expansionRequest.current = { signature: '', key: '' };
      setStep('proposals');
    } catch (e) {
      fail(e);
      if (e.code && !['RESULT_UNCERTAIN', 'EXPANSION_EXISTS'].includes(e.code))
        expansionRequest.current = { signature: '', key: '' };
    } finally {
      setBusy(false);
    }
  };
  const loadBatch = async (id, jobId) => {
    const token = ++batchLoad.current;
    setBusy(true);
    setError('');
    try {
      const [r, j] = await Promise.all([
          api.studio.exploreGet(id),
          api.studio.exploreJobs(id),
        ]),
        b = r.batch;
      if (token !== batchLoad.current) return;
      const snapshot = json(b.snapshot_json, {});
      // Old batches have no schema snapshot: derive labels without changing new-form state.
      if (!snapshot.preset)
        snapshot.preset = {
          fields: Object.keys(json(b.proposals_json, [])[0]?.dna || {}).map(
            (key) => ({ key, label: key })
          ),
        };
      setAdopted([]);
      setPresetId(b.preset_id);setIntent(b.intent_text || '');setAxes(json(b.axes_json, []));setCount(b.count || 6);
      setLocked(Object.fromEntries(Object.entries(snapshot.locked_fields || {}).map(([k,v]) => [k, Array.isArray(v) ? v.join("、") : String(v)])));setLockKeys(Object.keys(snapshot.locked_fields || {}));
      if (snapshot.expand_model?.id) setExpandId(snapshot.expand_model.id);
      setThinking(!!snapshot.thinking);
      setBatch({ ...b, proposals: json(b.proposals_json, []), snapshot });
      setSelected(json(b.selected_json, []));
      setJobs(j.jobs || []);
      const latest = j.jobs?.find(job => job.id === jobId) || j.jobs?.[0];
      if (latest) {
        setJob(latest);
        setRenderId(latest.snapshot?.model?.id || '');setSize(latest.snapshot?.size || '');
        setAdopted(adoptedIndexes(b, latest));
        setStep('results');
        setAdoptSel(
          latest.renders
            .filter((x) => x.status === 'succeeded' && !adoptedIndexes(b, latest).includes(x.proposal_idx))
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
  const render = async () => {
    if (!quote || busy || active) return;
    setBusy(true);
    setError('');
    try {
      const r = await api.studio.exploreStart(batch.id, {
        quote_id: quote.id,
        request_key: requestKey,
        confirm: true,
        async: true,
      });
      setAdopted([]);
      setJob(r.job);
      setJobs((previous) => [
        r.job,
        ...previous.filter((j) => j.id !== r.job.id),
      ]);
      setAdoptSel([]);
      setStep('results');
    } catch (e) {
      fail(e);
      if (['QUOTE_CHANGED', 'QUOTE_EXPIRED'].includes(e.code)) { setQuote(null); setQuoteVersion(v => v + 1); }
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
      setBatch(previous => ({...previous, adopted_json: JSON.stringify({...json(previous.adopted_json || '{}', {}), ...Object.fromEntries(adoptSel.map((idx, i) => [images.find(r => r.proposal_idx === idx)?.item_id || `proposal_${idx}`, r.template_ids[i]]))})}));
      setAdoptSel([]);
      setAdopted(a => [...new Set([...a, ...adoptSel])]);
      onAdopt(false);
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
    <ExploreModalShell onClose={onClose} hasViewer={!!viewer} header={(<div className="modal-head">
          <span>创意衍生</span>
          <div className="explore-tabs">
            <button
              className={tab === 'new' ? 'active' : ''}
              onClick={() => {
                if (currentTask.current) { const c = currentTask.current; setBatch(c.batch);setJob(c.job);setJobs(c.jobs);setSelected(c.selected);setAdoptSel(c.adoptSel);setStep(c.step);setAdopted(c.adopted);restoreInputs(c.inputs);currentTask.current=null; }
                setTab('new');
              }}
            >
              当前任务
            </button>
            <button
              className={tab === 'history' ? 'active' : ''}
              onClick={() => setTab('history')}
            >
              历史记录
            </button>
          </div>
          <button className="icon-btn" aria-label="关闭创意衍生" onClick={onClose}>
            <Icon name="x" size={20} />
          </button>
        </div>)} navigation={(<nav className="explore-navigation" aria-label="创意衍生步骤">
          {steps.map((value, i) => <button key={value} aria-current={step === value ? 'step' : undefined}
            disabled={tab === 'history' || (i > 0 && !batch) || (i === 2 && !selected.length) || (i === 3 && !job)}
            onClick={() => navigate(value)}>{i + 1} · {titles[i]}</button>)}
        </nav>)} footer={(<footer className="explore-footer">
          {tab === 'new' && step !== 'intent' && <button className="btn secondary" onClick={() => navigate(steps[steps.indexOf(step)-1])}>上一步</button>}
          {tab === 'new' && <div className="explore-footer-actions">{step === 'intent' && (<div className="save-row">
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
                      {busy ? '正在发散…' : batch ? '重新发散' : '开始发散'}
                    </button>
                    {error && (
                      <button className="btn secondary" onClick={loadInitial}>
                        重新加载配置
                      </button>
                    )}
                  </div>)}
{step === 'proposals' && (<div className="save-row">
                    <button
                      className="btn primary"
                      disabled={!selected.length || busy}
                      onClick={() => setStep('render')}
                    >
                      下一步：渲染设置（{selected.length} 张）
                    </button>
                  </div>)}
{step === 'render' && (<div className="save-row">

                    <button
                      className="btn primary"
                      disabled={busy || active || !quote || quoteLoading}
                      onClick={render}
                    >
                      {busy ? '提交中…' : '确认费用并生成'}
                    </button>
                  </div>)}
{step === 'results' && (<div className="save-row">
                    <button
                      className="btn primary"
                      disabled={busy || active || !adoptSel.length}
                      onClick={adopt}
                    >
                      收为款式卡（{adoptSel.length}）
                    </button>
                    {adopted.length > 0 && <button className="btn secondary" onClick={() => onAdopt(true)}>前往款式库</button>}
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
                        setStep('proposals');
                      }}
                    >
                      选择方案重新渲染
                    </button>
                  </div>)}
          </div>}
          {tab === 'new' && step === 'proposals' && <span>已选 {selected.length} / {proposals.length} 个方案</span>}
          {tab === 'new' && step === 'render' && <span role="status">{quoteLoading ? '正在更新报价…' : quote ? `${quote.indexes.length} 张 · ${size} · 预计 ${quote.total} 积分` : '暂无有效报价'}</span>}
          {step === 'render' && !quote && !quoteLoading && <button className="btn secondary" onClick={() => setQuoteVersion(v => v + 1)} disabled={busy || !renderId || !size || !selected.length}>重新获取报价</button>}
        </footer>)}>
      <div className="modal-body" ref={bodyRef} tabIndex={-1} aria-label={tab === 'history' ? '历史记录' : titles[steps.indexOf(step)]}>
          {error && (
            <div id="explore-error" role="alert" className="explore-render-err">
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
                  onClick={() => {
                    if (!currentTask.current) currentTask.current = {batch,job,jobs,selected,adoptSel,step,adopted,inputs:inputDraft()};
                    loadBatch(b.id);
                  }}
                >
                  {b.thumb_path && <img loading="lazy" src={imgUrl(b.thumb_path)} alt="" className="explore-history-thumb" />}
                  <span>
                    {b.intent_text || '随机灵感'}
                    <small className="dim">
                      {' '}
                      · {presets.find(p => p.id === b.preset_id)?.name || '历史类目'} · {b.proposal_count} 个方案 · {b.success_count || 0} 张成功 · {stateName(b.status)} · {b.created_at}
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
              {settingsChanged && <p role="status" className="explore-estimate">设置已修改，现有方案仍对应上次发散。返回创意设置并点击“重新发散”后才会使用新设置。</p>}
              {step === 'intent' && batch && <p className="explore-estimate">当前已有方案。查看设置不会调用模型；修改后点击“重新发散”才会提交新任务，原批次保留在历史记录中。</p>}
              {step === 'intent' && (
                <fieldset disabled={busy} aria-describedby={error ? "explore-error" : undefined} className="explore-intent-fields">
                  <legend>创意设置</legend>
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
                    希望探索哪些变化
                  </label>
                  <p id="explore-axes-help" className="small dim">至少选择一项变化；填写保留条件后，对应字段不参与变化。</p>
                  <div className="explore-axes">
                    {(preset?.fields || []).map((f) => (
                      <label
                        key={f.key}
                        className={`explore-axis${axes.includes(f.key) ? ' checked' : ''}`}
                      >
                        <input
                          type="checkbox"
                          disabled={!!locked[f.key]?.trim()}
                          checked={axes.includes(f.key)} aria-describedby="explore-axes-help"
                          onChange={() => toggle(setAxes, f.key)}
                        />
                        {f.label}{locked[f.key]?.trim() ? " · 已锁定" : ""}
                      </label>
                    ))}
                  </div>

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
                  <label className="explore-custom-count">
                    自定义（1–16）
                    <input
                      type="number"
                      className="text-input"
                      aria-label="自定义候选数量"
                      aria-invalid={!Number.isInteger(count) || count < 1 || count > 16}
                      aria-describedby="explore-count-help"
                      min={1}
                      max={16}
                      step={1}
                      value={Number.isNaN(count) ? '' : count}
                      disabled={busy}
                      onChange={(e) =>
                        setCount(
                          e.target.value === '' ? NaN : Number(e.target.value)
                        )
                      }
                    />
                  </label>
                  <p id="explore-count-help" className="small dim">
                    {(!Number.isInteger(count) || count < 1 || count > 16) && <strong>请输入 1–16 的整数。 </strong>}
                    数量越多，生成时间和费用通常越高；建议先生成 4–6
                    个方案再筛选。
                  </p>
                  <h3>模型设置</h3>
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
                  <details className="explore-advanced"><summary>高级设置 · 思考模式、保留条件与费用说明</summary>
                  <details>
                    <summary>哪些设计必须保留（可选）</summary>
                    <p className="small dim">
                      填写后会锁定该字段，并移出发散轴。自然语言要求仍会传给模型，结构化锁定可逐字段验证。
                    </p>
                    <label className="key-label">添加保留条件
                      <select aria-label="添加保留条件" value="" onChange={e => setLockKeys(keys => [...keys, e.target.value])}>
                        <option value="">选择需要保留的设计字段</option>
                        {(preset?.fields || []).filter(f => !lockKeys.includes(f.key)).map(f => <option key={f.key} value={f.key}>{f.label}</option>)}
                      </select>
                    </label>
                    {(preset?.fields || []).filter(f => lockKeys.includes(f.key)).map((f) => (
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
                        <button type="button" className="btn secondary small" aria-label={`移除保留${f.label}`} onClick={() => { setLockKeys(keys => keys.filter(k => k !== f.key)); setLocked(values => { const next = {...values}; delete next[f.key]; return next; }); }}>移除</button>
                      </label>
                    ))}
                  </details>
                  <label className="explore-thinking">
                    <input
                      type="checkbox"
                      role="switch"
                      aria-label="思考模式"
                      checked={effectiveThinking}
                      disabled={
                        busy ||
                        ['forced_on', 'unsupported'].includes(thinkingMode)
                      }
                      onChange={(e) => setThinking(e.target.checked)}
                    />
                    思考模式（
                    {thinkingMode === 'forced_on' ? '模型固定开启' : effectiveThinking ? '已开启' : '已关闭'}
                    ）
                  </label>
                  <p className="small dim">
                    {thinkingMode === 'forced_on'
                      ? '该模型固定使用思考，无法关闭；需要更快响应可换用非推理模型。'
                      : thinkingMode === 'unsupported'
                        ? '当前接口未提供可切换的思考模式。'
                        : thinkingMode === 'best_effort'
                          ? '自定义供应商可能不支持思考参数，实际行为以供应商为准。'
                          : '开启可能增加等待时间和 token 用量；关闭优先获得更快反馈。'}
                  </p>
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
                  </details>
                  {busy && progress && (
                    <div
                      role="status"
                      className="explore-estimate"
                      aria-live="polite"
                    >
                      {progress.message} · 已等待{' '}
                      {Math.max(
                        elapsed,
                        Math.floor((progress.elapsed_ms || 0) / 1000)
                      )}{' '}
                      秒
                      {progress.attempt
                        ? ` · 第 ${progress.attempt} 次调用`
                        : ''}
                      {progress.received_chars > 0
                        ? ` · 已接收 ${progress.received_chars} 字符，${progress.received_proposals || 0}/${count} 个方案待校验`
                        : ''}
                    </div>
                  )}

                  {!expandModels.length && !loading && (
                    <p>暂无可用发散模型，请在模型管理中配置。</p>
                  )}

                </fieldset>
              )}
              {step === 'proposals' && (
                <>
                  <p>
                    {batch?.snapshot?.timings?.total_ms !== undefined && (
                      <span className="small dim">
                        本次耗时{' '}
                        {(batch.snapshot.timings.total_ms / 1000).toFixed(1)} 秒
                        {batch.snapshot.timings.first_content_ms !== undefined
                          ? ` · 首段输出 ${(batch.snapshot.timings.first_content_ms / 1000).toFixed(1)} 秒`
                          : ''}{' '}
                        · {batch.snapshot.timings.attempts || 1} 次调用
                        <br />
                      </span>
                    )}
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
                  <label className="explore-option"><input type="checkbox" checked={onlyDiff} onChange={e => setOnlyDiff(e.target.checked)} />只看差异</label>
                  <label className="explore-option"><input type="checkbox" checked={compare} onChange={e => setCompare(e.target.checked)} />对比已选（最多 4 个）</label>
                  {compare && selected.length > 4 && <p role="status">仅对比前 4 个已选方案；可取消选择后比较其他方案。</p>}
                  {Object.keys(batch?.snapshot?.locked_fields || {}).length > 0 && <p>必须保留：{Object.entries(batch.snapshot.locked_fields).map(([key,value]) => `${fields.find(f => f.key === key)?.label || key}：${fmtDnaValue(value)}`).join('；')}</p>}
                  <div className="explore-grid">
                    {proposals.map((p, i) => (!compare || selected.slice(0, 4).includes(i)) && (
                      <DnaCard
                        key={i}
                        {...p}
                        fields={fields} index={i} axes={json(batch?.axes_json, null) || axes}
                        differences={onlyDiff ? fields.filter(f => new Set((compare ? proposals.filter((_,i) => selected.slice(0,4).includes(i)) : proposals).map(p => JSON.stringify(p.dna?.[f.key]?.value))).size > 1).map(f => f.key) : null}
                        checked={selected.includes(i)}
                        onToggle={() => toggle(setSelected, i)}
                      />
                    ))}
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
                          const next = jobs.find((j) => j.id === e.target.value);
                          setJob(next); setAdopted(adoptedIndexes(batch,next));
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
                      <div className="explore-render-item" key={r.proposal_idx}><div
                        data-status={r.status} className={`explore-render-card${adoptSel.includes(r.proposal_idx) ? ' checked' : ''}`}
                        onClick={() =>
                          r.status === 'succeeded' && setViewer({path:r.image_path, name:`方案 ${r.proposal_idx + 1}`})
                        }
                      >
                        {r.status === 'succeeded' ? (
                          <>
                            <img
                              src={imgUrl(r.thumb_path || r.image_path)}
                              role="button" tabIndex={0} onKeyDown={e => { if (['Enter', ' '].includes(e.key)) {e.preventDefault();setViewer({path:r.image_path,name:`方案 ${r.proposal_idx + 1}`});} }}
                              loading="lazy" alt={`候选 ${r.proposal_idx + 1}，点击查看原图`}
                            />
                            <label
                              className="explore-check"
                              onClick={(e) => e.stopPropagation()}
                            >
                              <input
                                type="checkbox"
                                disabled={adopted.includes(r.proposal_idx)}
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
                      <details><summary>设计摘要</summary>{proposals[r.proposal_idx]?.rationale || '历史方案'} </details>
                      <p>方案 {r.proposal_idx + 1} · {adopted.includes(r.proposal_idx) ? '已收卡' : stateName(r.status)}</p>
                      {r.status==='succeeded'&&<OriginalImageLink path={r.image_path}/> }
                      </div>
                    ))}
                  </div>

                </>
              )}
            </>
          )}
        </div>
      {viewer && <OriginalImageViewer image={viewer} onClose={() => setViewer(null)} />}
    </ExploreModalShell>
  );
}
