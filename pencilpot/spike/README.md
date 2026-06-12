# pencilpot/spike

Phase 0 viability spike for the Pencilpot programme. A local Node server that proves Penpot's stock designer SPA loads a real file, renders it, and round-trips a canvas edit to disk — with no JVM, no Postgres, and no auth.

Three modes: `proxy` (forward penpot-hl + record /api), `replay` (serve /api from captured fixtures), `serve` (get-file + update-file from disk via headless-core; everything else from fixtures).

See [SPIKE-REPORT.md](SPIKE-REPORT.md) for the go/no-go decision, the captured RPC contract, and deferred items for Phase 1.

---

## File inventory

| File | Purpose | Key exports / entry points | Key deps |
|---|---|---|---|
| `server.mjs` | Entry point. Reads `PENCILPOT_MODE` (proxy / replay / serve), creates the HTTP server, dispatches `/api/*` to `recorder.mjs` or `api.mjs`, proxies everything else via `proxy.mjs`. | — (run directly) | `proxy.mjs`, `recorder.mjs`, `api.mjs`, `node:http` |
| `proxy.mjs` | Reverse-proxy for penpot-hl's compiled frontend assets. Appends `penpotPublicURI=location.origin` to `/js/config.js` so the SPA sends RPC to our origin. Stubs `/ws/notifications` as a silent no-op WebSocket. | `proxyHttp`, `attachWsStub`, `readBody` | `ws` |
| `recorder.mjs` | In proxy mode: forwards each `/api/*` call to upstream and writes the full exchange (meta JSON + body binary) to `recordings/` as numbered files. | `record(req, res, body)` | `node:fs`, `node:fetch` |
| `fixtures.mjs` | Loads captured recordings into a command-name → response map. Filters anonymous `get-profile` captures; promotes `get-enabled-flags` 401 to 200 `[]`. Replays verbatim bytes. | `replayFixture(command, res)`, `hasFixture(command)` | `node:fs` |
| `api.mjs` | The `/api/*` router. In `serve` mode: handles `get-file` (headless-core + disk) and `update-file` (transit decode → `process-changes` → disk). All other commands fall through to `fixtures.mjs`. Exports `applyUpdate` (test-only JSON path). | `handleApi(req, res, mode)`, `applyUpdate(id, jsonBody)` | `fixtures.mjs`, `store.mjs`, `headless-core` |
| `store.mjs` | On-disk file store. Each file is `store/<id>.transit` (transit-encoded file data) + `store/<id>.meta.json` (id, name, revn, vern, features). | `readFile(id)`, `writeFile(id, transit, meta)` | `node:fs` |
| `launch.mjs` | Opens a chromeless `--app` Chromium window at a given URL. Tries a list of browser executables in order. | — (run directly: `node launch.mjs <url>`) | `node:child_process` |
| `playwright.config.mjs` | Playwright configuration. `testDir: ./e2e`, 60 s timeout, headless Chromium, base URL `http://localhost:${PENCILPOT_PORT\|\|7777}`. | — (config file) | `@playwright/test` |
| `e2e/helpers.mjs` | Shared Playwright helpers. `login` drives the penpot-hl login form (proxy/record mode only). `expectCanvasLoaded` asserts the workspace viewport is visible and the URL is not `/auth/login`. `trackErrors` collects console errors + page errors. | `login`, `expectCanvasLoaded`, `trackErrors` | `@playwright/test` |
| `e2e/record.spec.mjs` | Playwright spec for proxy/record mode. Logs into penpot-hl, opens the test file, nudges shapes to emit `update-file`, saves the workspace URL to `workspace-url.txt`. | test: `record: login, open the test file, nudge a shape` | `helpers.mjs`, `node:fs` |
| `e2e/boot.spec.mjs` | Playwright spec for replay mode. Navigates to the workspace URL and asserts the canvas loads from fixtures alone (no upstream API contact, no fatal errors). | test: `boot: SPA renders the canvas from replayed fixtures` | `helpers.mjs` |
| `e2e/serve.spec.mjs` | Playwright spec for serve mode. Two tests: (1) canvas renders with `get-file` confirmed from disk via `x-pencilpot-source: disk` header; (2) arrow-key edit → `update-file` → revn bumped on disk → reload re-renders. | tests: `serve: canvas renders…`, `serve: editing the canvas persists…` | `helpers.mjs`, `store.mjs`, `headless-core` |
| `test/engine-roundtrip.test.mjs` | node:test unit. Creates a session, adds a board + rect, calls `getFileResponse()`, re-hydrates from the emitted transit, asserts the board id survives the round-trip. | test: `getFileResponse emits inline transit that re-hydrates to the same shapes` | `headless-core` |
| `test/mutate.test.mjs` | node:test integration. Seeds a file in the store, calls `applyUpdate` with a `mod-obj` change, reloads from disk, asserts the moved coordinate persisted. | test: `applyUpdate moves a shape and persists the new position to disk` | `store.mjs`, `api.mjs`, `headless-core` |
