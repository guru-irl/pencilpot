---
name: pencilpot
description: Use when driving pencilpot (the local, filesystem-native Penpot design IDE) programmatically — editing a design via the penpot-headless MCP/SDK, creating boards/shapes/text/components/color-tokens, mapping variable fonts, playing prototypes, or persisting changes to disk. Triggers on "edit a pencilpot design", "add a component", "AI design in Penpot locally", "map variable font", "pencilpot MCP/CLI", "save the design".
---

# Driving pencilpot programmatically

## Overview

Pencilpot is a **local, filesystem-native, no-backend** Penpot design IDE. You edit a design by
pointing the **`penpot-headless` MCP** (or the WorkingCopy SDK it wraps) at a **running pencilpot
runtime**, then explicitly **saving to disk**. The runtime stages edits in memory; disk is written
only on an explicit save.

**Core principle:** edit through the engine (`checkout → script → validate → commit`), then
**`POST /pencilpot/save`**. `commit()` ≠ persisted.

Full capability matrix, exact opts, gaps, and worked harnesses:
**REFERENCE:** `docs/pencilpot/ai-dev-capabilities.md` and `pencilpot/e2e/ai/*.mjs` (executable proof of every claim below).

## The loop (do exactly this)

```
# 1. Boot the runtime (serves the SPA + the RPC API the MCP talks to)
pencilpot open <project.pencil>          # or: node pencilpot/runtime/server.mjs
#   env: PENCILPOT_PROJECT=<.pencil dir> [+ PENCILPOT_DESIGN=<name>]  OR  PENCILPOT_DESIGN=<abs design dir>;  PENCILPOT_PORT=<port>
#   waits for: "pencilpot runtime on http://localhost:<port>"

# 2. Point the headless MCP at the LOCAL runtime
PENPOT_HL_BASE=http://localhost:<port> PENPOT_TOKEN=local node headless-core/mcp/server.mjs

# 3. Edit (MCP tools / wc):
checkout(fileId) → script(code) → validate() → commit()    # commit stages in runtime MEMORY (revn bump)

# 4. PERSIST (REQUIRED — commit does NOT write disk):
POST http://localhost:<port>/pencilpot/save                 # flush working copy → on-disk EDN
GET  http://localhost:<port>/pencilpot/status               # {dirty, revn}
POST http://localhost:<port>/pencilpot/discard              # drop staged edits (revert to disk)
```

`script(code)` runs JS with a global `wc` (the WorkingCopy). Do many edits per call; return a value.

## Quick reference — the `wc` API (all WORK)

| Call | Result |
|---|---|
| `wc.addBoard({x,y,width,height,name})` | board id; becomes the active parent (nest children, then `wc.closeBoard()`) |
| `wc.addRect({x,y,width,height,name,fills:[{fillColor:"#rrggbb"}],strokes?})` | rect id |
| `wc.addEllipse({...})` | ellipse id (same opts) |
| `wc.addText({x,y,characters,fontSize?,fontId?,fills?,growType?,name})` | text id |
| `wc.setFlexLayout(boardId,{dir,gap,padding,align,justify,wrap})` | reflows the board's CURRENT children |
| `wc.setGridLayout(boardId,{cols,gap,padding,dir})` | `cols`=column count |
| `wc.setGrowType(id, "auto-width"\|"auto-height"\|"fixed")` | text/layout grow |
| `wc.setConstraints(id,{h,v})` | h:left\|right\|leftright\|center\|scale; v:top\|bottom\|topbottom\|center\|scale |
| `wc.createComponent(boardId,{name?})` | promotes a board into a main component |
| `wc.addColorToken({set,name,value})` / `wc.tokens()` | color token (name uses `.` for groups, `/` invalid) |
| `wc.serializeStore()` / `wc.validate()` / `wc.pendingChanges()` / `wc.tokens()` | introspection (the MCP `scene()` tool returns the id→shape map) |

**Order matters:** add children → THEN set layout (setters reflow existing children). `closeBoard()` is
stack-based: close a board before starting an unrelated sibling.

## Variable fonts (CLI is the persistence path)

```bash
pencilpot map-variable <project.pencil> --font-id custom-google-sans-flex --var-family "Google Sans Flex" \
  --map "Some Family=wdth:75,opsz:36" --map "Other=wdth:125"
pencilpot fonts <project.pencil>            # list custom fonts + missing-families report
pencilpot retarget-fonts <project.pencil> --family "Name=fontId"   # consolidate duplicate ids (no axes)
```
`map-variable` rewrites the on-disk EDN and strips stale position-data so widths re-layout. The MCP
`map_fonts_variable` tool applies the same transform but **does NOT round-trip `commit()`** — use the CLI to persist.

## Prototypes

You can build frames/shapes/components in code, but **interactions cannot be authored** via SDK/MCP
(see GAPs). Pencilpot **plays** prototypes that already exist (imported or UI-authored): the play button
opens `/view` in a separate window; `get-view-only-bundle` feeds the native viewer; hotspot clicks navigate frames.

## GAPs — do NOT attempt these via SDK/MCP (they fail or don't exist)

| Want | Reality | Do instead |
|---|---|---|
| Place a component instance | `wc.instantiateComponent` throws `"expected valid shape"` on SDK-created components | author instances in the Penpot UI, or pre-instantiate in the source `.penpot` |
| Wire a prototype interaction | no authoring verb exists | author in the UI / pre-author in the imported design; pencilpot then plays it |
| Typography/spacing/dimension tokens, token→shape binding | only `:color` tokens are wired | UI for other token types |
| Move/resize/reparent/delete/group an existing shape | append-only authoring (only layout/grow/constraints mod existing shapes) | UI for structural edits |
| Component variants/swap | no surface | UI |

## Common mistakes

- **Forgetting to save.** `commit()` only stages in runtime memory — the edit vanishes on restart/discard
  until `POST /pencilpot/save`. Always save; confirm with `GET /pencilpot/status` → `dirty:false`.
- **Setting `PENPOT_HL_BASE` after import.** The SDK freezes it at module load; set it (or spawn the MCP
  with it) BEFORE the SDK loads. The default `:9101` is a real backend (401) — always point at the runtime.
- **Token names with `/`.** Use `.` for group nesting (`brand.primary`); `/` throws.
- **`map-variable` on a bare design dir.** It's a PROJECT command — pass the `.pencil`.
- **Layout before children.** Add children first; layout setters reflow the board's current children.
- **Expecting `commit()` to be blocked by pre-existing imported-file issues.** It isn't — the gate blocks
  only errors YOUR edit introduces (baseline-diff). A pre-existing whole-file nonconformity is allowed through.

## Real-world impact

Verified end-to-end against the canonical DefaultLauncher design: an AI can boot the runtime, checkout,
build boards/rects/ellipses/text with flex/grid layout + constraints, define components, add color tokens,
map variable fonts, commit, save to disk, reopen clean, and play the prototype — all on the STABLE SVG
renderer, no browser injection. Every capability is backed by a deterministic harness in `pencilpot/e2e/ai/`.
