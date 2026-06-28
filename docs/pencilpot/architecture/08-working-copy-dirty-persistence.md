# Architecture Note: Phase 4 — Working Copy, Dirty Signature & Persistence

**Status:** Complete.
**Branch:** `pencilpot`
**Locations:** `pencilpot/runtime/worktree.mjs`, `pencilpot/store/edn.mjs`,
`pencilpot/store/store.mjs`, `pencilpot/runtime/rpc.mjs`, `pencilpot/runtime/server.mjs`
**Updated:** Phase 4 (manual-save model; content-only dirty signature; never-persist position-data).

---

## Overview

Stock pencilpot (Phase 1) **auto-saved**: every `update-file` RPC wrote the design to disk
immediately (the revn lifecycle in [01-runtime-store.md](01-runtime-store.md)). Phase 4 replaces that
with a **manual-save model** — an editor with an unsaved buffer:

- `update-file` applies changes to an **in-memory working copy** and marks it dirty; **no disk write**.
- `get-file` serves the working copy, so reloading the SPA preserves unsaved edits while the runtime lives.
- An explicit **Save** (`POST /pencilpot/save`, Ctrl/Cmd+S) flushes the buffer to disk and clears dirty.
- **Discard** (`POST /pencilpot/discard`) drops the buffer and reloads from disk (revert).

Two correctness problems fall out of this model, and most of the code here exists to solve them:

1. **The dirty flag must reflect CONTENT, not activity.** The SPA emits a no-op `update-file` on open,
   and every render recomputes derived text-layout cache — neither is a user edit. Opening a design "to
   look" and closing it must NOT raise a save prompt. → the **content-only dirty signature**.
2. **Derived data must never reach disk.** `:position-data` is browser-computed render cache; persisting
   it bloats diffs and pins stale layout. → **strip on write**.

Only the single OPEN design dir is buffered. Any other dir (linked shared libraries, read-only) always
reads straight from disk.

---

## The Working Copy (`runtime/worktree.mjs`)

A module-level singleton bound once at server start (`server.mjs:54 initWorktree(designDir)`):

```
_dir        absolute path of the managed (open) design dir
_store      in-memory parts { manifest, pages, components, media }   (lazily loaded)
_dirty      unsaved edits present?
_revn       last applied revision (diagnostics / status)
_savedRevn  revision last flushed to disk
_savedSig   content signature of the last-SAVED (on-disk) working copy   ← the dirty oracle
```

### State transitions

```
  initWorktree(dir)            _store=null  _dirty=false  _savedSig=""
        │
        │  getStore(dir)  (first use — lazy load from disk)
        ▼
  _store = readDesign(dir)     _savedSig = computeSig(_store)   ← disk content is the saved baseline
        │
        │  stage(dir, freshParts, revn)         ← from persistChanges, in MEMORY
        ▼
  _store = freshParts          _dirty = computeSig(freshParts) !== _savedSig
        │                                        ↑ dirty ONLY when content actually changed
        │  save()                                  (writeDesign → disk)
        ▼
  _dirty=false  _savedRevn=_revn  _savedSig = computeSig(_store)   ← just-written content is the new baseline
        │
        │  discard()
        ▼
  _store = readDesign(dir)  _dirty=false  _savedSig = computeSig(_store)   ← reloaded disk is the baseline
```

`getStore(dir)` returns the in-memory `_store` for the managed dir (lazy-loading + establishing
`_savedSig` on first touch) and a fresh `readDesign(dir)` for any other dir (`worktree.mjs:83`).
`stage()` (`worktree.mjs:96`) is the only writer of `_dirty`: it **reassigns `_store` to the fresh
parts** and recomputes dirty as `computeSig(parts) !== _savedSig`. `save()` writes through `writeDesign`
and re-baselines `_savedSig`; `discard()` reloads disk and re-baselines. (The `_store` reassignment in
`stage`/`discard` is also what the read-session cache keys on for identity-based invalidation —
`rpc.mjs:53-62`.)

---

## The Persist Path (`runtime/rpc.mjs`)

`update-file` never touches disk. `persistChanges` (`rpc.mjs:118-124`) is the chokepoint:

```
update-file (transit)  ──► updateFile(dir, body)  ──► persistChanges:
                              s = sessionFor(dir)              # fresh hydrated engine session
                              applyFn(s)                       # s.applyTransitUpdate(body)
                              revn = s.bumpRevn()              # N → N+1 in the engine
                              stage(dir, JSON.parse(s.serializeStore()), revn)   # ← IN MEMORY, not disk
                              broadcastStatus(status().dirty, revn)              # ← echo ACTUAL dirty
```

The serialized parts are handed to `stage()`, which recomputes the dirty signature. The dirty echo
broadcast to all windows is `status().dirty` (the recomputed value), **not** an unconditional `true` —
so a no-op or position-data-only `update-file` correctly broadcasts `dirty:false`.

---

## The Content-Only Dirty Signature (`computeSig`, `worktree.mjs:49`)

`_dirty` is derived by comparing a stable hash of the staged store against `_savedSig`. The signature is
**content-only** and **order-independent**:

```
computeSig(parts):
  canon(edn)  = normalizeEdnWhitespace(stripPositionData(edn))
  norm = {
    manifest:   normalizeEdnWhitespace(stripRevn(parts.manifest)),
    pages:      [[id, canon(edn)] … sorted by id],
    components: [[id, canon(edn)] … sorted by id],
  }                                  # media intentionally EXCLUDED
  return sha1(JSON.stringify(norm))
```

Three transforms (all in `store/edn.mjs`) make identical CONTENT hash identically regardless of
incidental representation:

| Transform | Strips | Why it isn't content |
|---|---|---|
| `stripPositionData(edn)` | `:position-data [ … ]` (balanced vector, string-safe scan) | browser-computed text-layout cache, recomputed every render |
| `stripRevn(manifest)` | `:revn <int>` → `:revn` | monotonic counter bumped on every `update-file` incl. the SPA's no-op-on-open |
| `normalizeEdnWhitespace(edn)` | collapses insignificant whitespace; folds EDN commas; drops whitespace adjacent to `{}[]()`; preserves string/char literals | the on-disk baseline is read as raw EDN text while a staged copy is freshly serialized by the engine — the two serializers differ only in insignificant formatting |

**Why all three are needed.** The saved baseline (`_savedSig`) is computed from raw on-disk EDN text
(`readDesign`), while a staged copy is freshly serialized by the engine (`serializeStore`). Those two
producers disagree on (a) the revn counter, (b) comma-vs-space map separators / brace spacing / the
blank-line residue `writeDesign` leaves after stripping `:position-data`, and (c) whether
position-data is present at all. Without normalizing each axis, **identical content would hash
differently and a freshly-opened design would appear spuriously dirty** — the exact "open to look,
get a save prompt you didn't earn" bug (commits `c6529229c9`, `3f05d851bb`).

**Media is intentionally excluded.** Media binaries are disk-managed out-of-band (written directly by
the upload RPC / import, never staged through the working copy). The saved baseline derives media from
disk filenames (`readDesign` → `readMediaIds`) while a staged copy derives it from the engine's
(empty-for-these-designs) `:media` registry — folding those divergent sources would mark every design
with on-disk media dirty on first stage. A real image add/replace already dirties via the page EDN's
`:fill-image :id` change.

---

## Never Persist `:position-data` (`store/store.mjs:11-12`)

`writeDesign` is the single disk-write chokepoint, and it strips position-data on the way out:

```js
for (const [id, edn] of Object.entries(parts.pages))
  fs.writeFileSync(path.join(dir, "pages", `${id}.edn`), stripPositionData(edn));
for (const [id, edn] of Object.entries(parts.components))
  fs.writeFileSync(path.join(dir, "components", `${id}.edn`), stripPositionData(edn));
```

So `:position-data` is computed live in the browser, may flow through `update-file` into the in-memory
working copy, but is **stripped both from the dirty signature (`computeSig`) and from every disk write**.
It is never canonical state. (`writeDesign` also does not touch `media/` — `prune` is scoped to `*.edn`
under `pages/`/`components/`, so a Save never deletes or rewrites media binaries.)

### Why a workspace-load is non-dirty

```
  open design ──► SPA loads ──► engine recomputes :position-data for every text shape
        │                          ──► SPA emits no-op update-file (revn bump only)
        ▼
  persistChanges → stage(freshParts)
        │
        ▼
  computeSig(freshParts):   :position-data stripped,  :revn stripped,  whitespace normalized
        │
        ▼
  == _savedSig   ⇒  _dirty = false   ⇒  no save prompt
```

The position-data-only change asserted non-dirty in `pencilpot/test/worktree.test.mjs` (commit
`abac6b31aa`). This is the correctness goal: **opening a design to view it, with no user edit, never
raises the dirty flag** even though rendering produces a fresh position-data layout and the SPA bumps revn.

---

## The Save Gap & HTTP Surface (`runtime/server.mjs`)

`commit()` / `update-file` stage in memory; **disk is written only on an explicit Save**. The runtime
exposes three endpoints (registered before the static/`/api` fall-through, `server.mjs:166-196`):

| Method · URL | Action | Response |
|---|---|---|
| `GET /pencilpot/status` | read `worktreeStatus()` | `{ dirty, revn }` |
| `POST /pencilpot/save` | `saveWorktree()` → `writeDesign`; `noteSelfWrite()`; broadcast `dirty:false` | `{ saved, dirty:false, revn }` |
| `POST /pencilpot/discard` | `discardWorktree()` → reload disk; broadcast `dirty:false` | `{ discarded, dirty:false, revn, reload:true }` |

`POST /pencilpot/save` is the **only** path from working copy to disk; the workspace binds it to
Ctrl/Cmd+S (manual-save model, commit `256b7a1291`; UI in [10-native-save-ui.md](10-native-save-ui.md)).
`noteSelfWrite()` tells the live-watcher the disk now equals the working copy, suppressing a false
"external change" event. `POST /pencilpot/discard` returns `reload:true` so the client reloads the
reverted on-disk state. The status broadcast (`broadcastStatus`) keeps the dirty indicator consistent
across multiple windows (e.g. the separate viewer window from [11-view-mode.md](11-view-mode.md)).

```
  Browser edit ──update-file──► persistChanges ──stage──► _store (MEMORY)   dirty=true
        │                                                      │
        │  Ctrl/Cmd+S → POST /pencilpot/save                   │ (disk still PRISTINE)
        ▼                                                      ▼
  saveWorktree() ──writeDesign──► disk EDN                _dirty=false   _savedSig re-baselined
```

---

## Lifecycle Summary

| Operation | Memory | Disk | `_dirty` after |
|---|---|---|---|
| open / first `get-file` | `_store` ← `readDesign` | unchanged | `false` (baseline set) |
| `update-file` (real edit) | `_store` ← fresh parts | unchanged | `true` |
| `update-file` (no-op / position-data only) | `_store` ← fresh parts | unchanged | `false` (sig == baseline) |
| `POST /pencilpot/save` | unchanged | `writeDesign` (position-data stripped) | `false` (baseline = new disk) |
| `POST /pencilpot/discard` | `_store` ← `readDesign` | unchanged | `false` (baseline = disk) |
| restart runtime (no save) | `_store` lost | last-saved EDN | `false` — unsaved edits gone |

The last row is the cost of the save gap: an AI/CLI loop that `commit()`s without `POST /pencilpot/save`
loses the edit on restart (see [12-headless-engine-and-ai-dev.md](12-headless-engine-and-ai-dev.md) and
`docs/pencilpot/ai-dev-capabilities.md`).

---

## Source map

| Concern | File / symbol | Commit |
|---|---|---|
| Working copy + state machine | `runtime/worktree.mjs` (`getStore`/`stage`/`save`/`discard`/`status`/`computeSig`) | `256b7a1291`, `c6529229c9` |
| Content-only dirty signature | `runtime/worktree.mjs:49 computeSig` | `3f05d851bb`, `c6529229c9` |
| EDN canonicalizers | `store/edn.mjs` (`stripPositionData`, `normalizeEdnWhitespace`, `stripRevn`) | `c397d377dd`, `3f05d851bb` |
| Strip position-data on write | `store/store.mjs:11-12 writeDesign` | `ed35bc630b`, `c397d377dd` |
| Media as store model (excluded from sig) | `store/store.mjs readMediaIds`, `worktree.mjs computeSig` | `f2cfaf7c5c` |
| Persist path (stage, not disk) | `runtime/rpc.mjs:118-124 persistChanges` | — |
| Save/discard/status endpoints | `runtime/server.mjs:166-196` | `256b7a1291` |
| position-data-only non-dirty test | `pencilpot/test/worktree.test.mjs` | `abac6b31aa` |
| Plan | `docs/superpowers/plans/2026-06-21-pencilpot-positiondata-and-profile-rpc.md` | — |
