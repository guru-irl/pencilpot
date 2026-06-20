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

// ── Module-level singleton state ────────────────────────────────────────────
let _dir = null;        // absolute path of the managed (open) design dir
let _store = null;      // in-memory parts { manifest, pages, components, media }
let _dirty = false;     // unsaved edits present?
let _revn = 0;          // last applied revision (for diagnostics / status)
let _savedRevn = 0;     // revision last flushed to disk

/** Bind the working copy to the open design dir (called once at server start). */
export function initWorktree(dir) {
  _dir = dir;
  _store = null;
  _dirty = false;
  _revn = 0;
  _savedRevn = 0;
}

/**
 * Return the store parts for `dir`.  For the managed design dir this is the
 * in-memory working copy (lazily loaded from disk on first use); for any other
 * dir it reads straight from disk.
 */
export function getStore(dir) {
  if (dir !== _dir) return readDesign(dir);
  if (!_store) _store = readDesign(dir);
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
  _store = parts;
  _dirty = true;
  if (typeof revn === "number") _revn = revn;
}

/** Flush the working copy to disk.  Returns the new status. */
export function save() {
  if (!_dir) return { saved: false, dirty: _dirty, revn: _revn };
  if (!_store) return { saved: true, dirty: false, revn: _revn }; // nothing edited
  writeDesign(_dir, _store);
  _dirty = false;
  _savedRevn = _revn;
  return { saved: true, dirty: false, revn: _revn };
}

/** Drop the in-memory buffer and reload from disk (revert all unsaved edits). */
export function discard() {
  _store = _dir ? readDesign(_dir) : null;
  _dirty = false;
  return { discarded: true, dirty: false, revn: _savedRevn };
}

/** Current dirty/revision status. */
export function status() {
  return { dirty: _dirty, revn: _revn, savedRevn: _savedRevn, design: _dir };
}
