# Pencilpot — a filesystem-native, local-first design IDE

**Status:** Design (umbrella spec). Each sub-project/phase below gets its own spec + implementation plan.
**Date:** 2026-06-12
**Branch:** `pencilpot` (forked from `feat/penpot-headless-sdk` @ `9168711af8`, which carries the headless engine + SDK).

---

## 1. Vision

Strip Penpot's entire SaaS layer — teams, projects, dashboard, auth, real-time collaboration, cloud storage — and turn the **designer itself** into a local, single-user, git-backed **IDE**.

- You **double-click a design** and the full Penpot canvas opens in a chromeless `--app` window.
- The **OS filesystem is the store**: designs live on disk as a git-friendly directory you can branch, diff, review, and merge.
- A **side terminal** runs an AI agent (default Claude Code) prebaked with our skills/instructions/MCP, wired into the **headless engine** and `pp` CLI.
- **No** login, **no** teams/projects, **no** collaboration server, **no** Postgres, **no** JVM at runtime.

It is to Penpot what a local code editor is to a cloud IDE: lean, file-native, version-controlled, AI-augmented.

## 2. Goals / Non-goals

**Goals**
- Reuse ~100% of Penpot's existing **designer UI** (canvas, panels, layer tree, tools) unmodified at the feature level.
- Filesystem-as-store with a **deterministic, diff-stable, git-native** on-disk format.
- **Cross-file shared libraries** via a `shared/` area, usable across multiple design files (first-class, not deferred).
- A lean local **runtime with no JVM and no database** — reuse the headless-core engine (Penpot's own `common` cljc).
- Integrated terminal + AI agent with the headless engine, `pp` CLI, and our knowledge prebaked.
- **First-class testing** and **first-class documentation** as definition-of-done in every phase.

**Non-goals (v1)**
- **Authentication / login of any kind.** No accounts, sessions, cookies, tokens, profiles, or login screen — it is a local single-user IDE. The auth/login *layer is removed entirely*, not stubbed-pretty, and the local server has zero auth.
- Real-time multi-user collaboration, presence, comments. Gone — not stubbed-pretty.
- Cloud accounts, sharing links, webhooks, billing, admin.
- Custom font *upload* management (bundled Google fonts only in v1).
- Server-rendered thumbnails/exports at scale (client-side or deferred).

## 3. Keystone insight (why this is feasible)

The frontend's **entire** backend dependency funnels through one chokepoint: `frontend/src/app/main/repo.cljs`'s `cmd!` (HTTP RPC, transit responses). If a local server speaks the same RPC contract for the **~12 commands the workspace actually needs**, the designer SPA runs essentially unmodified at the data layer.

We already implement the two hard commands in **headless-core**:
- `get-file` → hydrate transit file data into the in-memory model.
- `update-file` → apply `process-changes` and persist.

So the local server **is** headless-core's engine + filesystem persistence + RPC-shaped HTTP handlers + trivial stubs for the SaaS commands. **This pivot subsumes the old SDK Phase 3 (offline `.penpot` adapter).**

```
*.penpot dir ──(file assoc)──► penpot-open ──► local Node server (headless-core + FS)
                                                 │  serves stock designer SPA
   Chromium --app window ◄── http://localhost ───┤  RPC (~12 cmds) ↔ exploded git dir
   [ canvas + panels | xterm.js terminal ]        │  /pty ↔ node-pty ↔ AI agent
            └──────────── ws ───────────────────► │  auto `git init`
                          NO jvm · NO postgres · NO teams/auth/collab/cloud
```

## 4. Locked decisions

| Area | Decision |
|---|---|
| **Runtime** | No JVM, no DB. Lean local Node server reusing headless-core; FS is the store. |
| **On-disk format** | Exploded **git-native directory** — per-page / per-component JSON + manifest + `media/`. |
| **Workspace unit** | A **project folder** (git repo) holding design `.penpot` dirs + a `shared/` area of library `.penpot` dirs. |
| **Shared libraries** | First-class. Designs link libraries by **`{id, relative-path}`** in their manifest (path locates on disk; id matches `:component-file` refs). |
| **App shell** | Local web app: Chromium `--app` window, optionally installable as a **PWA**. No Electron/Tauri. |
| **AI agent** | Agent-agnostic, **default Claude Code**. Prebake `CLAUDE.md` + `AGENTS.md` + `.mcp.json` + `pp` on PATH. |
| **Git UX** | Terminal/CLI-driven. App auto-`git init`s and keeps saves diff-friendly; no in-canvas git UI in v1. |
| **Auth/login** | **Removed entirely.** No accounts, sessions, cookies, tokens, profiles, or login screen. The local server performs zero auth; the frontend's auth routes, login-redirect guard, boot-time profile fetch, and websocket-auth gate are all deleted. |
| **Frontend** | Strip dashboard/auth/collab routes + boot; repoint `cmd!`; boot straight to the designer. Keep ~100% designer UI. |

## 5. On-disk format

```
my-project/                       ← git repo root (the "workspace")
  home.penpot/                    ← a design file (exploded dir)
    manifest.json                   { id, name, version, page-order,
                                       libraries: [{id, path:"shared/brand.penpot"}, …] }
    pages/<page-id>.json            one file per page (pretty, deterministic)
    components/<comp-id>.json       file-local components
    media/<media-id>.<ext>          embedded media
  marketing.penpot/  …
  shared/
    brand.penpot/                 ← a shared library (exploded dir, is-shared)
      manifest.json   components/*.json   tokens.json   media/*
    icons.penpot/  …
  .git/
```

**Requirements**
- **Deterministic serialization**: stable key ordering, stable id placement, normalized number formatting — so a one-shape edit yields a one-file, minimal diff.
- **Round-trip fidelity**: `load(serialize(file)) == file` for the in-memory model (validated by tests).
- **Split granularity** tuned so common edits localize to a single page/component file.
- Hydrate-on-load and apply-changes→write-on-save go through headless-core's existing model.

## 6. Shared-library model

- A shared library is itself a `.penpot` dir (Penpot models a "library" as a *file*) living in `shared/`; it can hold components, color/typography tokens, and media.
- A design's manifest `libraries: [{id, path}]` lists linked libraries. On open, the server loads each linked library dir and builds the runtime `libraries` map keyed by **file id**, which is exactly what cross-file component instances (`:component-file <id>`) resolve against.
- Editing a component in a library updates every design linking it (re-resolved on load; live-update within a session is a later enhancement).
- The designer's "add/remove library" UI is backed by **`link-file-to-library` / `unlink-file-from-library`** RPC commands implemented against the manifest.

## 7. Sub-projects

Each gets its own spec + implementation plan.

- **L · Local runtime server** — Node HTTP server reusing headless-core. Serves the SPA and the workspace RPC commands from disk; resolves shared libraries; stubs teams/projects/profile/fonts/thumbnails. Hosts the `/pty` websocket. *(absorbs SDK Phase 3)*
- **S · Exploded git-native store** — deterministic, diff-stable serializer/deserializer over headless-core's model; project + `shared/` layout; manifest + links; auto `git init`.
- **F · Frontend strip & repoint** — **delete the entire auth/login layer** (the `/auth/*` routes, the login-redirect guard in `routes.cljs`, the boot-time `get-profile`/`get-teams` fetch in `main.cljs`'s `initialize`, the `is-authenticated?` websocket gate) plus the dashboard and collab routes; repoint `cmd!`; boot straight into the workspace; treat the single local user as implicit (no profile object). Keeps ~100% of the designer UI.
- **D · Desktop packaging** — `--app` launcher, `*.penpot` OS file association, open-file/open-project flow, optional PWA manifest.
- **T · Integrated terminal + AI** — xterm.js panel + node-pty in the server; prebaked working dir (`CLAUDE.md` + `AGENTS.md` + `.mcp.json` → headless engine, `pp` on PATH); auto-launch `$PENPOT_AI_AGENT` (default `claude`).

## 8. Phasing (risk-first)

- **Phase 0 · Viability spike** — serve the *stock, unmodified* frontend from a local server; hand-feed the ~12 RPC commands for **one real file** off disk; confirm the canvas loads and one edit round-trips to disk. Single-file. **Everything hinges here.**
- **Phase 1 · Runtime + store (L + S)** — real RPC server + exploded format + git init + the project/`shared/` layout. Library *resolution* + `link/unlink` is a called-out milestone within this phase. Edits persist as readable diffs.
- **Phase 2 · Frontend strip (F)** — direct-to-designer, lean build, SaaS UI gone.
- **Phase 3 · Desktop shell (D)** — double-click → `--app` window; PWA option; file association.
- **Phase 4 · Terminal + AI (T)** — side panel + prebaked agent env + headless/CLI wiring.
- **Phase 5 · Lean audit** — delete dead SaaS code, perf, packaging, final docs pass.

## 9. Cross-cutting disciplines (every phase's definition-of-done)

**Testing (first-class, non-negotiable).** A first-class, tiered test suite (unit / integration / e2e) with a one-command runner, preflight + loud skips, and a coverage matrix — mirroring the headless-core suite, with no silent gaps. **Every change in every phase ships with tests that prove the change works correctly.** No code lands without a test demonstrating its behavior; a phase is not "done" until its tests are green and its coverage row exists. New RPC commands, the serializer round-trip, library resolution, the terminal/PTY bridge, and the frontend boot path each get explicit tests.

**Documentation (first-class).**
- **Architecture docs** in `docs/pencilpot/architecture/` — living system docs (chokepoint/runtime, store-format spec, shared-library model, shell, terminal/AI), with diagrams; updated each phase.
- **Per-changefile docs** — every file pencilpot creates or materially changes gets a doc entry (purpose / interface / dependencies), kept in sync as part of each change.
- **README** — top-level update explaining the pencilpot vision and how it diverges from upstream Penpot.

**Commit hygiene.** Author `Gurupungav Narayanan <28506515+guru-irl@users.noreply.github.com>`; no Claude attribution/mentions anywhere.

## 10. Top risks

1. **Frontend-vs-handrolled-RPC fidelity** (transit response shapes, feature flags, expected fields) — mitigated by the Phase 0 spike before any stripping.
2. **Diff-stable serialization** of shape trees (ordering, number formatting, split granularity) — core of sub-project S; validated by round-trip + minimal-diff tests.
3. **Cross-file component resolution** correctness (referential integrity across linked libraries) — validated against headless-core's component machinery.
4. **Canvas / WASM render** under a plain Chromium `--app` window — low (it's Chromium); confirmed in Phase 0.

## 11. Open questions (resolve during per-phase specs)

- Exact split granularity for `pages/` (whole page vs per-frame) to minimize diffs without fragmenting.
- Whether library edits should hot-update open designs in-session or only on reload (v1: on reload).
- Media dedup/storage across designs sharing assets (content-addressed vs per-file copy).
- PWA file-handler reliability vs the `--app` + file-association path as the primary open mechanism.
