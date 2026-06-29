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
#   add --ai to auto-launch `pi` (this skill preloaded, MCP pointed at the runtime) in the integrated terminal
#   env: PENCILPOT_PROJECT=<project.pencil or project dir> [+ PENCILPOT_DESIGN=<name>]  OR  PENCILPOT_DESIGN=<abs design dir>;  PENCILPOT_PORT=<port>
#   waits for: "pencilpot runtime on http://localhost:<port> … fileId=<id>"  (fileId is also in <design>/manifest.edn :id;
#   the runtime serves the open design for any non-library id, so checkout(fileId) just works)

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
| `wc.instantiateComponent(componentId,{x,y})` | places a copy of a main component |
| `wc.addInteraction({shapeId,destination,eventType?,actionType?,preserveScroll?})` | wires a prototype link (default click→navigate) |
| `wc.addColorToken({set,name,value})` — alias of `wc.addToken({...,type:"color"})` |
| `wc.serializeStore()` / `wc.validate()` / `wc.pendingChanges()` / `wc.tokens()` | introspection (the MCP `scene()` tool returns the id→shape map) |
| `wc.renderShape(id)` → SVG / `wc.renderShapePng(id,{scale?,out?})` → png path / `wc.renderShapePngHiFi(id,{scale?,out?,fontsDir?})` | SEE a shape/board/component. `renderShape` = browser-free SVG (now carries TEXT as foreignObject). `renderShapePng` = fast rsvg raster but **text-less** (librsvg ignores foreignObject). `renderShapePngHiFi` = Chromium raster that **renders text** (pass `fontsDir`=`<project>/fonts` to embed custom families). MCP `render_shape(shapeId,format,scale,fidelity,fontsDir)` — use `fidelity:"high"` for any board with text. |

**Order matters:** add children → THEN set layout (setters reflow existing children). `closeBoard()` is
stack-based: close a board before starting an unrelated sibling.

## Editing & restructuring EXISTING shapes (all WORK)

| Call | Result |
|---|---|
| `wc.updateShape(id,{name?,opacity?,fills?,strokes?,blendMode?,constraintsH?,hidden?,…})` / `wc.updateShapes(ids,attrs)` | merge non-structural attrs onto existing shapes |
| `wc.moveShape(id,{x,y})` or `{dx,dy}` | move a shape (carries its whole subtree; ancestors reflow) |
| `wc.resizeShape(id,{width?,height?})` | resize (children reflow via the modifier engine) |
| `wc.rotateShape(id,{angle,cx?,cy?})` | rotate `angle`° about the shape center (or `{cx,cy}`); recomputes `:rotation`+`:selrect`+`:points` |
| `wc.deleteShape(id)` / `wc.deleteShapes(ids)` | delete shapes (+ descendants; component-copy children are hidden) |
| `wc.reparentShape(id,parentId,{index?})` | move under a new board/group/frame |
| `wc.reorderShape(id,index)` | change z-order within the parent |
| `wc.groupShapes(ids,{name?})` / `wc.ungroupShape(groupId)` | group / dissolve a group |
| `wc.swapComponent(instanceId,newComponentId)` | replace an instance with another component |
| `wc.detachInstance(id)` | unlink an instance from its component |
| `wc.makeVariant(instanceId,{name?})` | promote a component instance into a variant SET (variant-container board) |
| `wc.addVariant(variantShapeId)` | add a sibling variant to an existing variant set |
| `wc.addToken({set,name,type,value})` | token of ANY type: color/spacing/sizing/dimension/border-radius/opacity/rotation/font-size/typography… |
| `wc.applyToken(id,{token,attributes:[…]})` / `wc.unapplyToken(id,attributes)` | bind a token to shape attrs (`fill`,`stroke-color`,`width`,`r1`..`r4`,`p1`..`p4`,…); LITERAL 6-digit-hex/numeric values resolve onto the attr immediately, references resolve under the tokens runtime |

> `updateShape` **refuses** identity/structure/geometry keys (`id`/`type`/`shapes`/`parent-id`/`selrect`/
> `x`/`y`/`width`/`height`/`rotation`/…) and throws — use `moveShape`/`resizeShape`/`reparentShape`/
> `reorderShape`/`groupShapes`/`applyToken`/`addInteraction` for those. Everything edits in memory; persist
> with **`commit()` then `POST /pencilpot/save`** (the save gap) as usual.

## Seeing the design, syncing live, and reading the user's edits

**Render (SEE what you built).** `render_shape` / `wc.renderShape*`:
- SVG (`format:"svg"`) is browser-free and now text-faithful (text emits foreignObject HTML with inline font styles).
- PNG fast path (`fidelity:"fast"`, default) uses rsvg — great for shapes/colors, but **blank for text** by design (librsvg can't draw foreignObject).
- PNG **`fidelity:"high"`** uses the bundled Chromium and renders **text** correctly; pass `fontsDir` = the project's `fonts/` dir so custom families (e.g. Google Sans Flex) are embedded as `@font-face`. Always use high fidelity when the shape contains text.

**Realtime — you work WITH the user.** Your `commit()` (MCP/SDK, JSON path) is broadcast over SSE `/pencilpot/live` and applied **live** in the open editor via Penpot's own collab path — no reload. The user sees your edits as you make them; the header flips to "Unsaved changes". The user's OWN edits are not echoed back to you. (Persisting still needs `POST /pencilpot/save`.)

**Diff — see what the USER changed.** Before the user edits, capture a baseline; afterwards, diff:
- MCP: `diff_baseline` (capture), then `diff` → `{added,removed,modified[…keys,changes], summary, text}`.
- CLI: `pencilpot diff <project.pencil> --save-baseline` then `pencilpot diff <project.pencil>` (`--json` for machine-readable).
- Reports added/removed/modified shapes with the changed SEMANTIC keys (geometry, fills, content, hierarchy, name, visibility); derived/volatile keys are ignored. Use it to catch up on the user's manual edits before continuing.

## Variable fonts (CLI is the persistence path)

```bash
pencilpot map-variable <project.pencil> --font-id custom-google-sans-flex --var-family "Google Sans Flex" \
  --map "Some Family=wdth:75,opsz:36" --map "Other=wdth:125"
pencilpot fonts <project.pencil>            # list custom fonts + missing-families report
pencilpot retarget-fonts <project.pencil> --family "Name=fontId"   # consolidate duplicate ids (no axes)
```
`map-variable` rewrites the on-disk EDN and strips stale position-data so widths re-layout. The MCP
`map_fonts_variable` tool now records the per-shape remap so it **round-trips `commit()`**, but file-level
typographies/components persist via the **CLI only** — use `map-variable` for a complete remap.

## Prototypes

You can build frames/shapes/components AND wire interactions in code. `wc.addInteraction({shapeId,
destination})` appends a click→navigate link to a shape's `:interactions` (also `eventType`/`actionType`
for overlay/url/prev-screen). Pencilpot then **plays** the prototype — imported, UI-authored, OR
yours: the play button opens `/view` in a separate window; `get-view-only-bundle` feeds the native
viewer; hotspot clicks navigate frames.

## GAPs — the few residual things via SDK/MCP

Structural editing, rotation, all-type tokens + literal resolution, component swap, and **variant sets**
(`makeVariant`/`addVariant`) all WORK now. What's left is narrow:

| Want | Reality | Do instead |
|---|---|---|
| Variant set **visual auto-arrange** | `makeVariant` creates the variant container but doesn't flex-arrange it | call `wc.setFlexLayout(containerId,{dir,gap,…})` after |
| Token resolution for **references / `rgb()` / 3-or-8-digit hex** | `applyToken` resolves only literal 6-digit-hex + plain numerics at author time; the rest record the binding | open the design — the tokens runtime resolves the binding |
| `mapFontsToVariable` **typography/component** remap via `commit()` | page-shape remaps round-trip through `commit()`; file-level typographies/components persist via the **`map-variable` CLI** only | use the CLI to persist a full remap |

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

- **Rendering text with the fast path.** `renderShapePng`/`fidelity:"fast"` (rsvg) draws shapes but **blank text** — librsvg ignores foreignObject. Use `renderShapePngHiFi`/`fidelity:"high"` (Chromium) with `fontsDir` for any text board.

## Real-world impact

Verified end-to-end against the canonical DefaultLauncher design: an AI can boot the runtime, checkout,
build boards/rects/ellipses/text with flex/grid layout + constraints, define components, add color tokens,
map variable fonts, commit, save to disk, reopen clean, and play the prototype — all on the STABLE SVG
renderer, no browser injection. Every capability is backed by a deterministic harness in `pencilpot/e2e/ai/`.
The AI can also **render** any shape/board to faithful SVG or text-accurate PNG (`render.mjs`, `render-text.mjs`),
see its committed edits appear **live** in the open editor (`realtime.mjs`, browser-verified in `e2e/vf/realtime-browser.mjs`),
and **diff** the design against a baseline to read the user's manual edits (`diff.mjs`).
