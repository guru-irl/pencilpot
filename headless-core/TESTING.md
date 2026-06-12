# Penpot Headless SDK — Test Suite

A tiered, tagged test suite for the headless (browserless) Penpot editing SDK,
its MCP server, and its CLI. One command runs everything with a clean summary.

## How to run

```bash
npm test                # auto: unit always; live tiers if penpot-hl :9101 is up, else SKIPPED+warned
npm test -- --unit      # unit tier only (fast, no network)
npm run test:live       # require live; FAIL preflight if :9101 is down (don't skip)
```

Tier-by-tier (bypassing the runner):

```bash
npm run test:unit         # session + facade + script  (no network)
npm run test:integration  # workingcopy.roundtrip + roundtrip  (LIVE :9101)
npm run test:e2e          # mcp-server + cli  (LIVE :9101)
```

### Prerequisites

1. **Build artifact** — `target/headless/penpot.js`. The runner builds it
   automatically if missing (`npm run build`, which needs Clojure + shadow-cljs).
2. **penpot-hl up on :9101** — the live tiers talk to a self-hosted Penpot.
   ```bash
   cd /mnt/data/src/penpot
   docker compose -p penpot-hl \
     -f infra/penpot-hl/docker-compose.yaml \
     -f infra/penpot-hl/docker-compose.override.yaml up -d
   # wait for http://localhost:9101 to return 200
   ```
   (Use `penpot start` if you have the helper wired up.) **Never** :9001 — deleted.
3. **`infra/penpot-hl/test-env.json`** — `{ token, fileId, projectId }`. Created
   once by `node test/setup-env.mjs` against a running penpot-hl.

The runner's PREFLIGHT probes `http://localhost:9101` (3s timeout) AND checks for
`test-env.json`; both must succeed to set `LIVE_AVAILABLE`. When unavailable in
default mode, the live tiers are LOUDLY skipped and **not** counted as passed —
a skip is never mistaken for green (the summary screams it, exit stays 0).

## Tiers

| Tier          | Network | Files                                                   | What it proves |
|---------------|---------|---------------------------------------------------------|----------------|
| `unit`        | none    | `session.test.mjs`, `facade.test.mjs`, `script.test.mjs`| The CLJS engine builds geometry-complete changes and structurally-valid files; the JS script sandbox works. Fast, always runnable. |
| `integration` | LIVE    | `workingcopy.roundtrip.test.mjs`, `roundtrip.test.mjs`  | checkout → edit → commit actually persists to a real Penpot server, which validates referential integrity on `update-file`. |
| `e2e`         | LIVE    | `mcp-server.test.mjs`, `cli.test.mjs`                   | The MCP server tools and the `pp` CLI drive the full flow end-to-end against :9101. |

**The live tiers are the real integrity check.** The schema-level `validate()`
(used in the unit tier) is *structural only* — it confirms shapes have the right
fields/geometry, but only the server's `update-file` enforces full referential
integrity (component refs, copy `shape-ref`, token libs, etc.). A unit test that
passes `validate()` is necessary but not sufficient; the integration/e2e commit
is what proves an edit is truly valid.

Live files run with `--test-concurrency=1` (serialized) because they all share
the single penpot-hl `fileId`; running them in parallel races on object counts.

## Capability → Test matrix

Every SDK capability has at least one tier covering it. Live coverage (where the
server validates) is the authoritative one; unit coverage is the fast structural gate.

| Capability             | unit (`session.test.mjs` unless noted)        | integration (LIVE, server-validated)                       |
|------------------------|-----------------------------------------------|------------------------------------------------------------|
| `addBoard`             | "session adds a board and a nested rect…"     | "checkout -> add board+rect -> commit -> persists"         |
| `closeBoard`           | "session adds a board and a nested rect…" (calls `closeBoard`) | "checkout -> add board+rect -> commit -> persists" |
| `addRect`              | "session adds a board and a nested rect…"; "addRect honors parentId…" | "checkout -> add board+rect -> commit -> persists" |
| `addEllipse`           | "addEllipse creates a valid circle shape"     | "add ellipse persists as circle"                           |
| `addText`              | "addText creates a valid text shape…"         | "add text persists with content"                           |
| `setFlexLayout`        | "setFlexLayout arranges children in a row"    | "flex layout arranges + persists"                          |
| `setGridLayout`        | "setGridLayout arranges children into a 2-column grid" | "grid layout arranges + persists"                 |
| `setGrowType`          | "setGrowType changes a text shape's grow-type"| (structural; exercised via text shapes)                    |
| `setConstraints`       | "setConstraints sets horizontal + vertical constraints" | "constraints persist"                            |
| `addColorToken` + `tokens()` accessor | "addColorToken creates a token set + color token" (asserts `tokens()`) | "color token persists" (re-checkout + `tokens()` round-trip) |
| `createComponent`      | "createComponent promotes a board to a main component" | "promote board to component persists (server validates)" |
| `instantiateComponent` | "instantiateComponent creates a copy of a component" | "instantiate a component copy persists (server validates)" |
| `getShape` / `objects` | "getShape returns a single shape by id; objects returns the full map" | (objects map asserted throughout via persisted reads) |
| `validate`             | asserted in nearly every unit test (`validate() === []`) | asserted before every commit                          |
| `pendingChanges`       | "session adds a board…"; "clearChanges resets recorded changes" | "checkout -> … " (asserts `pendingChanges().length`) |
| `checkout` / `commit` / `discard` (roundtrip) | `facade.test.mjs` (`buildAddBoardChange`); `clearChanges` test simulates commit | every integration test does checkout→commit; discard covered in e2e (MCP `discard`) |
| MCP server tools (`checkout`/`script`/`scene`/`validate`/`commit`/`status`/`discard`) | — | **e2e** `mcp-server.test.mjs`: "tools/list exposes…", "checkout -> script -> validate -> commit persists", "status reports pending + revn; discard resets" |
| CLI (`bin/pp.mjs`: `run`, `scene`) | —                            | **e2e** `cli.test.mjs`: "pp run: checkout -> script -> commit persists", "pp scene: prints object map without committing" |

Explicitly confirmed to each have a row (no gaps): `addEllipse`, `setGridLayout`,
`setGrowType`, `setConstraints`, `addColorToken`, `createComponent`,
`instantiateComponent`.

### Tests added to close gaps

- **`getShape` / `objects`** had no dedicated test → added unit test
  *"getShape returns a single shape by id; objects returns the full map"*
  (`session.test.mjs`).
- **MCP `status` and `discard`** were only existence-checked in `tools/list` →
  added e2e behavioral test *"status reports pending count + revn; discard
  resets the working copy"* (`mcp-server.test.mjs`), which asserts `status`
  reflects pending edits and that after `discard` further tool calls error with
  "No file checked out".

## Other scripts

- `npm run build` / `npm run watch` — shadow-cljs release/watch of the `headless` target.
- `npm run test:engine` — runs Penpot's own common geometry + changes CLJS suite as a parity gate (`scripts/test-engine.mjs`). Heavy; not part of `npm test`.
- `npm run sanity` — ad-hoc smoke script.
- `npm run verify` — alias of `npm test` (the runner).
