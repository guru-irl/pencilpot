# Pencilpot

Local, filesystem-native Penpot design IDE. No JVM, no Postgres, no auth — the stock Penpot SPA designer runs against an EDN git-native store served by a lightweight Node HTTP server.

Phase 1 (this directory): EDN exploded store + local runtime server. See `docs/pencilpot/architecture/01-runtime-store.md` for the full architecture note.

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
| `server.mjs` | HTTP server entry point. Reads `PENCILPOT_PORT` (default 7777), `PENCILPOT_PROJECT`, `PENCILPOT_DESIGN`. Routes `/api/*` to `rpc.mjs`; everything else to `proxy.mjs`. | (run directly) | `node:http`, `proxy.mjs`, `rpc.mjs` |
| `rpc.mjs` | RPC handler table. `get-file`/`update-file`/`get-file-libraries` from disk; all others via `stubs.mjs`. | `getFile(dir)`, `updateFile(dir, body)`, `updateFileJson(dir, json)`, `getFileLibraries(designDir, root)`, `handleRpc(req, res, cfg)` | headless engine, `store/index.mjs`, `stubs.mjs` |
| `proxy.mjs` | Reverse-proxy to penpot-hl for static assets. Injects `penpotPublicURI = location.origin` into `/js/config.js` so the SPA routes all RPC calls to `:7777`. Provides WebSocket stub for `/ws/notifications`. | `proxyHttp(req, res)`, `attachWsStub(server)`, `readBody(req)` | `ws` |
| `stubs.mjs` | Replay verbatim recorded boot responses from `stub-data/` (get-profile, get-teams, etc.). Returns `[]` for get-enabled-flags regardless of the recording. | `isStub(cmd)`, `stub(cmd, res)` | `node:fs` |
| `launch.mjs` | Programmatic launcher used by the headless SDK integration. | `launch(opts)` | `node:child_process` |
| `stub-data/` | Recorded boot RPC responses copied from Phase 0. Each command has `<cmd>.body` + `<cmd>.meta.json`. | — | — |

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
| `boot.spec.mjs` | Canvas loads from EDN store; `x-pencilpot-source: disk` header present on `get-file` |
| `edit.spec.mjs` | Canvas edit (select-all + arrow nudge) triggers `update-file`; manifest `:revn` increments; survives reload |
| `library.spec.mjs` | Spins up its own runtime server on `:7779` with a temp project containing a shared library; asserts `get-file-libraries` is served from disk and the response is non-empty |
| `helpers.mjs` | `expectCanvasLoaded(page, expect)`, `trackErrors(page)` — shared Playwright utilities |

### `run-tests.mjs`

Tiered test runner. Unit + integration always run; e2e runs only when penpot-hl `:9101` is reachable and `infra/penpot-hl/test-env.json` exists. Missing live env produces a LOUD bordered skip (not a failure). Manages the e2e server lifecycle (spawn, readiness poll, teardown) and prints a summary table with per-tier counts and wall-time.
