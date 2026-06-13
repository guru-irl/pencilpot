# Pencilpot Phase 3 — `.pencil` Model + Desktop Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Open a project by double-clicking a `<name>.pencil` file. Add the `.pencil` project model (store/runtime), a `pencilpot` CLI, and host desktop integration (MIME + `.desktop`), installed on this machine.

**Architecture:** A project = git repo with `<name>.pencil` (JSON manifest) + `designs/<name>/` (exploded EDN) + `shared/`. The runtime opens a project's default design; the CLI scaffolds/opens projects and registers the desktop handler. Builds on Phase 1 store (`read/writeDesign` unchanged) + Phase 2 self-contained runtime.

**Tech Stack:** Node 22, the existing engine + runtime, xdg-mime/desktop tooling. Host: CachyOS/Arch.

---

## Scope
- **In:** `.pencil` JSON manifest + `designs/`/`shared/` layout; `project.mjs` rework; runtime opens project→default design; seed + e2e retargeted; `pencilpot` CLI (new/open[/import]); MIME + `.desktop` + install/uninstall; install on host + verify; tests + docs.
- **Out:** multi-design switching UI (later); terminal/AI (Phase 4); deleting dead namespaces (Phase 5). The built frontend bundle stays gitignored.

## Task D1: `.pencil` project model (store + runtime)
**Files:** `pencilpot/store/project.mjs`, `pencilpot/store/index.mjs`, `pencilpot/runtime/server.mjs`, `pencilpot/runtime/rpc.mjs`, `pencilpot/scripts/seed-from-hl.mjs`, `pencilpot/test/project.test.mjs`, e2e specs.
- [ ] **Step 1** — failing test `pencilpot/test/project.test.mjs`: `initProject(root,"acme")` creates `acme.pencil` (JSON `{name,designs,default,version}`) + `designs/` + `shared/` + `.git`; `readProject(<root>/acme.pencil)` → `{root,name,designs,default}`; `resolveProject(<root>/designs/home)` finds the project (walks up to the `.pencil`).
- [ ] **Step 2** — rework `project.mjs`: `initProject(root,name)` (git init + dirs + write `<name>.pencil`), `readProject(pencilPath)`, `resolveProject(anyPath)` (walk up to a `*.pencil`), `addDesign(root,name)` (mkdir `designs/<name>`, update the manifest), `listDesigns(root)` (from manifest). Keep `read/writeDesign(dir)` as-is. Update `index.mjs` exports. Run → pass.
- [ ] **Step 3** — runtime: `server.mjs` reads `PENCILPOT_PROJECT` (a `.pencil` path or project dir) + optional `PENCILPOT_DESIGN=<name>`; resolves the project, picks the default design dir (`designs/<default>`), passes it to `rpc.mjs` (get-file/update-file from that dir); shared-lib resolution uses the project root (`shared/<lib>`). Confirm `config.js`'s `pencilpotFile.fileId` = the open design's manifest id.
- [ ] **Step 4** — adapt `scripts/seed-from-hl.mjs`: `initProject(.scratch/proj,"demo")` + `addDesign` "home" + `writeDesign(.scratch/proj/designs/home, parts)`. Update the e2e runtime-start env (`PENCILPOT_PROJECT=.scratch/proj/demo.pencil`). Run the FULL e2e suite (`node run-tests.mjs`) → green with the new layout.
- [ ] **Step 5** — commit: `:sparkles: pencilpot: .pencil project model (manifest + designs/ + shared/)`.

## Task D2: `pencilpot` CLI + `--app` launcher
**Files:** `pencilpot/bin/pencilpot.mjs`, `pencilpot/runtime/launch.mjs` (reuse), `pencilpot/package.json` (`bin`), `pencilpot/test/cli.test.mjs`.
- [ ] **Step 1** — failing test `cli.test.mjs`: `pencilpot new <tmp>/acme` creates a project (assert `acme.pencil` valid JSON + `designs/` + `.git`); spawning `pencilpot open <tmp>/acme/acme.pencil` starts a runtime that answers `GET /api/.../get-file` (poll the port; kill after) — headless, no GUI assertion.
- [ ] **Step 2** — `bin/pencilpot.mjs`: subcommands `new <name|dir>` (initProject + optional empty design), `open <path>` (resolveProject → spawn the runtime server with env → wait-ready → `launch.mjs` opens the `--app` window; `--no-window` for headless/tests), `install-desktop`/`uninstall-desktop` (D3). Pick a free port; print the URL. `package.json` `"bin": {"pencilpot":"bin/pencilpot.mjs"}`.
- [ ] **Step 3** — run → pass (new scaffolds; open serves). Commit: `:sparkles: pencilpot: CLI (new/open) + --app launcher`.

## Task D3: Desktop integration + install on host
**Files:** `pencilpot/desktop/pencilpot.xml` (MIME), `pencilpot/desktop/pencilpot.desktop` (template), CLI `install-desktop`/`uninstall-desktop`, `pencilpot/scripts/verify-desktop.sh`.
- [ ] **Step 1** — `pencilpot/desktop/pencilpot.xml`: `application/x-pencil` with `<glob pattern="*.pencil"/>`. `pencilpot.desktop` template: `Exec=<abs pencilpot> open %f`, `MimeType=application/x-pencil;`, `Name=Pencilpot`, `StartupWMClass`, `Terminal=false`.
- [ ] **Step 2** — CLI `install-desktop`: copy the MIME xml → `~/.local/share/mime/packages/pencilpot.xml` + `update-mime-database ~/.local/share/mime`; render the `.desktop` (abs path to the installed `pencilpot`) → `~/.local/share/applications/pencilpot.desktop` + `update-desktop-database ~/.local/share/applications` + `xdg-mime default pencilpot.desktop application/x-pencil`. `uninstall-desktop` reverses it.
- [ ] **Step 3** — INSTALL on host: ensure `pencilpot` is on PATH (symlink `~/.local/bin/pencilpot` → `bin/pencilpot.mjs`, or `npm link` in `pencilpot/`), then run `pencilpot install-desktop`.
- [ ] **Step 4** — `scripts/verify-desktop.sh`: assert `xdg-mime query filetype <tmp>/x.pencil` = `application/x-pencil` AND `xdg-mime query default application/x-pencil` = `pencilpot.desktop` AND `pencilpot` resolves on PATH. Run it → all pass. (Note in output: a file-manager re-login may be needed for cached associations.)
- [ ] **Step 5** — commit: `:sparkles: pencilpot: desktop integration (application/x-pencil MIME + .desktop handler + install)`.

## Task D4: Tests + docs + push
**Files:** `pencilpot/run-tests.mjs`, `docs/pencilpot/architecture/04-desktop.md`, `pencilpot/README.md`.
- [ ] **Step 1** — add the new tiers/tests (project, cli) to `run-tests.mjs` unit/integration; keep e2e green; add a `desktop` smoke (run `verify-desktop.sh`, skip if not installed). Full `node run-tests.mjs` green; paste summary.
- [ ] **Step 2** — `docs/pencilpot/architecture/04-desktop.md`: the `.pencil` model, project layout, the CLI commands, the MIME/.desktop registration + how double-click works, the install/uninstall + verify. Update the architecture index + `pencilpot/README.md` (bin/, desktop/, the new project model).
- [ ] **Step 3** — full green; commit `:white_check_mark: pencilpot: Phase 3 tests + desktop docs`. Controller pushes the branch (to `guru-irl/pencilpot`).

## Self-Review (against the Phase 3 spec)
- `.pencil` JSON model + `designs/`/`shared/` layout (spec §2/§3): D1. ✓ · runtime opens project→default design (spec §3): D1. ✓ · CLI new/open (spec §4): D2. ✓ · MIME `application/x-pencil` + `.desktop` + install on host (spec §5): D3. ✓ · verification of registration (spec §6): D3 verify-desktop.sh. ✓ · seed+e2e retargeted (spec §3): D1 step 4. ✓ · tests + docs (spec §6): D4. ✓
- **Migration:** `read/writeDesign` unchanged; only project resolution + layout change; e2e is the guard each step.
- **Hygiene:** standard commit subjects, no Claude attribution; built bundle stays gitignored. `import` CLI subcommand is a stretch — include only if cheap, else note it deferred.
