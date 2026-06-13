# Pencilpot — Architecture Docs

Living architecture notes for the Pencilpot programme. One doc lands per phase; each is updated as implementation evolves.

| Doc | Phase | Topic |
|---|---|---|
| [00-phase0-spike.md](00-phase0-spike.md) | Phase 0 | Viability spike: proxy/record/replay/serve design, chokepoint insight, RPC contract, disk store, GO decision |
| [01-runtime-store.md](01-runtime-store.md) | Phase 1 | EDN store format (project layout, manifest, per-page/component EDN, tokens-lib), engine API (serializeStore/loadStore/bumpRevn), runtime RPC handler table, shared-library resolution, revn lifecycle |
| [02-frontend-build.md](02-frontend-build.md) | Phase 2 (prereq) | Building the frontend bundle: render-wasm toolchain (Rust/Emscripten), app bundle (CLJS), config.js runtime injection |
| [03-frontend-strip.md](03-frontend-strip.md) | Phase 2 | Serve own bundle (static.mjs/frontend.mjs, config.js injection, window.pencilpotFile); deleted auth/dashboard/collab CLJS (main.cljs, routes.cljs, workspace.cljs); boot-to-workspace flow; pruned stubs |
| [04-desktop.md](04-desktop.md) | Phase 3 | `.pencil` project model (manifest JSON, `designs/`, `shared/`); `pencilpot` CLI (new/open/install-desktop/uninstall-desktop); MIME registration (`application/x-pencil`, glob weight 90); `.desktop` handler + double-click flow; Hyprland/xdg-mime gotcha; `verify-desktop.sh` |

More docs land here as Phase 4 (T · terminal + AI) is implemented.
