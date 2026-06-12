# Pencilpot Phase 0 — Spike Report

## Decision: GO

The stock Penpot designer SPA loads a real file, renders the canvas, and round-trips a canvas edit through headless-core to disk — all with no JVM, no Postgres, and no auth — proving the programme is viable as specced.

---

## What Was Proven

All tests green across two independent runs.

### Unit / integration tests (node:test)

Run with `npm test` from `pencilpot/spike/`:

| Test file | Tests | Result |
|---|---|---|
| `test/engine-roundtrip.test.mjs` | `getFileResponse emits inline transit that re-hydrates to the same shapes` | PASS |
| `test/mutate.test.mjs` | `applyUpdate moves a shape and persists the new position to disk` | PASS |

The full headless-core engine unit suite (17 tests) also passes (`npm test` in `headless-core/`).

### Playwright e2e (automated, headless Chromium)

Run with `npx playwright test` from `pencilpot/spike/`:

| Spec / test name | Mode | What it proves |
|---|---|---|
| `e2e/boot.spec.mjs` — `boot: SPA renders the canvas from replayed fixtures` | `replay` | Stock SPA boots into the workspace canvas with every `/api/*` answered from captured fixtures; no fatal console errors; no upstream API contact. |
| `e2e/serve.spec.mjs` — `serve: canvas renders with get-file produced from disk by the engine` | `serve` | `get-file` served by headless-core from `store/<id>.transit`; canvas renders; `x-pencilpot-source: disk` header confirmed on response. Stable over 2 runs (deterministic). |
| `e2e/serve.spec.mjs` — `serve: editing the canvas persists to disk and survives reload` | `serve` | Arrow-key nudge in the real canvas → `update-file` → headless-core `process-changes` → `store/<id>.transit` rewritten (revn++) → page reload re-renders the mutated file. |

---

## RPC Contract

Captured by `e2e/record.spec.mjs` driving a real session against penpot-hl v2.15.4.

### Boot / dashboard commands

| Command | Method | Role |
|---|---|---|
| `get-enabled-flags` | POST | Fixture stub (401→200 `[]` mapped in `fixtures.mjs`) |
| `get-profile` | POST | Fixture stub (anonymous UUID filtered; synthetic identity replayed) |
| `get-teams` | POST | Fixture stub |
| `get-team-members` | POST | Fixture stub |
| `get-unread-comment-threads` | POST | Fixture stub |
| `get-projects` | POST | Fixture stub |
| `get-font-variants` | POST | Fixture stub |
| `get-team-recent-files` | POST | Fixture stub |
| `get-builtin-templates` | POST | Fixture stub |
| `get-file-data-for-thumbnail` | POST | Fixture stub |
| `create-file-thumbnail` | POST | Fixture stub |
| `push-audit-events` | POST | Fixture stub |

### Workspace-open commands

| Command | Method | Role |
|---|---|---|
| `get-font-variants` | POST | Fixture stub |
| `get-comment-threads` | POST | Fixture stub |
| `get-profiles-for-file-comments` | POST | Fixture stub |
| `get-file-object-thumbnails` | POST | Fixture stub |
| **`get-file`** | POST | **Disk-backed** — headless-core hydrates `store/<id>.transit`, emits inline transit via `getFileResponse()` |
| `get-project` | POST | Fixture stub |
| `get-file-libraries` | POST | Fixture stub |
| **`update-file`** | POST | **Disk-backed** — body transit decoded, `process-changes` applied, `store/<id>.transit` rewritten (revn++) |
| `create-file-object-thumbnail` | POST | Fixture stub |
| `delete-file-object-thumbnail` | POST | Fixture stub |

**No `get-file-fragment` appeared.** v2.15.4 loads the entire file inline in a single `get-file` response (see Inline-data Verdict below).

### `get-file` response shape

17 top-level keys in the transit-decoded map:

```
id  name  revn  vern  features  data  permissions
team-id  project-id  version  migrations  backend
has-media-trimmed  comment-thread-seqn  is-shared
modified-at  created-at
```

`:data` contains: `pages`, `pages-index`, `options`, `tokens-lib`, `components`.

### `update-file` request / response

**Request** (transit body): `:changes` (change vector), `:features`, `:session-id`, `:revn`, `:vern`, `:id`, `:commit-id`.

**Response** (transit): `{:revn N :lagged []}`.

Our server emits `["^ ","~:revn",<N>,"~:lagged",[]]` — minimal transit-encoded map matching the recorded shape.

---

## Inline-Data Verdict

**Serving a fully-inline `get-file` response works for the stock SPA.**

v2.15.4 does not request `get-file-fragment` at all; the entire file data arrives in the single `get-file` body. Headless-core's `getFileResponse()` emits the complete `:data` map inline, which the SPA accepts and renders without modification. Phase 1 (sub-project L) does not need fragment support for the current frontend version — but should re-verify if the upstream frontend is upgraded.

---

## Write Round-Trip

Confirmed. Sequence:

1. SPA sends `update-file` (transit body with `:changes`).
2. `api.mjs` calls `session.applyTransitUpdate(body)` — decodes transit, runs `process-changes` in headless-core.
3. `getFileResponse()` serialises the updated model back to transit.
4. `store.writeFile(id, transit, meta)` writes `store/<id>.transit` and bumps `revn` in `store/<id>.meta.json`.
5. SPA receives `{:revn N :lagged []}` and continues.
6. Page reload: fresh `get-file` served from the mutated `store/<id>.transit` — canvas renders the moved shapes.

Observed in `serve.spec.mjs` test 2: `revn` on disk increases by at least 1 after the nudge, and the post-reload canvas renders without error.

---

## Deferred to Phase 1 / Sub-project L

These were surfaced during the senior code review of the spike. They must be carried into L's design — not silently dropped.

**L1 — `applyChanges` JSON path is lossy (use transit).**
`applyChanges` (JSON input) cannot losslessly reconstruct keyword-valued attributes (e.g. `:val "auto-width"` vs `:auto-width`) or `:add-obj :obj` shape maps. `process-changes` runs with `verify?=false` so corruption is silent. `applyTransitUpdate` is the canonical, lossless path; `applyChanges` is test-only convenience. L must use transit for all live SPA traffic and add validation (or enable `verify?=true` in a test mode).

**L2 — Multi-page change targeting.**
`applyTransitUpdate` trusts each change's own `:page-id` (fixed during the spike). `applyChanges` is single-page only. L needs robust multi-page handling for both paths and must exercise it with explicit tests covering changes that target different pages in the same request.

**L3 — revn/vern lifecycle.**
The spike server bumps `revn` in the store meta only, as a counter. A real local runtime needs proper `revn`/`vern` management: `update-file` is revn-gated (the SPA sends its local `revn` and the server must accept or reject), and `vern` semantics must be reconciled. See review items I2/I3.

**L4 — `:features` consistency.**
The `:features` key in the emitted meta (from `getFileResponse`) must be reconciled with the features set in the full envelope the SPA uses to gate behaviour. A mismatch can silently disable or enable SPA features. Review item I1.

**L5 — Asset serving (Phase 2/3 concern, noted here).**
The spike proxies penpot-hl's compiled frontend assets. Phase 2 (sub-project F) must build and serve a stripped bundle from our own server. Auth/login routes, the login-redirect guard, the boot-time `get-profile`/`get-teams` fetch, and the websocket-auth gate are deleted in F — in the spike they survive because we replay a synthetic profile against the unmodified stock bundle.

**L6 — Full boot endpoint set.**
L must implement every command in the boot/dashboard list above. Most are trivially stubbable with empty/synthetic responses: comments → `[]`, thumbnails → empty/204, `push-audit-events` → 204, `get-teams`/`get-projects` → synthetic single-item lists. `get-file-libraries` must return a real response for shared-library resolution (Phase 1/sub-project S milestone).

---

## How to Run

All commands run from `pencilpot/spike/` unless noted. Requires penpot-hl running on `:9101` for proxy/record mode (`penpot start`).

```bash
# Install deps (once)
npm install && npx playwright install chromium

# Mode 1: proxy — forward to penpot-hl and record every /api/* exchange
PENCILPOT_MODE=proxy node server.mjs

# Mode 2: replay — serve /api/* from captured fixtures (no penpot-hl needed)
PENCILPOT_MODE=replay node server.mjs

# Mode 3: serve — get-file/update-file from disk via headless-core; everything else fixtures
PENCILPOT_FILE_ID=<uuid> PENCILPOT_MODE=serve node server.mjs

# Open a chromeless --app window at the workspace URL
node launch.mjs "http://localhost:7777/#/workspace?team-id=<tid>&file-id=<fid>"

# Unit + integration tests (node:test)
npm test

# End-to-end Playwright tests (requires serve mode server already running)
PENCILPOT_FILE_ID=<uuid> PENCILPOT_MODE=serve node server.mjs &
npx playwright test

# Record mode e2e (requires proxy mode server + penpot-hl)
PENCILPOT_MODE=proxy node server.mjs &
npx playwright test e2e/record.spec.mjs
```

Port defaults to `7777`; override with `PENCILPOT_PORT`. Upstream defaults to `http://localhost:9101`; override with `PENCILPOT_UPSTREAM`.
