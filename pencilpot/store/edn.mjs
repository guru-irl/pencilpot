// Shared EDN string helpers for the pencilpot store.

/**
 * Strip `:position-data [\u2026]` (and its balanced vector value) from an EDN string.
 *
 * position-data is browser-computed text-layout cache that Penpot recomputes on
 * every text render (see ui/workspace/shapes/text/viewport_texts_html
 * `text-changes-renderer`). It is DERIVED render metadata, not user content, so
 * it must neither count toward the dirty signature nor be persisted to disk.
 * String literals are skipped so brackets inside text never unbalance the scan.
 */
export function stripPositionData(edn) {
  if (!edn || edn.indexOf(":position-data") === -1) return edn;
  const KEY = ":position-data";
  const Q = '"';
  let out = "";
  let i = 0;
  while (i < edn.length) {
    const idx = edn.indexOf(KEY, i);
    if (idx === -1) { out += edn.slice(i); break; }
    out += edn.slice(i, idx);
    let j = idx + KEY.length;
    while (j < edn.length && /\s/.test(edn[j])) j++;
    if (edn[j] !== "[") { out += KEY; i = idx + KEY.length; continue; }
    let depth = 0, inStr = false;
    for (; j < edn.length; j++) {
      const c = edn[j];
      if (inStr) {
        if (c === "\\") { j++; continue; }
        if (c === Q) inStr = false;
      } else if (c === Q) inStr = true;
      else if (c === "[") depth++;
      else if (c === "]" && --depth === 0) { j++; break; }
    }
    i = j;
  }
  return out;
}
