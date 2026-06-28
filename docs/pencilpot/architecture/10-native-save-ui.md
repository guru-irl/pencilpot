# 10 — Native Save UI & Workspace Header (Phase 4 · UI)

**Status:** Complete.
**Branch:** `pencilpot`
**Locations:** `frontend/src/app/main/data/pencilpot.cljs`,
`frontend/src/app/main/ui/workspace/left_header.{cljs,scss}`,
`frontend/src/app/main/ui/workspace/sidebar.scss`,
`frontend/src/app/main/ui/workspace/main_menu.cljs`,
`frontend/src/app/main/ui/workspace/sidebar/options/menus/typography.{cljs,scss}`
**Updated:** Phase 4 — save status, Ctrl/Cmd+S, rename, variable-axes polish, blank-text fix, save-race hardening.

---

## Overview

Pencilpot uses a **manual-save** model: `update-file` stages edits into an in-memory
working copy (`pencilpot/runtime/worktree.mjs`), and disk is written only on an explicit
`POST /pencilpot/save` (see [`08-working-copy-dirty-persistence.md`](08-working-copy-dirty-persistence.md)).
The user needs to (1) *see* whether the open design is dirty/saving/saved, (2) trigger a
save (Ctrl/Cmd+S or File > Save), and (3) rename the file.

Earlier pencilpot phases delivered this as **injected JavaScript** (a `liveUpdateScript`
string concatenated into the served page by `pencilpot/runtime/frontend.mjs`): a bottom-left
save badge, a toast, a tab-title dot, a Ctrl/Cmd+S handler and a `beforeunload` guard. This
phase **removes all of that** and re-implements the same behavior as **native Penpot
CLJS/SCSS**, driving Penpot's own workspace header and File menu.

**Hard constraint — NO INJECTION.** Every behavior below lives in upstream-shaped CLJS/SCSS
that compiles into the normal bundle. The only thing the runtime still injects is bootstrap
*config globals* already consumed natively (`penpotPublicURI`, `penpotFlags`, `pencilpotFile`);
the gstatic font-URL rewrite (`gfonts.mjs`) is a network proxy, not DOM injection. The full
injection inventory and teardown is in plan
[`2026-06-21-pencilpot-native-save-ui.md`](../../superpowers/plans/2026-06-21-pencilpot-native-save-ui.md).

**Mode signal.** All native pencilpot UI gates on `globalThis.pencilpotFile` being non-nil
(`app.main.data.pencilpot/enabled?`, `data/pencilpot.cljs:19-22`) — the *same* check
`routes.cljs` already uses. No new global is introduced, and **stock Penpot is untouched**:
every branch is `(when ^boolean pp-enabled? …)` and every CSS rule is scoped via
`:has(.file-name-pp)`.

---

## The Native Save Client — `data/pencilpot.cljs`

New namespace (commit `353cccaf21`, *native save client … replacing injected script*). It owns
all save state and side effects; the UI only reads its atoms.

- `enabled?` (`:19-22`) — `(some? (obj/get js/globalThis "pencilpotFile"))`.
- `status` (`:25`) — `(atom {:dirty false :saving false})`; the header `mf/deref`s it.
- `rename-request` (`:28`) + `request-rename!` (`:30-33`) — a monotonically bumped tick the
  File menu raises to ask the header to enter rename mode (decouples the menu from the header
  component).
- `save!` (`:51-78`) — no-op unless `:dirty` and not already `:saving`. POSTs `/pencilpot/save`
  wrapped in an `AbortController` with a **15 s timeout** so a never-settling fetch can't pin
  the badge at "Saving…" forever. On `ok` it optimistically clears `:dirty` (avoids an "Unsaved"
  flash); on failure it `js/alert`s; **every** outcome calls `reconcile-status!`.
- `reconcile-status!` (`:35-49`) — clears `:saving` **first**, then re-syncs `:dirty` from an
  authoritative `GET /pencilpot/status`. This is the fix for the save-race (below).
- `on-status` (`:80-85`) — SSE `status` handler; updates `:dirty`, but **ignores echoes while
  our own save is in flight** (`when-not (:saving @status)`).
- `on-reload` (`:87-99`) — SSE `reload` handler; an external CLI/MCP edit on disk raises a native
  `ntf/dialog` offering a reload (never auto-reloads — that would discard in-progress UI state).
- `start-client!` (`:101-130`) — idempotent (`started?` guard); opens `EventSource
  "/pencilpot/live"`, binds capture-phase **Ctrl/Cmd+S** (`preventDefault` + `save!`) and a
  **`beforeunload`** guard that warns when `:dirty`. Started from `app.main/init`.

### The save-race desync (hardening)

Two bugs were closed after review (`960afeedb2`, then `542618d32f`):

```
update-file (late edit) ──► worktree dirty=true ──► SSE status{dirty:true}
                                                          │  (suppressed: :saving guard)
manual save in flight ─────────────────────────────────► save! clears :dirty=false
                                                          ▼
                              badge shows "Saved" while working copy ≠ disk  ✗
```

`reconcile-status!` fixes this by clearing `:saving` **before** issuing the authoritative
`GET /pencilpot/status`, so the suppressed edit (and any later SSE echo) is recovered and the
indicator converges to disk truth on every path — ok, not-ok, network error, and timeout.

---

## The Workspace Header Status Subtitle — `left_header.cljs`

The header component reads the client atoms (`:41-43`): `pp-enabled?`, `pp-status`, `pp-rename`.
A `mf/with-effect [pp-rename]` (`:94-96`) enters file-name editing when the rename tick is bumped.

The file-name node carries `(stl/css-case :file-name true :file-name-pp pp-enabled?)` (`:118-119`)
so CSS can target pencilpot mode. Then the render branches by mode:

- **Stock Penpot** (`when-not pp-enabled?`, `:124-141`) — the original persistence-status icon
  widget is preserved verbatim.
- **Pencilpot** (`when pp-enabled?`, `:143-156`) — a two-element subtitle below the title: a
  colored **dot** + **text**, derived from the client status:

  ```clojure
  state (cond saving :saving dirty :unsaved :else :saved)
  ;; dot: stl/css-case :pp-save-dot true :pp-dot-saving/:pp-dot-unsaved/:pp-dot-saved
  ;; text: "Saving…" / "Unsaved changes" / "Saved"
  ```

Double-clicking the title (`start-editing-name`) or bumping `rename-request` opens an inline
`<input>` that emits `dw/rename-file` on blur/Enter.

### Dot color legend (`left_header.scss:109-119`)

| State | Class | Color |
|---|---|---|
| Unsaved | `.pp-dot-unsaved` | `#f5a623` (orange) |
| Saving  | `.pp-dot-saving`  | `#7b61ff` (blue) |
| Saved   | `.pp-dot-saved`   | `#2c7a3f` (green) |

---

## The `stl/css` vs `stl/css-case` Lesson (invisible-dot bug)

`stl/css` is a **compile-time macro** that hashes only **literal keyword** arguments into the
scoped class names. The dot originally computed its color class at runtime *inside* `stl/css`:

```clojure
;; BROKEN — the runtime (case state …) keyword is not a literal, so stl/css
;; silently DROPS it; the dot rendered with no background (invisible).
[:span {:class (stl/css :pp-save-dot (case state :saving :pp-dot-saving …))}]
```

Fix (`1aa8541444`): use **`stl/css-case`**, which takes **literal class keywords paired with
runtime boolean expressions**, so the correct hashed color class is emitted:

```clojure
[:span {:class (stl/css-case :pp-save-dot true
                             :pp-dot-saving  (= state :saving)
                             :pp-dot-unsaved (= state :unsaved)
                             :pp-dot-saved   (= state :saved))}]
```

This is the same pattern as `:file-name-pp` above. **Rule of thumb: any class chosen at
runtime must go through `stl/css-case` (literal keyword + runtime boolean), never `stl/css`.**

> **Two builds.** This bug surfaced alongside a stale CSS bundle. The SCSS→CSS step
> (`scripts/build-app-assets.js` `compileStyles`) is **separate** from the JS build
> (`clojure -M:dev:shadow-cljs release main worker`). Layout/dot/status rules only reach
> `main.css` after running the assets build — a frontend rebuild must run **both** steps
> (see [`02-frontend-build.md`](02-frontend-build.md)).

---

## Header Layout — stacked title without tab overlap

The pencilpot subtitle makes the file-name a **two-line, column** block, which overlapped the
LAYERS/ASSETS/TOKENS tabs. Fixed with CSS scoped entirely to `:has(.file-name-pp)` so stock
Penpot's single-row 52 px header is untouched (`a437f305ea`, `2695c42335`, `adee4f9bcf`,
`30f08ec8cd`, `960afeedb2`):

- `sidebar.scss:32-34` — `.left-settings-bar:has(.file-name-pp)` gives a **taller header
  grid-row** (`$s-64` instead of the default) so the status row stays inside the header band.
- `left_header.scss:20-22` — `.workspace-header-left:has(.file-name-pp)` top-aligns
  (`align-items: flex-start`).
- `left_header.scss:70-75` — `.file-name-pp` becomes `flex-direction: column; height: auto;
  overflow: visible`.
- `left_header.scss:80-82` — `.project-tree:has(.file-name-pp) .project-name { display: none }`
  hides the empty stock project-name row so the title sits at the top.
- `left_header.scss:91-93` — `.file-name-pp .file-name-label { width: 100% }`, **scoped** to
  pencilpot so stock's row layout (where a greedy 100% label would crowd the persistence widget)
  is untouched (this scoping was the `960afeedb2` CSS-leak fix).
- `left_header.scss:95-100` — `.pp-save-status` pulls the subtitle snug under the title with
  `margin-block-start: calc(-1 * $s-2)` (`30f08ec8cd`).

Net effect: title y28→y12, status bottom 67→51, tabs at 63 — no overlap.

---

## Variable-Axes Panel Polish — `typography.{cljs,scss}`

The variable-font axes editor (used by the SVG-native variable-font feature, see
[`06-variable-fonts.md`](06-variable-fonts.md)) was cramped and offered no axis hints.

- **Padding / alignment** (`57ef431419`, `adee4f9bcf`, `typography.scss:322-342`):
  `.variation-axis` gets `padding-inline-end: var(--sp-s)` and `gap: var(--sp-s)`
  (was `--sp-xs`); `.variation-axis-input` gets `text-align: right`, so each cell reads
  `LABEL        value`.
- **Axis tooltip** (`57ef431419`, `typography.cljs:464-483`): a new `axis-descriptions` map
  (`wght`→Weight, `wdth`→Width, `opsz`→Optical size, `ital`/`slnt`/`GRAD`/`ROND`) plus
  `axis-tooltip`, which builds e.g. `Width (wdth): 50–151, default 100` and degrades to
  `Name (tag)` when min/max/default are missing. Wired into the row `:title` at `:536`.

---

## File Menu — Save & Rename — `main_menu.cljs`

Native File-menu entries, filesystem-mode only (`when ^boolean pp-enabled?`, `:670, 700-712`):

- **Save** (`:705-706`) → `pencilpot/save!` (`on-pp-save`, `:672-675`).
- **Rename** (`:711-712`) → `pencilpot/request-rename!` (`:685-687`), which bumps the tick the
  header effect listens for.

---

## Blank-Text Fix — `db6d191a59`

A correctness bug that manifested in the UI: text shapes rendered **blank** after save+reopen,
and their font never resolved. Root cause was in the engine's EDN serializer
(`headless-core`): text `:position-data` entries are `Rect` **records** that carry extension
keys (`:text`/`:fills`/`:font-family`/`:font-size`/`:font-weight`/…) assoc'd onto the 8 geometry
fields — that is how the SPA transit-encodes them. The serializer's `canon` matched
`(grc/rect? x)` **before** the map branch and emitted every `Rect` via the compact
`#penpot/rect "x,y,w,h,…"` literal, which carries **only** the 8 geometry numbers. So on save
each position-data entry collapsed to a bare rect and all the text data was dropped; the import
path was unaffected, so the bug only appeared on the round-trip.

The fix preserves extension keys for `Rect` records that carry them. This is an engine
serialization fix — covered in depth alongside the persistence/position-data story in
[`08-working-copy-dirty-persistence.md`](08-working-copy-dirty-persistence.md) — noted here
because the visible symptom (blank workspace text) belongs to the UI surface.

---

## What stays "Saved" vs "Unsaved" (data source)

The dot reflects the runtime's **content-only dirty signature**: `update-file` marks the design
dirty *only when the staged content actually differs* from the last-saved content (`c6529229c9`),
so non-content SPA events (load, viewport, selection) no longer flip the badge to "Unsaved".
That logic lives in `worktree.mjs` and is documented in
[`08-working-copy-dirty-persistence.md`](08-working-copy-dirty-persistence.md); the header is a
pure consumer of `GET /pencilpot/status` and the `/pencilpot/live` SSE stream.

---

## Source map

| Area | File(s) | Commit(s) |
|---|---|---|
| Native save client (status/save!/SSE/Ctrl+S/beforeunload/rename) | `frontend/src/app/main/data/pencilpot.cljs` | `353cccaf21` |
| Save-race + abort-timeout hardening | `frontend/src/app/main/data/pencilpot.cljs` (+ `runtime/server.mjs`, `left_header.scss`) | `960afeedb2`, `542618d32f` |
| Header save-status subtitle (dot + text + rename) | `frontend/src/app/main/ui/workspace/left_header.cljs` | `a437f305ea` |
| `stl/css` → `stl/css-case` invisible-dot fix | `frontend/src/app/main/ui/workspace/left_header.cljs` | `1aa8541444` |
| Header stacking scoped via `:has(.file-name-pp)` | `left_header.scss`, `sidebar.scss` | `a437f305ea`, `2695c42335`, `adee4f9bcf`, `30f08ec8cd`, `960afeedb2` |
| Variable-axes padding/alignment + axis tooltip | `typography.cljs`, `typography.scss` | `57ef431419`, `adee4f9bcf` |
| File menu Save / Rename | `frontend/src/app/main/ui/workspace/main_menu.cljs` | `353cccaf21` (entries) |
| Blank-text serialize fix (UI symptom) | `headless-core` EDN serializer | `db6d191a59` |
| Dirty data source (content signature) | `pencilpot/runtime/worktree.mjs` | `c6529229c9` (see `08-…`) |
| Plan / injection teardown inventory | `docs/superpowers/plans/2026-06-21-pencilpot-native-save-ui.md` | — |

**No-injection invariant:** the runtime injects only `penpotPublicURI`, `penpotFlags`,
`pencilpotFile` (native bootstrap config). All save/rename/status behavior compiles from the
CLJS/SCSS above. STABLE SVG renderer throughout; render-wasm never enabled.
