# Plan: Pencilpot architecture & change documentation

**Date:** 2026-06-28
**Base commit:** `4d66fb1c8a` (branch `pencilpot`)
**Skill regime:** subagent-driven-development, writing-plans, context-mode, pi-subagents.

## Goal

Produce a complete, accurate, durable documentation set under **`docs/pencilpot/`** that
explains *what pencilpot is*, *how every subsystem works*, and *every change we made to
vanilla Penpot to build it*. The commit history (`git log --grep=pencilpot -i`, plus the
view-mode / media / position-data / native-save chains) is the evidence base; each doc is
grounded in the actual code and commits, not hand-waving.

Audience: a future engineer (or AI) who must understand or extend pencilpot. Style: dense,
precise, diagram-where-useful (ASCII), every claim traceable to a file:line or commit.

## Principles
- **Native-first, no-injection**: document that all frontend changes are native Penpot CLJS/SCSS.
- **Filesystem-native, no backend**: the runtime replaces the Penpot backend with a local
  Node server over the on-disk design.
- **Stable SVG renderer** preferred over wasm — document why and where.
- Every doc ends with a "Source map" section: the files + commits that implement it.
- Cross-link docs with relative links. Keep an index (`docs/pencilpot/README.md`).

## Documentation tree (one subagent per doc — disjoint files, parallelizable)

### D0 — `docs/pencilpot/README.md` (index + overview)
What pencilpot is (local, filesystem-native, no-backend, no-injection Penpot design IDE),
the high-level architecture diagram (browser SPA ↔ runtime server ↔ on-disk design ↔ headless
engine ↔ MCP/CLI), the design philosophy, and a table of contents linking every doc below.
**Written last** (after the others exist, so the TOC is accurate). Owned by the consolidator.

### D1 — `docs/pencilpot/on-disk-format.md`
The `.pencil` project, `designs/<name>/`, the EDN "parts" (manifest, pages, components,
typographies, colors, tokens), `media/` (by-file-media-id + sidecars + thumbnails), `fonts/`,
linked libraries (`shared/`). The store model (`store/store.mjs` `readDesign`/`writeDesign`/
`readMediaIds`/`prune`). Source map: store.mjs, the import output layout.

### D2 — `docs/pencilpot/runtime-server.md`
`runtime/server.mjs`: request routing, every endpoint (`/api/*` → handleRpc, `/assets/by-id`,
`/assets/by-file-media-id`, `/internal/gfonts/*`, `/pencilpot/{status,save,discard,live}`,
terminal WS), boot sequence (initWorktree → listen → banner → `warmEngine` deferral),
the in-memory-stage-then-explicit-save model. Source map: server.mjs, launch.mjs, frontend.mjs.

### D3 — `docs/pencilpot/rpc-layer.md`
`runtime/rpc.mjs`: `handleRpc` dispatch, each command (get-file w/ library resolution,
update-file → `persistChanges`/`stage`, get-file-libraries, get-font-variants, rename-file,
media RPCs, get-view-only-bundle), transit encode/decode helpers, `sessionFor`/`readSessionFor`
(read-session cache, identity keying) + `warmEngine`. Source map: rpc.mjs + perf commit `897adde7bb`.

### D4 — `docs/pencilpot/working-copy-and-dirty.md`
`runtime/worktree.mjs`: the in-memory `_store`, `stage`/`save`/`discard`, `computeSig`, `_dirty`/
`_savedSig`. `store/edn.mjs`: `stripPositionData`, `stripRevn`, `normalizeEdnWhitespace`. The
**content-only dirty signature** (commit `3f05d851bb`) and **never-persist-position-data** (`ed35bc630b`).
Why a no-op reopen is non-dirty. Source map: worktree.mjs, edn.mjs, position-data commits.

### D5 — `docs/pencilpot/headless-engine.md`
`headless-core/`: the shadow-cljs `:headless` ESM build (`shadow-cljs.edn`, output
`target/headless/penpot.js`), `src/app/headless/session.cljs` (create-session, the exported
method table, `build-file-resp`/`modern-features`, `getFileResponse` vs `getViewerBundle`),
`core.cljs`, `store.cljs`. How the runtime imports + drives it. Build/rebuild instructions.
Source map: session.cljs, core.cljs, shadow-cljs.edn, view-mode commit `c527d55a94`.

### D6 — `docs/pencilpot/import-pipeline.md`
`runtime/import-binfile.mjs` + CLI `import`: `.penpot` → `designs/<name>/`, media keyed by
file-media-id with metadata sidecars, the storage-twin skip (`90399b78e3`), GSF/font mapping on
import. Source map: import-binfile.mjs, import commits `0ca3a22408`/`90399b78e3`/`5c7bfa582a`.

### D7 — `docs/pencilpot/media-flow.md`
The two id spaces (file-media-object id vs storage-object id), the 4-layer disk contract
(`media/<id>.<ext>` + `<id>.json` sidecar + optional thumbnail), the `/assets/by-file-media-id`
serve route, `upload-file-media-object`/`from-url`/`clone`, computeSig excluding media. Source map:
media.mjs, multipart.mjs, image-size.mjs, media commit chain (`7614e1435f`…`eb76c31feb`).

### D8 — `docs/pencilpot/fonts-and-variable-fonts.md`
`store/fonts.mjs`, `get-font-variants`, the gfonts proxy, custom fonts dir, GSF per-family axes,
the **SVG-native variable-font** approach (frontend `ui/shapes/text/*`, `util/text_svg_position.cljs`),
CLI `map-variable`/`retarget-fonts`/`fonts`, position-data stripping for re-layout. Why SVG over wasm
for variable fonts. Source map: fonts.mjs, the VF frontend files, plan `2026-06-20-svg-native-variable-fonts.md`.

### D9 — `docs/pencilpot/frontend-changes.md`
Every **native, no-injection** frontend change vs vanilla Penpot, grouped: native-save UI
(`left_header.cljs/.scss`, `data/pencilpot.cljs`), header/axes UI fixes, profile-RPC removal
(local profile/props/plugins, commits `0bb6119bb3`/`72e07c8744`/`94bd9d36cf`/`a8ea5ac05b`),
position-data rendering, dirty-state surfacing, blank-text fix, `stl/css` vs `stl/css-case` lesson.
Source map: the frontend files in the modified set + their commits.

### D10 — `docs/pencilpot/view-mode.md`
The prototype "play → view" feature: `go-to-viewer` (separate exitable window), `viewer.cljs`
`fetch-bundle`, `get-view-only-bundle` runtime handler, `getViewerBundle` engine method, the perf
warmup+cache. The two bugs fixed (new-window trap, 404). Source map: view-mode commit chain
(`3e167afd50`…`4d66fb1c8a`) + plan `2026-06-21-pencilpot-view-mode.md`.

### D11 — `docs/pencilpot/cli.md`
`pencilpot/bin/pencilpot.mjs`: every command (`new`, `import`, `open`, `fonts`, `retarget-fonts`,
`map-variable`, `install-desktop`/`uninstall-desktop`), flags, examples, the project/design resolver
(`PENCILPOT_PROJECT` vs `PENCILPOT_DESIGN`). Source map: pencilpot.mjs, server.mjs resolver.

### D12 — `docs/pencilpot/mcp-and-sdk.md`
The `penpot-headless` MCP (`headless-core/mcp/server.mjs`) + WorkingCopy SDK + `sdk/rpc.mjs`
transport; how to drive a **local** pencilpot design (`PENPOT_HL_BASE`=runtime), the checkout→
script→commit→save loop, and the known gaps. Cross-link the AI-dev findings ledger. Source map:
mcp/server.mjs, sdk/*.mjs, runtime get-file/update-file.

### D13 — `docs/pencilpot/build-and-test.md`
The TWO frontend build steps (JS shadow-cljs release; SCSS→CSS), the headless `:headless` build,
the "runtime .mjs needs no rebuild — just restart" rule, `node run-tests.mjs --unit`, the e2e
harness catalogue (`pencilpot/e2e/vf/*`, `pencilpot/e2e/ai/*`), boot/chromium conventions.
Source map: build commands, run-tests.mjs, e2e dir.

## Tasks
- Each doc D1–D13 = one fresh-context implementer (context-mode, reads code+commits, writes ONE file).
  Group into parallel waves of disjoint files (≤4 concurrent). Implementers must cite file:line/commit.
- After each wave, a fresh-context reviewer spot-checks accuracy against the code (no source edits).
- D0 (index) + a **capstone consistency pass** last: verify cross-links resolve, no contradictions,
  the capability claims match the AI-dev findings ledger, terminology consistent.

## Constraints
- Docs only (plus `docs/pencilpot/` tree). NO source changes. NO injection narrative drift.
- Every claim must be verifiable; when unsure, the implementer reads the code rather than guessing.
- Reuse the AI-dev findings ledger (`.superpowers/sdd/pencilpot-ai-dev-findings.md`) for D12.

## Done when
- `docs/pencilpot/` has README + D1–D13, all cross-links resolve, capstone review = SHIP.
- A new engineer can read the tree and understand pencilpot's architecture and every change made.
