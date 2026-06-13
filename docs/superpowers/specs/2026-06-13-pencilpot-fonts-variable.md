# Pencilpot — Fonts & Variable-Font Support (sub-project)

**Status:** Design spec. A sizable sub-project (own staged plan). Slots alongside Phase 4; the variable-axis stage is deep render-engine work.
**Date:** 2026-06-13 · **Branch:** `pencilpot`

## 1. Goal

Make pencilpot a *better* type tool than upstream Penpot:
- **Custom fonts**: add font files to a project; the runtime serves them; imported designs (e.g. the "Google Sans Flex" custom family) render. Self-contained + git-tracked.
- **Google Fonts connector**: browse/add Google fonts (incl. variable families with full axis metadata) into a project — downloaded locally (offline, versioned).
- **Variable fonts done right**: full OpenType **axis** support (`wght`, `wdth`, `opsz`, `slnt`, `ital`, + family-specific axes like Google Sans Flex's `GRAD`/etc.) — continuous control via `font-variation-settings`, applied in the renderer and exposed as per-axis UI. Upstream Penpot only models discrete weight/style.

## 2. Why staged (research findings)

Variable fonts touch every layer (per `Explore` mapping):
- **Model** (`common/types/text.cljc`, `typography.cljc`): only `:font-weight`/`:font-style`/`:font-variant-id` — **no axes field**.
- **Render-wasm/Skia** (`render-wasm/src/shapes/fonts.rs`, `render/text.rs`, `wasm/text.rs`): `FontFamily` = id/weight/style; fixed-size text span; Skia supports variations (`FontArguments`/`setVariationDesignPosition`) but Penpot doesn't call them. **Hardest lift; needs Rust + render-wasm rebuild.**
- **Loading** (`frontend/.../fonts.cljs`): `@font-face` has no `font-variation-settings`; custom → `assets/by-id/<id>`; google → `internal/gfonts/css` + `internal/gfonts/font` proxy.
- **UI** (`.../sidebar/options/menus/typography.cljs`): variant dropdown only.

## 3. Stages

### Stage 1 — Custom font support (foundation; discrete model)
Unblocks imported custom fonts immediately, no model/render changes.
- **Store**: `pencilpot/store/fonts.mjs` — a project `fonts/` dir + `fonts.json` (`{variants:[{id,fontId,family,weight,style,file,format,axes?}]}`) + binaries. `readFonts`, `addFont`.
- **CLI**: `pencilpot add-font <file> [--project] [--family] [--weight] [--style] [--id]`; `pencilpot fonts <project>` (list added + list families referenced-but-missing by the designs).
- **Runtime**: `get-font-variants` returns the project's variants in Penpot's recorded shape (with `*-file-id`s the runtime can resolve); serve the `assets/by-id/<id>` font-file route (right `font/woff2|ttf|otf` content-type). Empty list stays valid.
- **Render**: by CSS `font-family` — a served variant whose family matches makes imported text render. Validates with `document.fonts.check`.

### Stage 2 — Google Fonts connector
- **Metadata**: fetch the Google Fonts list WITH variable axes (Google Fonts Developer API `…/webfonts/v1/webfonts?capability=VF&key=…`, or a bundled/cached metadata snapshot to avoid a key dependency). Each family → `{family, category, axes:[{tag,min,max,defaultValue}], files}`.
- **CLI/connector**: `pencilpot add-gfont <Family> [--project]` → download the (variable) font file(s) into the project `fonts/`, record family + axes in `fonts.json` (reuse Stage 1 storage). Optionally a small in-app picker later.
- **Runtime**: serve those like custom fonts (self-contained). Optionally also proxy `internal/gfonts/css`/`font` for on-the-fly google loading, but the download-into-project path is primary (offline, git-tracked).

### Stage 3 — Variable-font axes end-to-end (the big one)
Starts with a **render-wasm spike** (de-risk Skia variations) before the full model/UI.
- **Spike**: in `render-wasm`, register a typeface CLONE with a `FontArguments` variation position (e.g. `wght`) and prove a single text span renders at a non-named weight; rebuild render-wasm; confirm in the canvas. GO/NO-GO for the Skia approach (typeface-clone-per-axis-combo, family alias encodes axis values).
- **Model**: add `:font-variation-settings` (map `{tag→value}`, e.g. `{"wght" 480 "wdth" 90 "GRAD" 30}`) to the text font attrs + `schema:typography`; thread through serialization (store EDN already lossless).
- **Render-wasm**: carry the axes into the text span (fix the fixed-size struct → variable-length/aux buffer), build a varied typeface via `FontArguments`, key the registered family by (font + axis values).
- **@font-face / loading**: emit `font-variation-settings` and variation descriptors; for the SVG/DOM path set `font-variation-settings` CSS.
- **UI**: per-axis controls in the typography panel — a slider per axis (tag, min/max/default from the font's `axes`), plus named-instance presets where available; show only the axes the selected font exposes.
- **Rebuild**: render-wasm + `build:app:main` (toolchain installed; recipe in `docs/pencilpot/architecture/02-frontend-build.md`).

## 4. Risks
1. **Skia variation rendering (Stage 3)** — biggest unknown; mitigated by the spike first. If skia-safe lacks a clean variation API, fall back to per-axis typeface clones via `FontArguments` at registration.
2. **Fixed-size text span overflow** — axes need a variable-length encoding across the WASM boundary; design an aux buffer.
3. **Model migration** — adding an axes map is additive (default empty = current discrete behavior), so backward-compatible.
4. **Google Fonts metadata without an API key** — bundle a cached VF-axis snapshot to avoid a hard key dependency; refreshable.
5. **UI complexity** — many axes; default to showing `wght` (+ `wdth`/`opsz` when present), advanced axes behind a disclosure.

## 5. Decisions / sequencing
- Build **Stage 1 now** (unblocks the imported design + is the storage foundation). Then Stage 2 (connector), then Stage 3 (variable axes, spike-first).
- Fonts live IN the project (`fonts/`), git-tracked, served by the runtime — self-contained, offline, versioned. No external Penpot/backend.
- Variable axes are additive to the model (empty = today's behavior) — no regression for non-variable fonts.
