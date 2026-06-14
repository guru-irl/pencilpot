# Pencilpot — Integrated terminal (Phase 4 · T)

A VS Code-style **bottom dock** in the workspace running a **real shell** (PTY) in
the open project directory, bridged to the browser over a WebSocket. Lets the user
run git / CLI / AI tools without leaving the design IDE. This is the terminal half
of Phase 4; AI-agent auto-launch is a later layer on top.

## Architecture

```
 browser (xterm.js)  ──WS──►  /pencilpot/terminal  ──►  node-pty(shell)  cwd = project root
        ▲  raw text frames (stdin/stdout)        │
        └────────────────────────────────────────┘
           NUL-prefixed JSON control frames (ready / exit / error / resize)
```

### Backend — `pencilpot/runtime/terminal.mjs`
- `attachTerminal(server, CONFIG)` attaches a `ws` `WebSocketServer({ noServer:true })`
  and routes the HTTP `upgrade` by pathname to `TERMINAL_WS_PATH` = `/pencilpot/terminal`.
- On connect it spawns a PTY via **node-pty** (`pty.spawn($SHELL || /bin/bash)`) with
  `cwd` = the project root (`resolveTerminalCwd(CONFIG)` — a `.pencil` path resolves to
  its containing dir, a project dir is used directly). The env gets `PENCILPOT=1`,
  `PENCILPOT_PROJECT`, `TERM`, `COLORTERM`.
- Streams bytes both ways; control messages are distinguished from shell I/O by a
  leading **NUL byte** (`\x00`) + JSON. Server → client: `ready` (pid/cwd/shell/pty),
  `exit` (code), `error`. Client → server: `resize` (cols/rows).
- Cleanup: the PTY is killed on socket `close`/`error` and on PTY `exit` (no leak).

### node-pty (native dep) outcome
node-pty's native addon **builds and loads cleanly** in this environment
(g++/python3 present); `pty.spawn` yields a true TTY. It is a `runtime/` dependency
(`runtime/package.json` + lockfile; installed into `runtime/node_modules`, which is
gitignored — cloners run `npm install`). If the native addon ever fails to load,
`createBackend()` **falls back** to a `child_process` shell with piped stdio
(line-based, no job control); the `ready` frame reports `pty:false` and the UI prints
a one-line degraded-mode notice. The terminal is therefore never non-functional.

### Multi-WS coexistence (gotcha)
The runtime attaches MORE THAN ONE WS endpoint to the same HTTP server (the
notifications stub `/ws/notifications` + this terminal). With the `{ server, path }`
form, `ws` installs competing `upgrade` listeners and the first one **rejects (HTTP
400)** upgrades for the other path. Fix: BOTH use `noServer:true` + an explicit
path-routed `handleUpgrade` (see `proxy.mjs attachWsStub` and `terminal.mjs`).

### Frontend — `frontend/src/app/main/ui/workspace/terminal.cljs` (+ `.scss`)
- `terminal-dock*` (`mf/defc`) owns the dock chrome (header, resize grip, close ✕)
  and drives **xterm.js** directly via JS interop (`["@xterm/xterm" :as xterm]`,
  `["@xterm/addon-fit" :as addon-fit]`), mirroring how Penpot consumes other npm libs
  (e.g. highlight.js). On mount it creates the Terminal + FitAddon, opens the WS, and
  forwards keystrokes/resize; on unmount it disposes both. A closed socket reconnects
  on Enter.
- Styling uses `(stl/css …)` + DS variables, matching the workspace dark surfaces.
  xterm's own base CSS is vendored into the **global** (non-modular) bundle at
  `resources/styles/common/dependencies/xterm.scss` (forwarded from
  `main-default.scss`) so `postcss-modules` does NOT hash the `.xterm*` class names.

### Toggle / integration points
- Layout flag **`:terminal`** added to `app.main.data.workspace.layout` (`valid-flags`
  + persistence mapping). The dock renders in `workspace.cljs` inside the `:workspace`
  section only `(when (:terminal layout) …)`, so the PTY session is created on open and
  torn down on close. Hidden by default.
- Toggles via: the **View menu → "Show/Hide terminal"** (`#file-menu-terminal`,
  `data-testid "terminal"`), or the **Ctrl+`** shortcut (`:toggle-terminal` in
  `workspace/shortcuts.cljs`), or the in-dock ✕ close button.

## Tests
- Backend: `pencilpot/test/terminal.test.mjs` (integration tier, 8 tests) — stands up
  an HTTP server + `attachTerminal`, drives it with a real `ws` client: ready frame,
  echo round-trip, project CWD (`pwd`), resize, and PTY-reaped-on-close (no leak).
- e2e: `pencilpot/e2e/terminal.spec.mjs` (headless-safe — no WebGL needed) — opens the
  workspace, reveals the dock via the View menu, types `echo pencilpot-terminal-ok`,
  asserts the marker appears in the xterm, and screenshots the dock
  (`test-results/terminal-dock.png`).

## Files
- `pencilpot/runtime/terminal.mjs` — PTY ↔ WS bridge (new)
- `pencilpot/runtime/server.mjs` — `attachTerminal(server, CONFIG)` wired in
- `pencilpot/runtime/proxy.mjs` — `attachWsStub` refactored to `noServer` path routing
- `pencilpot/runtime/package.json` (+ lock) — `node-pty` dep
- `frontend/src/app/main/ui/workspace/terminal.cljs` / `.scss` — dock UI (new)
- `frontend/src/app/main/ui/workspace.cljs` — renders the dock when `:terminal` set
- `frontend/src/app/main/data/workspace/layout.cljs` — `:terminal` flag
- `frontend/src/app/main/data/workspace/shortcuts.cljs` — `:toggle-terminal` (Ctrl+`)
- `frontend/src/app/main/ui/workspace/main_menu.cljs` — View-menu toggle item
- `frontend/resources/styles/common/dependencies/xterm.scss` (+ `main-default.scss`)
- `frontend/package.json` — `@xterm/xterm`, `@xterm/addon-fit`
- `pencilpot/test/terminal.test.mjs`, `pencilpot/e2e/terminal.spec.mjs`
