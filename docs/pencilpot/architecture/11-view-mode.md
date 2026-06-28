# Architecture Note: Phase 4 — Prototype View Mode (play → viewer)

**Status:** Complete (separate-window viewer; warm engine + read-session cache).
**Branch:** `pencilpot`
**Locations:** `frontend/src/app/main/data/common.cljs`, `frontend/src/app/main/data/viewer.cljs`,
`frontend/src/app/main/ui/viewer.cljs`, `frontend/src/app/main/router.cljs`,
`pencilpot/runtime/rpc.mjs`, `pencilpot/runtime/server.mjs`,
`headless-core/src/app/headless/session.cljs`
**Updated:** Phase 4 view mode complete (separate exitable window; bundle served from the engine; boot warmup + read cache).

---

## Overview

The workspace **play** button opens the design in Penpot's read-only **viewer** so the user can walk a
prototype (frames + `:interactions`). Stock Penpot fetches a `get-view-only-bundle` RPC from the backend and
opens the viewer in a new browser window. Pencilpot has no backend and is a single local window, so two things
had to be built:

1. **A bundle handler** — the runtime must answer `get-view-only-bundle` from disk, or the viewer raises
   `:not-found` and renders the "doesn't exist" screen.
2. **A window decision** — where does the viewer open, and how does the user get back?

The end state: play opens the viewer in a **separate, exitable window**; the runtime serves a real bundle built
**inside the headless engine** as one transit document; and the engine is **warmed at boot** + a **read-session
is cached** so the first (and every) view-mode load is ~100 ms instead of a ~8.5 s cold start.

```
 workspace ──play──► go-to-viewer ──(rt/nav :viewer + ::rt/new-window)──► NEW browser window
   (right_header)        │                                                     │
                         └─ ::dps/force-persist                        viewer boots
                                                                               │
                                              data/viewer fetch-bundle ──cmd!──► :get-view-only-bundle
                                                                               │
                  runtime rpc.mjs ◄───────────────────────────────────────────┘
                  get-view-only-bundle handler
                         │  readFonts(project) → font variants
                         │  getStore(dir).manifest → projectName
                         ▼
                  readSessionFor(dir).getViewerBundle({teamId,projectId,projectName,fonts})
                         │  (cached warm session — built at boot)
                         ▼
                  ONE transit doc  ──200 application/transit+json──►  viewer renders frames
```

---

## 1. The play → viewer navigation (separate, exitable window)

The play button (`right_header.cljs`) emits `(dcm/go-to-viewer {:page-id … :file-id … :section "interactions"})`.

`go-to-viewer` (`data/common.cljs:456-486`) resolves the page/file/frame, then nav's to the `:viewer` route with
the `::rt/new-window` flag:

```clojure
;; data/common.cljs:481-486
name    (dm/str "viewer-" file-id)
options (merge {::rt/new-window true
                ::rt/window-name name}
               options)]
(rx/of ::dps/force-persist
       (rt/nav :viewer params options))
```

The router consumes that flag (`router.cljs:105-108`): `new-window` ⇒ `dom/open-new-window` (a fresh browser
window/tab); otherwise it stays in-window via `bhistory/set-token!`. `::dps/force-persist` flushes any pending
edit before leaving the workspace so the viewer reads a consistent file.

### Why separate-window (an evolution, not the first guess)

This setting was reverted twice:

| Commit | Behavior | Why |
|---|---|---|
| (stock) | new window | Penpot default — opens `cf/public-uri#/view…` in a popup |
| `3e167afd50` | **same window** (dropped the merge) | first pencilpot take: single local window, browser **Back** returns to workspace |
| `8a11b30370` | **separate exitable window** (restored the merge — current) | same-window **trapped** the user in the viewer with no obvious exit; a separate window is closed/`⌘W`'d to exit, leaving the workspace untouched |

Net: the code today is identical to stock for this hop (`::rt/new-window true` + `viewer-<file-id>` window name),
chosen deliberately for a clean exit affordance — not by accident.

> e2e caveat (`4d66fb1c8a`): a popup opened via `open-new-window` is unobservable to a headless Chromium driver,
> so `verify-viewer.mjs` asserts the workspace page **stays put** after the play click and drives a **direct**
> `#/view?file-id&page-id&section=interactions` navigation to exercise the render path.

---

## 2. The bundle: `fetch-bundle` → `get-view-only-bundle`

The viewer's `fetch-bundle` (`data/viewer.cljs:115-171`) issues `(rp/cmd! :get-view-only-bundle {:file-id …
:features …})`, then walks `(-> bundle :file :data :pages-index)` resolving any transit pointers (pencilpot inlines
pages, so none exist) and finally emits `bundle-fetched`. The consumer reads `:project :file :team :share-links
:libraries :users :permissions :thumbnails :fonts` and, from `:file`, `:data :pages-index`.

**The 404 bug.** Before this work the runtime had **no** `get-view-only-bundle` handler, so the request fell
through to the benign `200 {}` boot stub. `bundle-fetched` then saw a nil `:file`/empty `:pages`, and the viewer's
render guard fired:

```clojure
;; ui/viewer.cljs:410-411
(when (nil? page)
  (ex/raise :type :not-found))   ; → renders the "doesn't exist" screen
```

The fix (`2884a07ca1`) adds a real handler that builds the bundle in the engine.

---

## 3. The runtime handler (`rpc.mjs` `get-view-only-bundle`)

`pencilpot/runtime/rpc.mjs:626-660` handles the command **before** the unhandled-RPC warning:

```js
if (command === "get-view-only-bundle") {
  const dir = cfg.design;
  let fonts = [];                                  // custom/variable font variants (best-effort)
  const projectRoot = cfg.project ?? resolveProjectRoot(dir);
  if (projectRoot) fonts = fontVariantsForBundle(readFonts(projectRoot));
  let projectName = "Local";                       // from manifest :name (display only)
  …getStore(dir).manifest.match(/:name\s+"…"/)…
  const teamId    = "0398e5fc-95c9-80d6-8008-29071f0fdaed";   // mirrors server.mjs TEAM_ID
  const projectId = "0398e5fc-95c9-80d6-8008-29071f0fdaf0";   // stable synthetic uuid
  const { transit } = JSON.parse(
    readSessionFor(dir).getViewerBundle(
      JSON.stringify({ teamId, projectId, projectName, fonts })));
  res.writeHead(200, { "content-type": "application/transit+json", "x-pencilpot-source": "disk" });
  res.end(transit);
  return;
}
```

Notes:
- **Fonts are injected** (`readFonts` → `fontVariantsForBundle`, the same variant shape `get-font-variants`
  serves) so GSF/custom/variable fonts render in the viewer (see `06-variable-fonts.md`).
- All slots are **best-effort**: a project-less or fonts-less design still yields a valid bundle (empty `:fonts`,
  default `"Local"` name).
- The handler returns the engine's `transit` string verbatim under `application/transit+json`.

---

## 4. The engine method: `getViewerBundle` (one transit doc)

`session.cljs:465-499` adds `:getViewerBundle` next to `:getFileResponse`. Both build the served `:file` map via the
**shared** `build-file-resp` helper (`session.cljs:82-102`) so the file payload can never drift between the
workspace's `get-file` and the viewer's bundle:

```clojure
;; session.cljs:483-499 (abridged)
{:keys [served-features resp]} (build-file-resp file-id features @state)
bundle {:project     {:id proj-id :name proj-nm}
        :file        resp                                   ; == getFileResponse's file map
        :team        {:id team-id :name "Local" :features served-features}
        :share-links [] :libraries [] :users [] :thumbnails {}
        :permissions {:type :membership :is-owner true :is-admin true
                      :can-edit true :can-read true}        ; full local permissions
        :fonts       fonts}
body (t/encode-str bundle)                                  ; ONE pass — see below
(js/JSON.stringify (clj->js {:transit body}))
```

Two invariants encoded here:

- **One transit pass.** The WHOLE bundle is `t/encode-str`'d in a single call. Transit's key/value cache (`^`
  back-refs) is per-document; embedding a *separately* encoded file string would corrupt those refs. So the file
  map is placed into the bundle map first, then the whole thing is encoded once. (`c527d55a94`)
- **`:features` is the same modern set** in both `:file` and `:team` — the viewer does `(features/initialize
  (:features team))` and keys the file by it; a mismatch would mis-render.

`build-file-resp` (`session.cljs:82-102`) returns `{:served-features :meta-m :resp}`; when a full file envelope was
captured on hydration it restores that envelope with live `:data`/`:revn`/`:vern`/features (UUID `:id`), otherwise
emits the minimal shape. The bundle uses `:resp` (the UUID-keyed file map) directly.

`getViewerBundle` is a **session method, not a module export** — no change to `headless-core/shadow-cljs.edn`'s
`:exports`. It does require a **headless rebuild** (`:headless` ESM build → `target/headless/penpot.js`).

---

## 5. Performance: cold engine, boot warmup, read-session cache (`897adde7bb`)

**Root cause of slow first view.** The *first* `createSession()` in a server process pays a one-time ~8.5–9.4 s
CLJS JIT/init; every `createSession` after that is ~300 ms. Read endpoints (`get-file`, `get-view-only-bundle`)
re-hydrate a session per call, so the user's first view-mode load paid the full cold cost (measured
**9393 ms → ~115/81 ms** after the fix; `get-file` likewise → ~78 ms).

Two mitigations, both in `rpc.mjs`:

**Read-session cache** (`rpc.mjs:53-62`). One hydrated session is cached for the open design, keyed on the
**identity of the working-copy store object** (`getStore(dir)`), not on a revn number:

```js
let _readSession = { store: null, session: null };
function readSessionFor(dir) {
  if (status().design !== dir) return sessionFor(dir);   // libraries/other dirs: always fresh
  const store = getStore(dir);
  if (_readSession.store === store) return _readSession.session;   // identity hit → reuse
  const session = createSession(JSON.stringify({ fromStore: store }));
  _readSession = { store, session };
  return session;
}
```

Used by `getFile` (`rpc.mjs:138`) and the `get-view-only-bundle` handler (`rpc.mjs:650`). The identity key is
precise *because of how the working copy mutates* (`worktree.mjs`, see `08-working-copy-dirty-persistence.md`):
`stage()`/`discard()` **reassign** `_store` (object identity changes → cache misses → rebuild on the new content),
while `save()` does **not** reassign it (identity stable → reuse; content already equals disk). So the cache never
serves stale reads and never goes stale after a save. Reads never mutate the session (`getFileResponse` /
`getViewerBundle` are pure), so sharing one session across read calls is safe; **writes** (`persistChanges`) keep
using a fresh `sessionFor()`. (The commit subject's "per (dir,revn)" is shorthand; the implementation keys on store
object identity, which is strictly more precise — it also invalidates on a `discard` that reverts content without
bumping revn.)

**Boot warmup** (`server.mjs:214` + `rpc.mjs:71-80`). After `listen()` + the banner, the server defers a warmup a
tick so the listen/banner and the initial static-asset burst go first, then builds + caches the read session:

```js
// server.mjs:207-214
server.listen(PORT, () => {
  console.log(`pencilpot runtime on http://localhost:${PORT}  …  fileId=${fileId}`);
  …
  setImmediate(() => warmEngine(CONFIG.design));   // off the request path
});
```

`warmEngine` (`rpc.mjs:71-80`) calls `readSessionFor(dir)` once and logs `engine warmed in <ms>ms`; failures are
swallowed (the engine simply warms on first real use). `createSession` is **synchronous**, so the warmup blocks the
event loop for the one-time duration — accepted for a local single-user app because it is front-loaded *before* the
browser connects (deferring to a worker thread would not share the main V8 JIT cache, so it would be a false fix).

---

## 6. What's in / out of scope

In: loading + rendering the prototype (first frame + frame navigation via `:interactions`), custom/variable fonts,
full local permissions. Out: comment threads, share links, multi-user, and interaction fidelity beyond loading +
rendering. Prototype **authoring** (writing `:interactions`) is a separate, currently-unfilled gap — see
`../ai-dev-capabilities.md` (the viewer *plays* interactions that already exist; nothing authors them headlessly).

---

## Source map

| Area | Files | Key commits |
|---|---|---|
| Play → viewer nav (separate exitable window) | `frontend/src/app/main/data/common.cljs` (`go-to-viewer` :456-486), `frontend/src/app/main/router.cljs` (:105-108) | `3e167afd50` (same-window), `8a11b30370` (revert → separate, current) |
| Viewer bundle fetch + not-found guard | `frontend/src/app/main/data/viewer.cljs` (`fetch-bundle` :115-171), `frontend/src/app/main/ui/viewer.cljs` (:410-411) | — (stock consumers) |
| Runtime `get-view-only-bundle` handler (+ fonts/projectName injection) | `pencilpot/runtime/rpc.mjs` (:626-660) | `2884a07ca1` |
| Engine `getViewerBundle` (one transit doc; shared `build-file-resp`) | `headless-core/src/app/headless/session.cljs` (`build-file-resp` :82-102, `:getViewerBundle` :465-499) | `c527d55a94` |
| Read-session cache (store-identity key) + boot warmup | `pencilpot/runtime/rpc.mjs` (`readSessionFor` :53-62, `warmEngine` :71-80), `pencilpot/runtime/server.mjs` (:214) | `897adde7bb` |
| Cache invalidation contract (stage/discard reassign `_store`; save does not) | `pencilpot/runtime/worktree.mjs` → see `08-working-copy-dirty-persistence.md` | `897adde7bb` |
| e2e (separate-window play + direct `/view` render) | `pencilpot/e2e/vf/verify-viewer.mjs`, `pencilpot/e2e/vf/verify-viewer-window.mjs`, `pencilpot/e2e/vf/verify-viewer-perf.mjs` | `c1544b6f8d`, `4d66fb1c8a` |
| Plan | `docs/superpowers/plans/2026-06-21-pencilpot-view-mode.md` | — |
