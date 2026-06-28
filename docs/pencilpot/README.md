# Pencilpot — Documentation

**Pencilpot** is a local, filesystem-native, **no-backend** Penpot design IDE. It serves the stock
Penpot designer SPA from a tiny Node runtime that satisfies the file RPCs from an on-disk, git-friendly
EDN store — no JVM, no Postgres, no auth, no collaboration server. All frontend changes are **native
CLJS/SCSS (no injection)**, and it renders on the **STABLE SVG renderer** (not wasm), which is what makes
SVG-native variable fonts and the lightweight viewer practical. Designs live in `.pencil` projects you
open from the CLI or by double-click.

This directory is the map. Start with the architecture tree; the companions cover the AI-dev surface.

## Architecture tree — [`architecture/`](architecture/)

Living, phase-numbered notes (read [`architecture/README.md`](architecture/README.md) for the index):

| Doc | Topic |
|---|---|
| [00](architecture/00-phase0-spike.md) | Viability spike: chokepoint insight (`repo.cljs cmd!`), RPC contract, GO decision |
| [01](architecture/01-runtime-store.md) | Runtime + EDN store: layout, engine API, the RPC handler table, revn lifecycle |
| [02](architecture/02-frontend-build.md) | Building the frontend from source: render-wasm toolchain + app bundle |
| [03](architecture/03-frontend-strip.md) | Serve own bundle; strip auth/dashboard/collab; boot straight to workspace |
| [04](architecture/04-desktop.md) | `.pencil` project model, the `pencilpot` CLI, MIME/`.desktop` integration |
| [05](architecture/05-terminal.md) | Integrated terminal: PTY↔WS bridge + xterm.js bottom dock |
| [06](architecture/06-variable-fonts.md) | SVG-native variable fonts: GSF axes, `map-variable`, position-data re-layout |
| [07](architecture/07-media-flow.md) | Media / image flow: id spaces, disk contract, upload/from-url/clone RPCs |
| [08](architecture/08-working-copy-dirty-persistence.md) | Working copy, content-only dirty signature, manual-save model |
| [09](architecture/09-local-profile-rpc-removal.md) | Local profile with zero network; profile-RPC removal |
| [10](architecture/10-native-save-ui.md) | Native (no-injection) save UI + workspace header changes |
| [11](architecture/11-view-mode.md) | Prototype view mode (play → viewer), boot warmup + read-session cache |
| [12](architecture/12-headless-engine-and-ai-dev.md) | Headless engine + the AI-dev MCP/SDK layer |
| [13](architecture/13-build-and-test.md) | Day-to-day build & test reality (the two frontend builds, the test runner, e2e) |

## Driving pencilpot with AI

- [`ai-dev-capabilities.md`](ai-dev-capabilities.md) — the **AI-dev capability matrix**: what the
  `penpot-headless` MCP / WorkingCopy SDK / CLI can and cannot do (WORKS / GAP), the canonical
  checkout → script → commit → save loop, env vars, and gotchas.
- [`../../pencilpot/skills/pencilpot/SKILL.md`](../../pencilpot/skills/pencilpot/SKILL.md) — the
  **pencilpot skill**: a reusable reference that teaches an agent to drive pencilpot well, grounded in
  the capability matrix above.
