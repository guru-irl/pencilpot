// Baseline snapshot store for `pencilpot diff`. Persists a captured objects map
// so a later diff can show what changed since (typically the user's SPA edits).
// Stored under the PROJECT root (persistent), never /tmp.
import fs from "node:fs";
import path from "node:path";

function baselinePath(root) { return path.join(root, ".pencilpot", "diff-baseline.json"); }

/** Persist `objectsByPage` ({pageId: {id: shape}}) or a flat objects map as the baseline. */
export function writeBaseline(root, objects, meta = {}) {
  const p = baselinePath(root);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({ at: new Date().toISOString(), ...meta, objects }));
  return p;
}

/** Read the stored baseline, or null if none. */
export function readBaseline(root) {
  const p = baselinePath(root);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
}

export function hasBaseline(root) { return fs.existsSync(baselinePath(root)); }
export { baselinePath };
