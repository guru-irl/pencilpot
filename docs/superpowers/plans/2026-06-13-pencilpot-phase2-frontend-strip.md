# Pencilpot Phase 2 — Frontend Strip + Delete Auth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Serve our OWN self-built Penpot frontend bundle (no proxy) and delete the auth/login layer at the CLJS source level, so the runtime boots straight into the designer for the opened file — pencilpot fully self-contained.

**Architecture:** The frontend build toolchain (render-wasm: Rust 1.91 + emsdk 4.0.6) is installed and a full bundle is built at `frontend/resources/public/` (see `docs/pencilpot/architecture/02-frontend-build.md`). The runtime serves that bundle statically + a runtime-injected `config.js`; we edit `frontend/src/app/**` CLJS to remove auth/dashboard/collab and boot to the workspace, rebuilding with `pnpm run build:app:main` (+ `:assets` if templates change).

**Tech Stack:** ClojureScript (shadow-cljs), Node runtime (`pencilpot/runtime/`), Playwright. penpot-hl no longer needed at runtime once F1 lands (still the contract reference).

---

## Scope & boundaries
- **In:** serve our bundle (drop proxy) + runtime `config.js`; delete `/auth` routes + login guard + boot profile/teams fetch + ws-auth gate; remove dashboard/collab routes; boot straight to workspace via injected `window.pencilpotFile`; tests + docs.
- **Out:** desktop shell/file-assoc (Phase 3); terminal/AI (Phase 4); deleting unused auth/dashboard *namespaces* from the tree (Phase 5 lean audit — Phase 2 just de-routes them so they don't load). Custom fonts/comments stay empty-stubbed.
- **Build artifacts** (`frontend/resources/public/**`, `render_wasm/api/shared.js`) stay **gitignored**; never commit them.

## File structure
- Modify: `pencilpot/runtime/server.mjs` + new `pencilpot/runtime/static.mjs` (serve `frontend/resources/public/` + `config.js` injector), drop the proxy from the default path.
- Modify (CLJS, frontend): `src/app/main.cljs` (boot), `src/app/main/ui/routes.cljs` (routes + guard), `src/app/main/data/workspace.cljs` (collab init) — exact edits in tasks.
- Create: `pencilpot/runtime/frontend.mjs` (resolve the built `resources/public` dir + the `config.js` template).
- Test: `pencilpot/e2e/own-bundle.spec.mjs` (render from our bundle), extend `pencilpot/e2e/{boot,edit}.spec.mjs`; `pencilpot/test/static.test.mjs`.
- Docs: `docs/pencilpot/architecture/03-frontend-strip.md` + per-file README updates.

## Task F1: Serve our own bundle + verify render (no proxy) — THE MILESTONE PROOF
**Files:** `pencilpot/runtime/static.mjs`, `pencilpot/runtime/frontend.mjs`, `pencilpot/runtime/server.mjs`, `pencilpot/e2e/own-bundle.spec.mjs`

- [ ] **Step 1:** `frontend.mjs` — resolve `FRONTEND_DIST` (default `<repo>/frontend/resources/public`); export `distDir()` + `configJs({publicUri, fileId, teamId})` returning a `config.js` body that sets `globalThis.penpotPublicURI`, `globalThis.penpotFlags=""`, and `globalThis.pencilpotFile={fileId,teamId}` (read by the boot in F2; harmless now).
- [ ] **Step 2:** `static.mjs` — `serveStatic(req,res)`: map `/` → `index.html`; `/js/config.js` → the injected `configJs(...)` (content-type application/javascript); every other path → the file under `distDir()` with the right content-type (.js/.css/.wasm/.map/.svg/.woff2/.png…); 404 if absent. Stream/readFile; set `cache-control: no-store` for index.html + config.js.
- [ ] **Step 3:** `server.mjs` — replace the `proxyHttp` fallback with `serveStatic`; keep `/api/*` → `handleRpc` and the ws stub. Env `PENCILPOT_DESIGN` provides the file id for `config.js`/the workspace URL.
- [ ] **Step 4:** failing e2e `pencilpot/e2e/own-bundle.spec.mjs` — like `boot.spec` but asserts the page is served by US (no penpot-hl): assert `index.html` came from our server and the workspace canvas renders a file from the EDN store, with **penpot-hl's frontend NOT consulted** (assert no request went upstream — our static server is the only source). Reuse `expectCanvasLoaded`.
- [ ] **Step 5:** seed (`node scripts/seed-from-hl.mjs`), start the runtime serving our bundle (`PENCILPOT_DESIGN=.scratch/proj/home.penpot`), run the spec → PASS. **If the self-built bundle doesn't render** (debug-wasm/asset/path issue), diagnose precisely (console + network 404s) — this is the real viability gate. Common: a missing asset path, the render-wasm.wasm content-type, or a stale-build version mismatch in index.html vs config.
- [ ] **Step 6:** commit (code only): `:sparkles: pencilpot runtime: serve our own self-built frontend bundle (drop the proxy)`.

## Task F2: Boot straight into the workspace (delete boot profile/teams fetch)
**Files:** `frontend/src/app/main.cljs`, `frontend/src/app/main/ui/routes.cljs`
- [ ] **Step 1:** Read `main.cljs` `initialize` + `routes.cljs` `on-navigate` (the Phase 0 recon documents these). Write a failing e2e assertion (extend own-bundle.spec): navigating to `/` (NOT a workspace URL) lands in the workspace for `window.pencilpotFile.fileId`, and **no `get-profile`/`get-teams` request is ever made** (network assertion).
- [ ] **Step 2:** Edit `main.cljs` `initialize`: remove `dp/refresh-profile` + the `profile-fetched?→routes`/`is-authenticated?→ws/initialize` arms; instead initialize routes immediately and, if `window.pencilpotFile` is set, `rt/nav` to `:workspace` with `{:team-id <pencilpotFile.teamId> :file-id <pencilpotFile.fileId>}`. Provide a minimal synthetic profile in app state (so downstream code that reads the profile doesn't NPE) WITHOUT fetching it.
- [ ] **Step 3:** Rebuild (`pnpm run build:app:main`); run the spec → PASS (boots to workspace, zero auth RPC). Commit.

## Task F3: Delete /auth routes + the login-redirect guard + dashboard routes
**Files:** `frontend/src/app/main/ui/routes.cljs`
- [ ] **Step 1:** failing assertion: navigating to `/#/auth/login` (or any `/auth/*`) does NOT render the login UI (route gone → redirect to workspace); and the `on-navigate` guard that did `(rt/nav :auth-login)` on `uuid/zero` is removed.
- [ ] **Step 2:** Remove the `/auth/*` and `/dashboard/*` route entries + the login-redirect branch in `on-navigate`; default/unknown route → the workspace (or a minimal "no file open" state). Keep `/workspace` + `/viewer` if desired.
- [ ] **Step 3:** Rebuild + e2e (no login reachable, no dashboard) → PASS. Commit.

## Task F4: Drop collab/notifications boot (already ws-stubbed)
**Files:** `frontend/src/app/main/data/workspace.cljs`
- [ ] **Step 1:** failing assertion: the workspace boots with NO `/ws/notifications` connection attempt (or it's inert) and no presence/notifications init; canvas + edit still work.
- [ ] **Step 2:** Remove the `dwn/initialize` (notifications) call from the workspace init; leave file/fonts/libraries fetch intact.
- [ ] **Step 3:** Rebuild + e2e (boot + edit round-trip still green) → PASS. Commit.

## Task F5: Remove now-unnecessary auth stubs from the runtime
**Files:** `pencilpot/runtime/stubs.mjs`, `pencilpot/runtime/rpc.mjs`
- [ ] **Step 1:** With the boot no longer fetching get-profile/get-teams, assert the runtime no longer NEEDS those stubs for boot (the e2e passes without them). Keep only the stubs the *workspace* still calls (fonts/comments/thumbnails/audit/file-libraries).
- [ ] **Step 2:** Remove the obsolete get-profile/get-teams/etc. stubs (or leave as harmless 200s if the workspace still pings them — verify via the network log). Update `stub-data/` accordingly.
- [ ] **Step 3:** Full e2e → PASS. Commit.

## Task F6: Tests + docs + tiered runner update
**Files:** `pencilpot/run-tests.mjs`, `pencilpot/e2e/*`, `docs/pencilpot/architecture/03-frontend-strip.md`, `pencilpot/README.md`
- [ ] **Step 1:** Ensure the runner's e2e tier builds/uses our bundle (preflight: build the frontend if `resources/public/index.html` missing — call out the toolchain dependency, LOUD-skip if unbuildable). Add `own-bundle`/auth-gone assertions to the suite. Keep unit/integration green.
- [ ] **Step 2:** `03-frontend-strip.md` — what was deleted (auth/dashboard/collab), the boot-to-workspace flow, `window.pencilpotFile`, the runtime static+config serving. Update the architecture index + `pencilpot/README.md` per-file table (runtime static.mjs/frontend.mjs). 
- [ ] **Step 3:** Full `node run-tests.mjs` green; commit. Then the controller pushes the branch (per the "push after every phase" rule).

## Self-Review (against the Phase 2 spec)
- Serve our bundle, drop proxy (spec §5): F1. ✓ · Delete boot profile/teams fetch + boot to workspace (spec §4): F2. ✓ · Delete /auth routes + login guard + dashboard (spec §4): F3. ✓ · Drop collab init (spec §4): F4. ✓ · `config.js` runtime-injected + `window.pencilpotFile` (spec §4/§5): F1/F2. ✓ · Remove obsolete stubs (spec §5): F5. ✓ · First-class tests asserting auth is GONE not hidden — no /auth render, no get-profile request (spec §6): F1–F5 network assertions. ✓ · Docs (spec §6): F6. ✓
- **Build dependency:** every CLJS edit task ends with `pnpm run build:app:main` then re-running e2e; artifacts stay gitignored.
- **Commit hygiene:** standard subjects, no Claude attribution.
