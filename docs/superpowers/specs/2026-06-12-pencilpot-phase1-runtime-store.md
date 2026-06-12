# Pencilpot Phase 1 — Local Runtime (L) + Exploded Git-Native Store (S)

**Status:** Design spec (sub-project, under the umbrella `docs/superpowers/specs/2026-06-12-pencilpot-design.md`). Feeds an implementation plan.
**Date:** 2026-06-12 · **Branch:** `pencilpot`
**Builds on:** Phase 0 viability spike (GO — `pencilpot/spike/SPIKE-REPORT.md`). Promotes the spike's faked `serve` mode into the real runtime + a durable on-disk store.

---

## 1. Goal

A real, durable local runtime: open a design on disk → the stock Penpot designer renders and edits it → every change persists to a **deterministic, lossless, git-diffable EDN directory**, with **cross-file shared libraries** resolved from a `shared/` area. No JVM, no DB, no auth. This is the foundation sub-projects F/D/T build on.

## 2. Scope

- **S · Exploded git-native store** — the on-disk format + a lossless canonical-EDN serializer/loader over the engine's file model; project/`shared/` layout; manifest + library links; `git init`.
- **L · Local runtime server** — the durable version of the spike's `serve` mode: serves the *full* workspace RPC set from the store (real get-file/update-file/get-file-libraries; synthetic stubs for the SaaS/boot endpoints); revn/vern lifecycle; multi-file project + shared-lib resolution.

Out of scope (later phases): our own stripped frontend bundle + auth deletion (Phase 2 — Phase 1 still **proxies penpot-hl's compiled assets** and replays a synthetic profile); desktop shell/file-association (Phase 3); terminal/AI (Phase 4). The spike (`pencilpot/spike/`) is retired/archived; Phase 1 lives in a clean `pencilpot/` layout.

## 3. On-disk format (sub-project S)

```
my-project/                       ← git repo root (the "workspace")
  home.penpot/                    ← a design file (exploded dir)
    manifest.edn                    file meta + page order + library links (see below)
    pages/<page-id>.edn             one EDN file per page (the page map incl. its :objects)
    components/<component-id>.edn    one EDN file per file-local component
    media/<media-id>.<ext>          embedded media (binary, verbatim)
  marketing.penpot/  …
  shared/
    brand.penpot/                 ← a shared library (same .penpot dir shape, is-shared)
      manifest.edn   pages/   components/   tokens.edn   media/
    icons.penpot/  …
  .git/
```

**`manifest.edn`** (lossless EDN) holds everything except per-page/per-component bodies:
```clojure
{:id #uuid "…"
 :name "Home"
 :revn 0 :vern 0
 :features #{…}
 :page-order [#uuid "…" …]      ; ordering (the engine's :data :pages vector)
 :options {…}                   ; :data :options
 :tokens-lib {…}                ; :data :tokens-lib (DTCG tokens)
 :libraries [{:id #uuid "…" :path "shared/brand.penpot"} …]  ; linked shared libs
 :is-shared false}
```
Components index and pages-index are exploded into `components/*.edn` and `pages/*.edn`; the loader reassembles `:data` = `{:pages page-order :pages-index {…} :components {…} :options … :tokens-lib …}`.

**Canonical EDN serialization (the core invariant):**
- **Lossless:** keywords, `#uuid`, sets, nested maps/vectors all round-trip exactly (native EDN; no JSON type-guessing).
- **Deterministic:** map keys sorted by a stable comparator, stable collection ordering, normalized number printing — so re-serializing unchanged data is byte-identical and a one-shape edit produces a one-file, minimal diff.
- **Round-trip:** `load(serialize(data)) == data` for the engine model (test-enforced).

## 4. Engine API (ClojureScript, in `headless-core`)

A new namespace (e.g. `app.pencilpot.store`) compiled into the existing `penpot.js` bundle, exposing to Node:
- `serializeStore()` → returns `{manifest, pages: {<id>: edn-str}, components: {<id>: edn-str}, media: [<id>…]}` — the split, canonical-EDN parts of the current session's file. (Media bytes are handled by the Node store; the engine only lists ids/refs.)
- `createSession({fromStore})` (or `loadStore(parts)`) → reconstruct `:data` from the manifest + page/component EDN parts and hydrate the session (mirrors the Phase 0 `fromTransit` path, but from EDN parts).
- Canonical EDN read/write helpers (`canonicalEdn`, `readEdn`) used by the above.
- Reuse Phase 0's `getFileResponse()` (envelope emit) and `applyTransitUpdate()` (canonical change-apply) unchanged.

**Determinism:** cljs `pr-str` does not sort keys — implement a small canonical writer (recursively sort map entries, pretty-print). Validated by a "serialize twice == identical bytes" test.

## 5. Local runtime server (sub-project L)

Replaces the spike's fixtures with real handlers. New clean layout: `pencilpot/runtime/` (the Node server + RPC handlers) using `pencilpot/store/` (FS layout over the engine's serialize/load) and the `headless-core` engine.

**RPC handlers (served from the store):**
| Command | Behavior |
|---|---|
| `get-file` | load `.penpot` dir from store → reconstruct full get-file envelope (synthesize `:permissions {:type :membership :is-owner true :can-edit true}`, `:project-id`/`:team-id` from a local constant, `:version`/`:migrations` from the file) → return transit (+ JSON meta). Reuses `getFileResponse`. |
| `update-file` | `applyTransitUpdate` → write changed pages/components back to the store → bump manifest `:revn` → return transit `{:revn N :lagged []}`. Revn-gated: if request `:revn` ≠ stored, return the standard conflict response. |
| `get-file-libraries` | resolve `manifest :libraries` from disk: load each linked `shared/*.penpot` and return its library data (so cross-file component instances resolve). |
| `get-file-object-thumbnails`, `create/delete-file-object-thumbnail`, `get-file-data-for-thumbnail`, `create-file-thumbnail` | empty/no-op (200 `{}` / 204). |
| `get-fonts` / `get-font-variants` | empty (bundled Google fonts only in v1). |
| `get-comment-threads`, `get-profiles-for-file-comments`, `get-unread-comment-threads` | empty. |
| `push-audit-events` | 204 no-op. |
| `get-profile` | synthetic constant local profile (non-zero id) — **temporary**; deleted with the auth layer in Phase 2/F. |
| `get-teams`/`get-team`/`get-team-members`/`get-projects`/`get-project`/`get-team-recent-files`/`get-builtin-templates`/`get-enabled-flags` | synthetic minimal responses sufficient for boot. |

**Frontend assets:** proxied from penpot-hl (:9101) in Phase 1 (own bundle = Phase 2). **WS:** `/ws/notifications` stub (no-op), as in the spike.

**Project resolution:** opening a `.penpot` dir walks up to the project root to locate `shared/`. A `pencilpot init <dir>` / `pencilpot open <dir>` entry creates/loads a project (auto `git init` on create).

**revn/vern lifecycle:** maintained in `manifest.edn`; `update-file` increments `:revn` and enforces the optimistic-concurrency check the SPA expects.

## 6. Addressing Phase 0 deferred items

- **Transit is the canonical change path** — L only uses `applyTransitUpdate`; the JSON `applyChanges` stays test-only.
- **Multi-page** — store is keyed by page-id; `update-file` writes exactly the page/component files whose data changed; a multi-page round-trip + cross-page edit test is required.
- **revn/vern** — managed in the manifest (§5).
- **`:features` consistency** — manifest is the single source; `getFileResponse` reads features from the loaded file, not a default.

## 7. Testing (first-class — every change ships a test)

Establish a pencilpot tiered runner (mirror headless-core): unit / integration / e2e, one command, preflight + loud skips, coverage matrix.
- **S unit:** round-trip equality (`load(serialize) == data`); determinism (serialize twice → identical bytes); minimal-diff (move one shape → exactly one `pages/<id>.edn` changes); multi-page; component + tokens-lib survive; media bytes preserved.
- **L integration:** drive the RPC handlers directly — `get-file` returns a valid envelope the engine re-hydrates; `update-file` applies + bumps revn + writes the right files; revn-conflict path; `get-file-libraries` resolves a linked `shared/` lib so a cross-file instance resolves.
- **e2e (Playwright, reuse the spike harness):** the stock SPA renders a design from the EDN store; an edit persists to the EDN store and survives reload; a design linking a `shared/` library shows the shared component.

## 8. Risks

1. **EDN determinism** — the canonical writer must be stable across runs/platforms (sorted keys, number formatting). Mitigation: the "serialize twice" + golden-file tests.
2. **Cross-file component referential integrity** — a design's instances reference a library file's components by id; the loader must build the libraries map so the engine resolves them (validate against the engine's component machinery, as the headless SDK does).
3. **Split granularity vs diff size** — per-page is the default; if pages are huge, revisit per-frame splitting (flagged, not done in v1).
4. **revn conflicts** — single-user, so rare; still implement the gate so the SPA's optimistic concurrency doesn't wedge.
5. **Media** — v1 stores media per-file (each `.penpot/media/`); content-addressed dedup across files is deferred.

## 9. Decisions locked for Phase 1

- Serialization = **EDN** (lossless, deterministic, git-diffable). Split = manifest.edn + one EDN per page + one per component + media/ binaries.
- Shared libraries linked by `{:id, :path}` in `manifest.edn`; resolved on load (hot-update on reload only in v1).
- Phase 1 still proxies penpot-hl assets + replays a synthetic profile (auth deleted in Phase 2).
- Clean `pencilpot/{runtime,store}/` layout; the spike is archived.
