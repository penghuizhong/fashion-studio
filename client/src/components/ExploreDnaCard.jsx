import { fmtDnaValue } from './DnaFields.js';
export default function DnaCard({ dna, rationale, checked, onToggle, fields, index, axes, differences }) {
  const list = Array.isArray(fields) && fields.length ? fields : [];
  return (
    <div
      className={`explore-dna-card${checked ? ' checked' : ''}`}
      onClick={onToggle}
      tabIndex={0} role="group" aria-label={`方案 ${index + 1}`}
      onKeyDown={(e) => { if (e.target === e.currentTarget && ["Enter", " "].includes(e.key)) { e.preventDefault(); onToggle(); } }}
    >
      <label className="explore-check" onClick={(e) => e.stopPropagation()}>
        <input
          type="checkbox" aria-label={`选择方案 ${index + 1}`}
          checked={!!checked}
          onChange={onToggle}
          onClick={(e) => e.stopPropagation()}
        />
      </label>
      <strong>方案 {index + 1} · {fmtDnaValue(dna?.[axes[0]]?.value).slice(0, 20)}{checked ? " · 已选择" : ""}</strong>
      {rationale && <p>{rationale}</p>}
      <div className="explore-dna-fields">
        {list.filter(f => differences ? differences.includes(f.key) : axes.includes(f.key)).map(({ key, label }) => {
          const f = (dna || {})[key] || {};
          const low =
            Number(f.confidence) < 0.75 && f.value !== '' && f.value != null;
          return (
            <div className="explore-dna-row" key={key}>
              <span className="dim">{label}</span>
              <span className={low ? 'low-conf' : ''}>
                {fmtDnaValue(f.value)}{low ? '（待确认）' : ''}
              </span>
            </div>
          );
        })}
      </div>
      <details onClick={e => e.stopPropagation()}><summary>展开完整 DNA</summary>
        {list.map(f => <p key={f.key}>{f.label}：{fmtDnaValue(dna?.[f.key]?.value)}</p>)}
      </details>
    </div>
  );
}

