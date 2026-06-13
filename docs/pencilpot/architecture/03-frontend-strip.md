# Architecture Note: Phase 2 — Frontend Strip

**Status:** Complete.
**Branch:** `pencilpot`
**Locations:** `frontend/src/app/main.cljs`, `frontend/src/app/main/ui/routes.cljs`,
`frontend/src/app/main/data/workspace.cljs`,
`pencilpot/runtime/frontend.mjs`, `pencilpot/runtime/static.mjs`,
`pencilpot/runtime/stub-data/`
**Updated:** Phase 2 complete (serve own bundle; strip auth/dashboard/collab; boot direct to workspace).

---

## Overview

Phase 2 converts the pencilpot runtime from a proxy that forwarded static assets to
penpot-hl:9101 into a self-contained server that serves our own frontend bundle.
Simultaneously, the CLJS source is edited to remove the auth/login/dashboard/collab
layer so the SPA boots directly into the designer with zero authentication RPCs.

Two sub-goals:

- **F (Frontend build):** serve `frontend/resources/public/` from the pencilpot runtime;
  inject `config.js` at runtime; set `window.pencilpotFile` so the workspace route can
  be derived without a URL.
- **Delete auth/dashboard/collab:** edit `main.cljs` + `routes.cljs` + `workspace.cljs`
  at the CLJS source level so the built bundle never fetches get-profile, never renders
  a login form, and never opens a WebSocket to `/ws/notifications`.

---

## Serving the Own Bundle

### `pencilpot/runtime/frontend.mjs`

New file. Exports two functions used by the static file server:

- `distDir()` — returns `frontend/resources/public/` (or `$PENCILPOT_FRONTEND` override).
- `configJs({ publicUri, fileId, teamId })` — returns the runtime-injected `config.js`
  body. Sets `globalThis.penpotPublicURI = location.origin` so all SPA RPC calls go to
  the pencilpot runtime; sets `globalThis.penpotFlags = ""` (empty); sets
  `globalThis.pencilpotFile = { fileId, teamId }` so the router can derive the workspace
  URL without a user-facing URL (see [Boot Flow](#boot-to-workspace-flow) below).

### `pencilpot/runtime/static.mjs`

New file. Handles all non-API requests:

- `/js/config.js` and `/config.js` — served by `configJs()` (injected, not read from disk).
- `/` and `` → `/index.html` (served from `distDir()`).
- Everything else — read from `distDir()` via MIME-typed `fs.readFile`. No path traversal
  (`file.startsWith(base)` guard).

`server.mjs` was updated to call `serveStatic()` instead of proxying to penpot-hl for
non-API traffic.

### `pencilpot/runtime/proxy.mjs`

The former proxy (forwarding to penpot-hl:9101) is **now unused for static assets**.
It remains in the codebase as a legacy file (it still exports `readBody` used by
`rpc.mjs`, and `attachWsStub` used by `server.mjs`). The proxy/asset-forwarding path
is dead; only `readBody` and `attachWsStub` are live.

### The bundle is gitignored and must be built

`frontend/resources/public/` is listed in `.gitignore`. It must be built from source
before running e2e tests. See
[`docs/pencilpot/architecture/02-frontend-build.md`](02-frontend-build.md) for the
full Rust/Emscripten/CLJS build recipe. Quick summary:

```bash
# render-wasm artifacts must already exist (one-time, ~10 min):
# see 02-frontend-build.md Step 1

cd frontend
corepack pnpm install
corepack pnpm run build:app:main    # CLJS -> js/ (~80s)
corepack pnpm run build:app:assets  # index.html, css, svgsprite, polyfills
```

---

## Deleted Auth / Dashboard / Collab

The following CLJS files were edited (not deleted — the upstream Penpot source is
preserved; only targeted changes were made):

### `frontend/src/app/main.cljs`

What was removed or replaced:

| Removed | Replaced with |
|---|---|
| `(dp/refresh-profile)` dispatch at boot | `(seed-local-profile)` — injects a synthetic profile map into app state |
| `profile-fetched?` stream arm that called `rt/init-routes` | `(rt/init-routes)` called immediately (no RPC gate) |
| `profile-fetched?` + `is-authenticated?` stream arm that called `ws/initialize` | Removed entirely (no WebSocket init) |
| `da/logged-out` on profile-deleted events | Removed |
| Imports: `app.main.data.auth`, `app.main.data.profile`, `app.main.data.websocket` | Removed |

`seed-local-profile` creates a map `{:id (uuid/next) :email "local@pencilpot" :fullname
"Local" :lang "" :theme "default" :props {}}` and asserts it into `:profile` +
`:profile-id` in app state. Downstream code reading `:profile` from state never NPEs.

**Result:** on `initialize`, the SPA immediately seeds the local profile and calls
`rt/init-routes` — no get-profile RPC, no is-authenticated check, no WebSocket init.

### `frontend/src/app/main/ui/routes.cljs`

What was removed:

- All `/auth/*` routes (`auth-login`, `auth-register`, `auth-register-validate`,
  `auth-register-success`, `auth-recovery-request`, `auth-recovery`, `auth-verify-token`).
- All `/settings/*` routes (`settings-profile`, `settings-password`, `settings-feedback`,
  `settings-options`, `settings-subscription`, `settings-integrations`,
  `settings-notifications`).
- All `/dashboard/*` routes — both the new-style `/dashboard/...` and the legacy
  `/dashboard/team/:team-id/...` variants (15 route names total).
- The `store-session-params` function (read `:template` and `:plugin` query params into
  session storage).
- The `on-navigate` else-branch that called `rp/cmd! :get-profile` + `rp/cmd! :get-teams`
  to decide where to redirect an unauthenticated user.
- Imports: `app.common.uri`, `app.common.uuid`, `app.main.data.team`,
  `app.main.errors`, `app.main.repo`, `app.util.storage`.

What was added:

- `nav-to-pencilpot-workspace` — reads `window.pencilpotFile.fileId` and
  `window.pencilpotFile.teamId` from the injected `config.js` and emits
  `rt/nav :workspace` with those params.
- `on-navigate` else-branch simplified to: if the path is empty or no route matches,
  call `nav-to-pencilpot-workspace`.

**Result:** navigating to `/` or `/#/auth/login` (or any unknown path) boots straight
into the workspace. No login form renders.

### `frontend/src/app/main/data/workspace.cljs`

One change: removed `(dwn/initialize team-id file-id)` from the
`bundle-fetched` handler's `rx/of` chain. This was the call that opened the
`/ws/notifications` WebSocket connection for real-time collab. Without it, no
WebSocket is ever attempted to `/ws/notifications`.

---

## Boot-to-Workspace Flow

```
Browser → GET /
         ↓
  static.mjs serves frontend/resources/public/index.html
         ↓
  index.html loads /js/config.js (runtime-injected)
    globalThis.penpotPublicURI = location.origin   ← all RPC → :7777
    globalThis.pencilpotFile   = { fileId, teamId } ← workspace coords
         ↓
  SPA boots: main.cljs/initialize fires
    → seed-local-profile (no get-profile RPC)
    → rt/init-routes (immediate, no auth gate)
         ↓
  on-navigate("") → no route match → nav-to-pencilpot-workspace
    → rt/nav :workspace { :file-id fileId :team-id teamId }
         ↓
  Workspace init: get-file?id=<fileId> → rpc.mjs → EDN store
    + get-file-libraries → rpc.mjs → shared/*.penpot
    + get-enabled-flags, get-teams, get-team-members, get-project,
      get-comment-threads, get-profiles-for-file-comments,
      get-font-variants, get-file-object-thumbnails … → stubs.mjs
         ↓
  Canvas renders (Penpot designer, filesystem-native, no auth/collab)
```

Zero `/auth` redirects. Zero `get-profile` calls. Zero `/ws/notifications` WebSocket.

---

## Pruned Stubs (Phase 2)

During Phase 2 boot logging, the following stubs were found to be never requested
by the SPA after auth/dashboard were stripped. They were deleted from
`pencilpot/runtime/stub-data/`:

| Removed stub | Why |
|---|---|
| `get-profile` | Auth gate — never called (profile is seeded synthetically) |
| `get-projects` | Dashboard RPC — never called post-strip |
| `get-team-recent-files` | Dashboard RPC — never called post-strip |
| `get-file-libraries` | Shadowed by the real `rpc.mjs` handler; stub was dead |

Stubs retained (still called by the workspace on every boot):
`get-enabled-flags`, `get-teams`, `get-team-members`, `get-project`,
`get-comment-threads`, `get-profiles-for-file-comments`, `get-font-variants`,
`get-file-object-thumbnails`, `create-file-object-thumbnail`,
`delete-file-object-thumbnail`, `create-file-thumbnail`,
`get-file-data-for-thumbnail`, `get-builtin-templates`,
`get-unread-comment-threads`, `push-audit-events`.

---

## System Diagram (Phase 2)

```
  Browser
     │
     │  GET /  (index.html + assets + config.js)
     │  GET /api/*/get-file                → rpc.mjs → disk
     │  GET /api/*/update-file             → rpc.mjs → disk
     │  GET /api/*/get-file-libraries      → rpc.mjs → disk
     │  GET /api/*/<workspace-stub>        → stubs.mjs → replay
     │  WS  /ws/notifications              → ws stub (silent, never opened by client)
     ▼
  localhost:7777
  ┌──────────────────────────────────────────────────────────────┐
  │  server.mjs   PENCILPOT_PROJECT=…  PENCILPOT_DESIGN=…       │
  │                                                              │
  │  /api/*          ──► rpc.mjs (disk or stubs.mjs)            │
  │  /js/config.js   ──► frontend.mjs (runtime-injected)        │
  │  /* (all else)   ──► static.mjs → distDir()                 │
  └──────────────────────────────────────────────────────────────┘
          │                        │
   ┌──────┴────────┐         ┌─────┴──────────────────────┐
   │  store/       │         │  frontend/resources/public/ │
   │  store.mjs    │         │  (gitignored, build first)  │
   │  project.mjs  │         └────────────────────────────┘
   └──────┬────────┘
          │
  ┌───────┴──────────────┐
  │  headless-core engine│
  │  createSession()     │
  │  applyTransitUpdate()│
  │  getFileResponse()   │
  └──────────────────────┘

  No JVM. No Postgres. No auth. No collab server. No penpot-hl for assets.
```

---

## e2e Coverage Added in Phase 2

| Spec | Asserts |
|---|---|
| `own-bundle.spec.mjs` | Our self-built bundle serves the workspace; zero requests to penpot-hl:9101 |
| `boot-direct.spec.mjs` | Root `/` lands in workspace without any `get-profile` call |
| `no-collab.spec.mjs` (inside `boot-direct`) | No `/ws/notifications` WebSocket is opened after boot |
| `no-auth.spec.mjs` | `/#/auth/login` does not render a login form; URL does not contain `/auth/login` after navigation |
