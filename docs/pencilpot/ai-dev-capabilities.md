# Pencilpot AI-driven development — capability findings (consolidated)

**Audit base:** branch `pencilpot` @ `4d66fb1c8a` → through the A-series (`02f19cb8e4`, `9494abe2ae`, `b2c6b90927`, `6190a21012`, `57182768ac`, `69dd01d3c6`).
**Method:** end-to-end harnesses under `pencilpot/e2e/ai/` driving the REAL MCP/SDK/CLI against a live runtime over COPIES of the canonical DefaultLauncher design. Every row below is backed by a deterministic, twice-green harness.

This is the single source of truth the **pencilpot skill** is written from. Per-task fragments: `ai-A1`, `ai-Afix`, `ai-B1`, `ai-B2`, `ai-B3`.

---

## 1. The canonical AI-dev loop (what to actually do)

```
# 1. Boot the runtime over a project/design (serves the SPA + the RPC API)
pencilpot open <project.pencil>            # or: node pencilpot/runtime/server.mjs
#   env: PENCILPOT_PROJECT=<.pencil dir> (+ PENCILPOT_DESIGN=<name>) OR PENCILPOT_DESIGN=<abs design dir>; PENCILPOT_PORT=<port>
#   -> "pencilpot runtime on http://localhost:<port>"

# 2. Point the headless MCP at the LOCAL runtime and edit
PENPOT_HL_BASE=http://localhost:<port> PENPOT_TOKEN=local \
  node headless-core/mcp/server.mjs        # stdio MCP: checkout/scene/script/validate/status/commit/discard

#   checkout(fileId)          read the design through the runtime
#   script(code)              edit via `wc` (add*/setLayout/createComponent/addColorToken/…)
#   validate()                Penpot's validator (now a correct oracle)
#   commit()                  update-file -> stages in runtime MEMORY (revn bump)
# 3. PERSIST: the runtime stages in memory; commit/update-file does NOT write disk.
POST http://localhost:<port>/pencilpot/save      # flush working copy -> on-disk EDN   (REQUIRED)
GET  http://localhost:<port>/pencilpot/status    # {dirty, revn}
POST http://localhost:<port>/pencilpot/discard   # drop staged edits (revert to disk)
```

**The two-step persistence rule (the "save gap"):** `commit()` (or any `update-file`) stages edits in the
runtime's in-memory working copy and bumps revn — **nothing reaches disk until `POST /pencilpot/save`**.
An AI dev loop MUST save explicitly, or the edit is lost on restart/discard. Poll `/pencilpot/status` to confirm.

---

## 2. Capability matrix

### Connection / session (MCP `penpot-headless`)
| Surface | Status | Notes |
|---|---|---|
| `checkout(fileId)` | WORKS | reads the local design via the runtime (after the A1 `getFile` guard) |
| `scene()` | WORKS | id → shape object map |
| `script(code)` | WORKS | runs JS against `wc`; many edits per call; returns a value |
| `status()` | WORKS | pending change count + revn (+ `preExistingValidationIssues`) |
| `validate()` | WORKS | correct schema oracle after A-FIX (was falsely failing) |
| `commit()` | WORKS | A-FIX/A-FIX2: blocks only on edit-INTRODUCED invalidity; pre-existing imported-file issues don't block |
| `discard()` | WORKS | re-checkout / drop working copy |

### Structural authoring (WorkingCopy SDK = MCP `script` globals)
| Method | Status | Opts / return |
|---|---|---|
| `addBoard({x,y,width,height,name})` | WORKS | → board id; pushed as active parent (nest children, then `closeBoard()`) |
| `addRect({x,y,width,height,name,parentId?,fills?,strokes?})` | WORKS | → rect id; `fills:[{fillColor:"#rrggbb",fillOpacity?}]` |
| `addEllipse(...)` | WORKS | same opts (engine `:circle`) |
| `addText({x,y,characters,fontSize?,fontId?,fills?,growType?,name})` | WORKS | `fontId` sets `:font-id`+`:font-family`; `characters`=literal run |
| `closeBoard()` | WORKS | pops the active board (STACK-based, not id-based) |
| `setFlexLayout(boardId,{dir,gap,padding,align,justify,wrap})` | WORKS | keywords (row/column,center/start/…); reflows CURRENT children |
| `setGridLayout(boardId,{cols,gap,padding,dir})` | WORKS | `cols`=column count (default 2); dir defaults `:column` |
| `setGrowType(id,mode)` | WORKS | `auto-width\|auto-height\|fixed` (text/layout attr; inert on plain rects) |
| `setConstraints(id,{h,v})` | WORKS | h:left\|right\|leftright\|center\|scale; v:top\|bottom\|topbottom\|center\|scale |
| `createComponent(boardId,{name?})` | WORKS | promotes a BOARD into a main component |
| `instantiateComponent(componentId,{x,y})` | **GAP** | throws `"expected valid shape"` on SDK-created components (engine `generate-instantiate-component`) |

### Design-system assets
| Surface | Status | Notes |
|---|---|---|
| `addColorToken({set,name,value})` + `tokens()` | WORKS | persists to `<design>/manifest.edn`; name uses `.` for groups, `/` invalid |
| Non-color tokens (typography/spacing/dimension/…) | **GAP** | engine wires `:type :color` only |
| Token → shape binding / themes / set management | **GAP** | no SDK/MCP surface |
| CLI `pencilpot map-variable <project> --font-id … --map "Fam=wdth:..,opsz:.."` | WORKS | the supported variable-font persistence path; strips stale position-data |
| MCP `map_fonts_variable` / `wc.mapFontsToVariable` | PARTIAL | whole-file `:data` transform, records NO change → does NOT round-trip `commit()`; persist via CLI |
| CLI `pencilpot fonts <project>` | WORKS | lists custom fonts + missing-families report |
| CLI `pencilpot retarget-fonts <project> --family "Name=fontId"` | WORKS | consolidates duplicate font-ids per family (no axis change) |
| Variable-font RENDER (STABLE SVG) | WORKS | mapped family paints in `/workspace` and `/view` |

### Prototypes / viewer
| Surface | Status | Notes |
|---|---|---|
| Interaction AUTHORING (SDK/MCP) | **GAP** | no `addInteraction`/`connect`/`:interactions` write verb anywhere |
| Prototype VIEWING / PLAYING (`/view`) | WORKS | `get-view-only-bundle` 200; viewer renders; a real hotspot click navigates frames |

### Lifecycle / persistence
| Guarantee | Status | Notes |
|---|---|---|
| Durability (commit → save → cold reopen) | WORKS | save writes EDN; restart re-serves it; `dirty=false` |
| Save gap | CONFIRMED | commit stages in memory; disk pristine until `/pencilpot/save` |
| Discard | WORKS | reverts ALL staged-since-save edits (reloads from disk); not per-change undo |
| No spurious dirty | WORKS | content-only signature strips `:revn`/`:position-data`/whitespace (commit `3f05d851bb`) |

---

## 3. Confirmed GAPs (what an AI cannot do today) + workarounds
1. **`instantiateComponent`** fails on SDK-created components → can define components but not place instances via SDK. *Workaround:* author instances in the Penpot UI, or pre-instantiate in the source `.penpot`. *Fix:* engine follow-up (`generate-instantiate-component` rejects a freshly-made main).
2. **Prototype interactions** cannot be authored (no verb) → build frames in code, but wire interactions in the UI or pre-author them in the imported design (pencilpot then plays them faithfully). *Fix:* an engine `update-shapes :interactions` verb.
3. **Only color tokens**; no typography/spacing/binding/themes.
4. **Append-only structural authoring**: no reposition/resize/reparent/delete/group verbs beyond layout/grow/constraints.
5. **Variant / component-swap** authoring: none.
6. **`mapFontsToVariable` doesn't round-trip `commit()`** → persist variable-font remaps with the CLI.

---

## 4. Gotchas (operational)
- **Save gap:** `commit()` ≠ persisted — always `POST /pencilpot/save`.
- **`PENPOT_HL_BASE` is frozen at SDK module load** — set it before importing the SDK; one runtime per SDK process. Default `:9101` is a REAL backend (401) — always point at the pencilpot runtime.
- **Auth ignored** by the runtime — `PENPOT_TOKEN` can be any value.
- **Token names use `.`** for groups; `/` throws.
- **`map-variable` is a PROJECT command** (needs the `.pencil`, not a bare design dir).
- **`closeBoard()` is stack-based** — close a board's children before starting an unrelated sibling.
- **Layout setters reflow current children** — add children first, then set flex/grid.
- **First engine call is ~8.5s** cold (mitigated by boot warmup `897adde7bb`); subsequent calls ~300ms; reads reuse a cached warm session.
- **commit gate is coarse:** the engine's `validate()` yields a single `["invalid file data"]` hint, so an error stacked on an already-invalid imported file can't be distinguished from baseline (documented false-negative; strictly safer than blocking everything).

---

## 5. Verifying harnesses (executable proof of every claim)
`pencilpot/e2e/ai/`: `mcp-roundtrip.mjs` (MCP transport), `commit-roundtrip.mjs` + `commit-imported.mjs` (commit gate), `sdk-structure.mjs` (shapes/layout/components), `sdk-tokens.mjs` + `variable-fonts.mjs` (assets), `prototypes.mjs` + `lifecycle.mjs` (viewer + persistence). Shared boot helper `_boot.mjs`. All SKIP exit 0 if `/mnt/data/src/DefaultLauncher/design` is absent.
