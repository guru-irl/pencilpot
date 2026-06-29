# Pencilpot — render fidelity, fast startup, auto-launch, realtime, diff

Date: 2026-06-29. Branch: pencilpot. Owner: parent. TDD per wave.

## Verified now
- `renderShape`/`renderShapePng` ship. 7/7 DefaultLauncher boards render. Shape + Color
  boards = pixel-perfect (fills, radii, shadows, palette). Text-only boards (Typography,
  Cover) blank → headless SSR has no fonts; rsvg has no Google Sans Code.
- Startup ~50-60s (frontend pulled into headless bundle). render call itself sub-ms.

## A. Text fidelity (todo 20)
Cause: SVG text has no font faces; rsvg substitutes nothing. Fix: embed `@font-face`
data-URIs from `<design>/media` (woff2 already on disk) into the `<svg><defs>` before
raster, OR pass `--font-file` dirs to rsvg / install fonts. TDD: render Typography board
→ PNG non-white pixel ratio > 5%. Variable-font axes already in svg_text path.

## B. Sub-10s startup (todo 22)
Cause: every `createSession` import loads 861-file frontend bundle. Options:
1. **Split render into its own lazy ESM module** loaded only when renderShape called;
   core engine stays small (data-only) → core startup back to ~2-3s. Render's first call
   pays a one-time ~20s, cached process-warm after.
2. Warm long-lived render daemon (the runtime already long-lived) — load once, sub-ms thereafter.
   The 60s only ever hits cold tests. Make MCP/runtime preload the bundle at boot.
TDD: time-to-first-verb on core < 10s; render daemon first-shot < 25s, warm < 50ms.

## C. Auto-launch on open (todo 23)
Opening a `.pencil`/design → spawn terminal that: starts runtime + MCP, then `pi`
preloaded with the pencilpot skill. Wire in `pencilpot/bin/pencilpot.mjs` open path +
desktop launcher template. TDD: open headless → MCP reachable + skill file linked.

## D. Realtime AI↔SPA (todo 24)
Today AI edits go to disk; open SPA won't see them until reopen. Want live. Path: AI
commit → runtime broadcasts (SSE/ws) → SPA applies changes (Penpot already has
notification/apply-changes). Reuse `applyTransitUpdate` shape. TDD: AI move → SPA DOM moves.

## E. Diff since last save (todo 25)
`pencilpot diff` CLI + MCP `diff` + API: changes since last commit/save. Snapshot store
on save; diff current vs snapshot → added/removed/modified shape ids + props. Lets AI see
USER's edits. TDD: user moves a rect → diff lists it.

## Order: A (fidelity) → E (diff, cheap) → B (startup) → C (launch) → D (realtime).
