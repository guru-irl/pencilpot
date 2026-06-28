# Pencilpot

**A local, filesystem-native Penpot design IDE — no backend.**

Pencilpot serves the stock Penpot SPA designer from a tiny Node runtime that answers the file RPCs out of
an on-disk, **git-friendly EDN store**. There is no JVM, no Postgres, no auth, no realtime collaboration
server. Designs live in `.pencil` projects you open from the CLI or by double-clicking in your file
manager, and every change is a plain diff you can version, branch, and review like code.

Two principles shape the whole thing:

- **No injection.** Every frontend change is native Penpot **CLJS/SCSS**, compiled into our own bundle —
  nothing is monkey-patched at runtime.
- **STABLE SVG renderer, not wasm.** Pencilpot renders on Penpot's SVG path, which is what makes
  SVG-native variable fonts and the lightweight prototype viewer practical.

> 📚 Full architecture & guides live in [`../docs/pencilpot/`](../docs/pencilpot/) — start at its
> [README](../docs/pencilpot/README.md), then the phase-numbered
> [architecture tree](../docs/pencilpot/architecture/README.md).

---

## What's inside

| Capability | What it does | Deep dive |
|---|---|---|
| **EDN store + runtime** | Designs exploded to per-page / per-component EDN; a Node HTTP server answers file RPCs from disk | [01](../docs/pencilpot/architecture/01-runtime-store.md) |
| **Own bundle, stripped shell** | Serves a self-built frontend with auth/dashboard/collab removed; boots straight into the workspace | [03](../docs/pencilpot/architecture/03-frontend-strip.md) |
| **`.pencil` projects + desktop** | Project model, the `pencilpot` CLI, and OS integration (double-click `*.pencil` → editor) | [04](../docs/pencilpot/architecture/04-desktop.md) |
| **Integrated terminal** | PTY↔WS bridge + xterm.js dock inside the editor | [05](../docs/pencilpot/architecture/05-terminal.md) |
| **SVG-native variable fonts** | Per-family axis mapping (`wght`/`wdth`/`opsz`…), the `map-variable` CLI, position-data re-layout | [06](../docs/pencilpot/architecture/06-variable-fonts.md) |
| **Media / image flow** | Upload, from-URL, and clone of file media objects with a clean on-disk contract | [07](../docs/pencilpot/architecture/07-media-flow.md) |
| **Working copy + manual save** | In-memory edits, a content-only dirty signature, and an explicit flush-to-disk save | [08](../docs/pencilpot/architecture/08-working-copy-dirty-persistence.md) |
| **Local profile, zero network** | A local user with no auth and no profile RPCs leaving the machine | [09](../docs/pencilpot/architecture/09-local-profile-rpc-removal.md) |
| **Native save UI** | A no-injection save control + workspace header, wired to the dirty model | [10](../docs/pencilpot/architecture/10-native-save-ui.md) |
| **Prototype view mode** | Play a prototype in a separate, exitable viewer window (boot warmup + read-session cache) | [11](../docs/pencilpot/architecture/11-view-mode.md) |
| **Headless engine + AI-dev** | An MCP server + WorkingCopy SDK that let an AI author designs in code | [12](../docs/pencilpot/architecture/12-headless-engine-and-ai-dev.md) |

---

## Quick start

```bash
# 1. Scaffold a new project (includes a starter design + a git repo)
pencilpot new my-project

# 2. Open it — starts the runtime and opens the editor window
pencilpot open my-project/my-project.pencil

# 3. Register as a desktop app so double-clicking *.pencil opens the editor
pencilpot install-desktop
```

### CLI commands

| Command | Purpose |
|---|---|
| `new <name\|dir> [--design <d>]` | Scaffold a `.pencil` project (starter design + git repo) |
| `open <path\|dir> [--no-window] [--port N]` | Start the runtime and open the editor (`--no-window` for headless) |
| `import <file.penpot> [dir] [--project <dir>] [--name <design>]` | Import a `.penpot` export into a project |
| `designs <path\|dir>` / `set-default <path> <design>` | List designs / choose the default |
| `add-font <file>` · `add-variable-font <file>` · `add-google <Family> [--variable]` | Add custom / variable / Google fonts |
| `fonts <path\|dir>` | List added fonts + report missing families |
| `map-variable <project> --font-id <id> --map "Family=wdth:62.5,opsz:120" …` | Map families onto a variable font (rewrites EDN, re-layouts) |
| `retarget-fonts <project> [--family "Name=fontId"]` | Consolidate duplicate font ids |
| `install-desktop` / `uninstall-desktop` | Add / remove the OS desktop + MIME integration |

### Project layout

```
my-project/
├── my-project.pencil   ← JSON manifest (name, designs list, default)
├── designs/
│   └── home/           ← EDN store for one design (manifest + pages/ + components/)
└── shared/             ← shared library assets
```

---

## Driving Pencilpot with AI

Pencilpot ships a **headless engine** (the real Penpot CLJS data model compiled to an ESM bundle) with
two AI-facing surfaces over it:

- a **WorkingCopy SDK** (`headless-core/sdk/`) — `checkout → author → validate → commit`, in memory;
- an **MCP server** (`headless-core/mcp/server.mjs`) exposing `checkout` / `script` / `scene` / `validate`
  / `status` / `commit` / `discard` / `map_fonts_variable` to any MCP client.

The canonical loop is: boot a runtime, point the SDK at it (`PENPOT_HL_BASE`), then
`checkout → script → validate → commit` (in memory) and finally **`POST /pencilpot/save`** to flush to
disk — the one step that makes edits durable.

An AI can build boards, shapes, text, components, layouts, constraints, color tokens, and variable-font
maps; **place component instances** (`instantiateComponent`); and **wire click→navigate prototypes**
(`addInteraction`) that the view-mode viewer then plays. For the full WORKS / PARTIAL / GAP capability
matrix, exact options, and copy-pasteable invocations:

- 🧭 the agent skill — [`skills/pencilpot/SKILL.md`](skills/pencilpot/SKILL.md)
- 📋 the capability ledger — [`../docs/pencilpot/ai-dev-capabilities.md`](../docs/pencilpot/ai-dev-capabilities.md)

To activate the skill locally:

```bash
ln -s "$PWD/skills/pencilpot" ~/.pi/agent/skills/pencilpot
```

---

## Build & test

The frontend has **two independent build steps** (JS via shadow-cljs `release`, SCSS→CSS separately), and
the headless engine is its own `:headless` shadow-cljs build (`headless-core/target/headless/penpot.js`).
See [13 — build & test](../docs/pencilpot/architecture/13-build-and-test.md) for the full reality.

```bash
# Pencilpot product suite — unit + integration (no external backend needed):
node pencilpot/run-tests.mjs --unit

# All tiers (seeds a project, starts the runtime, runs Playwright):
node pencilpot/run-tests.mjs

# Or from the pencilpot/ dir:
npm test            # all tiers
npm run test:unit   # unit + integration only
npm run test:e2e    # requires penpot-hl :9101

# Headless engine suite — run SERIALLY (its backend-integration tests share one dev backend):
cd headless-core && node --test --test-concurrency=1 test/*.test.mjs
```

The tiered runner has four tiers — **unit** and **integration** never skip; **desktop** (a `gio`/`xdg-mime`
smoke check) and **e2e** (Playwright) LOUDLY skip when their prerequisites are absent.

---

## File map

### `bin/`
`pencilpot.mjs` — CLI entry point. Project commands (`new`/`open`/`import`/`designs`/`set-default`),
font commands (`add-font`/`add-variable-font`/`add-google`/`fonts`/`map-variable`/`retarget-fonts`), and
desktop integration (`install-desktop`/`uninstall-desktop`). Propagates `SIGTERM`/`SIGINT` to the child
server.

### `store/`
| File | Purpose |
|---|---|
| `store.mjs` | Explode/read a design to/from the EDN directory layout (`writeDesign` / `readDesign`); `writeDesign` is the single disk-write chokepoint |
| `project.mjs` | `.pencil` project model — init, add designs, resolve from any path, list designs |
| `fonts.mjs` | Custom-font store: add/list fonts, Google-font fetch, variable-axis metadata |
| `index.mjs` | Re-exports `writeDesign` + `readDesign` |

### `runtime/`
| File | Purpose |
|---|---|
| `server.mjs` | HTTP entry point. Resolves `PENCILPOT_PROJECT` / `PENCILPOT_DESIGN`; routes `/api/*` to the RPC layer and the `/pencilpot/{save,status,discard,live,terminal}` control routes; warms the engine at boot |
| `rpc.mjs` | RPC handler table: file get/update, libraries, media (upload / from-url / clone), the view-only bundle, and the in-memory working-copy/dirty/save lifecycle. Caches the open design's read-session by store identity |
| `static.mjs` / `frontend.mjs` | Serve the self-built frontend bundle; generate the runtime-injected `config.js` |
| `media.mjs` · `multipart.mjs` · `image-size.mjs` | Media decode/store helpers |
| `import-binfile.mjs` | Import a `.penpot` export into the EDN store |
| `worktree.mjs` | Working-copy + dirty-signature bookkeeping |
| `launch.mjs` | Programmatic launcher used by tests / the headless SDK |
| `stubs.mjs` + `stub-data/` | Replay recorded boot responses for the few workspace endpoints the SPA still calls |

### `skills/` · `e2e/` · `test/` · `scripts/` · `desktop/`
The agent skill (`skills/pencilpot/`), AI-dev + variable-font/view e2e harnesses (`e2e/ai/`, `e2e/vf/`),
the product test suite (`test/`), seeding/verification scripts (`scripts/`), and the freedesktop MIME +
`.desktop` templates (`desktop/`).

---

## License

Inherits Penpot's [MPL-2.0](https://www.mozilla.org/en-US/MPL/2.0). Pencilpot is a downstream,
local-first reworking of Penpot's frontend + a bespoke Node runtime; it is not affiliated with or
endorsed by the Penpot project.
