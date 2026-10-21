// 模型 ID 可搜索下拉（自研，iOS Safari 不支持原生 datalist）
// 输入即筛选，点击选中；无匹配时可直接手动输入
import { useEffect, useRef, useState } from 'react';

export default function ModelPicker({ value, onChange, models, placeholder, openSignal, disabled }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const safeModels = Array.isArray(models) ? models : [];
  const safeValue = value == null ? '' : String(value);

  useEffect(() => {
    if (openSignal && safeModels.length > 0) setOpen(true);
  }, [openSignal, safeModels.length]);

  useEffect(() => {
    if (!open) return;
    const onDocDown = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDocDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const q = safeValue.trim().toLowerCase();
  const filtered = q
    ? safeModels.filter(
        (m) => m && (String(m.id || '').toLowerCase().includes(q) || (m.name && String(m.name).toLowerCase().includes(q)))
      )
    : safeModels;
  const shown = filtered.slice(0, 120);

  return (
    <div className="model-picker" ref={ref}>
      <input
        value={safeValue}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
        }}
        onFocus={() => {
          setOpen(true);
        }}
        placeholder={placeholder}
        spellCheck={false}
        autoComplete="off"
        disabled={disabled}
      />
      {!disabled && open && shown.length > 0 && (
        <ul className="model-dropdown">
          <li className="model-count" onMouseDown={(e) => e.preventDefault()}>
            {q ? `匹配 ${filtered.length} 个` : `共 ${safeModels.length} 个可用模型，输入筛选`}
          </li>
          {shown.map((m) => (
            <li
              key={m.id}
              onMouseDown={(e) => {
                e.preventDefault();
                onChange(m.id);
                setOpen(false);
              }}
            >
              <span className="model-id">{m.id}</span>
              {m.name && m.name !== m.id && <span className="model-name">{m.name}</span>}
            </li>
          ))}
        </ul>
      )}
      {!disabled && open && safeModels.length > 0 && shown.length === 0 && (
        <ul className="model-dropdown">
          <li className="model-empty" onMouseDown={(e) => e.preventDefault()}>
            无匹配模型，可直接手动输入
          </li>
        </ul>
      )}
    </div>
  );
}
