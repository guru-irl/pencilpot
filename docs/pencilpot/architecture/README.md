# Pencilpot — Architecture Docs

Living architecture notes for the Pencilpot programme. One doc lands per phase; each is updated as implementation evolves.

| Doc | Phase | Topic |
|---|---|---|
| [00-phase0-spike.md](00-phase0-spike.md) | Phase 0 | Viability spike: proxy/record/replay/serve design, chokepoint insight, RPC contract, disk store, GO decision |
| [01-runtime-store.md](01-runtime-store.md) | Phase 1 | EDN store format (project layout, manifest, per-page/component EDN, tokens-lib), engine API (serializeStore/loadStore/bumpRevn), runtime RPC handler table, shared-library resolution, revn lifecycle |
| [02-frontend-build.md](02-frontend-build.md) | Phase 2 (prereq) | Building the frontend bundle: render-wasm toolchain (Rust/Emscripten), app bundle (CLJS), config.js runtime injection |
| [03-frontend-strip.md](03-frontend-strip.md) | Phase 2 | Serve own bundle (static.mjs/frontend.mjs, config.js injection, window.pencilpotFile); deleted auth/dashboard/collab CLJS (main.cljs, routes.cljs, workspace.cljs); boot-to-workspace flow; pruned stubs |
| [04-desktop.md](04-desktop.md) | Phase 3 | `.pencil` project model (manifest JSON, `designs/`, `shared/`); `pencilpot` CLI (new/open/install-desktop/uninstall-desktop); MIME registration (`application/x-pencil`, glob weight 90); `.desktop` handler + double-click flow; Hyprland/xdg-mime gotcha; `verify-desktop.sh` |
| [05-terminal.md](05-terminal.md) | Phase 4 (T) | Integrated terminal: PTY↔WS bridge (`runtime/terminal.mjs`, node-pty, `/pencilpot/terminal`); multi-WS `noServer` path-routing fix; xterm.js bottom dock (`workspace/terminal.cljs`); `:terminal` layout flag + Ctrl+` + View-menu toggle; vendored xterm CSS into the global bundle |
| [06-variable-fonts.md](06-variable-fonts.md) | Phase 4 | SVG-native variable fonts: VF axis bug + fix, GSF per-family axes (`store/fonts.mjs`, `get-font-variants`), gfonts proxy + custom-fonts dir, the SVG text render path (`ui/shapes/text/*`, `util/text_svg_position.cljs`), CLI `map-variable`/`retarget-fonts`/`fonts`, position-data stripping for re-layout, why SVG over wasm |
| [07-media-flow.md](07-media-flow.md) | Phase 4 | Media / image flow: two id spaces (file-media-object vs storage-object), the disk contract (`media/<id>.<ext>` + `<id>.json` sidecar), `/assets/by-file-media-id` serve route, the `upload`/`from-url`/`clone` media RPCs, import re-keying, computeSig excluding media |
| [08-working-copy-dirty-persistence.md](08-working-copy-dirty-persistence.md) | Phase 4 | Manual-save model: `runtime/worktree.mjs` (`_store`, `stage`/`save`/`discard`, `_dirty`/`_savedSig`), the content-only dirty signature (`computeSig`), `store/edn.mjs` normalizers (`stripPositionData`/`stripRevn`/`normalizeEdnWhitespace`), never-persist position-data, the save gap |
| [09-local-profile-rpc-removal.md](09-local-profile-rpc-removal.md) | Phase 4 | Local profile with zero network: seeded local profile, `fetch-profile`/`refresh-profile`/`update-profile-props` gutted of RPC, plugin registry persisted to local state, onboarding/release-notes props local; verified zero profile RPCs |
| [10-native-save-ui.md](10-native-save-ui.md) | Phase 4 | Native (no-injection) workspace UI: save status / dirty indicator + Ctrl/Cmd+S + rename (`left_header.{cljs,scss}`, `data/pencilpot.cljs`), variable-axes polish, blank-text fix, save-race hardening, the `stl/css` vs `stl/css-case` runtime-keyword lesson |
| [11-view-mode.md](11-view-mode.md) | Phase 4 | Prototype view mode (play → viewer): `go-to-viewer` (separate exitable window), `viewer.cljs` `fetch-bundle`, the `get-view-only-bundle` runtime handler + `getViewerBundle` engine method, the two bugs fixed (new-window trap, 404), the boot warmup + read-session cache |
| [12-headless-engine-and-ai-dev.md](12-headless-engine-and-ai-dev.md) | Phase 4 | Headless engine (`headless-core/`): the `:headless` ESM build, `session.cljs` method table, `getFileResponse` vs `getViewerBundle`, the dataTransit-validation fix + baseline-diff commit gate; the AI-dev layer (`penpot-headless` MCP + WorkingCopy SDK driving a LOCAL design via `PENPOT_HL_BASE`) |
| [13-build-and-test.md](13-build-and-test.md) | Phase 4 | Day-to-day build & test reality: the two frontend builds (JS shadow-cljs release; SCSS→CSS), the headless `:headless` build, the `.mjs`-no-rebuild rule, the tiered `run-tests.mjs --unit` runner, and the `e2e/vf/*` + `e2e/ai/*` harness catalogue |

## Companion docs

- [../ai-dev-capabilities.md](../ai-dev-capabilities.md) — the AI-dev **capability matrix** (WORKS / GAP for the MCP/SDK/CLI surface), the canonical checkout→script→commit→save loop, env vars, and gotchas. Source of truth for doc `12`.
- [../../../pencilpot/skills/pencilpot/SKILL.md](../../../pencilpot/skills/pencilpot/SKILL.md) — the **pencilpot skill**: a reusable reference teaching an agent to drive pencilpot (the loop, the `wc` API, the gaps, the gotchas), grounded in the capability matrix.

Phase 4 is now substantially documented: variable fonts (`06`), media (`07`), persistence/dirty (`08`), local profile (`09`), save UI (`10`), view mode (`11`), the AI agent / headless engine (`12`), and build/test (`13`). Further docs land here as the programme evolves.
