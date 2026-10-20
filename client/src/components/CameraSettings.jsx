import { CAMERA_OPTIONS, DEFAULT_CAMERA } from "../../../shared/photography.js";
export default function CameraSettings({
  value = DEFAULT_CAMERA,
  onChange,
  disabled = false,
  scope = "batch",
}) {
  const set = (key, val) => {
    const next = { ...value, [key]: val };
    if (key === "display") {
      next.angle = val === "flat" ? "overhead" : "level";
      if (val === "flat") {
        next.view = "front";
        if (next.framing === "outfit") next.framing = "garment";
      }
    }
    if (key === "framing" && val !== "detail") next.detail = "";
    onChange(next);
  };
  const labels = {
    display: "展示方式",
    view: "服装朝向",
    angle: "拍摄角度",
    framing: "取景范围",
    scale: "主体大小",
    scope: "展示范围",
  };
  return (
    <fieldset className="camera-settings" disabled={disabled}>
      <legend>视角与取景</legend>
      <p className="dim small">
        {scope === "item"
          ? "本图单独设置视角与取景，其他模块可使用不同景别。模型仍可能偏离要求。"
          : "标准款式对比默认正面平视、完整单品、居中留白。同批图片共用设置，模型仍可能偏离要求。"}
      </p>
      <div className="camera-controls">
        {Object.entries(CAMERA_OPTIONS).map(([key, options]) => (
          <label key={key}>
            {labels[key]}
            <select
              aria-label={labels[key]}
              value={value[key]}
              onChange={(e) => set(key, e.target.value)}
            >
              {options.map(([v, label]) => (
                <option
                  key={v}
                  value={v}
                  disabled={
                    (value.display === "flat" &&
                      ((key === "view" && v !== "front") ||
                        (key === "angle" && v !== "overhead") ||
                        (key === "framing" && v === "outfit"))) ||
                    (value.display !== "flat" &&
                      key === "angle" &&
                      v === "overhead")
                  }
                >
                  {label}
                </option>
              ))}
            </select>
          </label>
        ))}
      </div>
      {value.framing === "detail" && (
        <label>
          特写部位
          <input
            className="text-input"
            aria-label="特写部位"
            maxLength={160}
            value={value.detail}
            onChange={(e) => set("detail", e.target.value)}
            placeholder="例如：左袖口、领口走线"
          />
        </label>
      )}
      <p className="dim small">
        上衣保留袖口与下摆，裤装保留腰头与裤脚，裙装保留完整裙摆。局部特写不会展示整件服装。
      </p>
    </fieldset>
  );
}
