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

/**
 * Canonicalize EDN whitespace to a CONTENT-only form: collapse every run of
 * insignificant whitespace to the minimal separator and drop whitespace that is
 * adjacent to a structural delimiter `{}[]()`.  In EDN the comma is whitespace,
 * so it is folded too.  Whitespace inside `"…"` string literals is preserved
 * verbatim (escaped quotes `\"` are honoured so a string is never closed early);
 * an outside-string char literal (`\x`) is also passed through so its following
 * char is never mistaken for a separator.
 *
 * Rationale: the dirty signature compares the on-disk EDN text (read verbatim)
 * against the engine's freshly serialized text.  Different serializers disagree
 * on insignificant formatting — comma vs no-comma map separators, spacing around
 * braces, and the blank-line residue writeDesign leaves when stripping
 * :position-data — so identical CONTENT would otherwise hash differently and
 * spuriously mark a design dirty.  None of that formatting is significant in EDN,
 * so normalizing it makes the signature robust to any disk-vs-engine drift.
 *
 * A canonical separator space is emitted only BETWEEN two non-delimiter tokens
 * (where it is needed to keep them apart); whitespace touching a delimiter is
 * dropped.  Thus `{:id 1, :name "x"}` and `{ :id 1 :name "x" }` both canonicalize
 * to `{:id 1 :name "x"}`.
 */
export function normalizeEdnWhitespace(edn) {
  if (!edn) return edn;
  const Q = '"';
  const isWs = (c) => c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f" || c === ",";
  const isDelim = (c) => c === "{" || c === "}" || c === "[" || c === "]" || c === "(" || c === ")";
  let out = "";
  let i = 0;
  let inStr = false;
  while (i < edn.length) {
    const c = edn[i];
    if (inStr) {
      out += c;
      if (c === "\\") { out += edn[i + 1] ?? ""; i += 2; continue; }
      if (c === Q) inStr = false;
      i++;
      continue;
    }
    if (c === Q) { inStr = true; out += c; i++; continue; }
    if (c === "\\") { out += c + (edn[i + 1] ?? ""); i += 2; continue; } // char literal
    if (isWs(c)) {
      let j = i; while (j < edn.length && isWs(edn[j])) j++;
      const prev = out.length ? out[out.length - 1] : "";
      const next = j < edn.length ? edn[j] : "";
      // separator space only when BOTH neighbours are real tokens; whitespace
      // adjacent to a structural delimiter (or at the ends) is insignificant.
      if (prev && next && !isDelim(prev) && !isDelim(next)) out += " ";
      i = j; continue;
    }
    out += c; i++;
  }
  return out;
}

/**
 * Remove the manifest revision counter (`:revn <int>` → `:revn`).
 *
 * `:revn` is a monotonic bookkeeping counter bumped on every update-file —
 * including the no-op `update-file` the SPA emits on open — so it must not count
 * toward the content signature, exactly like `:position-data`.  Leaves `:vern`
 * and all other keys untouched.
 */
export function stripRevn(edn) {
  if (!edn) return edn;
  return edn.replace(/:revn\s+\d+/, ":revn");
}
