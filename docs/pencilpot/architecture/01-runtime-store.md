# Architecture Note: Phase 1 — Runtime + EDN Store

**Status:** Complete.
**Branch:** `pencilpot`
**Location:** `pencilpot/store/`, `pencilpot/runtime/`
**Updated:** Phase 1 complete (tiered test runner, cross-file shared-library resolution).

---

## Overview

Phase 1 implements two sub-projects from the umbrella spec:

- **S (Store):** replace the spike's opaque transit blobs with a git-native, per-page EDN directory layout that is diff-friendly and human-readable.
- **L (Local runtime):** a production-grade HTTP server (`server.mjs`) that serves the Penpot SPA designer without any JVM, Postgres, or auth — `get-file` / `update-file` / `get-file-libraries` are satisfied from disk; everything else falls through to recorded boot stubs.

---

## EDN Store Format

Each design is a directory named `<design-name>.penpot/` (by convention, `home.penpot/`):

```
home.penpot/
├── manifest.edn            ← file-level metadata + library links
├── pages/
│   └── <page-uuid>.edn     ← per-page shape tree (one file per page)
├── components/
│   └── <component-uuid>.edn ← per-component EDN (one file per component)
└── media/                  ← asset IDs (currently empty; reserved)
```

A **project** is the parent directory containing one or more `.penpot/` designs plus a `shared/` subdirectory for cross-file libraries:

```
proj/
├── .git/
├── shared/
│   └── brand.penpot/       ← shared library (same layout as home.penpot)
└── home.penpot/
```

### manifest.edn

The manifest is a single EDN map. Key fields:

```clojure
{:id      #uuid "…"
 :name    "home"
 :revn    42
 :vern    0
 :features ["…" …]
 :pages   [#uuid "…"]       ; ordered page list
 :libraries [{:id #uuid "…" :path "shared/brand.penpot"}]
 ; when design tokens are present:
 :tokens-lib #penpot/tokens-lib {…}
```

The `#penpot/tokens-lib` tagged literal is a custom EDN reader tag registered in the headless engine via `cljs.reader/register-tag-parser!`. Without this registration the EDN round-trip would either error or silently drop token data. The same pattern applies to any future custom tags (e.g. `#penpot/fills`) — register the parser in `session.cljs` before using the round-trip.

### Per-page / per-component EDN

Each page file is the canonical EDN representation of the page's `:objects` map as emitted by `penpot.cljs/serialize-store`. Keys are `#uuid "…"` literals; values are shape maps. The serialization is deterministic: two identical sessions produce byte-identical files.

---

## Engine Serialize / Load API

The headless engine (`headless-core/target/headless/penpot.js`) exports these entry points relevant to the store:

| Method | Signature | Description |
|---|---|---|
| `createSession` | `(optsJson)` → Session | Create a session. `opts.empty=true` starts blank; `opts.fromStore=parts` loads from EDN parts; `opts.fromTransit=t, meta=m` loads from transit payload. |
| `serializeStore` | `()` → JSON string | Serialize the current session to `{manifest, pages:{id:edn}, components:{id:edn}, media:[]}`. Deterministic. |
| `loadStore` | (internal) | Used by `createSession({fromStore})` to reconstruct the CLJS data model from EDN parts. |
| `bumpRevn` | `()` → number | Increment `:revn` in the in-memory model; returns the new revn. Called before `serializeStore` on every persist cycle. |
| `getFileResponse` | `()` → JSON string | Emit a transit-encoded `get-file` envelope (the full inline payload the SPA expects). |
| `applyTransitUpdate` | `(transitBody)` → void | Decode a transit-encoded `update-file` body, extract `:changes`, and call `process-changes`. The canonical change path for live SPA traffic. |
| `applyChanges` | `(changesJson)` → void | Accept a JSON change array. Test-only convenience — cannot losslessly represent all Penpot change types. |

---

## Store Read/Write (pencilpot/store/)

```
store/
├── store.mjs      — writeDesign(dir, parts) / readDesign(dir) → parts
├── project.mjs    — initProject(root) / resolveProjectRoot(path) / listDesigns(root)
└── index.mjs      — re-exports writeDesign + readDesign
```

`writeDesign` explodes a `parts` object onto disk (creating `pages/`, `components/`, `media/` subdirs) and prunes stale `.edn` files that no longer exist in the session (so deleting a page removes its file). `readDesign` reconstructs the parts object. Both are synchronous.

`resolveProjectRoot` walks up from any nested path (including from inside `pages/`) until it finds a directory containing `shared/` or `.git/`.

---

## Runtime RPC Handler Table

`pencilpot/runtime/rpc.mjs` — called by `server.mjs` for every `/api/*` request.

```
RPC command             Handler                                    Source
──────────────────────  ─────────────────────────────────────────  ──────────
get-file                sessionFor(dir) → getFileResponse()        disk
get-file                (with ?id=<libId>) → shared/*.penpot       disk
update-file             applyTransitUpdate → bumpRevn → writeDesign disk
get-file-libraries      parseLibraries(manifest) → [getFile(lib)]  disk
get-profile             stub-data/get-profile.body                 replay
get-teams               stub-data/get-teams.body                   replay
get-team-members        stub-data/…                                replay
get-enabled-flags       [] (empty, overrides 401)                  synthetic
get-font-list           stub-data/…                                replay
get-file-thumbnail      stub-data/…                                replay
(all others)            404 no stub                                —
/js/config.js           proxy + publicURI rewrite                  upstream
/js/* /css/* /fonts/*   proxy → penpot-hl:9101                     upstream
/ws/notifications       WebSocket stub (silent no-op)              synthetic
```

All non-API traffic (static assets) is proxied to `penpot-hl:9101` via `proxy.mjs`. The `globalThis.penpotPublicURI = location.origin` injection in `/js/config.js` forces the SPA to send all RPC calls to `:7777` without any frontend source changes.

---

## Shared-Library Resolution

```
get-file-libraries request
         │
         ▼
  rpc.mjs: parseLibrariesFromManifest(manifest.edn)
         │   returns [{id, path}] from :libraries []
         ▼
  for each {id, path}:
    resolveProjectRoot(design) → projectRoot
    getFile(projectRoot + "/" + path)
         │   sessionFor(libDir) → getFileResponse() → meta
         ▼
  encodeTransitLibraryList([meta…])
         │   transit+json array; :modified-at == :synced-at (no sync-banner)
         ▼
  HTTP 200 + x-pencilpot-source: disk
```

When the SPA subsequently calls `get-file?id=<libId>`, the `get-file` handler matches the `?id` against `:libraries` in the design's manifest and serves the library's full transit payload from `shared/<libname>.penpot/`.

---

## Revn Lifecycle

```
  disk: manifest.edn :revn N
         │
         │  readDesign → createSession({fromStore})
         ▼
  in-memory session (CLJS): :revn N
         │
         │  applyTransitUpdate(body)
         ▼
  in-memory session: changes applied, :revn still N
         │
         │  bumpRevn()
         ▼
  in-memory session: :revn N+1
         │
         │  serializeStore → writeDesign
         ▼
  disk: manifest.edn :revn N+1
```

The SPA sends the current revn in `update-file` requests; the runtime ignores the SPA's revn and uses `bumpRevn` to increment the authoritative disk copy.

---

## System Diagram

```
  penpot-hl:9101  (static assets only in Phase 1)
       │
       │  GET /js/* /css/* /fonts/*  (proxy.mjs)
       ▼
  localhost:7777  ◄──── Browser (stock Penpot SPA, unmodified)
  ┌──────────────────────────────────────────────────────────┐
  │  server.mjs   PENCILPOT_PROJECT=…  PENCILPOT_DESIGN=…   │
  │                                                          │
  │  /api/.../get-file           ──► rpc.mjs (disk)          │
  │  /api/.../update-file        ──► rpc.mjs (disk)          │
  │  /api/.../get-file-libraries ──► rpc.mjs (disk)          │
  │  /api/.../* (others)         ──► stubs.mjs (replay)      │
  │  /ws/notifications           ──► ws stub (no-op)         │
  │  /js/* /css/* /fonts/*       ──► proxy.mjs → :9101       │
  └──────────────────────────────────────────────────────────┘
                │                              │
         ┌──────┴──────┐             ┌─────────┴────────┐
         │  store/     │             │  runtime/        │
         │  store.mjs  │             │  stubs.mjs       │
         │  project.mjs│             │  proxy.mjs       │
         └──────┬──────┘             └──────────────────┘
                │
    ┌───────────┴──────────────┐
    │  headless-core engine    │
    │  createSession()         │
    │  serializeStore()        │
    │  applyTransitUpdate()    │
    │  getFileResponse()       │
    │  bumpRevn()              │
    └──────────────────────────┘

  No JVM. No Postgres. No auth. No collab server.
```

---

## Known Limitation: `#penpot/fills` Tagged Literal

The CLJS engine can emit a `#penpot/fills` tagged literal for certain fill configurations. This tag is not registered in the current EDN reader (symmetrically with `#penpot/tokens-lib`). The same fix applies — register the parser in `session.cljs`. This is not triggered by any current test files or the seeded penpot-hl project; it will surface if a fill-heavy file is round-tripped.

---

## Test Coverage

| Tier | Files | Tests | What is asserted |
|---|---|---|---|
| unit | `headless-core/test/store.test.mjs` | 3 | round-trip, determinism, tokens-lib |
| unit | `pencilpot/test/store.test.mjs` | 3 | FS explode/read, minimal-diff, project init |
| integration | `pencilpot/test/rpc.test.mjs` | 2 | getFile envelope, updateFileJson + revn |
| integration | `pencilpot/test/library.test.mjs` | 2 | getFileLibraries linked + empty |
| e2e | `pencilpot/e2e/boot.spec.mjs` | 1 | canvas renders, x-pencilpot-source:disk |
| e2e | `pencilpot/e2e/edit.spec.mjs` | 1 | canvas edit → manifest revn increments |
| e2e | `pencilpot/e2e/library.spec.mjs` | 1 | get-file-libraries served from disk |

Run with: `node pencilpot/run-tests.mjs` (all tiers) or `--unit` (no e2e).
