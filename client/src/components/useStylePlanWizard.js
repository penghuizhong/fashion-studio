import { cleanPlanContent } from "../../../shared/stylePrompt.js";
import { mergeStylePlanDrafts } from "./mergeStylePlanDrafts.js";
import { useEffect, useRef, useState, useCallback } from "react";
import { api } from "../api.js";
import { useAuth } from "../auth.jsx";
import { imageTaskAllowed, sizeAllowed } from "../../../shared/imageOptions.js";
import { normalizeCamera } from "../../../shared/photography.js";
export const defaultPlanInput = () => ({
  modules: { main: 1 },
  references: [],
  requirements: "",
  facts: {},
  model_id: "",
  size: "",
  quality: "",
  analysis_model_id: "",
  thinking: false,
  style: "auto",
  op: "create",
});
export const cleanContent = cleanPlanContent;
const sign = (input, content) =>
  JSON.stringify({ input, content: cleanContent(content) });
export default function useStylePlanWizard({
  templateId,
  initialVersionId,
  initialStep,
  initialImage,
  onChanged,
  enablePlanning = true,
}) {
  const { user, multiUser } = useAuth();
  const key = `style-wizard:${multiUser ? user?.id || user?.username : "local"}:${templateId}`;
  const [data, setData] = useState(null),
    [versionId, setVersionId] = useState(initialVersionId || null),
    [plan, setPlan] = useState(null),
    [input, setInput] = useState(defaultPlanInput),
    [content, setContent] = useState(null),
    [step, setStep] = useState(initialStep ?? 1),
    [analysis, setAnalysis] = useState(null),
    [job, setJob] = useState(null),
    [busy, setBusy] = useState(false),
    [saving, setSaving] = useState(false),
    [error, setError] = useState(""),
    [saveError, setSaveError] = useState(""),
    [conflict, setConflict] = useState(null),
    [models, setModels] = useState([]),
    [chatModels, setChatModels] = useState([]),
    [modelError, setModelError] = useState(""),
    [modelRetry, setModelRetry] = useState(0),
    [quote, setQuote] = useState(null),
    [quoteBusy, setQuoteBusy] = useState(false),
    [quoteRetry, setQuoteRetry] = useState(0),
    [estimate, setEstimate] = useState(null),
    [pending, setPending] = useState(null),
    [pendingAnalysis, setPendingAnalysis] = useState(null),
    [retryJobId, setRetryJobId] = useState(null),
    [ready, setReady] = useState(false),
    [editingPrompt, setEditingPrompt] = useState(false);
  const refreshController = useRef(null);
  const refs = useRef({}),
    live = useRef(true),
    saved = useRef(""),
    savingRef = useRef(null),
    createKey = useRef(crypto.randomUUID()),
    quoteKey = useRef(""),
    auto = useRef(false);
  refs.current = {
    editingPrompt,
    data,
    versionId,
    plan,
    input,
    content,
    analysis,
    job,
    pending,
    step,
  };
  const adopt = useCallback((p) => {
    setPlan(p);
    setVersionId(p.version_id);
    setInput(p.input);
    setContent(p.content);
    saved.current = sign(p.input, p.content);
    setSaveError("");
    setQuote(null);
  }, []);
  const loadPlan = useCallback(
    async (id) => {
      const r = await api.studio.plan(templateId, id);
      if (!live.current) return;
      adopt(r.plan);
      setAnalysis(r.analyses?.[0] || null);
      return r.plan;
    },
    [templateId, adopt],
  );
  const refresh = useCallback(
    async (selected) => {
      refreshController.current?.abort();
      const controller = new AbortController();
      refreshController.current = controller;
      let editParent;
      try {
        editParent = JSON.parse(
          sessionStorage.getItem(`${key}:attributes`) || "null",
        )?.parent;
      } catch {}
      const r = await api.studio.workspace(
        templateId,
        {
          view: "summary",
          ...(selected ? { version_id: selected } : {}),
          ...(editParent ? { edit_parent_id: editParent } : {}),
        },
        { signal: controller.signal },
      );
      if (live.current) {
        setData(r);
        setVersionId(selected || r.template.work_version_id);
      }
      return r;
    },
    [templateId, key],
  );
  useEffect(() => {
    live.current = true;
    let cache = {};
    try {
      cache = JSON.parse(sessionStorage.getItem(key) || "{}");
    } catch {}
    (async () => {
      try {
        const r = await refresh(
          refs.current.versionId || initialVersionId || cache.versionId,
        );
        if (!live.current) return;
        if (!enablePlanning) return;
        if (cache.pending) setPending(cache.pending);
        if (cache.pendingAnalysis) setPendingAnalysis(cache.pendingAnalysis);
        const list = await api.studio.plans(templateId);
        if (!live.current) return;
        const remembered =
          cache.planId && list.plans.find((p) => p.id === cache.planId);
        const last =
          remembered ||
          list.plans.find(
            (p) =>
              p.version_id === (initialVersionId || r.template.work_version_id),
          );
        if (last) {
          const p = await loadPlan(last.id);
          if (cache.local && cache.baseRevision === p.revision) {
            setInput(cache.local.input);
            setContent(cache.local.content);
          }
          if (cache.jobId) {
            const j = await api.studio.styleJob(templateId, cache.jobId);
            if (live.current) {
              setJob(j.job);
              setStep(
                initialStep ??
                  (["running", "queued"].includes(j.job.status)
                    ? 4
                    : cache.step === 5
                      ? 5
                      : cache.step || 3),
              );
            }
          } else {
            const latest = r.jobs?.find(
              (j) => j.snapshot.style?.plan_id === p.id,
            );
            if (latest) {
              const full = await api.studio.styleJob(templateId, latest.id);
              if (live.current) {
                setJob(full.job);
                setStep(
                  initialStep ??
                    (["running", "queued"].includes(full.job.status)
                      ? 4
                      : cache.step || 1),
                );
              }
            } else setStep(initialStep ?? cache.step ?? 1);
          }
        } else {
          let legacy;
          try {
            legacy = JSON.parse(
              sessionStorage.getItem(
                `style-draft-v1:${multiUser ? user?.id || user?.username : "local"}:${templateId}`,
              ) || "null",
            );
          } catch {}
          const source =
            legacy?.form?.source ||
            (initialImage?.id
              ? String(initialImage.id)
              : r.template.source_available
                ? "original"
                : "");
          const old = legacy?.form;
          setInput((f) => ({
            ...f,
            ...(cache.local?.input || {}),
            ...(old
              ? {
                  requirements: old.instruction || "",
                  keep: old.keep || "",
                  ...(old.camera ? { camera: old.camera } : {}),
                  explore_variation: old.explore_variation === true,
                  op: old.op || "create",
                  model_id: old.model_id || "",
                  size: old.size || "",
                  quality: old.quality || "",
                  style: old.visual_style || "auto",
                  modules: { main: Math.min(16, Math.max(1, old.count || 1)) },
                }
              : {}),
            references: source
              ? [
                  { id: crypto.randomUUID(), source, role: "garment" },
                  ...(old?.references || []).map((r) => ({
                    id: crypto.randomUUID(),
                    source: r.source,
                    role: "model",
                  })),
                ]
              : [],
          }));
          if (legacy?.pendingStart) setPending(legacy.pendingStart);
          if (r.jobs?.length) {
            const full = await api.studio.styleJob(templateId, r.jobs[0].id);
            if (live.current) {
              setJob(full.job);
              if (["running", "queued"].includes(full.job.status))
                setStep(initialStep ?? 4);
            }
          }
          if (legacy?.draft)
            window.dispatchEvent(
              new CustomEvent("style-legacy-draft", { detail: legacy }),
            );
        }
      } catch (e) {
        if (live.current) setError(e.message);
      } finally {
        if (live.current) setReady(true);
      }
    })();
    return () => {
      live.current = false;
      refreshController.current?.abort();
    };
  }, [templateId, enablePlanning]);
  useEffect(() => {
    if (!ready) return;
    try {
      sessionStorage.setItem(
        key,
        JSON.stringify({
          planId: plan?.id,
          versionId,
          step,
          jobId: job?.id,
          pending,
          pendingAnalysis,
          baseRevision: plan?.revision,
          local: input ? { input, content } : null,
        }),
      );
    } catch {}
  }, [
    ready,
    plan?.id,
    plan?.revision,
    versionId,
    step,
    job?.id,
    pending,
    pendingAnalysis,
    input,
    content,
  ]);
  const flush = useCallback(async () => {
    if (savingRef.current) await savingRef.current;
    const current = refs.current;
    if (!current.plan) return null;
    const signature = sign(current.input, current.content);
    if (signature === saved.current) return current.plan;
    setSaving(true);
    setSaveError("");
    const operation = (async () => {
      try {
        const body = {
          expected_revision: current.plan.revision,
          input: current.input,
        };
        // Input module changes use the server reconciler; explicit item edits carry their own counts.
        if (current.content) body.content = cleanContent(current.content);
        const r = await api.studio.updatePlan(
          templateId,
          current.plan.id,
          body,
        );
        if (!live.current) return r.plan;
        saved.current = sign(r.plan.input, r.plan.content);
        setPlan(r.plan);
        refs.current.plan = r.plan;
        if (sign(refs.current.input, refs.current.content) === signature) {
          setInput(r.plan.input);
          setContent(r.plan.content);
          refs.current.input = r.plan.input;
          refs.current.content = r.plan.content;
        }
        setQuote(null);
        return r.plan;
      } catch (e) {
        if (e.code === "PLAN_CONFLICT")
          try {
            sessionStorage.setItem(
              key + ":conflict",
              JSON.stringify({
                base: JSON.parse(saved.current),
                local: {
                  input: current.input,
                  content: cleanContent(current.content),
                },
                plan_id: current.plan.id,
              }),
            );
          } catch {}
        if (live.current) setSaveError(e.message);
        throw e;
      } finally {
        savingRef.current = null;
        if (live.current) setSaving(false);
      }
    })();
    savingRef.current = operation;
    return operation;
  }, [templateId]);
  useEffect(() => {
    if (enablePlanning && ready && step >= 2 && !plan && input.model_id)
      work(ensurePlan);
  }, [enablePlanning, ready, step >= 2, !!plan, !!input.model_id]);
  const changed = !!plan && sign(input, content) !== saved.current;
  useEffect(() => {
    if (
      !ready ||
      !changed ||
      Object.values(input.modules).reduce((a, b) => a + b, 0) < 1 ||
      ["running", "uncertain"].includes(analysis?.status)
    )
      return;
    const timer = setTimeout(() => flush().catch(() => {}), 1000);
    return () => clearTimeout(timer);
  }, [ready, changed, input, content, analysis?.status, flush]);
  useEffect(() => {
    if (step < 2 || models.length) return;
    const c = new AbortController();
    setModelError("");
    Promise.all([
      api.studio.imageModels({ signal: c.signal }),
      api.studio.exploreModels({ signal: c.signal }),
    ])
      .then(([images, chats]) => {
        if (c.signal.aborted) return;
        setModels(images.models);
        setChatModels(chats.models);
        setInput((f) => {
          const m =
              images.models.find((m) =>
                f.references.length
                  ? m.capabilities?.image_edit
                  : m.capabilities?.text,
              ) || images.models[0],
            chat =
              chats.models.find((m) => !f.references.length || m.vision) ||
              chats.models[0];
          return {
            ...f,
            model_id: f.model_id || m?.id || "",
            size: f.size || m?.sizes?.[0] || "",
            analysis_model_id: f.analysis_model_id || chat?.id || "",
          };
        });
      })
      .catch((e) => {
        if (!c.signal.aborted) setModelError(e.message);
      });
    return () => c.abort();
  }, [step >= 2, models.length, modelRetry]);
  const ensurePlan = async () => {
    let p = await flush();
    if (p) return p;
    const current = refs.current;
    const r = await api.studio.createPlan(templateId, {
      version_id: current.versionId,
      input: current.input,
      request_key: createKey.current,
    });
    adopt(r.plan);
    refs.current.plan = r.plan;
    refs.current.input = r.plan.input;
    refs.current.content = r.plan.content;
    return r.plan;
  };
  const work = async (fn) => {
    if (auto.current) return;
    auto.current = true;
    setBusy(true);
    setError("");
    try {
      return await fn();
    } catch (e) {
      if (live.current) setError(e.message);
    } finally {
      auto.current = false;
      if (live.current) setBusy(false);
    }
  };
  const prepareAnalysis = (ids) =>
    work(async () => {
      const p = await ensurePlan();
      const body = { item_ids: ids || p.content.items.map((i) => i.id) };
      const e = await api.studio.analysisEstimate(templateId, p.id, body);
      setEstimate({
        ...e,
        plan_id: p.id,
        item_ids: body.item_ids,
        request_key: crypto.randomUUID(),
      });
    });
  const submitAnalysis = async (submission) => {
    setPendingAnalysis(submission);
    try {
      const cache = JSON.parse(sessionStorage.getItem(key) || "{}");
      sessionStorage.setItem(
        key,
        JSON.stringify({ ...cache, pendingAnalysis: submission }),
      );
    } catch {}
    try {
      const r = await api.studio.analyzePlan(
        templateId,
        submission.plan_id,
        submission.body,
      );
      setPendingAnalysis(null);
      setAnalysis(r.analysis);
      if (r.analysis.status === "succeeded") {
        await loadPlan(submission.plan_id);
        if (!r.analysis.progress?.review_required) setStep(3);
      }
    } catch (e) {
      if (e.status && e.status < 500) setPendingAnalysis(null);
      throw e;
    } finally {
      setEstimate(null);
    }
  };
  const recoverAnalysis = () => work(() => submitAnalysis(pendingAnalysis));
  const startAnalysis = () =>
    work(async () => {
      const e = estimate;
      if (!e) return;
      await submitAnalysis({
        plan_id: e.plan_id,
        body: {
          expected_revision: e.revision,
          estimate_signature: e.estimate_signature,
          item_ids: e.item_ids,
          request_key: e.request_key,
          confirm: true,
        },
      });
    });
  useEffect(() => {
    if (!plan || analysis?.status !== "running") return;
    let stopped = false;
    let timer;
    const poll = async () => {
      try {
        const r = await api.studio.planAnalysis(
          templateId,
          plan.id,
          analysis.id,
        );
        if (stopped) return;
        setAnalysis(r.analysis);
        if (r.analysis.status !== "running") {
          if (r.analysis.status === "succeeded") {
            if (!r.analysis.progress?.review_required)
              setStep((current) => (current === 2 ? 3 : current));
            await loadPlan(plan.id);
          }
          return;
        }
      } catch (e) {
        if (!stopped) setError(e.message);
      }
      if (!stopped) timer = setTimeout(poll, 900);
    };
    poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [analysis?.id, analysis?.status, plan?.id]);
  const selected =
    content?.items.filter((i) => i.selected && i.status === "ready") || [];
  const selectedModel = models.find((m) => m.id === input.model_id);
  let readiness = "";
  if (editingPrompt) readiness = "请先完成提示词编辑";
  else if (content?.items.some((i) => i.selected && i.prompt_stale))
    readiness = "手工提示词的上游内容已变化，请同步或确认保留";
  else if (!selectedModel) readiness = "请选择有效图片模型";
  else if (
    selected.some(
      (i) => !sizeAllowed(selectedModel.capabilities, i.size || input.size),
    )
  )
    readiness = "请调整尺寸以符合当前模型限制";
  else if (
    selected.some(
      (i) =>
        !imageTaskAllowed(selectedModel.capabilities, i.reference_ids.length),
    )
  )
    readiness = "请调整参考数量或选择兼容模型";
  else if (
    selected.some(
      (i) =>
        (i.quality || input.quality) &&
        !selectedModel.capabilities.qualities?.some(
          (q) => q.value === (i.quality || input.quality),
        ),
    )
  )
    readiness = "请选择有效质量档位";
  else {
    try {
      for (const i of selected) normalizeCamera(i.camera);
    } catch (e) {
      readiness = e.message;
    }
  }
  const designVersion = data?.versions.find((v) => v.id === versionId);
  if (
    ["free_design", "recolor", "detail_modify"].includes(input.op) &&
    !designVersion?.parent_id
  )
    readiness = "请先在款式属性中另存设计变化";
  else if (
    !["create", "free_design"].includes(input.op) &&
    selected.some(
      (i) => i.module_id !== "transition" && !i.reference_ids.length,
    )
  )
    readiness = "请选择款式主体参考图";
  else if (input.op === "scene" && !input.requirements.trim())
    readiness = "请描述想要的场景";
  const localSignature = sign(input, content);
  useEffect(() => {
    setQuote(null);
    if (
      step !== 3 ||
      (!plan && !retryJobId) ||
      (!retryJobId && (changed || !selected.length || !!readiness)) ||
      ["running", "queued"].includes(job?.status) ||
      ["running", "uncertain"].includes(analysis?.status) ||
      pending ||
      pendingAnalysis
    )
      return;
    const c = new AbortController();
    setQuoteBusy(true);
    const timer = setTimeout(async () => {
      try {
        const r = retryJobId
          ? await api.studio.styleRetry(templateId, retryJobId, {
              signal: c.signal,
            })
          : await api.studio.planQuote(
              templateId,
              plan.id,
              {
                expected_revision: plan.revision,
                item_ids: selected.map((i) => i.id),
              },
              { signal: c.signal },
            );
        if (!c.signal.aborted) {
          setQuote(r.quote);
          quoteKey.current = crypto.randomUUID();
        }
      } catch (e) {
        if (!c.signal.aborted) setError(e.message);
      } finally {
        if (!c.signal.aborted) setQuoteBusy(false);
      }
    }, 450);
    return () => {
      c.abort();
      clearTimeout(timer);
      setQuoteBusy(false);
    };
  }, [
    step,
    plan?.revision,
    plan?.id,
    localSignature,
    changed,
    job?.status,
    analysis?.status,
    quoteRetry,
    pending,
    retryJobId,
    readiness,
    pendingAnalysis,
  ]);
  useEffect(() => {
    if (!quote) return;
    const timer = setTimeout(
      () => {
        setQuote(null);
        setQuoteRetry((n) => n + 1);
      },
      Math.max(0, quote.expires_at - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [quote]);
  const startGeneration = () =>
    work(async () => {
      if (
        !pending &&
        (refs.current.editingPrompt || changed || readiness || !quote)
      )
        throw new Error("请完成编辑、保存并重新确认报价");
      const body = pending || {
        quote_id: quote.id,
        request_key: quoteKey.current,
        confirm: true,
      };
      setPending(body);
      try {
        const cache = JSON.parse(sessionStorage.getItem(key) || "{}");
        sessionStorage.setItem(
          key,
          JSON.stringify({
            ...cache,
            pending: body,
            planId: refs.current.plan?.id,
          }),
        );
      } catch {}
      try {
        const r = await api.studio.styleStart(templateId, body);
        setPending(null);
        setJob(r.job);
        setStep(4);
        onChanged?.();
      } catch (e) {
        if (e.status && e.status < 500) {
          setPending(null);
          setQuote(null);
        }
        throw e;
      }
    });
  useEffect(() => {
    if (!job || !["running", "queued"].includes(job.status)) return;
    let stopped = false,
      timer;
    const poll = async () => {
      try {
        const r = await api.studio.styleProgress(templateId, {
          [job.id]: job.revision || "",
        });
        if (stopped) return;
        const update = r.jobs.find((j) => j.id === job.id);
        if (update) {
          setJob((old) => ({
            ...old,
            ...update,
            snapshot: old.snapshot,
            renders: update.renders,
          }));
          if (!["running", "queued"].includes(update.status)) {
            onChanged?.();
            setStep((current) => (current === 4 ? 5 : current));
            return;
          }
        }
      } catch (e) {
        if (!stopped) setError(e.message);
      }
      if (!stopped) timer = setTimeout(poll, 1000);
    };
    poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [job?.id, job?.status, job?.revision]);
  const selectVersion = async (id) => {
    await flush();
    setVersionId(Number(id));
    setPlan(null);
    setContent(null);
    setAnalysis(null);
    setQuote(null);
    saved.current = "";
    createKey.current = crypto.randomUUID();
    setStep(1);
    await refresh(Number(id));
  };
  const newRound = () => {
    setRetryJobId(null);
    setJob(null);
    setPending(null);
    setStep(2);
    setQuote(null);
  };
  const beginNewPlan = async (next) => {
    await flush();
    setPlan(null);
    setContent(null);
    setAnalysis(null);
    setQuote(null);
    setEstimate(null);
    saved.current = "";
    createKey.current = crypto.randomUUID();
    setInput(next || refs.current.input);
    setStep(2);
  };
  const openConflict = () =>
    work(async () => {
      let stored;
      try {
        stored = JSON.parse(
          sessionStorage.getItem(key + ":conflict") || "null",
        );
      } catch {}
      if (!stored)
        stored = {
          base: JSON.parse(saved.current),
          local: {
            input: refs.current.input,
            content: cleanContent(refs.current.content),
          },
          plan_id: refs.current.plan.id,
        };
      const latest = await api.studio.plan(templateId, stored.plan_id);
      setConflict({
        ...stored,
        remote: {
          input: latest.plan.input,
          content: cleanContent(latest.plan.content),
        },
        revision: latest.plan.revision,
      });
    });
  const resolveConflict = (prefer) =>
    work(async () => {
      const merged = mergeStylePlanDrafts(
        conflict.base,
        conflict.local,
        conflict.remote,
        prefer,
      );
      const result = await api.studio.updatePlan(templateId, conflict.plan_id, {
        expected_revision: conflict.revision,
        input: merged.input,
        content: merged.content,
      });
      adopt(result.plan);
      setConflict(null);
    });
  return {
    editingPrompt,
    setEditingPrompt,
    conflict,
    openConflict,
    resolveConflict,
    closeConflict: () => setConflict(null),
    readiness,
    retryJobId,
    cancelRetry: () => {
      setRetryJobId(null);
      setQuote(null);
    },
    prepareRetry: (id) =>
      work(async () => {
        await flush();
        setRetryJobId(id);
        setStep(3);
      }),
    beginNewPlan,
    data,
    setData,
    versionId,
    setVersionId,
    plan,
    input,
    setInput,
    content,
    setContent,
    step,
    setStep,
    analysis,
    setAnalysis,
    job,
    setJob,
    busy,
    saving,
    error,
    setError,
    saveError,
    setSaveError,
    models,
    chatModels,
    modelError,
    retryModels: () => setModelRetry((n) => n + 1),
    quote,
    quoteBusy,
    refreshQuote: () => setQuoteRetry((n) => n + 1),
    estimate,
    setEstimate,
    pending,
    pendingAnalysis,
    recoverAnalysis,
    ready,
    changed,
    adopt,
    loadPlan,
    refresh,
    flush,
    ensurePlan,
    work,
    prepareAnalysis,
    startAnalysis,
    startGeneration,
    selectVersion,
    newRound,
    selected,
    key,
  };
}
