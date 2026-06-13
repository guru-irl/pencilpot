# Pencilpot Phase 3 — `.pencil` Project Model + Desktop Integration (D)

**Status:** Design spec (sub-project D, under the umbrella `docs/superpowers/specs/2026-06-12-pencilpot-design.md`). Feeds an implementation plan.
**Date:** 2026-06-13 · **Branch:** `pencilpot` · **Fork:** `guru-irl/pencilpot`
**Builds on:** Phase 2 (self-contained own bundle + auth deleted, DONE).

---

## 1. Goal

Double-click a project to open the designer. Since Linux can't hijack double-click on a *directory*, the openable unit is a single **`<name>.pencil`** manifest file. Deliver: the `.pencil` project model, a `pencilpot` CLI, and host desktop integration (MIME + `.desktop` handler) so `*.pencil` opens an `--app` window at the designer. **Install on this machine.**

## 2. On-disk model (adjusts Phase 1 naming)

```
my-project/                  ← git repo (the project)
  my-project.pencil          ← double-click this. JSON manifest (MIME application/x-pencil)
  designs/
    home/                    ← exploded EDN design (manifest.edn, pages/*.edn, components/*.edn, media/)
    marketing/ …
  shared/
    brand/                   ← shared library (same exploded shape)
  .git/
```

- **`.pencil` is JSON** (Node-read by the runtime/CLI, not engine data): `{ "name", "designs": [{"name","path":"designs/home"}], "default": "home", "version": 1 }`.
- **Why `.pencil` not `.penpot`:** `.penpot` is Penpot's real binary export — a distinct extension avoids any clash.
- Designs move from Phase 1's `<name>.penpot/` dirs to `designs/<name>/` subfolders; the exploded-EDN shape inside is unchanged. Shared-library links in a design's `manifest.edn` `:libraries` use paths like `shared/brand` (no suffix).

## 3. Store/runtime changes

- `pencilpot/store/project.mjs`: `initProject(root, name)` → git init + `designs/` + `shared/` + write `<name>.pencil`; `readProject(pencilPath)` → parse manifest → `{root, name, designs:[{name, dir}], default}`; `resolveProject(path)` → from a `.pencil` file or any path inside, find the project (walk up to the `.pencil`); `listDesigns` reads the manifest (fallback: scan `designs/`). `writeDesign(dir, parts)`/`readDesign(dir)` unchanged (operate on a `designs/<name>/` dir).
- `pencilpot/runtime/server.mjs`: accept `PENCILPOT_PROJECT=<.pencil or dir>`; resolve the project; open its `default` design (or `PENCILPOT_DESIGN=<name>`); serve get-file from that design dir; resolve `shared/` libraries from the project root.
- Adapt `pencilpot/scripts/seed-from-hl.mjs` + the e2e to the new layout (project with `designs/home/`).

## 4. CLI (`pencilpot`)

A Node bin `pencilpot/bin/pencilpot.mjs` (installed on PATH as `pencilpot`):
- `pencilpot new <name> [dir]` — scaffold a project (git init, `<name>.pencil`, `designs/`, `shared/`); optionally seed an empty design.
- `pencilpot open <path.pencil|dir>` — start the runtime for that project + open an `--app` window at the designer (reuse the Chromium `--app` pattern). If a runtime is already serving it, focus the window.
- `pencilpot import <file.penpot> [project]` — import a real Penpot binary export into a design (via the engine: hydrate → serializeStore → writeDesign). *(stretch; include if cheap)*
- `pencilpot install-desktop` / `uninstall-desktop` — register/remove the MIME + `.desktop` handler.

## 5. Desktop integration (install on host)

- **MIME:** `application/x-pencil` with glob `*.pencil` → `~/.local/share/mime/packages/pencilpot.xml`, then `update-mime-database ~/.local/share/mime`.
- **Handler:** `~/.local/share/applications/pencilpot.desktop` → `Exec=pencilpot open %f`, `MimeType=application/x-pencil;`, `StartupWMClass=...` for the `--app` window; then `update-desktop-database ~/.local/share/applications` + `xdg-mime default pencilpot.desktop application/x-pencil`.
- **Result:** double-click `my-project.pencil` in the file manager → `pencilpot open` → runtime + `--app` window at the designer.
- Mirrors the existing `~/.local/bin/penpot` launcher conventions (see [[penpot-running-locally]]); host is CachyOS/Arch.

## 6. Testing (first-class)

- **unit/integration:** `.pencil` manifest read/write; `initProject` creates the right layout + git; `resolveProject` from a nested path; runtime opens a project's default design (get-file from `designs/<name>/`); shared-lib resolution with the `shared/<lib>` path form.
- **CLI:** `pencilpot new` scaffolds a valid project (assert files + `git` repo + a valid `.pencil`); `pencilpot open` starts the runtime + serves the design (headless: assert the server answers, without requiring the GUI window).
- **e2e:** the existing Playwright suite, retargeted to a `pencilpot new`-created project seeded from the hl file, still renders + edits.
- **desktop install:** a verification script asserting the MIME is registered (`xdg-mime query default application/x-pencil` → `pencilpot.desktop`) and `xdg-mime query filetype <f>.pencil` → `application/x-pencil`.

## 7. Risks

1. **Model migration churn** — moving designs to `designs/<name>/` + the `.pencil` manifest touches Phase 1 store/runtime/seed/e2e; mitigated by keeping `read/writeDesign` unchanged and adapting only project resolution, with the e2e as the guard.
2. **Desktop env specifics** — xdg-mime/update-desktop-database behavior on CachyOS; verification script confirms registration. The `--app` window relies on a Chromium-class browser (present).
3. **Double-click reliability** — file managers cache MIME associations; the install runs `update-mime-database`/`update-desktop-database`; document a re-login if the file manager caches.

## 8. Decisions locked

- Openable unit = `<name>.pencil` JSON manifest (MIME `application/x-pencil`); project = git repo with `designs/<name>/` + `shared/`. NOT `.penpot` (avoids clashing with Penpot's binary format).
- Phase 3 is **installed on this host** (MIME + `.desktop` + `pencilpot` CLI on PATH).
- Designer opens the project's `default` design in v1 (multi-design switching UI is later/Phase 5+).
