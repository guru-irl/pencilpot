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

This runs four layers in sequence; any failure stops the chain:

| Script | What it checks |
|---|---|
| `npm run build` | shadow-cljs compiles `src/app/headless/core.cljs` (+ all `app.common.*` deps) to `target/headless/penpot.js` with 0 warnings. |
| `npm run test:unit` | Node built-in test runner executes `test/session.test.mjs` and `test/facade.test.mjs`. Covers the `HeadlessSession` state machine (setup-shape + process-changes in-process) and the `buildAddBoardChange` / `buildAddBoardBody` facade exports. No network required. |
| `npm run test:engine` | `scripts/test-engine.mjs` loads Penpot's own `cljs.test`-compiled common suites via the built bundle and runs every `deftest` in `common-tests.geom.*`, `common-tests.types.*`, and `common-tests.files.*`. These are Penpot's upstream unit tests — ~14 000+ assertions — running against the exact compiled code the headless SDK uses. A failure here means a Penpot-engine regression, not an SDK bug. No network required. |
| `npm run test:roundtrip` | `test/workingcopy.roundtrip.test.mjs` hits the live `penpot-hl` instance (port 9101). It calls `checkout`, adds a board and a rect, calls `validate`, calls `commit`, then re-fetches the file and asserts both shapes persist with correct geometry. Reads credentials from `infra/penpot-hl/test-env.json`. |

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
npm run build          # compile only
npm run test:unit      # unit (no network)
npm run test:engine    # engine parity gate (no network)
npm run test:roundtrip # live round-trip (penpot-hl must be up)
```

---

## What's next (Phase 1b deferrals)

The following are deliberately out of scope for Phase 1a:

- **Text shapes** — `addText()` needs DOM-measured `position-data` (per-glyph
  layout metrics) which requires a browser or headless Chromium. Not available in
  the pure Node runtime.
- **Flex / grid reflow** — `app.common.types.shape.layout` reflow calls are
  implemented in `app.common.*` but the integration into the headless session (auto
  layout propagation on commit) is deferred.
- **`script(js)` sandbox** — user-supplied JS snippets evaluated inside the
  working-copy session.
- **`pp` CLI** — a command-line interface that drives `WorkingCopy` ops from shell
  scripts and CI pipelines.
- **MCP server** — exposes headless ops as MCP tools consumable by Claude Code.
- **Claude Code skill** — a `/penpot-headless` skill that drives the MCP server for
  AI-assisted design automation.
- **Golden dump-file snapshots** — deterministic `get-file` response fixtures for
  offline regression testing, eliminating the `penpot-hl` dependency from
  `test:roundtrip`.

See:
- `docs/superpowers/specs/2026-06-11-penpot-headless-sdk-design.md`
- `docs/superpowers/plans/2026-06-11-penpot-headless-sdk-phase0.md`
