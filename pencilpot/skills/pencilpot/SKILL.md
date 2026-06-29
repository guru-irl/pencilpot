---
name: pencilpot
description: Use when driving pencilpot (the local, filesystem-native Penpot design IDE) for a DESIGNER — interpreting a designer's request and resolving it through the penpot-headless MCP/SDK: locating where things are (pages/boards/components/text), acting on the user's current selection, creating/editing boards/shapes/text/components/variants/color-tokens, mapping variable fonts, rendering to see results, diffing the user's edits, prototyping, and persisting to disk. Triggers on "edit a pencilpot design", "add a component", "new version of this component", "change the selected thing", "where is X", "what's in this file", "AI design in Penpot locally", "map variable font", "pencilpot MCP/CLI", "save the design".
---

# Driving pencilpot programmatically

## Overview

Pencilpot is a **local, filesystem-native, no-backend** Penpot design IDE. You edit a design by
pointing the **`penpot-headless` MCP** (or the WorkingCopy SDK it wraps) at a **running pencilpot
runtime**, then explicitly **saving to disk**. The runtime stages edits in memory; disk is written
only on an explicit save.

**Core principle:** edit through the engine (`checkout → script → validate → commit`), then
**`POST /pencilpot/save`**. `commit()` ≠ persisted.

### Operating rules (read this first)

1. **You are a designer's assistant, not a file editor. NEVER read the design's files.** Do not open or
   `cat`/`read` the `.pencil`, the design's `*.edn` (`manifest.edn`, `page-*.edn`, `components.edn`), or
   media files. They are a serialized snapshot — stale the moment the runtime stages an edit, and not
   meant to be hand-parsed. The **engine's in-memory model is the only source of truth**; read it through
   the MCP (`outline`, `scene`, `viewport`, `render_shape`). Treating the EDN as the model WILL desync you.
2. **Orient before you act.** Start every task with `outline` (and `viewport` if the user said "this" /
   "the selected …"). Locate the exact target ids first; never guess an id.
3. **Act through the typed verbs** (the `wc`/MCP API below), not by hand-writing change ops.
4. **See your work.** After a visual change, `render_shape` the affected board (`fidelity:"high"` for text)
   to confirm it looks right before telling the user it's done.
5. **Persist deliberately.** `commit()` stages in runtime memory; the user sees it live, but it's only on
   disk after `POST /pencilpot/save`. Save when the user is happy; confirm `status → dirty:false`.

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

## Orient first — discovery tools (never read the files)

| Need | Tool | Returns |
|---|---|---|
| **"What's in this file? Where's what?"** | `outline` | every page → boards (id/name/geometry/child-count), text shapes (id/name/**text snippet**/frameId), component instances; + the file's **components** (path, variant info, where the main instance lives). Your map of the whole design. |
| **"this" / "the selected …" / "what I'm looking at"** | `viewport` | the user's CURRENT page + selection: `{pageId,pageName,selected:[ids],shapes:[{id,name,type}]}`. Resolve vague references to concrete ids. `selected` empty ⇒ ask, or infer from `outline`. |
| Full shape data for a page | `scene` | id→shape map (geometry, fills, layout, component links) for the active page. |
| **See a shape/board** | `render_shape` | SVG or PNG of one shape/board/component. `fidelity:"high"` (+`fontsDir`) renders text. |
| What did the USER change? | `diff_baseline` then `diff` | added/removed/modified shapes since you captured a baseline. Capture before handing back to the user; diff when they return. |

**The orientation reflex:** `viewport` (if the request is about "this") → `outline` (locate the target +
its context: which board, sibling shapes/components, existing variants) → act → `render_shape` to verify.

## Reading a designer's request → a tool plan

Designers speak in intent ("make a dark version", "tighten this", "link these"), not ids. Translate:

| The designer says… | They mean | Your plan |
|---|---|---|
| "**this** / the selected …" | the current selection | `viewport` → ids → act |
| "the **X** component / board / heading" | a named/text target | `outline` → match by name/text snippet → ids |
| "a **new version** of this component" | a variant of a component | identify component (viewport→`component-id`, or outline), inspect its board + siblings + existing variants in `outline`, then `makeVariant`/`addVariant` |
| "make **these** consistent / aligned / evenly spaced" | layout intent | get the parent board, `setFlexLayout`/`setGridLayout` |
| "use our **brand/primary** color / spacing" | a design token | `tokens()` to find it, `applyToken` |
| "the **condensed**/display font here" | a variable-font axis | `map-variable` CLI (persisted) / `mapFontsToVariable` |
| "**show me** / does it look right?" | visual check | `render_shape` (high fidelity for text) |
| "what did **I** change / review my edits" | diff intent | `diff` vs a baseline |
| "**link**/connect this to …" | a prototype flow | `addInteraction` |
| "**save** / ship it" | persist | `commit` → `POST /pencilpot/save` |

## Designer scenario playbook (worked recipes)

**"Add a new version of this component."**
1. `viewport` → the selected shape; read its `component-id` from `scene`/`outline` (an instance carries
   `component-id`; a main may be the component's main shape).
2. `outline` → find that component: its `name`, `path`, which **board** its main instance sits on, any
   **sibling components** on that board, and whether it already has `variantId`/`variant` peers (existing versions).
3. If it isn't a variant set yet: `makeVariant(instanceId,{name})` to promote it into a variant container,
   then `setFlexLayout(containerId,{dir,gap})` to arrange. If it already is one: `addVariant(variantShapeId)`
   to add a sibling version. Tweak the new version's props (`updateShape`/`moveShape`/fills/text).
4. `render_shape` the variant container (high fidelity) → confirm → `commit` → save when the user approves.

**"Make this a component."** `viewport`→ board id → `createComponent(boardId,{name})`. To place copies:
`instantiateComponent(componentId,{x,y})`.

**"Swap this instance for the X component" / "detach this."** `viewport` → instance id; `outline` → the
target component id; `swapComponent(instanceId,newComponentId)` (or `detachInstance(id)`).

**"Change / restyle the selected thing."** `viewport` → id. Color/opacity/stroke/name → `updateShape`.
Position → `moveShape`. Size → `resizeShape`. Then `render_shape` to verify.

**"Build a <section> with N items."** `addBoard` (becomes the active parent) → add children
(`addRect`/`addText`/`instantiateComponent`) → `closeBoard` → `setFlexLayout`/`setGridLayout` the board
(**layout AFTER children** — setters reflow current children). `render_shape` → verify.

**"Align / evenly space these."** Find their parent board (`outline`/`scene`), `setFlexLayout(boardId,
{dir,gap,align,justify})`.

**"Apply our brand color / a token."** `tokens()` → find the token name; `applyToken(id,{token,
attributes:["fill"]})`. New token: `addColorToken({set,name,value})` (names nest with `.`, never `/`).

**"Use the condensed font on this text."** Variable-font axis remap persists via the **CLI**:
`pencilpot map-variable <project.pencil> --font-id <id> --var-family "<Family>" --map "<Family>=wdth:75"`.
(`mapFontsToVariable` previews in the working copy.)

**"Link this button to the next screen."** `outline` → source shape id + destination board id;
`addInteraction({shapeId,destination})` (click→navigate by default). pencilpot plays it via `/view`.

**"What did I change?"** Capture `diff_baseline` when you hand control back; on return call `diff` →
report the added/removed/modified shapes + which keys (geometry, fill, text, hierarchy) changed.

**"Show me / does it match?"** `render_shape(boardId, format:"png", fidelity:"high", fontsDir:"<project>/fonts")`.

When a request is ambiguous and `viewport`+`outline` can't disambiguate (e.g. two boards named "Card"),
**ask one targeted question** ("the Card on the Foundations page or on Now Playing?") rather than guessing.

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
| `wc.outline()` → file index / `wc.viewport()` → user's page+selection | LOCATE things without reading files (MCP `outline` / `viewport`) |
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

- **Reading the design's files to "understand" it.** The `.pencil`/EDN/media are a stale snapshot, not the
  live model — hand-parsing them desyncs you from the runtime. Use `outline`/`scene`/`viewport`/`render_shape`.
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
