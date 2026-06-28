# Plan: Pencilpot architecture & change documentation

**Date:** 2026-06-28
**Base commit:** `09c2e50d0d` (branch `pencilpot`)
**Skill regime:** subagent-driven-development, writing-plans, context-mode, pi-subagents.

## Goal

Bring the **existing** living architecture-notes tree (`docs/pencilpot/architecture/`) up to date by
documenting every subsystem and change made since Phase 4·T (the last doc, `05-terminal.md`). The tree
is phase/topic-numbered; we CONTINUE it (`06`…`13`), refresh drifted docs, and update the index.
Audience: a future engineer/AI who must understand or extend pencilpot. Every claim traceable to a
file:line or commit. The big features built since `05` (variable fonts, profile-RPC removal, native-save
UI, position-data/dirty, media flow, view mode, the headless MCP/SDK AI-dev layer, the perf cache) are
currently UNDOCUMENTED — this plan closes that.

## What already exists (do NOT duplicate — extend/refresh)
- `00-phase0-spike.md` · `01-runtime-store.md` · `02-frontend-build.md` · `03-frontend-strip.md` ·
  `04-desktop.md` · `05-terminal.md` · `README.md` (index).
- New companion (this session): `docs/pencilpot/ai-dev-capabilities.md` (AI-dev capability matrix) and
  the `pencilpot/skills/pencilpot/SKILL.md` skill — the AI-agent doc (`12`) cross-links these, doesn't repeat them.

## Principles
- Native-first, **no-injection** (all frontend changes are native CLJS/SCSS); filesystem-native, no backend;
  STABLE SVG renderer preferred over wasm — say why and where.
- Match the existing docs' voice (status header: Status/Branch/Locations/Updated; dense; ASCII diagrams; a
  "Source map" of files+commits). Read `01-runtime-store.md` + `03-frontend-strip.md` first for house style.
- Every doc ends with **Source map** (files + commits). Cross-link with relative links.

## New docs (one subagent per doc — disjoint files, parallelizable)

### 06 — `06-variable-fonts.md` (Phase 4 · fonts)
SVG-native variable fonts: the VF axis bug + fix, GSF per-family axes, `store/fonts.mjs`, `get-font-variants`,
the gfonts proxy + custom fonts dir, the frontend SVG text path (`ui/shapes/text/*`, `util/text_svg_position.cljs`),
CLI `map-variable`/`retarget-fonts`/`fonts`, position-data stripping for re-layout, why SVG over wasm for VF.
Source: the VF frontend files, fonts.mjs, plan `2026-06-20-svg-native-variable-fonts.md`, the VF commit chain.

### 07 — `07-media-flow.md` (Phase 4 · media)
Two id spaces (file-media-object vs storage-object), the 4-layer disk contract (`media/<id>.<ext>` + `<id>.json`
sidecar + optional thumbnail), `/assets/by-file-media-id`, `upload-file-media-object`/`from-url`/`clone`,
import storage-twin skip, computeSig excluding media. Source: media.mjs, multipart.mjs, image-size.mjs,
import-binfile.mjs, media commit chain `7614e1435f`…`eb76c31feb`.

### 08 — `08-working-copy-dirty-persistence.md` (Phase 4 · persistence)
`runtime/worktree.mjs` (`_store`, `stage`/`save`/`discard`, `_dirty`/`_savedSig`), the **content-only dirty
signature** (`computeSig`), `store/edn.mjs` (`stripPositionData`/`stripRevn`/`normalizeEdnWhitespace`),
never-persist-position-data, why a no-op reopen is non-dirty, the save gap. Source: worktree.mjs, edn.mjs,
commits `3f05d851bb`/`ed35bc630b`/`c397d377dd`.

### 09 — `09-local-profile-rpc-removal.md` (Phase 4 · local profile)
Local profile/props/plugins with zero network: `fetch-profile` resolves the seeded local profile, plugin
registry persists to local state, onboarding/release-notes props update locally — the removed profile RPCs at
the frontend choke points. Source: data/profile.cljs, data/pencilpot.cljs, commits `0bb6119bb3`/`72e07c8744`/`94bd9d36cf`/`a8ea5ac05b`.

### 10 — `10-native-save-ui.md` (Phase 4 · UI)
The native, no-injection workspace UI changes: save status/dirty indicator (`left_header.cljs/.scss`,
`data/pencilpot.cljs`), header/variable-axes layout fixes, the `stl/css` vs `stl/css-case` runtime-keyword
lesson, blank-text fix. Source: the left_header/typography/sidebar SCSS+CLJS, commits `c6529229c9`…`30f08ec8cd`.

### 11 — `11-view-mode.md` (Phase 4 · prototype viewer)
Play → view prototype: `go-to-viewer` (separate exitable window), `viewer.cljs` `fetch-bundle`,
`get-view-only-bundle` runtime handler, `getViewerBundle` engine method, the two bugs fixed (new-window trap,
404), the perf warmup + read-session cache (`897adde7bb`). Source: view-mode commit chain `3e167afd50`…`4d66fb1c8a`,
plan `2026-06-21-pencilpot-view-mode.md`.

### 12 — `12-headless-engine-and-ai-dev.md` (Phase 4 · AI agent)
The headless engine (`headless-core/`): the `:headless` ESM build, `session.cljs` method table,
`build-file-resp`/`modern-features`, `getFileResponse` vs `getViewerBundle`, the dataTransit-validation fix +
baseline-diff commit gate (`9494abe2ae`/`b2c6b90927`). Then the **AI-dev layer**: the `penpot-headless` MCP +
WorkingCopy SDK + `sdk/rpc.mjs` transport, driving a LOCAL design (`PENPOT_HL_BASE`=runtime), the
checkout→script→commit→save loop and the gaps. **Cross-link** `../ai-dev-capabilities.md` + the skill (don't repeat).
Source: session.cljs, mcp/server.mjs, sdk/*.mjs, runtime rpc.mjs, the A-series commits.

### 13 — `13-build-and-test.md` (Phase 4 · build/test)
Current build reality: the TWO frontend builds (JS shadow-cljs release; SCSS→CSS), the headless `:headless`
build, the "runtime .mjs needs no rebuild — just restart" rule, `node run-tests.mjs --unit`, the e2e harness
catalogue (`pencilpot/e2e/vf/*`, `pencilpot/e2e/ai/*`), boot/chromium conventions. Source: build commands,
run-tests.mjs, the e2e dirs.

### Refresh pass
- `01-runtime-store.md`: extend the RPC handler table with the media RPCs + `get-view-only-bundle` + the
  read-session cache/warmup; note where deeper docs now live.
- `README.md`: add rows `06`–`13`, add a "Companion docs" line for `ai-dev-capabilities.md` + the skill,
  update the trailing "more docs land here" note (Phase 4 now substantially documented).
- Optional top-level `docs/pencilpot/README.md` pointing at `architecture/` + `ai-dev-capabilities.md` + the skill.

## Tasks
- Each new doc `06`–`13` = one fresh-context implementer (context-mode; reads code+commits; writes ONE file;
  cites file:line/commit; matches house style). Workers do NOT git-commit (disjoint files, but avoid the
  index race) — report paths; the parent commits per wave. Waves of ≤4 disjoint files.
- After each wave, a fresh-context reviewer spot-checks accuracy vs the code (no source edits).
- Last: the refresh pass (`01` + `README`) + a capstone consistency review (cross-links resolve, no
  contradictions, capability claims match `ai-dev-capabilities.md`, terminology consistent).

## Constraints
- Docs only. NO source changes. NO injection narrative drift. Every claim verifiable (read code, don't guess).

## Done when
- `architecture/` has `06`–`13` + a refreshed `01`/`README`, all cross-links resolve, capstone = SHIP.
- A new engineer can read the tree and understand pencilpot's architecture and every change since Phase 4·T.
