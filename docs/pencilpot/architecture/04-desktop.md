# 04 — Desktop Shell & `.pencil` Project Model (Phase 3)

Phase 3 adds the `pencilpot` CLI, the `.pencil` project model, and OS-level desktop
integration so double-clicking a `.pencil` file opens the editor directly.

---

## The `.pencil` Project Model

### Layout on disk

```
my-project/                 ← project root (a git repo)
├── my-project.pencil       ← JSON manifest
├── designs/
│   ├── home/               ← design dir (EDN store, see 01-runtime-store.md)
│   └── dashboard/
└── shared/                 ← shared library assets
```

### Manifest JSON shape (`<name>.pencil`)

```json
{
  "name": "my-project",
  "version": 1,
  "default": "home",
  "designs": [
    { "name": "home",      "path": "designs/home" },
    { "name": "dashboard", "path": "designs/dashboard" }
  ]
}
```

| Field | Meaning |
|---|---|
| `name` | Project name (matches the containing directory and the `.pencil` filename) |
| `version` | Schema version (currently `1`) |
| `default` | Name of the design that opens when no `--design` flag is given; set to the first design automatically |
| `designs` | Ordered list of design entries; `path` is relative to the project root |

### Store API (`pencilpot/store/project.mjs`)

| Export | Signature | What it does |
|---|---|---|
| `initProject` | `(root, name)` | Creates `<name>.pencil`, `designs/`, `shared/`, and a git repo; backward-compat: called with one arg it only creates `shared/` + git |
| `addDesign` | `(root, name)` | Creates `designs/<name>/`, appends to the manifest, sets `default` if not yet set; returns the design dir path |
| `readProject` | `(pencilPath)` | Parses a `.pencil` file; returns `{ root, name, designs: [{name, dir}], default }` |
| `resolveProject` | `(anyPath)` | Walks up from any path inside the tree (or accepts a `.pencil` file directly) until it finds the manifest; returns the same shape as `readProject`; throws if not found |
| `listDesigns` | `(root)` | Returns `[{name, dir}]` from the manifest; returns `[]` if no manifest |

---

## The `pencilpot` CLI (`pencilpot/bin/pencilpot.mjs`)

### Commands

```
pencilpot new  <name|dir>  [--design <d>]
pencilpot open <path.pencil|dir>  [--no-window]  [--port N]
pencilpot install-desktop
pencilpot uninstall-desktop
```

#### `new`

Scaffolds a new project:

1. Creates the directory (and any missing parents).
2. Calls `initProject(dir, name)` — writes `<name>.pencil`, `designs/`, `shared/`, `git init`.
3. If `--design <d>` is passed, also calls `addDesign(dir, d)`.

#### `open`

Opens a project in the editor:

1. Calls `resolveProject(path)` — works with a `.pencil` file, a project root directory, or
   any path inside the tree.
2. Spawns `runtime/server.mjs` with `PENCILPOT_PROJECT=<path.pencil>` and `PENCILPOT_PORT`.
3. Polls the server until it responds (up to 10 s).
4. Reads the default design's `manifest.edn` to extract the file UUID and constructs
   `http://localhost:<port>/#/workspace?team-id=…&file-id=<uuid>`.
5. In normal mode: launches `runtime/launch.mjs <url>` (chromeless app window).
6. In `--no-window` mode: skips the window; stays alive so the caller can interact with the
   HTTP server — useful for scripting and CI.
7. Propagates `SIGTERM`/`SIGINT` to the child server and exits cleanly.

#### `install-desktop` / `uninstall-desktop`

See the Desktop Integration section below.

---

## Desktop Integration

Files live in `pencilpot/desktop/`:

| File | Purpose |
|---|---|
| `pencilpot.xml` | freedesktop shared-MIME definition — registers `application/x-pencil` with glob `*.pencil` (weight 90) |
| `pencilpot.desktop` | XDG desktop entry template — `Exec=__PENCILPOT_BIN__ open %f`; the placeholder is replaced with the real bin path at install time |

### Install

`pencilpot install-desktop` does four things:

1. Makes the script executable (`chmod +x`) and symlinks it to `~/.local/bin/pencilpot`.
2. Copies `pencilpot.xml` to `~/.local/share/mime/packages/pencilpot.xml` and runs
   `update-mime-database ~/.local/share/mime`.
3. Renders the `.desktop` template (replaces `__PENCILPOT_BIN__`) and writes it to
   `~/.local/share/applications/pencilpot.desktop`, then runs `update-desktop-database`.
4. Registers `pencilpot.desktop` as the default handler via `xdg-mime default pencilpot.desktop application/x-pencil`.

### Uninstall

`pencilpot uninstall-desktop` removes the symlink, the MIME XML, and the `.desktop` file, then
re-runs both database update commands.

### How double-click works

1. The file manager resolves `*.pencil` → `application/x-pencil` via GIO (freedesktop MIME DB).
2. GIO looks up the default handler for that MIME type → `pencilpot.desktop`.
3. The `.desktop` entry's `Exec=` line is `pencilpot open %f`, where `%f` is the file path.
4. `pencilpot open` resolves the project, starts the runtime server, and opens the workspace
   URL in a chromeless app window via `runtime/launch.mjs`.

### Hyprland / xdg-mime gotcha

On Hyprland (and other compositors not recognised as a known DE), `xdg-mime query filetype`
falls back to `file` (libmagic) for content-type detection. libmagic content-sniffs `{}` as
`application/json` and ignores the freedesktop glob database, so it misreports `.pencil` files.

The canonical lookup used by actual file managers goes through GIO, which correctly returns
`application/x-pencil`. The glob weight is set to **90** in `pencilpot.xml` (above the default
of 50) to ensure it wins when multiple globs could match.

`verify-desktop.sh` uses `gio info` (not `xdg-mime query filetype`) for the MIME assertion,
matching what file managers actually do.

---

## Verification Script

`pencilpot/scripts/verify-desktop.sh` asserts five things and exits nonzero if any fail:

1. `pencilpot` is on `PATH`.
2. `*.pencil` → `application/x-pencil` (via `gio info`, or `xdg-mime` with `XDG_CURRENT_DESKTOP=GNOME` as fallback).
3. Default handler for `application/x-pencil` = `pencilpot.desktop`.
4. `~/.local/share/applications/pencilpot.desktop` exists.
5. The `Exec=` line in the installed `.desktop` file points at the real `pencilpot` binary.

The test runner (`run-tests.mjs`) runs this script as the **desktop smoke** tier. The tier is
LOUDLY skipped (not failed) when `pencilpot` is not on PATH or the `.desktop` file is not
installed — install first with `pencilpot install-desktop`.
