# Penpot Headless SDK — Design Spec

**Date:** 2026-06-11
**Status:** Approved design, pre-implementation
**Author:** AI pairing session (Claude) with repo owner

## 1. Problem & goal

Driving Penpot from a CLI AI agent (Claude Code, Copilot) is too slow and too
fragile today. The current path is:

```
AI → MCP server → WebSocket → browser plugin (live page) → Penpot Plugin API
```

Two friction sources:

1. **The live-instance requirement.** The AI can only act when a human has Penpot
   open in a browser, has loaded the MCP plugin, and has clicked "Connect." Every
   operation is a network round-trip to that browser tab.
2. **Per-op latency.** Even batched, work flows through a browser the agent doesn't
   control, so iteration is slow and stateful in a way the agent can't manage.

**Goal:** Let a CLI AI agent manipulate Penpot designs **superfast** and **without a
live browser/plugin**, by editing the file through a **headless engine that reuses
Penpot's own code (1:1 parity)**, with a git-like local working-copy model.

### Success criteria
- An agent edits a real Penpot file with **no browser tab and no plugin** open.
- Hundreds of geometry-correct operations execute **locally and instantly** (zero
  network per op); a single `commit` persists them.
- Shapes produced are **structurally identical** (same shape maps and `:changes`
  ops, modulo encoding) to what Penpot's frontend/plugin would produce for the same
  logical operation (parity tests prove it).
- Works from both Claude Code and Copilot via MCP **and** a CLI.

### Non-goals (initially)
- Replacing the existing in-app plugin/MCP for users who want over-the-shoulder live editing.
- Server-side (no-browser) rendering — rendering still uses the existing exporter (headless browser) and is only for *viewing*, never editing.
- Real-time collaborative merge semantics beyond optimistic `revn`/`vern` + re-fetch/rebase.

## 2. Decisions (locked during brainstorming)

| # | Decision | Rationale |
|---|----------|-----------|
| D1 | **Headless engine, browserless editing** | The backend `update-file` RPC persists fully-specified shapes; no browser needed to edit. |
| D2 | **1:1 parity by reusing Penpot's CLJC** (not a reimplementation) | `common/**.cljc` (changes, geometry, layout, types, validate) is the *same* code the frontend and JVM backend run; compiling it for Node gives parity by construction and stays current on recompile. |
| D3 | **Engine build = new shadow-cljs `:esm`/`:node-library` target** (Approach ①) | Rides Penpot's existing build; clean because `common.*` is already DOM-free / re-frame-free (the JVM backend compiles it). |
| D4 | **One engine, two adapters** (online RPC + offline `.penpot`) behind a common in-memory file value | "Direct file access" both ways without duplicating engine logic. |
| D5 | **Git-like working model**: `checkout → edit (local, instant) → commit` | Decouples fast local mutation from network persistence; enables batching + conflict handling. |
| D6 | **Control surface = headless scripting core + helpers** | One `script(js)` primitive = hundreds of ops per call, zero network until commit — the speed lever. Helpers + discrete verbs layered on top. |
| D7 | **Packaging: MCP server (stdio) + `pp` CLI**, access-token auth | Covers Claude Code and Copilot; no live page, no plugin. |
| D8 | **Render via the existing exporter**, optional/async | Only browser dependency; only for viewing. |

## 3. Architecture

```
AI (Claude Code / Copilot CLI)
   │   MCP stdio tool   ──or──   `pp` CLI subcommand   (same core underneath)
   ▼
penpot-headless toolkit (Node/TS)
   ├─ Session / working-copy manager   checkout → in-mem file value → commit
   ├─ Scripting runtime                run JS against the engine; batched; instant
   ├─ Helpers                          createBoard, autoLayout, setFill, find…
   ├─ Adapters
   │    ├─ online  : RPC client  (get-file / update-file, access-token auth)
   │    └─ offline : .penpot file reader/writer
   ├─ Render client                    exporter → PNG/SVG (optional "see it")
   └─ @penpot/headless-core            ← Penpot's own CLJC, compiled for Node (ESM)
```

## 4. Components

### 4.1 `@penpot/headless-core` (compiled engine)
A new shadow-cljs build target in the Penpot repo that compiles a curated set of
`common.*` namespaces and exposes a **stable JS facade**. No new business logic lives
here — it only re-exports/binds Penpot's functions.

Namespaces in scope (initial): `app.common.files.changes`,
`app.common.files.changes-builder` (the `pcb` fluent builder),
`app.common.files.validate`, `app.common.types.file`, `app.common.types.container`,
`app.common.types.shape` (+ `app.common.types.shape.layout` for flex/grid),
`app.common.geom.*` (point, matrix, rect, shapes/*, modifiers, flex/grid layout).

Facade (JS-facing) responsibilities:
- `hydrate(fileData) → FileValue` and `serialize(FileValue) → fileData` (transit on the wire).
- Expose a changes-builder handle (`pcb`) to accumulate change-ops.
- Geometry-complete operations (compute selrect/points/transform/reflow): add/move/resize shapes, set attrs, add & reflow flex/grid layouts, components, text.
- `validate(FileValue)` (optional, gated like the frontend).
- Emit the resulting `:changes` vector **and** the updated `FileValue`.

**Constraint:** the dependency graph of these namespaces must not transitively require
frontend-only or DOM/re-frame namespaces. Verified per-namespace during Phase 0.

### 4.2 Session / working-copy manager (TS)
Holds an in-memory `FileValue` plus `revn`/`vern` and an accumulating change list.
- `checkout(ref, {token?})` — ref = file id/URL (online) or `.penpot` path (offline).
- `status()` — pending change count + human-readable diff summary.
- `commit({message?})` — online: POST one `update-file` with the accumulated `:changes`, current `revn`/`vern`, and a `session-id`; on `revn-conflict`/`vern-conflict`, re-fetch and rebase/replay, then retry (bounded). Offline: write the `.penpot`.
- `discard()` — drop pending changes.

### 4.3 Scripting runtime (TS)
- `script(js, {timeoutMs?})` — evaluates JS as the body of an async function with
  bound globals: `engine` (facade), `file` (current `FileValue` / convenience accessors),
  `helpers`, `find` (query helpers), `log`. Returns the script's return value (plain data).
  All mutations accumulate in the session's change list; **no network** until `commit`.
- Mirrors the ergonomics of today's `execute_code`, minus the browser and latency.

### 4.4 Helpers (TS, on top of the facade)
Common-80% verbs: `createBoard`, `createFrame`, `createRect`, `createText`,
`setFill`, `setStroke`, `setPosition`, `setSize`, `autoLayout(flex)`,
`findById`, `findAll(pred)`, `shapeTree(depth)`. Each delegates to engine geometry ops.

### 4.5 Adapters
- **Online RPC client**: `get-file`, `update-file` (and later `get-file-fragments` if
  the file uses pointer-map fragments); `Authorization: Token <access-token>`;
  Transit/JSON encoding for `:changes`.
- **Offline `.penpot`**: read/write the export artifact (blob format: fressian v5 /
  transit; pointer-map fragments). Phase 3.

### 4.6 Render client (TS)
`render(target, {format})` — ensure committed, then call the running instance's
exporter to produce PNG/SVG/PDF for a page/board/shape; return bytes to the agent.
Online-only (the exporter loads from the backend). Phase 3.

### 4.7 Packaging
- **MCP server (stdio)**: tools `checkout`, `script`, `commit`, `status`, `render`,
  `discard` (+ optional discrete helper tools). Configure in Claude Code/Copilot as a
  normal stdio MCP server. No live page, no plugin.
- **`pp` CLI**: `pp login`, `pp checkout <ref>`, `pp script -f file.js | -e "…"`,
  `pp status`, `pp commit`, `pp render <target> -o out.png`, `pp discard`. Shares the
  toolkit core.

### 4.8 Auth
Access tokens via `create-access-token` (or reuse the existing `mcp` token type /
`get-current-mcp-token`). `pp login` obtains/stores a token (config file or env
`PENPOT_TOKEN`, base URL `PENPOT_BASE_URI`). Requires the instance's `access-tokens`
flag enabled.

## 5. Data flow (online edit)
```
checkout(fileId)  → get-file (Token)            → FileValue + revn/vern in memory
script() ×N       → engine ops (local, instant) → accumulate :changes
commit()          → update-file(Token, revn, vern, session-id, :changes)
                   → persists; any open browser live-updates via Penpot's websocket
render(board)     → (commit) → exporter → PNG → back to agent   [optional]
```

### 5.1 Live-update behavior
- **Online mode is live.** Because `commit` persists through the backend `update-file`
  RPC, Penpot's existing collaboration channel broadcasts the change-ops over websocket
  to every other client viewing that file; an open browser tab applies them live. The
  headless client is just another collaborator (distinct `session-id`).
- **Granularity = per `commit`, not per op.** Local edits are batched; the user sees
  changes land each time the agent commits. Commit more often (per board/section) for
  more granular live feedback.
- **Offline mode is not live** — no server in the loop; visible only after import/open.
- **Concurrent human edits** to the same file/shapes are the conflict case handled by
  `revn`/`vern` optimistic concurrency + rebase-on-commit.

## 6. Parity & testing
- **Golden parity tests**: for each engine op, assert the resulting shape/`:changes`
  match Penpot's real output. Sources of truth: the backend `validate.cljc` (must pass),
  and recorded outputs from the frontend/plugin for representative ops.
- **Round-trip tests**: hydrate(get-file) → serialize → equality; commit → get-file →
  expected shapes present.
- **Conflict tests**: concurrent `revn` bump → commit rebases and succeeds.
- TS unit tests for the toolkit (session, scripting, adapters) following the Phase-1
  MCP test harness (`node:test` + `tsx`).

### 6.1 Isolation constraint (hard requirement)
The owner uses the existing local Penpot deployment (compose project `penpot`, port
`9001`, volumes `penpot_penpot_*`, the deployed `penpot-mcp:local` image + mounted
plugin, and the Claude Code `penpot` MCP config) for **real design work**. This project
must **never** touch it. All testing uses a **separate isolated instance**: a distinct
compose project name (e.g. `penpot-hl`), distinct host ports (e.g. `9101`/`1180`), and
its own volumes, with a throwaway account/file. All code work happens on a dedicated
git branch.

## 7. Phasing & deliverables

**Phase 0 — Engine spike (de-risk the whole idea).**
Add the shadow-cljs node/ESM target. Export `hydrate`/`serialize`, the changes-builder,
`:add-obj`/`:mod-obj`, and ONE geometry op (create a rect/board with correct
selrect/points/transform). Script a headless `get-file → add board → update-file` against
the local instance and confirm the file changed (and an open browser reflects it).
*Exit:* a real file mutated headlessly with a geometry-correct shape.

**Phase 1 — Online MVP.**
Working-copy manager + RPC adapter + scripting runtime + commit + access-token auth.
Helpers for boards/frames/rects/text/fills/strokes/position/**basic flex layout**.
MCP server + `pp` CLI. Skill v1. Parity tests for the covered ops.
*Exit:* agent builds a multi-board layout end-to-end, browserless, and commits once.

**Phase 2 — Fidelity.**
Grid layout, constraints, components/instances, design tokens, text auto-size. Hardened
conflict/rebase. Expanded parity suite.

**Phase 3 — Offline + render.**
`.penpot` read/write adapter; exporter-backed `render` ("see it" loop); offline→online sync.

## 8. Risks & mitigations
| Risk | Mitigation |
|------|------------|
| Node-target dependency cut pulls in frontend-only deps | Phase 0 verifies per-namespace; `common.*` is portable by design (JVM backend compiles it). |
| Large geometry/layout surface area | Phased; cover the 80% (abs-positioned + flex) first, grid/constraints later. |
| Concurrent human edits → `revn`/`vern` conflicts | Re-fetch + rebase/replay on commit, bounded retries; surface a clear error if irreconcilable. |
| Pointer-map fragmented file data on large files | Detect and fetch fragments via the documented storage path; fall back to error with guidance if unsupported in a phase. |
| Penpot CLJC changes break the facade | Parity tests catch drift; facade re-exports rather than copies. |
| Render still needs a browser | Accepted; isolated to the view step, never editing. |

## 9. Open questions (resolve during planning)
- Exact shadow-cljs target (`:node-library` vs `:esm`) and where the build config lives
  (frontend `shadow-cljs.edn` vs a new module).
- Whether to vendor the compiled artifact into the toolkit or build it on demand.
- Session-id semantics for `update-file` from a non-browser client (any server-side
  expectations beyond a UUID?).
- Token UX: reuse `mcp` token type vs a dedicated access token; storage location.

## 10. Naming (tentative)
- Engine: `@penpot/headless-core`
- Toolkit + CLI: `penpot-headless` / `pp`
- Skill: `penpot-headless` (supersedes/extends `penpot-local`)
