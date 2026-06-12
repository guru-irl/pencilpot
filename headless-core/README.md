# headless-core — Penpot Headless SDK (Phase 1a)

> **Status: Phase 1a complete.** Full working-copy API — `checkout → edit → commit` — built
> on top of Penpot's own `app.common.*` engine, with a live round-trip test gate against
> `penpot-hl` and a one-command `npm run verify` that proves all four layers green.

---

## What this is

`headless-core` is a thin ClojureScript facade over Penpot's canonical shared logic:

| Penpot namespace | Role |
|---|---|
| `app.common.types.shape/setup-shape` | geometry — computes selrect, transform, points |
| `app.common.files.changes-builder` (pcb) | builds the `add-obj` change operation |
| `app.common.transit` | encodes the change body to `application/transit+json` |

No logic is reimplemented. The facade (`src/app/headless/core.cljs`) simply wires these
three together and exposes two JS-callable exports via shadow-cljs' ESM `:target`:

- **`buildAddBoardChange`** — returns a single geometry-complete change as JSON (for unit
  tests and inspection).
- **`buildAddBoardBody`** — returns the full `update-file` request body as a
  `transit+json` string, ready to POST.

---

## What Phase 0 proved

Running `node --test test/roundtrip.test.mjs` against the isolated `penpot-hl` instance
demonstrates end-to-end:

1. `buildAddBoardBody` produces a valid transit+json payload carrying Penpot's native
   `Shape`, `Matrix`, and `Point` records.
2. `POST /api/rpc/command/update-file` returns HTTP 200.
3. The file's `revn` increments on the server.
4. A subsequent `get-file` call confirms the frame persists with the correct `selrect`
   (e.g. `width: 320`) — no client-side geometry drift.

This establishes **1:1 parity**: the same code Penpot's frontend and backend use, reused
directly via compilation rather than reimplementation.

---

## Prerequisites

| Requirement | Notes |
|---|---|
| **JDK ≥ 21** | Tested on JDK 26. Required by shadow-cljs at build time. |
| **Clojure CLI** (`clojure`) | Install from [clojure.org/guides/install_clojure](https://clojure.org/guides/install_clojure). |
| **Node.js ≥ 20** | ESM + built-in test runner (`node:test`). |
| **npm** | Bundled with Node. |

First-time Maven dependency download (triggered by `npm run build`) can be slow
(several minutes). Subsequent builds are fast.

---

## Build

```bash
cd headless-core

# Install the single runtime npm dep (date-fns, pulled in by app.common.time)
npm install

# Compile ClojureScript → Node ESM bundle
npm run build
# equivalent: clojure -M:dev:shadow-cljs release headless
```

Output: `headless-core/target/headless/penpot.js` (gitignored).

To rebuild on every save during development:

```bash
npm run watch
# equivalent: clojure -M:dev:shadow-cljs watch headless
```

---

## Test

### 1. Provision the throwaway test environment (once)

The roundtrip test needs a live Penpot instance. Run this once (or any time the
`penpot-hl` volumes are recreated). It registers the test user, mints an access token,
creates a file, and writes the gitignored `infra/penpot-hl/test-env.json`.

```bash
# from headless-core/
node test/setup-env.mjs
```

Requires the `penpot-hl` instance to be running (see Isolation & Teardown below).

### 2. Unit test — geometry built headlessly (no network)

```bash
node --test test/facade.test.mjs
```

Verifies that `buildAddBoardChange` produces a geometry-complete `add-obj` change with
correct `selrect`, `points`, and `transform` fields — purely in-process, no Penpot
instance required.

### 3. End-to-end roundtrip test

```bash
node --test test/roundtrip.test.mjs
```

Posts a headlessly-built board to `penpot-hl`, then fetches the file back and asserts
the frame persists with the expected geometry. Reads credentials from
`infra/penpot-hl/test-env.json` (written by `setup-env.mjs`).

To point the test at a different base URL:

```bash
PENPOT_HL_BASE=http://localhost:9101 node --test test/roundtrip.test.mjs
```

---

## How it works

### The facade (ClojureScript → ESM)

`src/app/headless/core.cljs` calls Penpot's own `setup-shape` to produce a
geometry-complete shape map (selrect, points, transform), then threads it through `pcb`
to build the `add-obj` change, and finally passes the full changes list through
`app.common.transit/encode-str` to produce the wire-ready transit+json string.

shadow-cljs compiles this to `target/headless/penpot.js` as an ES module, exporting the
two functions above. Because the compilation target is `:esm` + `:node`, all of Penpot's
CLJS macros and conditional reader forms work correctly.

### Wire protocol

| Concern | Detail |
|---|---|
| RPC endpoint | `POST /api/rpc/command/<name>` |
| Reads (`get-file`, etc.) | `Content-Type: application/json` / `Accept: application/json` |
| Writes (`update-file`) | `Content-Type: application/transit+json` / `Accept: application/json` |
| Auth | `Authorization: Token <access-token>` — requires `enable-access-tokens` flag on the server |
| Concurrency fields | Echo `revn`, `vern`, and `features` from the current `get-file` response; supply a random `sessionId` UUID |

**Why transit for writes?** The `update-file` body contains Penpot record types
(`Shape`, `Matrix`, `Point`). These are opaque to plain JSON but are first-class transit
tagged values. Using `app.common.transit/encode-str` on the ClojureScript side means the
backend's transit decoder receives the correct typed records — no manual conversion, no
drift.

---

## Isolation & teardown

> **The owner's live Penpot instance must never be touched.**

| Instance | Compose project | Ports | Volumes |
|---|---|---|---|
| **Live (owner)** | `penpot` | 9001 | `penpot_penpot_*`, `~/.local/share/penpot/*` |
| **Throwaway (tests)** | `penpot-hl` | 9101 / 1180 | isolated, defined in `infra/penpot-hl/docker-compose.yaml` |

All testing is done exclusively against `penpot-hl`.

```bash
# Stop penpot-hl without deleting data
sudo docker compose -p penpot-hl -f infra/penpot-hl/docker-compose.yaml stop

# Full teardown including volumes (throwaway data — safe to delete)
sudo docker compose -p penpot-hl -f infra/penpot-hl/docker-compose.yaml down -v
```

The `enable-access-tokens` flag is set on `penpot-hl` (required for
`Authorization: Token` auth). It is NOT implied by `enable-mcp`.

---

---

## Phase 1a — Working Copy

### The `WorkingCopy` API

`WorkingCopy` is the Phase 1a high-level API for headless editing. It wraps the
session manager and provides a structured checkout → edit → commit workflow:

```js
import { WorkingCopy } from './sdk/WorkingCopy.mjs';

// 1. Checkout — fetches the current file state from the server
const wc = await new WorkingCopy(fileId, token).checkout();

// 2. Edit — all mutations are in-memory; nothing hits the network yet
const b = wc.addBoard({ x: 0, y: 0, width: 800, height: 600, name: 'Main' });
wc.addRect({ x: 20, y: 20, width: 200, height: 100, name: 'Box',
             parentId: b, fills: [{ fillColor: '#FF3333' }] });
wc.addEllipse({ x: 240, y: 20, width: 100, height: 100, name: 'Dot',
                parentId: b, fills: [{ fillColor: '#22c55e' }] });
wc.closeBoard();

// 3. Validate — runs Penpot's own validate-file-schema! as the parity oracle
wc.validate();

// 4. Commit — encodes accumulated changes as transit+json and POSTs update-file
await wc.commit();
```

`addBoard()` returns the new board's UUID string; pass it as `parentId` to
`addRect()` (or any other shape adder) to nest the shape inside the board.
`closeBoard()` finalises the current board's `objects` index so the frame is
ready to be read back.

### Session model

Internally `WorkingCopy` delegates to a `HeadlessSession`, which holds all
in-memory state:

| Stage | What happens |
|---|---|
| **`checkout`** | Calls `get-file` via JSON RPC. Records `revn`, `vern`, `features`, and the full `objects` map. |
| **`setup-shape`** | Each shape adder calls Penpot's own `app.common.types.shape/setup-shape`, computing `selrect`, `transform`, and `points` in-process. |
| **`process-changes`** | Changes are fed through `app.common.files.changes/process-changes` to update the local `objects` map — the same function Penpot's frontend uses. |
| **`accumulate`** | The raw `add-obj` operations are accumulated in a changes list throughout the editing session. |
| **`commit`** | `app.common.transit/encode-str` encodes the full changes payload; `POST /api/rpc/command/update-file` sends it. |
| **conflict handling** | If the server returns a 400 stale-revn error, `WorkingCopy` calls `get-file` again to refresh `revn`/`vern`, then resubmits the unchanged accumulated changes. |
| **`validate`** | Calls `app.common.files.validate/validate-file-schema!` on the local objects map. This is the same validator Penpot's backend runs, so it acts as a 1:1 parity oracle before the network round-trip. |

After `commit()` the accumulated changes list is cleared, and the session's
`revn`/`vern` are updated to match the server's response.

---

## One-command gate: `npm run verify`

```bash
cd headless-core
npm run verify
```

This runs six layers in sequence; any failure stops the chain:

| Script | What it checks |
|---|---|
| `npm run build` | shadow-cljs compiles `src/app/headless/core.cljs` (+ all `app.common.*` deps) to `target/headless/penpot.js` with 0 warnings. |
| `npm run test:unit` | Node built-in test runner executes `test/session.test.mjs` and `test/facade.test.mjs`. Covers the `HeadlessSession` state machine (setup-shape + process-changes in-process) and the `buildAddBoardChange` / `buildAddBoardBody` facade exports. No network required. |
| `node --test test/script.test.mjs` | Unit tests for the `runScript` sandbox (`sdk/script.mjs`): return values, console capture, error surfacing, and top-level `await`. No network required. |
| `npm run test:engine` | `scripts/test-engine.mjs` loads Penpot's own `cljs.test`-compiled common suites via the built bundle and runs every `deftest` in `common-tests.geom.*`, `common-tests.types.*`, and `common-tests.files.*`. These are Penpot's upstream unit tests — ~14 000+ assertions — running against the exact compiled code the headless SDK uses. A failure here means a Penpot-engine regression, not an SDK bug. No network required. |
| `npm run test:roundtrip` | `test/workingcopy.roundtrip.test.mjs` hits the live `penpot-hl` instance (port 9101). It calls `checkout`, adds a board and a rect, calls `validate`, calls `commit`, then re-fetches the file and asserts both shapes persist with correct geometry. Reads credentials from `infra/penpot-hl/test-env.json`. |
| `npm run test:mcp` | `test/mcp-server.test.mjs` spins up the MCP server with an in-memory transport, verifies all 7 tools are registered, and runs a full `checkout → script → validate → commit` round-trip against `penpot-hl`. 2 tests, 2 pass. |

### Running `penpot-hl`

The roundtrip test requires the throwaway Penpot instance to be running:

```bash
sudo docker compose -p penpot-hl -f infra/penpot-hl/docker-compose.yaml up -d
```

Then provision credentials once if the volumes are fresh:

```bash
node test/setup-env.mjs
```

### Individual layers

```bash
npm run build                         # compile only
npm run test:unit                     # unit (no network)
node --test test/script.test.mjs      # script sandbox unit (no network)
npm run test:engine                   # engine parity gate (no network)
npm run test:roundtrip                # live round-trip (penpot-hl must be up)
npm run test:mcp                      # MCP integration (penpot-hl must be up)
```

---

## What's next (Phase 1b deferrals — original)

The following were out of scope for Phase 1a and have since been addressed (MCP server)
or remain deferred (1c):

- **Text shapes** — `addText()` is implemented (Phase 1c-1). Text persists and is
  schema-valid; precise per-glyph `position-data` is computed by the editor on open
  (headless cannot measure font metrics). See the Phase 1b/1c README section.
- **Flex reflow** — `setFlexLayout()` is now implemented (Phase 1c-2). Grid reflow
  is now implemented (Phase 1d) — see `setGridLayout()` above.
- **`pp` CLI** — a command-line interface that drives `WorkingCopy` ops from shell
  scripts and CI pipelines. Deferred to Phase 1c.
- **Claude Code skill** — a `/penpot-headless` skill that drives the MCP server for
  AI-assisted design automation. Deferred to Phase 1c.
- **Golden dump-file snapshots** — deterministic `get-file` response fixtures for
  offline regression testing. Deferred to Phase 1c.

See:
- `docs/superpowers/specs/2026-06-11-penpot-headless-sdk-design.md`
- `docs/superpowers/plans/2026-06-11-penpot-headless-sdk-phase0.md`

---

## Phase 1b — Headless MCP Server

> **Status: Phase 1b complete.**  The MCP server is live and registered with Claude Code.
> Six verify layers all pass: build → test:unit → script sandbox → engine gate →
> roundtrip → MCP integration.

---

### The 7 MCP tools

| Tool | Description |
|---|---|
| `checkout` | Load a Penpot file into a headless working copy (`fileId` arg). Returns current `revn` and object count. |
| `script` | Run a JS snippet against the working copy (`code` arg). Globals: `wc` (`addBoard`, `addRect`, `addEllipse`, `addText`, `closeBoard`, `setFlexLayout`, `setGridLayout`, `setGrowType`, `setConstraints`, `validate`, `pendingChanges`). Many edits in one call; no network until `commit`. |
| `scene` | Return the full working-copy object map (id → shape). |
| `validate` | Run Penpot's own `validate-file-schema!` on the local state. Returns `[]` on success; error details otherwise. |
| `status` | Pending (uncommitted) change count + current `revn`. |
| `commit` | Encode accumulated changes as transit+json and POST `update-file`. Validates before sending; rolls back on validation failure. |
| `discard` | Drop the working copy without committing (call `checkout` again to start over). |

### The `checkout → script → commit` flow

```
checkout(fileId)          # fetch file state; wc is now ready
script(code)              # edit in-memory; repeat as needed
validate()                # optional: confirm valid before committing
commit()                  # persist to Penpot
```

### Example `script` payload

This snippet (also used in `test/mcp-server.test.mjs`) adds a board and a rect inside it:

```js
const b = wc.addBoard({ x: 900, y: 60, width: 280, height: 180, name: 'MCP Board' });
wc.addRect({ x: 920, y: 80, width: 100, height: 60, parentId: b, fills: [{ fillColor: '#3366ff' }] });
wc.closeBoard();
return wc.pendingChanges().length;   // → 2
```

`addBoard()` returns the new board's UUID. Pass it as `parentId` to `addRect()` or
`addText()` to nest the shape inside the board. `closeBoard()` finalises the board's
`objects` index. Nothing hits the network until `commit()`.

`addText({x, y, width, height, characters, fontSize, fontId, fills, parentId, growType})`
adds a text shape and returns its UUID. Multi-line text is supported via `"\n"` in
`characters`. **Position-data caveat:** precise per-glyph layout (`position-data`) is
computed by the Penpot editor when the file is opened — headless cannot measure font
metrics — so text dimensions and line-wrapping settle when the file is next opened in the
editor. The shape is schema-valid and persists correctly on `commit`.

`setFlexLayout(boardId, {dir, gap, padding, align, justify, wrap})` turns an existing
board into a flex container and immediately reflows its children using Penpot's own
modifier engine (`app.common.types.shape.layout`). Parameters:

| Parameter | Type | Default | Description |
|---|---|---|---|
| `boardId` | string (UUID) | required | The board to make a flex container. |
| `dir` | `"row"` \| `"column"` | `"row"` | Main axis direction. `"row"` spaces children along x; `"column"` along y. |
| `gap` | number | `0` | Gap (in px) between children along the main axis. |
| `padding` | number | `0` | Uniform padding (in px) inside the board on all sides. |
| `align` | string | `"start"` | Cross-axis alignment of children (`"start"`, `"center"`, `"end"`). |
| `justify` | string | `"start"` | Main-axis justification (`"start"`, `"center"`, `"end"`, `"space-between"`). |
| `wrap` | boolean | `false` | Whether children wrap onto a new line when they overflow the main axis. |

After the call the board's `layout` field is set to `"flex"` and each child's `x`/`y`
position is updated to reflect the reflow (e.g. `dir:"row"` with `gap:10` places
children at x = 0, 90, 180, … for 80 px-wide shapes). `setFlexLayout` counts as a
pending change and is persisted by the next `commit()`.

```js
const b = wc.addBoard({ x: 0, y: 0, width: 400, height: 120, name: 'Row' });
for (let i = 0; i < 3; i++)
  wc.addRect({ x: 0, y: 0, width: 80, height: 60, parentId: b });
wc.closeBoard();
wc.setFlexLayout(b, { dir: 'row', gap: 10, padding: 8 });
// children are now at x ≈ 8, 98, 188 (padding + gap applied by Penpot's engine)
await wc.commit();
```

`setGridLayout(boardId, {cols, gap, padding, dir})` turns an existing board into a grid
container and reflows its children into a fixed-column grid using Penpot's own modifier
engine (`app.common.types.shape.layout`). Parameters:

| Parameter | Type | Default | Description |
|---|---|---|---|
| `boardId` | string (UUID) | required | The board to make a grid container. |
| `cols` | number | `2` | Number of columns. Children fill left-to-right, then wrap to new rows. |
| `gap` | number | `0` | Gap (in px) between cells in both directions. |
| `padding` | number | `0` | Uniform padding (in px) inside the board on all sides. |
| `dir` | `"column"` \| `"row"` | `"column"` | Primary fill direction. `"column"` (default) fills columns first, wrapping into rows — so a fixed `cols` count produces a natural multi-row grid. `"row"` fills rows first. |

After the call the board's `layout` field is set to `"grid"` and each child is assigned
to a cell; `x`/`y` positions are updated by Penpot's engine to reflect the grid. The
call counts as a pending change and is persisted by the next `commit()`.

```js
const b = wc.addBoard({ x: 0, y: 0, width: 360, height: 240, name: 'Grid' });
for (let i = 0; i < 6; i++)
  wc.addRect({ x: 0, y: 0, width: 80, height: 60, parentId: b,
               fills: [{ fillColor: '#3366ff' }] });
wc.closeBoard();
wc.setGridLayout(b, { cols: 3, gap: 12, padding: 16 });
// 6 children arranged in 2 rows × 3 columns, with 12 px gaps and 16 px board padding
await wc.commit();
```

`setGrowType(id, mode)` sets the auto-sizing behaviour of a text shape. `mode` must be one
of `"auto-width"` (default for new text), `"auto-height"`, or `"fixed"`. Emits a `:mod-obj`
change via `pcb/update-shapes`.

```js
const t = wc.addText({ x: 10, y: 10, width: 200, height: 30, characters: "Hello" });
wc.setGrowType(t, "fixed");    // lock size; editor won't resize on open
await wc.commit();
```

`setConstraints(id, {h, v})` sets horizontal and/or vertical pinning constraints on any shape.
Either key may be omitted to leave the existing constraint unchanged.

| Key | Valid values |
|---|---|
| `h` | `"left"` `"right"` `"leftright"` `"center"` `"scale"` |
| `v` | `"top"` `"bottom"` `"topbottom"` `"center"` `"scale"` |

```js
const b = wc.addBoard({ x: 0, y: 0, width: 200, height: 200, name: "Card" });
const r = wc.addRect({ x: 10, y: 10, width: 50, height: 50, parentId: b });
wc.closeBoard();
wc.setConstraints(r, { h: "right", v: "bottom" });  // pin to bottom-right corner
await wc.commit();
```

### Environment variables

| Variable | Required | Description |
|---|---|---|
| `PENPOT_TOKEN` | Yes | Penpot access token (requires `enable-access-tokens` flag on the server). |
| `PENPOT_HL_BASE` | No (default: `http://localhost:9101`) | Base URL of the Penpot instance. |

### Claude Code registration

Register the server once (user scope, so it persists across projects):

```bash
TOKEN=$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync("/mnt/data/src/penpot/infra/penpot-hl/test-env.json")).token)')
claude mcp add penpot-headless -s user \
  -e PENPOT_TOKEN="$TOKEN" \
  -e PENPOT_HL_BASE=http://localhost:9101 \
  -- node /mnt/data/src/penpot/headless-core/mcp/server.mjs
```

Verify registration:

```bash
claude mcp list | grep penpot-headless
# penpot-headless: node .../mcp/server.mjs - ✔ Connected
```

The server speaks stdio; Claude Code launches it on demand.

### ISOLATION — penpot-hl only

> **This server is wired to `penpot-hl` (port 9101) exclusively.**

| Instance | Compose project | Ports | `enable-access-tokens` |
|---|---|---|---|
| **Live (owner)** | `penpot` | 9001 | NOT set by default |
| **Throwaway (tests)** | `penpot-hl` | 9101 / 1180 | Set in `infra/penpot-hl/docker-compose.yaml` |

To point the MCP server at a *different* instance, supply that instance's token and base
URL in `PENPOT_TOKEN` / `PENPOT_HL_BASE`, **and** ensure `enable-access-tokens` is set
in that instance's `docker-compose.yaml`. The owner's `:9001` instance does NOT have this
flag and cannot accept token-based auth — do not use it.

### Sanity test (`npm run sanity`)

A standalone AI-flow check that **spawns the real stdio server** (exactly how Claude Code
launches it), connects an MCP client over stdio, and runs the full agent loop against
`penpot-hl`:

```bash
cd headless-core && npm run sanity
```

```
  ✓ tools/list exposes the 7 tools
  ✓ checkout returns revn + object count
  ✓ script adds board+rect (2 pending)
  ✓ validate returns no errors
  ✓ status reports 2 pending
  ✓ commit persists (revn advances)
  ✓ re-checkout shows +2 objects & advanced revn
  ✓ board persisted as frame, width 240
  ✓ nested rect persisted with fill
  ✓ fresh working copy is clean (0 pending)
PASS — headless MCP sanity OK
```

It exits non-zero on any failure. Unlike `test:mcp` (in-process via `InMemoryTransport`),
this exercises the actual spawned binary + stdio transport + env config. Penpot shipped no
MCP tests upstream, so this follows the repo's own conventions: `node:test` suites plus a
standalone integration/sanity script (cf. `mcp/packages/server/scripts/integration-test-*`).

### Phase 1c/1d deferrals

The following remain out of scope:

- **Paths / components** — not yet exposed via `wc`.
- **`pp` CLI** — shell-friendly command-line interface wrapping `WorkingCopy` ops.
- **Full Claude Code teaching skill** — a `/penpot-headless` skill that drives the
  MCP server with guided prompts for AI-assisted design automation.

> **Phase 1c-1 (text) complete:** `addText()` is now implemented on `HeadlessSession`,
> `WorkingCopy`, and the MCP `script` sandbox. Text shapes persist correctly;
> see the position-data caveat above.

> **Phase 1c-2 (flex) complete:** `setFlexLayout()` is now implemented on `HeadlessSession`,
> `WorkingCopy`, and the MCP `script` sandbox. Boards persist with `layout:"flex"` and
> children are reflowed by Penpot's own modifier engine on commit.

> **Phase 2 (fidelity) complete:** `setGrowType()` and `setConstraints()` are now implemented
> on `HeadlessSession` and `WorkingCopy`. `setGrowType(id, "auto-width"|"auto-height"|"fixed")`
> sets text shape auto-sizing behaviour. `setConstraints(id, {h, v})` sets horizontal and/or
> vertical pinning constraints on any shape — values are validated against Penpot's own enums
> (`constraints-h` ∈ `left|right|leftright|center|scale`; `constraints-v` ∈ `top|bottom|topbottom|center|scale`).
> Both emit `:mod-obj` changes via `pcb/update-shapes` and are schema-validated before commit.

> **Phase 1c-3 (`pp` CLI) complete:** `bin/pp.mjs` is implemented with `run` and `scene`
> subcommands. `npm run test:cli` is wired into `npm run verify` as the final layer.

---

## `pp` CLI

A shell-friendly command-line interface that drives `WorkingCopy` operations from terminals
and CI pipelines. Each invocation is self-contained (checkout → edit → commit in one shot).

### Running the CLI

```bash
# From headless-core/ directly (no install step):
node bin/pp.mjs <cmd> [args]

# Or link once to get `pp` on $PATH:
cd headless-core && npm link
pp <cmd> [args]
```

### Subcommands

#### `pp run <fileId> -e "<script>"`

One-shot edit: checkout the file, run the JS script against the working copy, validate, and
commit. The script has the same `wc` globals as the MCP `script` tool.

```bash
# Add a board and commit it:
pp run abc123 -e "
  const b = wc.addBoard({ x: 0, y: 0, width: 400, height: 300, name: 'Hero' });
  wc.addRect({ x: 20, y: 20, width: 200, height: 100, parentId: b,
               fills: [{ fillColor: '#3366ff' }] });
  wc.closeBoard();
"
```

On success the new `revn` is printed to stdout. On validation or commit failure the process
exits non-zero.

#### `pp scene <fileId>`

Prints the full object map (`id → shape`) for the file as JSON to stdout, without making
any changes or committing.

```bash
pp scene abc123 | jq 'keys'
```

### Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `PENPOT_TOKEN` | Yes | — | Penpot access token (requires `enable-access-tokens` on the server). |
| `PENPOT_HL_BASE` | No | `http://localhost:9101` | Base URL of the Penpot instance. |

### MCP vs CLI

| | MCP tools | CLI (`pp`) |
|---|---|---|
| **Use case** | Interactive AI sessions | Shell scripts, CI |
| **State** | Stateful across tool calls | Self-contained per invocation |
| **Interface** | `checkout` / `script` / `commit` | `pp run` / `pp scene` |
| **Under the hood** | `WorkingCopy` | `WorkingCopy` (same API) |

### Test

```bash
npm run test:cli         # runs test/cli.test.mjs (requires penpot-hl at :9101)
```

This test is included in `npm run verify` as the final layer.
