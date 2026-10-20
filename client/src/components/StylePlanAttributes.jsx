import { useEffect, useRef, useState } from "react";
import { api } from "../api.js";
import { fmtDnaValue } from "./DnaFields.js";
import { mergeRecords } from "./useWorkspaceCollections.jsx";
const parse = (s, f = {}) => {
  try {
    return JSON.parse(s);
  } catch {
    return f;
  }
};
export default function StylePlanAttributes({ w, onDirty, onSaved }) {
  const { data, versionId, work } = w,
    version = data?.versions.find((v) => v.id === versionId);
  const draftKey = `${w.key}:attributes`;
  const [draft, setDraft] = useState(null),
    [note, setNote] = useState(""),
    [parent, setParent] = useState(null),
    [showVersions, setShowVersions] = useState(false),
    [page, setPage] = useState(1),
    [total, setTotal] = useState(0),
    [versionRows, setVersionRows] = useState([]),
    [loading, setLoading] = useState(false),
    [status, setStatus] = useState("");
  const displayedVersion = draft
      ? data?.versions.find((v) => v.id === parent)
      : version,
    dna = parse(displayedVersion?.dna_json),
    fields = parse(displayedVersion?.schema_json, []);
  const request = useRef({ key: "", signature: "" });
  useEffect(() => {
    let saved;
    try {
      saved = JSON.parse(sessionStorage.getItem(draftKey) || "null");
    } catch {}
    if (saved) {
      setDraft(saved.draft);
      setNote(saved.note);
      setParent(saved.parent);
    } else {
      const userKey = w.key.split(":").slice(1, -1).join(":");
      let legacy;
      try {
        legacy = JSON.parse(
          sessionStorage.getItem(
            `style-draft-v1:${userKey}:${data?.template.id}`,
          ) || "null",
        );
      } catch {}
      if (legacy?.draft && legacy.editParent === versionId) {
        setDraft(legacy.draft);
        setNote(version?.design_note || "");
        setParent(versionId);
      } else if (
        !legacy?.wizard_migrated &&
        legacy?.form?.op === "free_design" &&
        legacy.form.instruction?.trim()
      ) {
        setDraft(
          Object.fromEntries(
            Object.entries(dna).map(([k, f]) => [k, fmtDnaValue(f.value)]),
          ),
        );
        setNote(legacy.form.instruction);
        setParent(versionId);
      }
    }
  }, []);
  useEffect(() => {
    onDirty(!!draft);
    try {
      if (draft)
        sessionStorage.setItem(
          draftKey,
          JSON.stringify({ draft, note, parent }),
        );
      else sessionStorage.removeItem(draftKey);
    } catch {}
  }, [draft, note, parent]);
  const start = () => {
    setDraft(
      Object.fromEntries(
        Object.entries(dna).map(([k, f]) => [k, fmtDnaValue(f.value)]),
      ),
    );
    setNote(version.design_note || "");
    setParent(versionId);
  };
  const save = () =>
    work(async () => {
      const original = data.versions.find((v) => v.id === parent);
      if (!original?.dna_json) throw new Error("请重新选择草稿来源版本后保存");
      const before = parse(original.dna_json);
      const next = Object.fromEntries(
        Object.entries(draft).map(([k, value]) => [
          k,
          {
            ...before[k],
            value: Array.isArray(before[k]?.value)
              ? value
                  .split(/[、,，]/)
                  .map((s) => s.trim())
                  .filter(Boolean)
              : value,
          },
        ]),
      );
      const signature = JSON.stringify({ parent, dna: next, note });
      if (request.current.signature !== signature)
        request.current = { key: crypto.randomUUID(), signature };
      const r = await api.studio.saveVersion(data.template.id, {
        parent_id: parent,
        dna: next,
        design_note: note,
        request_key: request.current.key,
      });
      setDraft(null);
      setParent(null);
      try {
        const userKey = w.key.split(":").slice(1, -1).join(":"),
          key = `style-draft-v1:${userKey}:${data.template.id}`,
          legacy = JSON.parse(sessionStorage.getItem(key) || "null");
        if (legacy)
          sessionStorage.setItem(
            key,
            JSON.stringify({
              ...legacy,
              draft: null,
              editParent: null,
              wizard_migrated: true,
            }),
          );
      } catch {}
      onDirty(false);
      await w.selectVersion(r.version.id);
      onSaved?.();
      setStatus(
        r.version.id === parent
          ? "属性没有变化，未新增版本"
          : `已保存为 V${r.version.number}，原属性与图片保留`,
      );
    });
  const loadVersions = async (next) => {
    setLoading(true);
    try {
      const r = await api.studio.workspaceItems(data.template.id, "versions", {
        page: next,
        limit: 20,
      });
      w.setData((d) => ({ ...d, versions: mergeRecords(d.versions, r.items) }));
      setVersionRows((old) =>
        next === 1 ? r.items : mergeRecords(old, r.items),
      );
      setTotal(r.total);
      setPage(next);
    } catch (e) {
      w.setError(e.message);
    } finally {
      setLoading(false);
    }
  };
  const options = data?.versions.filter((v) => v.dna_json) || [];
  return (
    <div className="wizard-attributes">
      <section className="wizard-section">
        <h3>版本选择</h3>
        <label className="style-field">
          设计版本
          <select
            aria-label="设计版本"
            value={versionId || ""}
            disabled={!!draft || w.busy}
            onChange={(e) =>
              w.work(() => w.selectVersion(Number(e.target.value)))
            }
          >
            {options.map((v) => (
              <option key={v.id} value={v.id}>
                V{v.number} · {v.status === "final" ? "已定稿" : "设计中"} ·{" "}
                {new Date(v.created_at).toLocaleDateString()}
              </option>
            ))}
          </select>
        </label>
        <p className="dim small">
          查看版本不会切换工作版本或封面。修改会另存新版本。
        </p>
        <button
          className="btn secondary small"
          aria-expanded={showVersions}
          onClick={() => {
            setShowVersions(!showVersions);
            if (!showVersions) loadVersions(1);
          }}
        >
          浏览版本记录（{data?.totals.versions || 0}）
        </button>
        {showVersions && (
          <div className="wizard-version-list">
            {versionRows.map((v) => (
              <button
                className="btn secondary"
                key={v.id}
                disabled={!!draft}
                onClick={() => w.work(() => w.selectVersion(v.id))}
              >
                <strong>
                  V{v.number}
                  {v.parent_id
                    ? ` · 来自 V${data.versions.find((p) => p.id === v.parent_id)?.number || "历史版"}`
                    : ""}
                </strong>
                <span>
                  {v.summary?.startsWith("[") ? "设计属性已修改" : v.summary}
                </span>
              </button>
            ))}
            {loading && <p role="status">加载版本…</p>}
            {page * 20 < total && (
              <button
                className="btn secondary"
                onClick={() => loadVersions(page + 1)}
              >
                加载更多版本
              </button>
            )}
          </div>
        )}
      </section>
      <section className="wizard-section">
        <div className="wizard-section-head">
          <h3>基础属性</h3>
          {!draft && (
            <button
              className="btn secondary small"
              disabled={!version || w.busy}
              onClick={start}
            >
              基于此版本修改
            </button>
          )}
        </div>
        <p className="dim small">
          {draft
            ? `正在编辑基于 V${data?.versions.find((v) => v.id === parent)?.number} 的新版本草稿`
            : "已保存属性只读；识别信息与人工修正分别保留。"}
        </p>
        <div className="wizard-attribute-fields">
          {Object.entries(dna).map(([key, field]) => (
            <label className="style-field" key={key}>
              {fields.find((f) => f.key === key)?.label || key}
              {draft ? (
                <textarea
                  rows={Array.isArray(field.value) ? 2 : 1}
                  aria-label={`属性${fields.find((f) => f.key === key)?.label || key}`}
                  value={draft[key] || ""}
                  onChange={(e) =>
                    setDraft((old) => ({ ...old, [key]: e.target.value }))
                  }
                />
              ) : (
                <span className="style-value">
                  {fmtDnaValue(field.value)}
                  {field.provenance === "manual" && <small> · 人工确认</small>}
                </span>
              )}
            </label>
          ))}
        </div>
        <label className="style-field">
          设计变化说明
          {draft ? (
            <textarea
              rows={3}
              maxLength={1200}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="例如：换成深蓝色，保留版型；新版本不会覆盖原设计"
            />
          ) : (
            <span className="style-value">
              {version?.design_note || "无额外设计变化"}
            </span>
          )}
        </label>
        {draft && (
          <div className="wizard-inline">
            <button
              className="btn secondary"
              disabled={w.busy}
              onClick={() => {
                setDraft(null);
                onDirty(false);
              }}
            >
              取消修改
            </button>
            <button className="btn primary" disabled={w.busy} onClick={save}>
              保存为新版本
            </button>
          </div>
        )}
        {status && <p role="status">{status}</p>}
        <details>
          <summary>版本操作与识别信息</summary>
          <p className="dim small">
            置信度是识别模型的估计，历史未知信息不会补造。
          </p>
          {Object.entries(dna).map(([key, f]) => (
            <p key={key}>
              {fields.find((a) => a.key === key)?.label || key}：
              {f.confidence == null
                ? "来源未记录"
                : `${Math.round(f.confidence * 100)}%`}
              {f.provenance === "manual" ? " · 人工确认" : ""}
            </p>
          ))}
          <div className="wizard-inline">
            <button
              className="btn secondary small"
              disabled={w.busy}
              onClick={() =>
                work(async () => {
                  await api.studio.setWorking(data.template.id, {
                    version_id: versionId,
                    expected_version_id: data.template.work_version_id,
                  });
                  await w.refresh(versionId);
                })
              }
            >
              设为工作版本
            </button>
            <button
              className="btn secondary small"
              disabled={w.busy}
              onClick={() =>
                work(async () => {
                  await api.studio.versionStatus(
                    data.template.id,
                    versionId,
                    version.status === "final" ? "draft" : "final",
                  );
                  await w.refresh(versionId);
                })
              }
            >
              {version?.status === "final" ? "取消定稿" : "定稿此版本"}
            </button>
          </div>
        </details>
      </section>
    </div>
  );
}
