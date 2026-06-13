# Pencilpot

Local, filesystem-native Penpot design IDE. No JVM, no Postgres, no auth — the stock Penpot SPA designer runs against an EDN git-native store served by a lightweight Node HTTP server.

Phase 1: EDN exploded store + local runtime server. See `docs/pencilpot/architecture/01-runtime-store.md`.

Phase 2: runtime serves our own frontend bundle (no penpot-hl for assets); CLJS auth/dashboard/collab layer deleted; boots directly into the designer. See `docs/pencilpot/architecture/03-frontend-strip.md`.

---

## How to Run

**Prerequisites:**
- `headless-core/target/headless/penpot.js` built (the runner builds it automatically if missing).
- For e2e: penpot-hl running at `http://localhost:9101` and `infra/penpot-hl/test-env.json` present.

```bash
# From repo root — unit + integration (no penpot-hl needed):
node pencilpot/run-tests.mjs --unit

# From repo root — all three tiers (seeds project, starts runtime, runs Playwright):
node pencilpot/run-tests.mjs

# Via npm (from pencilpot/ dir):
npm test             # all tiers
npm run test:unit    # unit + integration only
npm run test:e2e     # require penpot-hl; fail preflight if down
```

---

## File Map

### `store/`

| File | Purpose | Key exports | Deps |
|---|---|---|---|
| `store.mjs` | Explode/read a design to/from the `<name>.penpot/` directory layout (manifest + per-page + per-component EDN files) | `writeDesign(dir, parts)`, `readDesign(dir)` | `node:fs`, `node:path` |
| `project.mjs` | Project-level helpers: init a git repo with `shared/`, walk up to the project root, list designs | `initProject(root)`, `resolveProjectRoot(path)`, `listDesigns(root)` | `node:fs`, `node:child_process` |
| `index.mjs` | Re-exports `writeDesign` + `readDesign` | — | `store.mjs` |

### `runtime/`

| File | Purpose | Key exports | Deps |
|---|---|---|---|
| `server.mjs` | HTTP server entry point. Reads `PENCILPOT_PORT` (default 7777), `PENCILPOT_PROJECT`, `PENCILPOT_DESIGN`. Routes `/api/*` to `rpc.mjs`; everything else to `static.mjs`. | (run directly) | `node:http`, `static.mjs`, `proxy.mjs` (ws stub only), `rpc.mjs` |
| `static.mjs` | *(Phase 2)* Serves `frontend/resources/public/` for all non-API requests. Intercepts `/js/config.js` and returns the runtime-injected body from `frontend.mjs`. Path-traversal guarded. | `serveStatic(req, res, cfg)` | `node:fs`, `frontend.mjs` |
| `frontend.mjs` | *(Phase 2)* Resolves the dist directory and generates the runtime-injected `config.js` body (sets `penpotPublicURI`, `penpotFlags`, `window.pencilpotFile`). | `distDir()`, `configJs(opts)` | `node:path` |
| `rpc.mjs` | RPC handler table. `get-file`/`update-file`/`get-file-libraries` from disk; all others via `stubs.mjs`. | `getFile(dir)`, `updateFile(dir, body)`, `updateFileJson(dir, json)`, `getFileLibraries(designDir, root)`, `handleRpc(req, res, cfg)` | headless engine, `store/index.mjs`, `stubs.mjs` |
| `proxy.mjs` | *Legacy (Phase 1 asset proxy — no longer used for static assets in Phase 2).* Still exports `readBody(req)` (used by `rpc.mjs`) and `attachWsStub(server)` (used by `server.mjs`). | `readBody(req)`, `attachWsStub(server)` | `ws` |
| `stubs.mjs` | Replay verbatim recorded boot responses from `stub-data/` for workspace endpoints still called by the SPA. Auth/dashboard stubs pruned in Phase 2. | `isStub(cmd)`, `stub(cmd, res)` | `node:fs` |
| `launch.mjs` | Programmatic launcher used by the headless SDK integration. | `launch(opts)` | `node:child_process` |
| `stub-data/` | Recorded workspace RPC responses (Phase 0 recordings). Pruned in Phase 2: `get-profile`, `get-projects`, `get-team-recent-files`, `get-file-libraries` stubs removed. | — | — |

### `scripts/`

| File | Purpose | Deps |
|---|---|---|
| `seed-from-hl.mjs` | Fetch the live penpot-hl file (from `infra/penpot-hl/test-env.json`), serialize to EDN, write to `.scratch/proj/`. Run from `pencilpot/`. | headless SDK `rpc.mjs`, headless engine, `store/` |

### `test/`

| File | Tier | What it tests |
|---|---|---|
| `store.test.mjs` | unit | `writeDesign`/`readDesign` FS round-trip; minimal-diff (single page changes); `initProject`/`resolveProjectRoot`/`listDesigns` |
| `rpc.test.mjs` | integration | `getFile` envelope (meta.id + data); `updateFileJson` + revn bump + persistence |
| `library.test.mjs` | integration | `getFileLibraries` with a linked shared library; empty-libraries path |

### `e2e/`

| File | What it tests |
|---|---|
| `own-bundle.spec.mjs` | *(Phase 2)* Our self-built bundle serves the workspace; zero requests hit penpot-hl:9101 |
| `boot-direct.spec.mjs` | *(Phase 2)* Root `/` lands in workspace without any `get-profile` call; no `/ws/notifications` WebSocket opened |
| `no-auth.spec.mjs` | *(Phase 2)* `/#/auth/login` renders no login form and does not keep the `/auth/login` URL |
| `boot.spec.mjs` | Canvas loads from EDN store; `x-pencilpot-source: disk` header present on `get-file` |
| `edit.spec.mjs` | Canvas edit (select-all + arrow nudge) triggers `update-file`; manifest `:revn` increments; survives reload |
| `library.spec.mjs` | Spins up its own runtime server on `:7779` with a temp project containing a shared library; asserts `get-file-libraries` is served from disk and the response is non-empty |
| `helpers.mjs` | `expectCanvasLoaded(page, expect)`, `trackErrors(page)` — shared Playwright utilities |

### `run-tests.mjs`

Tiered test runner. Unit + integration always run. e2e tier has two preflight gates (Phase 2):
1. `frontend/resources/public/index.html` must exist — if missing, e2e is LOUDLY skipped with a pointer to `docs/pencilpot/architecture/02-frontend-build.md` (no auto-build attempt).
2. penpot-hl must be reachable at `:9101` and `infra/penpot-hl/test-env.json` must exist — if missing, e2e is LOUDLY skipped.

Both missing conditions produce a bordered warning (not a failure). Manages the e2e server lifecycle (spawn, readiness poll, teardown) and prints a summary table with per-tier counts and wall-time.
