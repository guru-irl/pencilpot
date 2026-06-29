# 12 — Headless Engine & AI-Dev Layer (Phase 4 · AI agent)

**Status:** Complete (audited end-to-end; see `../ai-dev-capabilities.md`).
**Branch:** `pencilpot`
**Locations:** `headless-core/` (`src/app/headless/session.cljs`, `src/app/headless/core.cljs`,
`shadow-cljs.edn`, `mcp/server.mjs`, `sdk/working-copy.mjs`, `sdk/rpc.mjs`),
`pencilpot/runtime/rpc.mjs` (get-file / update-file / read-session cache).
**Updated:** Phase 4 · AI agent — MCP transport proof + dataTransit-validation fix + baseline-diff commit gate.

---

## Overview

Two layers sit on top of the runtime + EDN store (docs `01`, `08`):

- **The headless engine** (`headless-core/`) — the *same* Penpot CLJS data/changes/validation kernel the
  SPA runs, compiled to a **standalone Node ESM module** (`target/headless/penpot.js`). It has no DOM, no
  browser, no network; it hydrates a file, applies authoring changes, validates against Penpot's own
  schema, and serializes back to canonical EDN. The runtime imports it to satisfy `get-file` /
  `update-file` / `get-view-only-bundle`; the SDK imports it to author headlessly.
- **The AI-dev layer** — the `penpot-headless` **MCP server** + the **WorkingCopy SDK** that let an AI
  agent drive a **LOCAL pencilpot design** over the runtime's RPC surface: `checkout → script → commit →
  save`. The capability matrix, exact opts, and gaps live in **`../ai-dev-capabilities.md`** and the
  **`pencilpot/skills/pencilpot/SKILL.md`** skill; THIS doc is the architecture — how the pieces are wired.

```
  AI agent (stdio MCP client)
        │  JSON-RPC over stdio
        ▼
  mcp/server.mjs  "penpot-headless"   ── tools: checkout/script/scene/validate/status/commit/discard/map_fonts_variable
        │  (in-process)
        ▼
  sdk/working-copy.mjs  WorkingCopy   ── addBoard/addRect/…/createComponent/addColorToken/commit + baseline gate
        │
        ├── createSession(...)  ────────────────►  headless engine  (target/headless/penpot.js)
        │                                          authoring · changes · validate · serialize
        │
        └── sdk/rpc.mjs  (HTTP transit) ─ PENPOT_HL_BASE ─►  pencilpot runtime (:PORT)
                 getFile / updateFile                         get-file / update-file (disk-backed, staged)
```

`PENPOT_HL_BASE` is what makes this LOCAL: the SDK's transport posts to that base, so pointing it at the
running pencilpot runtime drives the on-disk design instead of a real Penpot backend.

---

# Part A — The Headless Engine

## Build: the `:headless` ESM module

`headless-core/shadow-cljs.edn` declares ONE build, `:headless`:

```clojure
{:target :esm  :runtime :node  :output-dir "target/headless"
 :modules {:penpot {:exports {createSession    app.headless.session/create-session
                              importBinfileV3  app.pencilpot.import/import-binfile-v3
                              buildAddBoardChange / buildAddBoardBody / buildSetPositionDataBody …}}}}
```

→ emits `headless-core/target/headless/penpot.js` (a Node-importable ESM module). Rebuild with:

```bash
cd headless-core && clojure -M:dev:shadow-cljs release headless
```

This is **separate** from the frontend bundle (doc `02`). It shares the `common/` CLJS source (changes,
schema, layout, tokens) but compiles for Node, not the browser. Runtime `.mjs` changes need no rebuild;
any change under `headless-core/src/**.cljs` (e.g. `session.cljs`) requires this release + a runtime restart.

## `create-session` — the constructor

`session.cljs` `^:export create-session` (the module's primary entry) accepts a JSON arg and supports
**four hydrate modes**, chosen by which key is present:

| Mode | Arg | Source of `:data` |
|---|---|---|
| empty | `{empty:true, name?}` | `make-file-data` — one blank page, root frame at `uuid/zero` |
| dataTransit | `{dataTransit, fileId, features}` | decode a `get-file` transit body → full file map, unwrap `:data` (the SDK's `checkout` path) |
| fromTransit | `{fromTransit, meta}` | decode a `getFileResponse()` body; keep the whole map minus `:data` as **`:file-envelope`** |
| fromStore | `{fromStore: parts}` | `store/load-store` of canonical-EDN parts (the runtime's path; doc `01`) |

File-id precedence: `fromStore` > `meta.id` > `fileId` > decoded > fresh. `revn`/`vern`/`name` carry from
`fromStore`/decoded/`meta`. `features` default to a components/v2 set when absent. The session is an `atom`:

```clojure
{:data <file-data>  :page-id <uuid>  :frame-id uuid/zero  :stack [uuid/zero]
 :changes []  :revn N  :vern V  :name "…"  :file-envelope <full get-file map or nil>}
```

`:file-envelope` is the key to lossless round-trips: when hydrated from a real `get-file`, the engine keeps
every SPA-required key (`:permissions`/`:team-id`/`:project-id`/`:version`/…) and re-emits them from
`getFileResponse`, only swapping in the live `:data`.

## The method table (the JS-facing session)

`make-session` returns a `#js {…}` object — every method takes/returns JSON strings (the JS⇄CLJS boundary
stringifies UUIDs via `stringify-uuids`/`->plain-js`). Grouped:

| Group | Methods | Mechanism |
|---|---|---|
| **Authoring** | `addBoard` `closeBoard` `addRect` `addEllipse`(`:circle`) `addText` | `mk-shape` → `cts/setup-shape`; `add-shape!` builds+applies+records a `:add-obj`. Parenting is a STACK: `addBoard` pushes the board as active `:frame-id`+parent; `closeBoard` pops. `addText` runs `txt/change-text` and `dissoc`s `:position-data`. |
| **Layout** | `setFlexLayout` `setGridLayout` `setGrowType` `setConstraints` | (A) `pcb/update-shapes` writes the layout attrs onto the board; (B) reflow children through Penpot's OWN engine — `ctm/reflow-modifiers` seed → `gm/set-objects-modifiers` → `gsh/transform-shape`. Grid builds tracks via `ctl/add-grid-column`/`assign-cells`/`reorder-grid-children`. |
| **Components** | `createComponent` `instantiateComponent` `swapComponent` `detachInstance` `makeVariant` `addVariant` | `createComponent` promotes an existing board: raw `:add-component` + `:mod-obj` (sets `:component-root`/`:main-instance`/`:component-id`/`:component-file`). `instantiateComponent` calls `cll/generate-instantiate-component` over **records + `:data` `:id`-restored** (coerce-for-validation), so it works on hydrated designs too (fix `01cc717d26`). `swapComponent`/`addVariant` use the SAME coercion (both instantiate — `cll/generate-component-swap` / `clv/generate-add-new-variant`→`generate-duplicate-component`). `detachInstance` uses `cll/generate-detach-instance` (plain-map safe). `makeVariant` is plain-map safe: `cfsh/prepare-create-artboard-from-selection` makes the container frame (a `cts/setup-shape` record — only the new frame is `check-shape`d) then `clvp/generate-make-shapes-variant` assigns `:variant-id`/`:variant-properties`. |
| **Edit existing shapes** | `updateShapes` `deleteShapes` `reparentShape` `reorderShape` `moveShape` `resizeShape` `rotateShape` `groupShapes` `ungroupShape` | All over the engine's high-level generators, plain-map safe (no `cts/check-shape`). `updateShapes` = raw `pcb/update-shapes` with a structural/geometry-key denylist. `delete` = `cls/generate-delete-shapes`; `reparent`/`reorder`/`ungroup` = `cls/generate-relocate` (auto-cleans emptied groups). `moveShape` translates the subtree (`gsh/move`) + `pcb/resize-parents` for ancestors; `resizeShape`/`rotateShape` run `ctm/change-dimensions-modifiers` / `ctm/rotation-modifiers` through `gm/set-objects-modifiers` (recompute `:selrect`/`:points`). `groupShapes` adds a `cts/setup-shape` `:group` record + `pcb/change-parent`. |
| **Tokens** | `addToken` `addColorToken` `applyToken` `unapplyToken` `tokens` | FILE-level `TokensLib`: `pcb/with-library-data` + `set-token-set`/`set-token` + the existing hidden theme enabled additively (mirrors frontend `create-token-with-set`). `addToken` passes `:type` to `ctob/make-token` (ALL types; fail-fast on invalid). `applyToken`/`unapplyToken` write `:applied-tokens` via `cto/apply-token-to-shape`; `applyToken` also RESOLVES literal values (6-digit hex → `:fills`/`:stroke-color`, plain numerics via `cft/parse-token-value` → `:opacity`/`:r1..:r4`/`:stroke-width`), leaving references (`cft/is-reference?`) to the runtime. |
| **Fonts** | `mapFontsToVariable` `retargetFonts` | whole-`:data` `walk/postwalk`: rewrite `:font-id`/`:font-family`/`:font-variant-id`, merge axis map into `:font-variation-settings`, strip stale `:position-data`. `mapFontsToVariable` ALSO records per-page `pcb/update-shapes` changes (so the MCP tool round-trips `commit()`); the whole-`:data` pass is kept for CLI parity (typographies/components — those persist via CLI only). `retargetFonts` stays a direct `:data` transform (doc `06`; CLI persists). |
| **Changes** | `applyChanges` `applyTransitUpdate` `pendingChanges` `clearChanges` `commitBody` `bumpRevn` | `applyTransitUpdate` (canonical) decodes a transit `update-file` body and applies its `:changes` VERBATIM; `commitBody` encodes the accumulated `:changes` into an `update-file` transit body. |
| **Serialize** | `serializeStore` `loadStore` | canonical-EDN parts (doc `01`). |
| **Render** | `renderShape` (+SDK `renderShapePng`) | `app.main.render/shape->svg` mounts `frame-imposter` (a non-deferred `mf/defc`) through `react-dom/server` `renderToStaticMarkup` → SVG string, sub-ms, no Playwright. SDK rasterizes via system `rsvg-convert`/`magick` (zero npm dep). Pulls `frontend` onto the headless classpath + react-dom + node export-conditions (~50–60s one-time bundle load; render itself sub-ms). Fill paint is emitted as child paint elements, not literal hex; raster fidelity needs fonts present. |
| **Responses** | `getFileResponse` `getViewerBundle` | shared `build-file-resp` (below). |
| **Realtime** | runtime `broadcastChanges` (live.mjs) + frontend `on-changes` (data.pencilpot) | AI commit hits `update-file` with `Accept: application/json` (the SDK/MCP path) → runtime broadcasts the transit `:changes` over the SSE `/pencilpot/live` channel as a `changes` event → SPA decodes with `app.common.transit/decode-str` and feeds Penpot's own `handle-file-change` (`dch/commit :source :remote`), applying live with no reload. The SPA's OWN edits use `Accept: transit+json` and are NOT broadcast (already applied locally → no echo loop). |
| **Introspection** | `objects` `getShape` `validate` | `validate` runs `cfv/validate-file-schema!` (with coercion, below). |

## Shared file payload: `build-file-resp` / `modern-features`

`build-file-resp` (session.cljs) produces, from session state, a triple — `:meta-m` (JSON meta, **string**
`:id`), `:resp` (the get-file-shaped map, **UUID** `:id` + live `:data` + modern features), `:served-features`.
It is shared by BOTH `getFileResponse` and `getViewerBundle`, so the `:file` payload can never drift between
the workspace and the viewer (the viewer bundle's `:file` slot is byte-identical to the get-file `:resp`;
doc `11`). When a `:file-envelope` exists it is restored verbatim with `:data`/`:revn`/`:vern`/`:features`
refreshed; otherwise the minimal shape is emitted.

`modern-features` forces the modern feature SET (`components/v2`, `render-wasm/v1`, `design-tokens/v1`,
`variants/v1`, `text-editor/v2`, …). This is required because the SPA's `active-feature?` uses `contains?`:
on a *vector* that checks indices, not membership, so a non-set feature list makes the SPA treat the file as
legacy and render the options panel (and viewer) empty.

## The dataTransit validation fix (`coerce-data-for-validation`, `9494abe2ae`)

`validate` is the parity oracle (`cfv/validate-file-schema!`). Hydrated `:data` (from get-file transit OR
`load-store`) is not schema-clean for the raw validator, which runs WITHOUT the schema's `:decode/json`
coercions. Two gaps, both **validation-only** (never touch session state, wire transit, or on-disk EDN):

1. Shapes arrive as **plain maps**, but `schema:shape` opens with `[:fn shape?]` = `(implements? IShape)` —
   it wants `Shape` *instances*. `->shape-record` coerces maps → records (`cts/create-shape`).
2. `load-store` re-emits `:tokens-lib`/`:options` even when `nil`; `schema:data` marks them
   `{:optional true}` but **non-nillable**, so present-and-nil fails. Drop them when nil.

`coerce-data-for-validation` applies both inside `:validate` only. Residual (still flagged by validate): a
**non-nil** `:tokens-lib` needs a `TokensLib` *instance* (no cheap reconstructor from the decoded form) — an
imported design's real token library is out of scope here and surfaces as a baseline issue (handled by the
commit gate, Part B).

## update-file revn — Accept-honouring (runtime side)

`runtime/rpc.mjs` `update-file` (L481-501) serves two clients from one handler:

- **SPA** (`Accept: transit+json`) → `["^ ","~:revn",N,"~:lagged",[]]` (matches the recorded contract).
- **SDK/MCP** (`Accept: application/json`) → `{revn: N-1, lagged: []}`. The real backend returns the
  **pre-increment** revn (`files_update.clj`), and `wc.commit()` computes the new revn as `res.revn + 1`;
  `persistChanges` returns the post-increment revn, so the JSON path hands back `revn - 1`.

---

# Part B — The AI-Dev Layer

## Transport: `sdk/rpc.mjs`

```js
const BASE = process.env.PENPOT_HL_BASE ?? "http://localhost:9101";   // frozen at module load
```

- `getFile(fileId)` issues TWO `get-file` POSTs: JSON (meta: revn/vern/features) + `transit+json` (the file
  body, so the engine hydrates faithful records). It guards `meta.data.pages[0]` with optional chaining
  because pencilpot returns `data` as a RAW transit blob (the A1 crash, `02f19cb8e4`).
- `updateFile(transitBody)` POSTs an `update-file` transit body, reads back `{revn}` as JSON.

`BASE` is read once at import — **set `PENPOT_HL_BASE` before the SDK module loads** (or spawn the MCP with
it). The default `:9101` is a real backend (401); always point at the pencilpot runtime for local designs.

## WorkingCopy SDK: `sdk/working-copy.mjs`

`checkout()` = `getFile` → `createSession({dataTransit, fileId, features})` → **snapshot
`this.baselineErrs = this.validate()`**. The authoring methods delegate straight to the session object.

`commit({retries})`: refuse if `newValidationErrors()` is non-empty (gate, below) → `session.commitBody(…)`
→ `updateFile(body)` → `this.revn = res.revn + 1` → `session.clearChanges()` (so a later commit doesn't
re-send). On `revn-conflict`/`vern-conflict` it refreshes revn/vern from a fresh `getFile` and resubmits the
SAME recorded changes (append-only changes apply cleanly on any newer revn).

## The baseline-diff commit gate (`b2c6b90927`)

Imported designs carry pre-existing whole-file schema nonconformities that render fine but trip the strict
validator (the non-nil `TokensLib`, VF `:font-variation-settings`, …). Blocking commit on those would make
the AI unable to edit a real design. So:

```
checkout()  → baselineErrs = validate()                       # snapshot pre-edit issues
newValidationErrors() = validate()  ⊖  baselineErrs           # compared by VALUE via errKey()
commit()    → throws ONLY if newValidationErrors() is non-empty
```

`errKey` (`JSON.stringify` for objects, identity for strings) makes the set-diff value-based, robust to the
engine's generic `["invalid file data"]` hint. **Limitation:** that coarse single-string hint means an error
*stacked on* an already-invalid file can't be distinguished from baseline — a documented false-negative,
strictly safer than blocking every edit.

## MCP server: `mcp/server.mjs`

`createHeadlessMcp({token, base})` registers the `penpot-headless` tools (stdio):

| Tool | Action |
|---|---|
| `checkout(fileId)` | `new WorkingCopy(fileId).checkout()`; reports `{checkedOut, revn, objects}` |
| `script(code)` | `runScript(code, {wc})` — global `wc`; returns `{result, log, pending}` |
| `scene()` | `wc.session.objects()` (id → shape map) |
| `validate()` | bare error array (backward-compat) |
| `status()` | `{pending, revn, preExistingValidationIssues}` |
| `commit()` | `{committed, revn, preExisting}` or `{error, introduced, preExisting}` |
| `discard()` | drop the working copy (re-checkout to start over) |
| `map_fonts_variable(mapping)` | `wc.mapFontsToVariable` — whole-`:data` transform; persist via CLI |

## The loop + the save gap

```
boot runtime  →  MCP checkout(fileId)  →  script(edits)  →  validate()  →  commit()  →  POST /pencilpot/save
                 (banner prints fileId)   stages in        oracle         stages in       flush to disk
                                          engine memory                   runtime memory   (REQUIRED)
```

`commit()`/`update-file` stages edits in the runtime's in-memory working copy and bumps revn — **nothing
reaches disk until `POST /pencilpot/save`** (the "save gap"; docs `08`, `11`). Read endpoints reuse a warm,
content-keyed **read-session cache** (`readSessionFor`, warmed at boot via `warmEngine`); writes
(`persistChanges`) always use a fresh `sessionFor` and their `stage()` reassigns `_store`, auto-invalidating
the cache (read-after-write is fresh). See doc `11` for the cache/warmup.

## Known GAPs (architecture cause; full matrix in `../ai-dev-capabilities.md`)

- **Variant set visual auto-arrange** — `makeVariant` creates the variant container but doesn't flex-arrange
  it (the UI's `transform-in-variant` is event-driven; the persisted structure is correct). Call
  `setFlexLayout` on the container to arrange.
- **Token resolution for references / `rgb()` / 3-or-8-digit hex** — StyleDictionary lives only in the
  frontend, so `applyToken` resolves only literal 6-digit-hex + plain numerics at author time; everything
  else records the binding for the tokens runtime.
- **`mapFontsToVariable` typography/component remap via `commit()`** — page-shape remaps are recorded and
  round-trip; file-level typographies/components persist via the `map-variable` CLI only.

**Closed (engine follow-ups):** `instantiateComponent` on hydrated designs (`01cc717d26`); `addInteraction`
prototype authoring (`5268503075`); the **SDK full-control waves** (`267c9dadc5`…`8fe3190c8d`) — full
structural editing + all-type tokens/binding + component swap/detach; and the **last-gaps waves**
(`6231daeab6` rotateShape · `4d6fc23a8d` mapFonts `commit()` round-trip · `6c36b75dd4` applyToken literal
resolution · `b7de630af8` variants makeVariant/addVariant). The pattern is identical throughout: a thin
verb over an existing `cls/`/`cll/`/`clv/`/`clvp/`/`ctm/`/`ctob/`/`cfsh/` generator + `apply-changes!`;
verbs that don't instantiate are plain-map safe (no `cts/check-shape`), verbs that do (swap, addVariant)
reuse the instantiate coercion (records + restored `:data` `:id`). All verified on hydrated sessions +
store round-trips.

For the full WORKS/PARTIAL/GAP capability matrix, exact opts, env vars, and copy-pasteable invocations see
**`../ai-dev-capabilities.md`** and the **`pencilpot/skills/pencilpot/SKILL.md`** skill.

---

## Source map

| Concern | File / symbol | Commit |
|---|---|---|
| `:headless` ESM build | `headless-core/shadow-cljs.edn` | — |
| Session constructor + 4 hydrate modes | `headless-core/src/app/headless/session.cljs` `create-session` | — |
| Method table (authoring/layout/components/tokens/fonts/responses) | `session.cljs` `make-session` | — |
| Shared file payload / modern features | `session.cljs` `build-file-resp`, `modern-features` | `c527d55a94` |
| dataTransit validation coercion | `session.cljs` `coerce-data-for-validation`, `:validate` | `9494abe2ae` |
| Standalone change builders | `headless-core/src/app/headless/core.cljs` | — |
| SDK transport (`PENPOT_HL_BASE`, getFile/updateFile) | `headless-core/sdk/rpc.mjs` | `02f19cb8e4` |
| WorkingCopy + commit + baseline gate | `headless-core/sdk/working-copy.mjs` | `b2c6b90927` |
| MCP tool surface | `headless-core/mcp/server.mjs` | `b2c6b90927` |
| Runtime get-file / update-file (Accept) / read-session cache | `pencilpot/runtime/rpc.mjs` (`getFile`, `update-file` L481, `readSessionFor`/`warmEngine`) | `897adde7bb` |
| Boot banner (`fileId=…`) + warmup | `pencilpot/runtime/server.mjs` L208-215 | `897adde7bb` |
| AI-dev capability matrix (companion) | `docs/pencilpot/ai-dev-capabilities.md`, `pencilpot/skills/pencilpot/SKILL.md` | `09c2e50d0d` |

> Phase 4 · AI agent: the headless engine is the SPA's own kernel compiled for Node; the MCP/SDK drive a
> LOCAL design through the runtime with a checkout→script→commit→save loop, a baseline-diff commit gate, and
> a warm read-session cache. Authoring breadth and gaps are catalogued in the companion capability doc.
