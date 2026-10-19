import { getDb } from "./db.js";
import { getConfig } from "./config.js";
import { getPreset } from "./dnaPresets.js";
import { problem } from "./exploreErrors.js";
const now = () => new Date().toISOString();
export const parse = (s, f = {}) => {
  try {
    return JSON.parse(s);
  } catch {
    return f;
  }
};
export const canonical = (value) => JSON.stringify(sort(value));
function sort(v) {
  return Array.isArray(v)
    ? v.map(sort)
    : v && typeof v === "object"
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, sort(v[k])]),
        )
      : v;
}
export function styleTemplate(id, req) {
  const db = getDb();
  const t = getConfig().multiUser
    ? db
        .prepare("SELECT * FROM style_dna_templates WHERE id=? AND user_id=?")
        .get(id, req.userId || "local")
    : db.prepare("SELECT * FROM style_dna_templates WHERE id=?").get(id);
  if (!t || t.lifecycle==='deleted') throw problem("TEMPLATE_NOT_FOUND", "款式不存在", 404);
  return ensureStyle(t);
}
export function ensureStyle(t) {
  const db = getDb();
  if (t.work_version_id) return t;
  return db.transaction(() => {
    const fresh = db
      .prepare("SELECT * FROM style_dna_templates WHERE id=?")
      .get(t.id);
    if (fresh.work_version_id) return fresh;
    const root = db
      .prepare(
        "INSERT INTO style_versions(template_id,number,parent_id,dna_json,schema_json,preset_id,category,summary,status,created_at,design_note) VALUES(?,1,NULL,?,?,?,?,?,?,?,?)",
      )
      .run(
        t.id,
        t.dna_json,
        JSON.stringify(
          getPreset(t.preset_id)?.fields ||
            Object.keys(parse(t.dna_json)).map((key) => ({ key, label: key })),
        ),
        t.preset_id || "",
        t.category || "",
        "初始属性快照（既有图片未记录历史属性）",
        t.status,
        now(),
        t.initial_design_note || "",
      );
    const cover = db
      .prepare(
        "SELECT id FROM dna_generations WHERE template_id=? AND COALESCE(user_rating,'')!='deleted' ORDER BY id DESC LIMIT 1",
      )
      .get(t.id);
    db.prepare(
      "UPDATE style_dna_templates SET work_version_id=?,cover_generation_id=? WHERE id=?",
    ).run(root.lastInsertRowid, cover?.id || null, t.id);
    return db.prepare("SELECT * FROM style_dna_templates WHERE id=?").get(t.id);
  })();
}
export function styleVersion(t, id) {
  const v = getDb()
    .prepare("SELECT * FROM style_versions WHERE id=? AND template_id=?")
    .get(id || t.work_version_id, t.id);
  if (!v) throw problem("VERSION_NOT_FOUND", "设计版本不存在", 404);
  return v;
}
export function saveVersion(t, b) {
  const db = getDb();
  if (!/^[\w-]{8,100}$/.test(b.request_key || ""))
    throw problem("INVALID_REQUEST_KEY", "保存版本需要请求标识");
  const parent = styleVersion(t, b.parent_id);
  const dna = b.dna;
  if (!dna || typeof dna !== "object" || Array.isArray(dna))
    throw problem("INVALID_DNA", "属性格式不正确");
  const preset = getPreset(parent.preset_id),
    allowed = new Set(Object.keys(parse(parent.dna_json)));
  const previous = parse(parent.dna_json),
    next = {},
    changes = [];
  if (
    canonical(Object.keys(dna).sort()) !==
    canonical(Object.keys(previous).sort())
  )
    throw problem("INVALID_DNA", "属性字段须完整保留");
  for (const [key, f] of Object.entries(dna)) {
    if (
      !allowed.has(key) ||
      !f ||
      typeof f !== "object" ||
      (!["string", "number"].includes(typeof f.value) &&
        !Array.isArray(f.value))
    )
      throw problem("INVALID_DNA", "属性字段或值不正确");
    if (Array.isArray(f.value) && f.value.some((v) => typeof v !== "string"))
      throw problem("INVALID_DNA", "细节必须为文字列表");
    if (JSON.stringify(f.value).length > 2000)
      throw problem("INVALID_DNA", "单项属性内容过长");
    const changed = canonical(f.value) !== canonical(previous[key]?.value);
    next[key] = changed
      ? {
          value: f.value,
          confidence: previous[key]?.confidence ?? null,
          confirmed: true,
          provenance: "manual",
        }
      : previous[key];
    if (changed)
      changes.push({ key, before: previous[key]?.value, after: f.value });
  }
  if(b.design_note!==undefined && typeof b.design_note!=='string')throw problem('INVALID_INSTRUCTION','设计要求必须是文字');
  const note = b.design_note === undefined ? (parent.design_note||'') : String(b.design_note).trim();
  if(note.length>1200)throw problem('INVALID_INSTRUCTION','设计要求限1200字');
  if(note!==(parent.design_note||''))changes.push({key:'design_note',before:parent.design_note||'',after:note});
  const signature = canonical({ parent_id: parent.id, dna: next, design_note:note });
  return db.transaction(() => {
    const prior = db
      .prepare(
        "SELECT * FROM style_version_requests WHERE template_id=? AND request_key=?",
      )
      .get(t.id, b.request_key);
    if (prior) {
      if (prior.signature !== signature)
        throw problem("IDEMPOTENCY_CONFLICT", "此请求标识已用于其他修改", 409);
      return styleVersion(t, prior.version_id);
    }
    let id = parent.id;
    if (changes.length) {
      const number = db
        .prepare(
          "SELECT COALESCE(MAX(number),0)+1 AS n FROM style_versions WHERE template_id=?",
        )
        .get(t.id).n;
      const r = db
        .prepare(
          "INSERT INTO style_versions(template_id,number,parent_id,dna_json,schema_json,preset_id,category,summary,status,created_at,design_note) VALUES(?,?,?,?,?,?,?,?,'draft',?,?)",
        )
        .run(
          t.id,
          number,
          parent.id,
          JSON.stringify(next),
          parent.schema_json,
          parent.preset_id,
          parent.category,
          JSON.stringify(changes),
          now(),
          note,
        );
      id = r.lastInsertRowid;
    }
    db.prepare("INSERT INTO style_version_requests VALUES(?,?,?,?)").run(
      t.id,
      b.request_key,
      signature,
      id,
    );
    return styleVersion(t, id);
  })();
}
export function setWorking(t, id) {
  const v = styleVersion(t, id);
  getDb()
    .prepare(
      "UPDATE style_dna_templates SET work_version_id=?,dna_json=?,preset_id=?,category=?,status=?,updated_at=? WHERE id=?",
    )
    .run(v.id, v.dna_json, v.preset_id, v.category, v.status, now(), t.id);
  return v;
}
export function recordStyleImage(context, result, itemId) {
  const db = getDb();
  const prior = db
    .prepare("SELECT id FROM dna_generations WHERE task_item_id=?")
    .get(itemId);
  if (prior) return prior.id;
  const r = db
    .prepare(
      "INSERT INTO dna_generations(template_id,user_id,image_path,thumb_path,prompt_snapshot,seed,model_id,size,op,created_at,design_version_id,source_generation_id,task_item_id,settings_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    )
    .run(
      context.template_id,
      context.user_id,
      result.image_path,
      result.thumb_path,
      result.prompt_snapshot,
      result.seed,
      result.model,
      result.size,
      context.op,
      now(),
      context.version_id,
      context.source_generation_id || null,
      itemId,
      JSON.stringify(context),
    );
  return Number(r.lastInsertRowid);
}
