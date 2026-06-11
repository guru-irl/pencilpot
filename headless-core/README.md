# headless-core — Penpot Headless SDK (Phase 0)

> **Status: Phase 0 complete.** Proof-of-concept that a geometry-complete board can be
> added to a real Penpot file purely headlessly — no browser, no plugin — by compiling
> Penpot's own `common/**.cljc` namespaces into a Node ESM bundle and POSTing changes
> through the `update-file` RPC.

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
`app.common.transit/encode` to produce the wire-ready transit+json string.

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
tagged values. Using `app.common.transit/encode` on the ClojureScript side means the
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

## What's next (Phase 1)

Phase 0 establishes the facade pattern: reuse `app.common.*` via shadow-cljs ESM
compilation for any operation that needs geometry or change-building parity.

Phase 1 builds on this with:

- **Working-copy / session manager** — `checkout → edit → commit` with `revn`/`vern`
  rebase and conflict handling.
- **Scripting runtime + helpers** — higher-level JS/TS API for common operations
  (add frame, add text, set fill, etc.).
- **MCP server + `pp` CLI** — expose headless ops as MCP tools and a command-line
  interface.
- **Skill integration** — Claude Code skill that drives the MCP server for design
  automation.

See:
- `docs/superpowers/specs/2026-06-11-penpot-headless-sdk-design.md`
- `docs/superpowers/plans/2026-06-11-penpot-headless-sdk-phase0.md`
