# Pencilpot Phase 2 — Frontend Strip + Delete Auth/Login (F)

**Status:** Design spec (sub-project F, under the umbrella `docs/superpowers/specs/2026-06-12-pencilpot-design.md`). Feeds an implementation plan.
**Date:** 2026-06-13 · **Branch:** `pencilpot`
**Builds on:** Phase 1 (runtime L + EDN store S, DONE). Phase 1 still **proxies penpot-hl's compiled assets** and serves a synthetic profile. Phase 2 makes pencilpot self-contained at the frontend level.

---

## 1. Goal

Serve our **own** Penpot frontend bundle (no proxy to penpot-hl) and **delete the entire auth/login layer**, so the runtime boots straight into the designer for the opened file — no accounts, no login screen, no dashboard. After Phase 2, pencilpot needs penpot-hl for nothing at runtime.

## 2. Scope

- Build the Penpot frontend app bundle locally (shadow-cljs `release main` + libs + assets).
- **Edit the frontend ClojureScript source** to: delete `/auth/*` routes + the login-redirect guard, delete the boot-time `get-profile`/`get-teams` fetch + the `is-authenticated?` websocket gate, remove the dashboard + collab route trees, and **boot straight into the workspace** for a runtime-provided file id (synthetic local team id).
- Make the runtime **serve our built bundle statically** (drop the asset proxy) and inject the file-to-open via `index.html`.
- Keep ~100% of the **designer/workspace UI** untouched.

Out of scope: desktop shell/file-association (Phase 3); terminal/AI (Phase 4); deleting unused backend/SaaS *code* (Phase 5 lean audit). Custom fonts/comments remain stubbed/empty.

## 3. Keystone risk & decision (de-risk FIRST)

**Can we build the frontend in this environment?** Tooling is present (clojure, java, pnpm@10.31, corepack); `node_modules` needs `pnpm install`. The app build is `pnpm run build:app` (= `build:app:main` via `clojure -M:dev:shadow-cljs release main worker` + `build:app:libs` + assets). The WASM render build is **separate** and not part of `build:app` (the SVG render path doesn't require it).

**Plan F1 is a build-viability spike:** `pnpm install` → `pnpm run build:app` → serve the *unmodified* built `resources/public/` from the runtime (replacing the proxy) and confirm via the Phase 1 e2e that the designer still renders + edits a file from the EDN store. **The whole phase approach depends on this:**
- **If the build works** → Phase 2 = edit cljs + rebuild + serve our bundle (the clean path this spec assumes).
- **If the build is infeasible** here → fall back to serving penpot-hl's *proxied* assets but applying the auth/boot strip via a small injected script + patched `config.js`/`index.html` (a runtime-patch path); revise this spec accordingly. Decided by F1's outcome, recorded in the plan.

## 4. What gets deleted / changed (frontend cljs)

Grounded in the Phase 0 recon (paths to confirm live):
- **`frontend/src/app/main/ui/routes.cljs`** — remove the `/auth/*` and `/dashboard/*` (and viewer/settings if unused) route entries; remove the `on-navigate` login-redirect guard (`get-profile`→`get-teams`→`(rt/nav :auth-login)` when `id == uuid/zero`). Default route → the workspace for the configured file.
- **`frontend/src/app/main.cljs` `initialize`** — remove `dp/refresh-profile` (boot `get-profile`) + the `profile-fetched?→get-teams` and `is-authenticated?→ws/initialize` arms. Boot directly: read the runtime-injected file config and `rt/nav` to `:workspace` with a synthetic local team id + the file id.
- **`frontend/src/app/main/data/workspace.cljs` boot** — drop the collab/notifications init (`dwn/initialize`) and any comment-thread fetch that isn't wanted; keep the file/fonts/libraries fetch (served by the runtime).
- **Auth/dashboard UI namespaces** — no longer routed; left in the tree for Phase 5 deletion (not imported by the boot path so they don't load).
- **Config:** the runtime templates `index.html` to set `window.penpotPublicURI = location.origin` and a new `window.pencilpotFile = {fileId, teamId}`; the stripped boot reads `window.pencilpotFile`.

## 5. Runtime changes (L)

- Serve our built `frontend/resources/public/` (index.html + js/ + css/ + assets) **statically** from the runtime; drop `proxy.mjs`'s upstream forwarding (keep the `/api` router + ws stub). `index.html` is templated to inject `window.pencilpotFile` (from `PENCILPOT_DESIGN`'s manifest id) + a constant local team id.
- The synthetic `get-profile`/`get-teams` stubs become **unnecessary** once the boot no longer fetches them — remove or keep as harmless. The workspace's own RPC (get-file/get-fonts/get-file-libraries/…) stays served from the store.
- A `pencilpot build-frontend` step (or a documented command) produces the bundle; the runtime serves whatever is in `resources/public/`.

## 6. Testing (first-class — every change ships a test)

- **e2e (primary):** after each strip, the runtime serving OUR bundle (no proxy, no auth) boots straight into the designer for the configured file, renders it from the EDN store, and an edit round-trips — reusing the Phase 1 Playwright harness, asserting **no `/auth/login` redirect ever** and **no get-profile/get-teams request fired** (network assertions prove the layer is gone, not just hidden).
- **unit/integration:** runtime serves index.html with the injected `window.pencilpotFile`; static asset serving returns the built js/css; the boot config plumbing.
- Extend `pencilpot/run-tests.mjs` tiers; keep it green.

## 7. Risks

1. **Build feasibility/time** — `pnpm install` + `build:app` may be heavy/slow or hit native-dep snags; mitigated by F1 (and the runtime-patch fallback). The build is also a one-time cost, cached after.
2. **Boot-path edits** — removing the profile fetch may surface assumptions (state expecting a profile object); fix by providing a minimal synthetic profile in app state rather than fetching. Validated by e2e + console-error assertions.
3. **Stale-build / version check** — `main.cljs` compares compiled vs index version tag and reloads; the runtime's templated index must carry a consistent version.
4. **Asset completeness** — fonts/sprites/images must all serve from our `resources/public/`; the F1 spike (serving the unmodified bundle) flushes out any 404s before stripping.

## 8. Decisions locked

- Edit-cljs-and-rebuild is the intended path; F1 confirms build viability before stripping (runtime-patch fallback only if the build is infeasible).
- Auth/login is **deleted**, not stubbed: no `/auth` routes, no login guard, no boot profile/teams fetch, no ws-auth gate; a synthetic local team id + the configured file id drive the boot.
- The runtime serves our own bundle statically (proxy dropped); `index.html` injects `window.pencilpotFile`.
- Designer/workspace UI is untouched; dashboard/auth namespaces are de-routed now, deleted in Phase 5.
