# Architecture Note: Phase 4 — SVG-Native Variable Fonts

**Status:** Complete.
**Branch:** `pencilpot`
**Locations:** `pencilpot/store/fonts.mjs`, `pencilpot/runtime/{rpc,gfonts,server}.mjs`,
`pencilpot/bin/pencilpot.mjs`, `headless-core/src/app/headless/session.cljs`,
`frontend/src/app/main/fonts.cljs`,
`frontend/src/app/main/ui/shapes/text/{styles,svg_text}.cljs`,
`frontend/src/app/util/text_svg_position.cljs`,
`frontend/src/app/main/ui/workspace/sidebar/options/menus/typography.cljs`.
**Updated:** Variable fonts render on the STABLE SVG renderer (no wasm); CLI `map-variable`/`retarget-fonts`/`fonts`.

---

## Overview

A **variable font** ships every weight/width/optical-size/etc. in one binary, exposing continuous
**axes** (`wght`, `wdth`, `opsz`, `GRAD`, `ROND`, `slnt`, …). Penpot models a per-text override as a
`:font-variation-settings` map on the text leaf — `{"slnt" -10 "wdth" 151}` — where `wght` is excluded
(it is driven separately by `:font-weight`).

Pencilpot makes the **stable SVG/HTML renderer** paint those axes, so the wasm renderer is not needed
for variable fonts (the launcher default stays SVG). Three things make this work:

1. **Storage + serving** — `store/fonts.mjs` registers a VF as a `custom-…` family with a full weight
   ramp sharing ONE binary; the runtime serves the bytes (`/assets/by-id/<id>`) and advertises the
   axes via `get-font-variants`; Google Fonts are proxied through `/internal/gfonts/*`.
2. **SVG render emissions** — `app.main.fonts` emits a single *variable* `@font-face` (weight/width as
   CSS ranges); the SVG text path emits `font-variation-settings` on the rendered `<text>`.
3. **CLI authoring** — `pencilpot map-variable` rewrites text leaves' `:font-id` + axis map in the
   engine and **strips stale `:position-data`** so new widths re-layout.

```
  fonts/<id>.woff2  ──serve──►  /assets/by-id/<id>          (server.mjs)
  fonts.json        ──encode─►  get-font-variants (transit) (rpc.mjs)
        │                              │  :variable :axes
        ▼                              ▼
  app.main.fonts  ──►  variable @font-face (font-weight/stretch RANGES, no format())
        │                              │
        ▼                              ▼
  text leaf :font-variation-settings  ──►  <text style="font-variation-settings: …">
        ▲                                          (styles.cljs → position-data → svg_text.cljs)
        │
  pencilpot map-variable  (engine mapFontsToVariable: rewrite :font-id + merge axes, drop :position-data)
```

---

## Why the STABLE SVG renderer, not wasm

Variable-font axes were first wired end-to-end through the **wasm** renderer
(`bda37622d5`, render-wasm `font-variation-settings`). That path proved brittle in the pencilpot
context: axes did not repaint on edit, custom VFs were not loaded on boot, and the axis panel crashed
(`cf8ea25090`, `4a83402aa9`, `155ade7622`). The wasm renderer keeps the canvas busy (it never goes
idle), which also breaks deterministic screenshot e2e.

The pivot (`docs/superpowers/plans/2026-06-20-svg-native-variable-fonts.md`) targets the **SVG/HTML
renderer only** — browsers render variable fonts natively via a variable `@font-face` +
`font-variation-settings`, the page goes idle (so Playwright can screenshot text bounding boxes), and
the change is two surgical CLJS emissions with **no `render-wasm/` changes and no `&wasm=true`**. This
matches pencilpot's standing preference: STABLE SVG over wasm.

---

## Data model: per-family axes on text leaves

A `:variable` font in the frontend `fontsdb` carries axis metadata:

```clojure
{:family "Google Sans Flex"
 :variable true
 :axes [{:tag "wght" :min 100 :max 900 :default 400 :name "Weight"}
        {:tag "wdth" :min 25  :max 151 :default 100 :name "Width"}
        {:tag "opsz" :min 6   :max 144 :default 14  :name "Optical Size"}
        {:tag "slnt" :min -10 :max 0   :default 0   :name "Slant"} …]
 :variants [{:font-id "custom-google-sans-flex" …} …]}
```

A text leaf records the chosen axis values as a `{tag-string → number}` map:

```clojure
{:font-id "custom-google-sans-flex" :font-family "Google Sans Flex"
 :font-weight "600" :font-variation-settings {"wdth" 62.5 "opsz" 120}}
```

**Invariant:** `wght` is NOT stored in `:font-variation-settings` — it is the leaf's `:font-weight`,
matched against the weight ramp / driven by the variable face's `font-weight` range. The typography
axis-slider UI reads/writes `:font-variation-settings`, falling back to each axis `:default`
(`typography.cljs:486-526`).

---

## Font storage — `pencilpot/store/fonts.mjs`

A project keeps fonts under `<root>/fonts/`:

```
fonts/
├── fonts.json            ← index of all variants
└── <id>.<ext>            ← binary files (woff2 / woff / ttf / otf)
```

`readFonts(root)` returns the `variants` array. Two writers:

- **`addFont(root, {file,family,weight,style,fontId})`** — copies the file to `fonts/<id><ext>`
  (`id = <slug(family)>-<weight>-<style>`), appends one static variant. Idempotent per id.
- **`addVariableFont(root, {file,family,fontId,axes,instances})`** — copies the VF binary **once** to
  `fonts/<fontId><ext>` and writes a **full weight ramp** (100–900, `VF_WEIGHT_RAMP`) of variant
  descriptors that all point at that one file, each carrying `variable:true` + `axes`
  (`fonts.mjs:181-218`). Weight-matching against a leaf's `:font-weight` then resolves a ramp slot.

**The `custom-` prefix invariant** (`fonts.mjs:166-168`): the family font-id MUST start with `custom-`
(`fId = custom-<slug(family)>`). The renderer's `font-backend` only treats `custom-`/`gfont-` prefixes
as *loadable*; an earlier `vf-` prefix was misclassified as `:builtin` and the VF never loaded.

---

## Serving fonts

### Binary route — `/assets/by-id/<id>`

`server.mjs:105-148` resolves `/assets/by-id/<file-id>` to `fonts/<file>` and serves it with the right
content-type (`FONT_CONTENT_TYPES`, `server.mjs:96-100`). It is checked BEFORE the static handler.

### `get-font-variants` — advertising the variants + axes

`rpc.mjs:521-533` answers `get-font-variants` from `readFonts(projectRoot)` via
`encodeTransitFontVariants` (`rpc.mjs:243-310`). Two hard-won encoding rules:

- **Serve the RAW (un-`custom-`-prefixed) `:font-id`.** The frontend `data/fonts.cljs adapt-font-id`
  ALWAYS prepends `custom-`; serving an already-prefixed id yields a doubled `custom-custom-…`
  registry key that bakes a broken id into every edited leaf (`rpc.mjs:251-260`, fix `40e4be36ed`).
- **Point ALL `*-file-id` slots at the same id.** There is one file per variant; Penpot's
  `generate-custom-font-variant-css` builds its URL from `:woff1-file-id`, so every slot
  (`woff2/woff1/ttf/otf`) gets the same id and the browser sniffs the real format (`rpc.mjs:261-272`).

Variable variants append `:variable true` + `:axes` (+ optional `:instances`) AFTER the file-id slots,
so static variants stay byte-identical to the pre-VF output (`rpc.mjs:282-308`). `fontVariantsForBundle`
(`rpc.mjs:312-340`) is the plain-object twin used by the view-only bundle (see `11-view-mode.md`).

### Google Fonts proxy — `/internal/gfonts/*`

`gfonts.mjs` lets the SPA load Google Fonts without the page hitting `googleapis.com` directly:

- `GET /internal/gfonts/css?family=<Family>:<ids>` translates Penpot's legacy variant-id format to
  CSS2 (`Roboto:400,700italic` → `Roboto:ital,wght@0,400;0,700;1,700`), fetches from
  `fonts.googleapis.com`, and rewrites `fonts.gstatic.com/s/` src URLs to `/internal/gfonts/font/`.
- `GET /internal/gfonts/font/*` streams the bytes from `fonts.gstatic.com`.
- Responses are memory-cached by URL; **offline-safe** — CSS returns empty (no crash), font returns 502
  (`gfonts.mjs:7-30`). Wired in `server.mjs:151-155`.

---

## The SVG render path — two emissions + position-data

The visible workspace text is painted by `svg_text.cljs` from the shape's `:position-data`, NOT
directly by `generate-text-styles` (which only feeds the off-screen HTML measurement overlay). So the
axis value must flow **measurement → position-data → `<text>`**. Four touch-points:

### 1. Variable `@font-face` — `frontend/src/app/main/fonts.cljs:195-245`

`generate-variable-font-css` emits ONE `@font-face` per variable family:
`font-weight: <wght.min> <wght.max>` (or `1 1000`), `font-stretch: <wdth.min>% <wdth.max>%`
(or `normal`), `font-style: normal`, **no `format()` hint** (browser sniffs the served file).
`generate-custom-font-css` (`:240`) and `fetch-font-css` (`:415`) branch on `:variable` so static
custom fonts keep byte-identical output. `wght`/`wdth` become CSS ranges so the browser exposes them;
ALL other axes (`slnt`, `opsz`, …) are driven per-text via `font-variation-settings`.

### 2. `font-variation-settings` in the text styles — `styles.cljs:68-80`, `:166-168`

`variation-settings->css {"slnt" -10 "wdth" 151}` → `"slnt" -10, "wdth" 151` (nil for nil/empty/non-map).
`generate-text-styles` emits `fontVariationSettings` from the leaf's `:font-variation-settings` via a
`cond->` clause. This drives the measurement overlay so the leaf is measured at the right axis values.

### 3. Carry the value into `:position-data` — `text_svg_position.cljs:108-110`

`calc-position-data`'s `transform-data` reads the browser-normalized computed
`font-variation-settings` and stores it on each position-data run, **propagating nil** when absent
(`"normal"`/missing is dropped) so non-variable text is unaffected.

### 4. Emit on the rendered `<text>` — `svg_text.cljs:96`

The `<text>` `:style` `#js` map sets `:fontVariationSettings (:font-variation-settings data)`. When
nil, React omits it — non-variable text renders unchanged.

### Position-data regeneration

`:position-data` is a cached layout that `viewport_texts_html.cljs` only regenerates when the shape
changed or `:position-data` is nil. An axis edit changes content → regenerates → the new axes flow
through. A rapid-edit race that dropped axis/weight edits was closed in `3271732552`; serialize was
fixed to preserve text `:position-data` extension keys in `db6d191a59`.

---

## CLI font commands — `pencilpot/bin/pencilpot.mjs`

| Command | What it does |
|---|---|
| `fonts <project>` | Lists registered variants (`readFonts`) + a heuristic **missing-families** report (scans page EDN `:font-family` vs added + builtins). `cmdFonts`, `:1085-1142`. |
| `add-font <file> [--family --weight --style --id]` | `addFont` — register a static custom font. `:792`. |
| `add-variable-font <file> [--family --id]` | `addVariableFont` — register a VF (axes read from the binary's `fvar`). `:846`. |
| `retarget-fonts <project> [--family "Name=fontId"]` | Consolidate duplicate font-ids per family. Explicit mode (`--family`) or auto-detect families with >1 id in the page EDN; calls engine `retargetFonts`. `:324-466`. |
| `map-variable <project> --font-id <id> [--var-family <name>] --map "Family=wdth:62.5,opsz:120"` | Map source families onto a VARIABLE font with per-family axes; calls engine `mapFontsToVariable`. `:469-566`. |

`retarget-fonts` and `map-variable` follow the same persistence shape: load design into the engine,
snapshot `baselineErrs = validate()`, apply the transform, re-`validate()`, **block only on
edit-INTRODUCED errors** (`postErrs − baselineErrs`) so pre-existing imported-file issues don't fail
the command, then `writeDesign(serializeStore())` (`:447-462`, `:560-563`). This baseline-diff gate is
the same pattern the MCP/SDK commit gate later adopted (see `12-headless-engine-and-ai-dev.md`).

---

## Engine transforms — `headless-core/src/app/headless/session.cljs`

### `:mapFontsToVariable` (`:496-532`)

`mapping: {"Family Name" {"fontId" "custom-…" "family" "Google Sans Flex" "axes" {"wdth" 62.5 …}}}`.
A `postwalk` over `:data`: for every node it **drops stale `:position-data`** (so it re-lays-out from
the new font — otherwise stale data paints the OLD font/width until the next edit), and for any node
whose `:font-family` matches a key it rewrites `:font-id`/`:font-family`/`:font-variant-id`
(`<style>-<weight>`) and **merges** the axis map into `:font-variation-settings` (existing axes kept
unless overridden). `:font-weight`/`:font-size`/`:font-style` are untouched.

### `:retargetFonts` (`:534-557`)

A `postwalk` over `:data`: for any node with `:font-family` matching a mapping key, rewrite `:font-id`
and `:font-variant-id` (`normal-<weight>`). Covers text shapes (shape-level + nested content tree) and
typographies. No axis change.

---

## End-to-end render diagram

```
  pencilpot map-variable proj --font-id custom-google-sans-flex \
        --map "Bebas Neue=wdth:62.5,opsz:120"
        │  engine mapFontsToVariable: rewrite leaf :font-id + merge {"wdth" 62.5 "opsz" 120},
        │  drop :position-data → writeDesign
        ▼
  fonts.json  + pages/*.edn (leaf :font-variation-settings {"wdth" 62.5 "opsz" 120})
        │
        │  runtime boot
        ▼
  get-font-variants  ──►  fontsdb {:variable true :axes […]}  ──►  variable @font-face
        │                                                          (font-weight/stretch ranges)
        ▼
  workspace renders leaf → measurement overlay (styles.cljs fontVariationSettings)
        │                → calc-position-data carries the value (text_svg_position.cljs)
        ▼
  <text style="font-variation-settings: \"wdth\" 62.5, \"opsz\" 120">  (svg_text.cljs)
        │
        ▼
  browser paints the real Condensed/optical-size width — STABLE SVG, no wasm.
```

---

## Test Coverage

| Tier | File | What is asserted |
|---|---|---|
| unit | `frontend/test/frontend_tests/text_styles_test.cljs` | `variation-settings->css` formatting / nil cases |
| unit | `frontend/test/frontend_tests/fonts_test.cljs` | `generate-variable-font-css`: single face, `font-weight`/`font-stretch` ranges, no `format()`; static unchanged |
| e2e | `pencilpot/e2e/vf/vf-render-svg.mjs` | SVG-mode (no wasm): width 25 vs 151 → RMSE > 1.0, VF fetched, 0 canvas |
| e2e | `pencilpot/e2e/ai/variable-fonts.mjs` | CLI `map-variable` persists + renders on SVG (B2 audit) |

---

## Source map

| Area | Files | Key commits |
|---|---|---|
| Storage (`addFont`/`addVariableFont`, weight ramp, `custom-` prefix) | `pencilpot/store/fonts.mjs` | `925507d38c`, `2a08f55e4a`, `bead1aa049` |
| Serving (`/assets/by-id`, `get-font-variants`, raw font-id, all `*-file-id` slots) | `pencilpot/runtime/{server,rpc}.mjs` | `925507d38c`, `40e4be36ed` |
| Google Fonts proxy (`/internal/gfonts/*`, CSS2 translate, offline-safe) | `pencilpot/runtime/gfonts.mjs` | `925507d38c`, `adbd282e48` |
| Variable `@font-face` (ranges, no `format()`) | `frontend/src/app/main/fonts.cljs` | `bf292f3cb0` |
| `font-variation-settings` emission (styles + position-data + `<text>`) | `frontend/src/app/main/ui/shapes/text/{styles,svg_text}.cljs`, `frontend/src/app/util/text_svg_position.cljs` | `02d72f1df6`, `883579af13` |
| position-data race / serialize fixes | engine serialize, `viewport_texts_html.cljs` | `3271732552`, `db6d191a59` |
| Typography axis UI controls | `frontend/src/app/main/ui/workspace/sidebar/options/menus/typography.cljs` | `8793eb1a6c`, `72c3a7c30c`, `57ef431419`, `adee4f9bcf` |
| Engine transforms (`mapFontsToVariable`, `retargetFonts`) | `headless-core/src/app/headless/session.cljs` | `3f69e10011`, `552dccd1a9` |
| CLI (`fonts`/`add-font`/`add-variable-font`/`retarget-fonts`/`map-variable`) | `pencilpot/bin/pencilpot.mjs` | `3f69e10011`, `552dccd1a9` |
| SVG-native pivot plan | `docs/superpowers/plans/2026-06-20-svg-native-variable-fonts.md` | `02d72f1df6`…`883579af13` |
| (Superseded) wasm VF path | `render-wasm/**`, `frontend/src/app/render_wasm/api/{fonts,texts}.cljs` | `bda37622d5`, `cf8ea25090`, `4a83402aa9` |
| e2e | `pencilpot/e2e/vf/vf-render-svg.mjs`, `pencilpot/e2e/ai/variable-fonts.mjs` | `5550563dd1`, `5c7bfa582a`, `57182768ac` |
