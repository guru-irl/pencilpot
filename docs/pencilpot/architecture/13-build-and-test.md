# Pencilpot — Build & Test reality (Phase 4)

**Status:** Living (current as of branch `pencilpot`).
**Branch:** `pencilpot`
**Locations:** `frontend/` (app bundle), `headless-core/` (engine + MCP/SDK), `pencilpot/run-tests.mjs`,
`pencilpot/test/`, `headless-core/test/`, `pencilpot/e2e/`.
**Updated:** Phase 4 — adds the headless `:headless` build, the `.mjs`-no-rebuild rule, the tiered test
runner, and the `e2e/ai/*` AI-dev harness catalogue.

> Companion: [`02-frontend-build.md`](02-frontend-build.md) documents the **from-source** render-wasm + app
> build toolchain (Rust/Emscripten/Skia, `build:wasm`, `build:app`). This doc is the **day-to-day** build &
> test reality — what you rebuild after a change, and how to verify it. Read `02` first for the one-time setup.

---

## The three build artifacts

Pencilpot has **three** independently-built, gitignored artifacts. Knowing which one a change touches tells
you what to rebuild (and what you don't).

```
 change you made                          rebuild                                  artifact
 ───────────────────────────────────────  ───────────────────────────────────────  ─────────────────────────
 frontend CLJS  (app/main/**)             frontend JS build (shadow-cljs release)   frontend/resources/public/js/*
 frontend SCSS  (**/*.scss)               frontend assets build (sass)              frontend/resources/public/css/main.css
 headless CLJS  (headless-core/src/**)    headless build (shadow-cljs release)      headless-core/target/headless/penpot.js
 runtime/CLI .mjs (pencilpot/**, sdk/**)  NOTHING — just restart the process        (interpreted at runtime)
```

### 1. Frontend — TWO separate steps (JS and CSS are independent)

The frontend is **not** one build. JS (CLJS→JS) and CSS (SCSS→CSS) are produced by different commands; a
SCSS-only change must **not** trigger the slow CLJS release, and vice-versa.

```bash
# JS (CLJS → js/main.js, js/worker.js, …) — the slow one (~minutes)
cd frontend && SHADOW_SERVER_URL=http://localhost:3449 clojure -M:dev:shadow-cljs release main worker
#   (= `pnpm run build:app:main`; full app build is `pnpm run build:app` = clear-cache + main + libs)

# CSS (SCSS → resources/public/css/main.css) — a SEPARATE step
cd frontend && pnpm run build:app:assets
#   build:app:assets = node scripts/build-app-assets.js → compileSass (resources/styles/main-default.scss
#   + per-namespace *.scss modules), svg sprites, polyfills, index.html. It does NOT build config.js
#   (the runtime injects that — see 03-frontend-strip.md).
```

Outputs land under `frontend/resources/public/` (`js/*`, `css/main.css`, `index.html`, fonts, images) — all
**gitignored** (generated). render-wasm artifacts persist from the one-time `build:wasm` (see `02`); a CLJS
edit does **not** rebuild wasm.

**Rule of thumb after a frontend edit:** edited `.cljs` → run the JS release; edited `.scss` → run
`build:app:assets`; edited a template/`index.mustache` → `build:app:assets`. Most native-UI changes in this
programme (e.g. `left_header.scss`, `typography.scss`) are **SCSS-only** → assets step only, no CLJS release.

> **CLJS class-name lesson** (relevant when editing SCSS-bound CLJS): the `stl/css` macro hashes only
> **literal** keywords at compile time; a class chosen at runtime must use `stl/css-case`. A CLJS change here
> needs the JS release, not just the assets step.

### 2. Headless engine — the `:headless` ESM build

`headless-core/` compiles the Penpot engine (shapes/changes/validation, plus pencilpot's session façade) to a
**single Node ESM module**:

```bash
cd headless-core && clojure -M:dev:shadow-cljs release headless
#   (= `npm run build`) → headless-core/target/headless/penpot.js
```

Config: `headless-core/shadow-cljs.edn` build `:headless` — `:target :esm`, `:runtime :node`,
`:output-dir target/headless`, module `:penpot` exporting `createSession` (`app.headless.session/create-session`),
`importBinfileV3`, and the `buildAdd*Change` helpers. The runtime (`pencilpot/runtime/*`) and the SDK
(`headless-core/sdk/*`) **import this artifact** — it is the engine singleton loaded once per process.

Rebuild the headless artifact whenever you change `headless-core/src/**` (e.g. `session.cljs`'s
`getViewerBundle`/`:validate`). `pencilpot/run-tests.mjs` auto-builds it if `target/headless/penpot.js` is
missing (preflight `ensureBuild`).

### 3. Runtime / CLI / SDK `.mjs` — NO rebuild

Everything under `pencilpot/runtime/*`, `pencilpot/store/*`, `pencilpot/bin/*`, `headless-core/sdk/*`, and
`headless-core/mcp/*` is **plain ES modules executed by Node** — there is no compile step. A `.mjs`-only change
takes effect on the next process start. **Just restart the runtime** (`pencilpot open …` / `node
runtime/server.mjs`); never rebuild for a `.mjs` edit. This is the single most common time-saver.

---

## Testing

### Unit / integration — `node --test` via the tiered runner

```bash
cd pencilpot && node run-tests.mjs --unit     # unit + integration tiers; no browser, no live backend
```

`pencilpot/run-tests.mjs` is a one-command tiered runner (preflight: ensure `headless-core` engine built;
probe `:9101` for the live tier). Tiers:

| Tier | Needs | Examples |
|---|---|---|
| **unit** | engine build only | `headless-core/test/store.test.mjs`, `pencilpot/test/{store,project,live}.test.mjs` |
| **integration** | engine build | `pencilpot/test/{rpc,library,cli,fonts,terminal}.test.mjs` |
| **desktop** | `pencilpot` on PATH + installed `.desktop` | `pencilpot/scripts/verify-desktop.sh` (LOUDLY skipped if not installed) |
| **e2e** | Playwright + live penpot-hl `:9101` | `pencilpot/e2e/{boot,edit,library,terminal}.spec.mjs` (LOUDLY skipped if not live) |

Flags: `--unit` (unit+integration only — the default green-bar check), `--live` (require `:9101`, fail if
down), none (unit+integration+desktop always; e2e only if live). A skip is **not** a failure — the runner is
loud about why a tier was skipped.

The authoritative pass/fail signal is `node --test`'s TAP summary (`# pass N` / exit 0). To run one suite
definitively: `node --test pencilpot/test/worktree.test.mjs` (or `headless-core/test/*.test.mjs`). The
headless-core suite has its own runner too: `cd headless-core && npm test` (`node scripts/run-tests.mjs`).

**Full suite inventory:**
- `pencilpot/test/`: `cli`, `edn`, `fonts`, `fvar`, `image-size`, `import-media`, `library`, `live`,
  `media-route`, `multipart`, `project`, `read-session-cache`, `rpc`, `store`, `terminal`, `upload-media`,
  `worktree`.
- `headless-core/test/`: `cli`, `commit-baseline-gate`, `dataTransit-roundtrip`, `facade`, `mcp-server`,
  `roundtrip`, `script`, `session`, `store`, `viewer-bundle`, `workingcopy.roundtrip`.

### e2e harnesses — self-booting Node scripts under `pencilpot/e2e/`

Two flavours live here:

**(a) `pencilpot/e2e/*.spec.mjs`** — the Playwright specs the runner drives in the `e2e` tier
(`boot`, `boot-direct`, `edit`, `fonts`, `library`, `live`, `no-auth`, `no-crash`, `own-bundle`, `render`,
`terminal`, `workspace-url`). Gated on a live `:9101`.

**(b) `pencilpot/e2e/vf/*` and `pencilpot/e2e/ai/*`** — standalone, **self-booting** verification harnesses
(run directly with `node`, they spawn their own runtime). Each SKIPs with exit 0 when its design fixture
(`/mnt/data/src/DefaultLauncher/design`) is absent, so they're CI-safe.

`pencilpot/e2e/vf/` — renderer / feature verifiers (variable fonts, media, view mode, save UI):
`vf-render.mjs`, `vf-render-svg.mjs`, `vf-stress.mjs`, `ui-axis.mjs`, `shoot.mjs`, `seed.mjs`,
`verify-renderer.mjs`, `verify-media.mjs`, `verify-positiondata.mjs`, `verify-no-profile-rpc.mjs`,
`verify-native-save-ui.mjs`, `verify-viewer.mjs`, `verify-viewer-perf.mjs`, `verify-viewer-window.mjs`.

`pencilpot/e2e/ai/` — the **AI-dev** harnesses (the executable proof behind
[`../ai-dev-capabilities.md`](../ai-dev-capabilities.md)): `mcp-roundtrip.mjs` (MCP stdio transport),
`commit-roundtrip.mjs` + `commit-imported.mjs` (commit gate), `sdk-structure.mjs` (boards/shapes/layout/
components), `sdk-tokens.mjs` + `variable-fonts.mjs` (assets), `prototypes.mjs` + `lifecycle.mjs` (viewer +
persistence), plus the shared boot helper `_boot.mjs`.

**The boot pattern** (`pencilpot/e2e/ai/_boot.mjs`): `spawnRuntime(dir, port)` spawns
`process.execPath runtime/server.mjs` with env `PENCILPOT_DESIGN=<dir>` + `PENCILPOT_PORT=<port>`, then
`waitForHttp(base + "/")` polls the HTTP root until the runtime answers (a `randomPort()` avoids collisions).
Helpers expose `status()`/`save()`/`discard()` (POST `/pencilpot/{status,save,discard}`) and
`getFileViaRuntime()` (the json-meta + transit pair the SDK uses). For browser-rendering harnesses (the vf
ones and the chromium-using ai ones — `sdk-structure`, `variable-fonts`, `prototypes`, `lifecycle`),
swiftshader Chromium is launched with `--use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader
--ignore-gpu-blocklist` (see `e2e/vf/shoot.mjs`), so SVG/GL rendering works headless without a GPU.

---

## Quick recipes

```bash
# After editing frontend CLJS:
cd frontend && SHADOW_SERVER_URL=http://localhost:3449 clojure -M:dev:shadow-cljs release main worker

# After editing frontend SCSS only:
cd frontend && pnpm run build:app:assets

# After editing headless-core CLJS (engine/session):
cd headless-core && clojure -M:dev:shadow-cljs release headless

# After editing runtime/CLI/SDK .mjs:
# (nothing — restart the runtime)

# Green-bar check:
cd pencilpot && node run-tests.mjs --unit

# One AI-dev harness (needs the DefaultLauncher design fixture; else SKIPs exit 0):
node pencilpot/e2e/ai/sdk-structure.mjs
```

---

## Source map
- Frontend build scripts — `frontend/package.json` (`build:app:main`, `build:app`, `build:app:assets`,
  `build:wasm`), `frontend/scripts/build-app-assets.js`, `frontend/scripts/_helpers.js` (`compileSass`).
- Headless build — `headless-core/shadow-cljs.edn` (`:headless` → `:esm`/`:node`, `target/headless/penpot.js`),
  `headless-core/package.json` (`build`, `test`, `mcp`).
- Test runner — `pencilpot/run-tests.mjs` (tiers, preflight `ensureBuild`/`probeLive`, flags).
- Test suites — `pencilpot/test/*.test.mjs`, `headless-core/test/*.test.mjs`.
- e2e — `pencilpot/e2e/*.spec.mjs` (Playwright tier), `pencilpot/e2e/vf/*`, `pencilpot/e2e/ai/*`
  (`_boot.mjs` boot pattern; `shoot.mjs`/`ui-axis.mjs` swiftshader chromium args).
- Companion — [`02-frontend-build.md`](02-frontend-build.md) (from-source toolchain),
  [`03-frontend-strip.md`](03-frontend-strip.md) (config.js injection),
  [`../ai-dev-capabilities.md`](../ai-dev-capabilities.md) (what the `e2e/ai/*` harnesses prove).
