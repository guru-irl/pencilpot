// Structural diff between two Penpot objects maps (id -> shape).
//
// Used by `pencilpot diff` / the MCP `diff` tool so an AI can see what changed in
// a design since a baseline snapshot — typically the USER's edits made in the open
// SPA while the AI was working. We compare a curated set of SEMANTIC keys (geometry,
// style, content, hierarchy, visibility, name) rather than deep-diffing every key,
// so derived/volatile fields (selrect, points, transform matrices recomputed from
// geometry, browser-only position-data) don't create noise.

// Semantic keys worth reporting when they change. Order = report order.
export const COMPARED_KEYS = [
  "name", "type",
  "x", "y", "width", "height", "rotation", "flip-x", "flip-y",
  "frame-id", "parent-id", "shapes",            // hierarchy / children
  "hidden", "blocked", "opacity", "blend-mode",
  "fills", "strokes", "shadow", "blur",
  "rx", "ry", "r1", "r2", "r3", "r4",           // corner radii
  "constraints-h", "constraints-v", "proportion-lock",
  "layout", "layout-item-h-sizing", "layout-item-v-sizing",
  "content",                                     // text content tree
  "component-id", "component-file", "component-root",
  "fill-color", "stroke-color",
];

function stableStringify(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(stableStringify).join(",") + "]";
  return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + stableStringify(v[k])).join(",") + "}";
}
function eq(a, b) { return stableStringify(a) === stableStringify(b); }

function brief(o) {
  if (!o) return null;
  return { id: o.id, type: o.type, name: o.name ?? null };
}
function clip(v, n = 120) {
  const s = typeof v === "string" ? v : stableStringify(v);
  return s.length > n ? s.slice(0, n) + "…" : s;
}

/**
 * @param {Record<string,object>} before  baseline objects map (id -> shape)
 * @param {Record<string,object>} after   current objects map
 * @param {{keys?:string[]}} [opts]
 * @returns {{added:object[], removed:object[], modified:object[], summary:object}}
 */
export function diffObjects(before = {}, after = {}, opts = {}) {
  const keys = opts.keys || COMPARED_KEYS;
  const beforeIds = new Set(Object.keys(before));
  const afterIds = new Set(Object.keys(after));

  const added = [];
  const removed = [];
  const modified = [];

  for (const id of afterIds) if (!beforeIds.has(id)) added.push(brief(after[id]));
  for (const id of beforeIds) if (!afterIds.has(id)) removed.push(brief(before[id]));

  for (const id of afterIds) {
    if (!beforeIds.has(id)) continue;
    const a = before[id], b = after[id];
    const changes = {};
    for (const k of keys) {
      const had = Object.prototype.hasOwnProperty.call(a, k);
      const has = Object.prototype.hasOwnProperty.call(b, k);
      if (!had && !has) continue;
      if (!eq(a[k], b[k])) changes[k] = { from: had ? clip(a[k]) : undefined, to: has ? clip(b[k]) : undefined };
    }
    if (Object.keys(changes).length) {
      modified.push({ ...brief(b), keys: Object.keys(changes), changes });
    }
  }

  return {
    added, removed, modified,
    summary: { added: added.length, removed: removed.length, modified: modified.length,
               changed: added.length + removed.length + modified.length },
  };
}

/** Human-readable one-line-per-change rendering of a diff result. */
export function formatDiff(d) {
  const lines = [];
  for (const s of d.added)    lines.push(`+ ${s.type} "${s.name ?? ""}" (${String(s.id).slice(0, 8)})`);
  for (const s of d.removed)  lines.push(`- ${s.type} "${s.name ?? ""}" (${String(s.id).slice(0, 8)})`);
  for (const s of d.modified) lines.push(`~ ${s.type} "${s.name ?? ""}" (${String(s.id).slice(0, 8)}) — ${s.keys.join(", ")}`);
  const { added, removed, modified } = d.summary;
  lines.push(`\n${added} added, ${removed} removed, ${modified} modified`);
  return lines.join("\n");
}
