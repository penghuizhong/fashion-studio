// Three-way merge: preserve unrelated remote edits and make same-field conflicts explicit.
const json = (v) => JSON.stringify(v);
export function mergeStylePlanDrafts(base, local, remote, prefer = "local") {
  const conflicts = [];
  const merge = (b, l, r, path) => {
    if (json(l) === json(b)) return r;
    if (json(r) === json(b) || json(l) === json(r)) return l;
    if (
      b &&
      l &&
      r &&
      !Array.isArray(l) &&
      !Array.isArray(r) &&
      typeof l === "object" &&
      typeof r === "object"
    ) {
      const result = {};
      for (const k of new Set([
        ...Object.keys(b),
        ...Object.keys(l),
        ...Object.keys(r),
      ]))
        result[k] = merge(b[k], l[k], r[k], `${path}.${k}`);
      return result;
    }
    conflicts.push({ path, local: l, remote: r });
    return prefer === "local" ? l : r;
  };
  const input = merge(base.input, local.input, remote.input, "需求"),
    standard = merge(
      base.content.standard,
      local.content.standard,
      remote.content.standard,
      "整体规范",
    );
  const bm = new Map(base.content.items.map((i) => [i.id, i])),
    lm = new Map(local.content.items.map((i) => [i.id, i])),
    rm = new Map(remote.content.items.map((i) => [i.id, i]));
  const localOrder = local.content.items.map((i) => i.id),
    order =
      json(localOrder) !== json(base.content.items.map((i) => i.id))
        ? [...localOrder, ...remote.content.items.map((i) => i.id)]
        : remote.content.items.map((i) => i.id).concat(localOrder);
  const items = [];
  for (const id of new Set(order)) {
    const item = merge(bm.get(id), lm.get(id), rm.get(id), `图片 ${id}`);
    if (item) items.push(item);
  }
  return {
    input,
    content: { standard, standard_edited: true, items },
    conflicts,
  };
}
