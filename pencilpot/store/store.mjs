import fs from "node:fs";
import path from "node:path";

// parts = { manifest: edn-str, pages: {id: edn}, components: {id: edn}, media: [id…] }
export function writeDesign(dir, parts) {
  fs.mkdirSync(path.join(dir, "pages"), { recursive: true });
  fs.mkdirSync(path.join(dir, "components"), { recursive: true });
  fs.mkdirSync(path.join(dir, "media"), { recursive: true });
  fs.writeFileSync(path.join(dir, "manifest.edn"), parts.manifest);
  for (const [id, edn] of Object.entries(parts.pages)) fs.writeFileSync(path.join(dir, "pages", `${id}.edn`), edn);
  for (const [id, edn] of Object.entries(parts.components)) fs.writeFileSync(path.join(dir, "components", `${id}.edn`), edn);
  prune(path.join(dir, "pages"), new Set(Object.keys(parts.pages).map((i) => `${i}.edn`)));
  prune(path.join(dir, "components"), new Set(Object.keys(parts.components).map((i) => `${i}.edn`)));
}

function prune(d, keep) {
  if (!fs.existsSync(d)) return;
  for (const f of fs.readdirSync(d)) if (f.endsWith(".edn") && !keep.has(f)) fs.rmSync(path.join(d, f));
}

export function readDesign(dir) {
  return {
    manifest: sanitizeManifestEdn(fs.readFileSync(path.join(dir, "manifest.edn"), "utf8")),
    pages: readEdnDir(path.join(dir, "pages")),
    components: readEdnDir(path.join(dir, "components")),
    media: [],
  };
}

/**
 * Strip unrecognized EDN tagged literals from the manifest before passing to the CLJS
 * reader, which only knows #uuid.  Currently handles #penpot/tokens-lib (TokensLib record).
 *
 * Replaces:  :tokens-lib\n #penpot/tokens-lib {…},
 * with:      :tokens-lib nil,
 *
 * Uses a balanced-bracket scan to find the end of the tagged value, correctly handling
 * nested {}, [], #{} — so it's robust even when token data contains nested structures.
 */
function sanitizeManifestEdn(edn) {
  // Pattern: the tag may appear as "#penpot/tokens-lib" followed by whitespace then a value.
  // The value is always a map `{...}` (possibly with nested #{}, [], {}).
  const TAG = "#penpot/tokens-lib";
  const idx = edn.indexOf(TAG);
  if (idx === -1) return edn;

  // Find the start of the tagged value (skip whitespace after the tag).
  let i = idx + TAG.length;
  while (i < edn.length && /\s/.test(edn[i])) i++;

  // Scan to end of the balanced value (could be {, [, or #{).
  const end = findBalancedEnd(edn, i);
  if (end === -1) return edn; // safety: leave as-is if we can't parse

  // Replace everything from "#penpot/tokens-lib" through the closing delimiter with "nil".
  return edn.slice(0, idx) + "nil" + edn.slice(end);
}

/**
 * Find the index of the character AFTER the EDN value starting at `start`.
 * Handles {}, [], #{} (sets), strings, and ignores characters inside strings.
 */
function findBalancedEnd(s, start) {
  const opens  = new Map([["{"  , "}"], ["[", "]"], ["(", ")"]]);
  const closes = new Set(["}", "]", ")"]);
  const stack  = [];
  let i = start;

  while (i < s.length) {
    const ch = s[i];

    // Skip EDN strings (double-quoted).
    if (ch === '"') {
      i++;
      while (i < s.length) {
        if (s[i] === "\\") { i += 2; continue; }
        if (s[i] === '"') { i++; break; }
        i++;
      }
      if (stack.length === 0) return i; // bare string value (shouldn't happen here)
      continue;
    }

    // Handle #{ — it's a set opener; push the expected closer }.
    if (ch === "#" && i + 1 < s.length && s[i + 1] === "{") {
      stack.push("}");
      i += 2;
      continue;
    }

    if (opens.has(ch)) {
      stack.push(opens.get(ch));
      i++;
      continue;
    }

    if (closes.has(ch)) {
      if (stack.length === 0) return i; // past the value
      const expected = stack.pop();
      if (ch !== expected) return -1; // malformed
      i++;
      if (stack.length === 0) return i; // value complete
      continue;
    }

    // Scalar value (number, keyword, symbol, nil, …): end at whitespace or delimiter.
    if (stack.length === 0) {
      while (i < s.length && !/[\s,\}\]\)]/.test(s[i])) i++;
      return i;
    }

    i++;
  }
  return stack.length === 0 ? i : -1;
}

function readEdnDir(d) {
  const out = {};
  if (!fs.existsSync(d)) return out;
  for (const f of fs.readdirSync(d).filter((x) => x.endsWith(".edn"))) out[f.replace(/\.edn$/, "")] = fs.readFileSync(path.join(d, f), "utf8");
  return out;
}
