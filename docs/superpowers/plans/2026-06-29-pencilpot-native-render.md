# Pencilpot — native, browser-free `renderShape` (SVG + fast PNG)

## Goal
Headless engine returns a **rendered screenshot of one shape/component** with NO Playwright:
- `renderShape(id,{zoom?,background?}) → SVG string` — synchronous, sub-ms, via Penpot's own
  `app.main.render/component-svg` mounted through `react-dom/server` `renderToStaticMarkup`.
- `renderShapePng(id,{scale?}) → pngPath` — pipe that SVG through the system `rsvg-convert` (librsvg
  2.62, already installed; `magick` fallback). The agent then `read`s the PNG. ZERO new npm deps for raster.

The only new npm dep is **react-dom** (react already transitively present); both are core Penpot, not foreign.

## Why this path
`component-svg` (frontend/src/app/main/render.cljs:345) is the asset-panel thumbnail renderer: takes
`{:objects :root-shape :zoom}`, negates the root x/y to origin, mounts `shape-container` + frame/group
wrapper, returns a self-contained `<svg viewBox w h>`. It is the SVG renderer the user prefers, pixel-true,
and already used head-lessly by the worker. No canvas, no wasm.

## W0 SPIKE RESULT = GO (proven). Recipe:
- Add `penpot/frontend {:local/root "../frontend"}` to `headless-core/deps.edn`; add `react`+`react-dom` to `headless-core/package.json` (scratch proved a symlink to frontend/node_modules works). Compiles clean (861 files, 0 warn, ~22s).
- **No global stub needed.** `component-svg` is `mf/deferred` → SSR returns empty; `render-frame` is rx/async. The synchronous SSR component is **`frame-imposter`** — `(rds/renderToStaticMarkup (mf/element render/frame-imposter #js {:objects :frame :vbox :x :y :width :height}))` → real `<svg>` (1330B for frame+rect). Add a tiny `defn shape->svg` to render.cljs that computes bounds via `gsb/get-object-bounds` + mounts imposter; verb calls it. PNG via `rsvg-convert -z scale` → 400×240 verified, zero npm raster dep.
- ALWAYS run node test scripts through ctx_execute with a timeout (raw `node run.mjs` can hang on font/idle paths).

## (orig) Risk to retire FIRST (Wave 0 spike)
`render.cljs` pulls `app.config`, `app.main.fonts`, `app.util.dom`, etc. Under `:target :esm :runtime :node`
there is no `window`/`document`; module-top-level or wrapper code may deref them. The exporter uses a real
browser precisely to dodge this. We must learn which of: (a) clean SSR, (b) a tiny `globalThis` stub
(window/document/CSS-var shim), or (c) mount the wrapper factory directly (avoid the `mf/deferred` wrap so
SSR isn't a no-op) is needed. Spike answers this before committing the build change.

## Waves (subagent TDD; OMIT model; parent commits per wave; rebuild penpot.js + force-add)
- **W0 spike (1 subagent):** in `headless-core/.scratch/`, try requiring `app.main.render` + react-dom/server,
  render a hand-built rect; report exactly which globals/deps break + the minimal stub, and whether
  `component-svg` (deferred) emits sync or needs the wrapper-factory directly. NO source commit.
- **W1 verb:** add react-dom to package.json + frontend src to classpath; `renderShape(id,{zoom?})` returns
  SVG string; TDD: SVG contains `<svg`, viewBox≈shape WH, child rect/text present; hydrated + fresh.
- **W2 raster:** SDK `renderShapePng(id,{scale?})` → spawn `rsvg-convert -z scale -f png` → tmp PNG path; TDD:
  PNG magic bytes, width>0. Pure mjs (no rebuild).
- **W3:** MCP `render_shape` tool; live e2e renders a real component → PNG; update SKILL/ledger/arch-12; push.

## Verify: full serial suite ≥ current; new render tests; live PNG opens. Test serially (:9101 race).
