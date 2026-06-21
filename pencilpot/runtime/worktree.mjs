// pencilpot working copy — manual-save model.
//
// Stock pencilpot auto-saves: every update-file RPC writes the design to disk
// immediately.  Instead we keep an in-memory WORKING COPY of the open design and
// only flush it to disk on an explicit Save (Ctrl/Cmd+S), exactly like a text
// editor with an unsaved buffer.
//
//   - update-file (rpc.mjs persistChanges) applies changes to the working copy
//     in memory and marks it dirty — NO disk write.
//   - get-file serves the working copy, so reloading the SPA preserves unsaved
//     edits as long as the runtime process is alive.
//   - save() flushes the working copy to disk and clears dirty.
//   - discard() drops the buffer and reloads from disk (revert).
//
// Only the single OPEN design dir is managed in memory.  Any other dir (linked
// shared libraries, read-only) always reads straight from disk.

import { readDesign, writeDesign } from "../store/index.mjs";
import { stripPositionData, normalizeEdnWhitespace, stripRevn } from "../store/edn.mjs";
import crypto from "node:crypto";

/**
 * Stable CONTENT signature of a serialized working copy.  Order-independent
 * over the `pages`/`components` maps so two stores with the same content but
 * different key ordering hash identically.  Each component is canonicalized to
 * its user content before hashing:
 *
 *   - `:position-data` is stripped: derived text-layout cache (recomputed on
 *     every render), never a user edit.
 *   - manifest `:revn` is stripped: a monotonic counter bumped on every
 *     update-file (incl. the no-op update-file the SPA emits on OPEN), so it
 *     reflects activity, not content.
 *   - inter-token whitespace is normalized: the saved baseline is read as raw
 *     on-disk EDN text while a staged copy is freshly serialized by the engine,
 *     and those two serializers differ in insignificant whitespace (e.g. the
 *     blank-line residue writeDesign leaves when stripping :position-data).
 *     Without this, identical content hashes differently and a design opens
 *     spuriously "dirty".
 *
 * `media` is intentionally EXCLUDED: media binaries are disk-managed out-of-band
 * (written directly by the upload RPC / import, never staged through the working
 * copy).  The saved baseline derives media from disk filenames (readDesign) while
 * a staged copy derives it from the file's :media registry (serializeStore), which
 * is empty for these designs — folding media here would couple two divergent
 * sources and spuriously mark every design with on-disk media dirty on first
 * stage.  Any real image add/replace already dirties via the page EDN's
 * :fill-image :id change.
 */
function computeSig(parts) {
  if (!parts) return "";
  const canon = (edn) => normalizeEdnWhitespace(stripPositionData(edn || ""));
  const norm = {
    manifest: normalizeEdnWhitespace(stripRevn(parts.manifest || "")),
    pages: Object.keys(parts.pages || {}).sort().map((k) => [k, canon(parts.pages[k])]),
    components: Object.keys(parts.components || {}).sort().map((k) => [k, canon(parts.components[k])]),
  };
  return crypto.createHash("sha1").update(JSON.stringify(norm)).digest("hex");
}

// ── Module-level singleton state ────────────────────────────────────────────
let _dir = null;        // absolute path of the managed (open) design dir
let _store = null;      // in-memory parts { manifest, pages, components, media }
let _dirty = false;     // unsaved edits present?
let _revn = 0;          // last applied revision (for diagnostics / status)
let _savedRevn = 0;     // revision last flushed to disk
let _savedSig = "";     // content signature of the last-saved (on-disk) working copy

/** Bind the working copy to the open design dir (called once at server start). */
export function initWorktree(dir) {
  _dir = dir;
  _store = null;
  _dirty = false;
  _revn = 0;
  _savedRevn = 0;
  _savedSig = "";
}

/**
 * Return the store parts for `dir`.  For the managed design dir this is the
 * in-memory working copy (lazily loaded from disk on first use); for any other
 * dir it reads straight from disk.
 */
export function getStore(dir) {
  if (dir !== _dir) return readDesign(dir);
  if (!_store) {
    _store = readDesign(dir);
    _savedSig = computeSig(_store);   // freshly-read disk content is the saved baseline
  }
  return _store;
}

/**
 * Stage applied changes into the working copy (in memory) without touching disk.
 * `parts` is the freshly serialized store; `revn` the new revision number.
 */
export function stage(dir, parts, revn) {
  if (dir !== _dir) {
    // Non-managed dir mutated (shouldn't happen in normal flow) — write through.
    writeDesign(dir, parts);
    return;
  }
  // Ensure the saved baseline signature is established before comparing.
  if (!_store) {
    _store = readDesign(dir);
    _savedSig = computeSig(_store);
  }
  _store = parts;
  _dirty = computeSig(parts) !== _savedSig;   // dirty only when content actually changed
  if (typeof revn === "number") _revn = revn;
}

/** Flush the working copy to disk.  Returns the new status. */
export function save() {
  if (!_dir) return { saved: false, dirty: _dirty, revn: _revn };
  if (!_store) return { saved: true, dirty: false, revn: _revn }; // nothing edited
  writeDesign(_dir, _store);
  _dirty = false;
  _savedRevn = _revn;
  _savedSig = computeSig(_store);   // the just-written content is now the saved baseline
  return { saved: true, dirty: false, revn: _revn };
}

/** Drop the in-memory buffer and reload from disk (revert all unsaved edits). */
export function discard() {
  _store = _dir ? readDesign(_dir) : null;
  _dirty = false;
  _savedSig = computeSig(_store);   // reloaded disk content is the saved baseline
  return { discarded: true, dirty: false, revn: _savedRevn };
}

/** Current dirty/revision status. */
export function status() {
  return { dirty: _dirty, revn: _revn, savedRevn: _savedRevn, design: _dir };
}
