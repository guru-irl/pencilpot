# pencilpot — handover

Date: 2026-06-15. Repo: `/mnt/data/src/penpot`, branch `pencilpot`, remote `github.com/guru-irl/pencilpot` (all work below is pushed; HEAD = `d55e3b90e0`).

This is a handover for a new agent picking up the work. It is deliberately blunt about what works, what doesn't, and the **one open bug** that I (the previous agent) could not get to reproduce in the user's real browser despite it passing every automated check.

---

## 0. TL;DR — the one thing still broken

**Variable-font axis edits don't visually update the canvas in the user's real browser.** The user selects a "Google Sans Flex" (variable font) text, changes an axis (Width / Optical / Grade / Roundness / **Slant**), and the glyphs don't change. Weight works.

What makes this maddening: **it is verified working in headless (swiftshader) Playwright** — driving the real UI (click the layer row to select the shape, type into the axis input, Enter), the canvas demonstrably changes (Slant clearly leans the glyphs; Width condenses/widens; pixel RMSE before/after is non-trivial). The data→render path is also provably correct (setting `:font-variation-settings` in the EDN and loading renders the right glyphs). **But the user reports it still doesn't work — even on a byte-identical fresh test project, on a confirmed-current build.**

So the gap is specifically: *something about how the user's real interaction or environment differs from headless Playwright UI-driving.* I could not close it. **This is the #1 thing to solve.** See §5.

---

## 1. What pencilpot is

A local, filesystem-native Penpot design IDE. No JVM, no Postgres, no auth, no cloud. Architecture:

- **Stock Penpot SPA frontend** (`frontend/`, ClojureScript) — unmodified-ish, built to `frontend/resources/public`.
- **Node runtime** (`pencilpot/runtime/`) — serves that frontend bundle + a backendless HTTP/RPC API. Replaces the whole Penpot backend. The SPA's only backend chokepoint (`repo.cljs cmd!` → `window.penpotPublicURI`) points at this runtime.
- **EDN git store** — a project is a git repo: a `<name>.pencil` JSON manifest + `designs/<name>/` exploded EDN (`manifest.edn`, `pages/*.edn`, `components/*.edn`, `media/`). Lossless, deterministic, git-diffable.
- **Headless engine** (`headless-core/`, ClojureScript compiled to `headless-core/target/headless/penpot.js`) — wraps Penpot's own `common` code to (de)serialize the store, apply changes, validate. Imported by the runtime.
- **render-wasm** (`render-wasm/`, Rust + Skia → wasm) — the canvas renderer. Prebuilt Skia binaries; built via emscripten.

Run it: `pencilpot open <path>.pencil` (CLI at `pencilpot/bin/pencilpot.mjs`, installed symlink at `~/.local/bin/pencilpot`). It spawns the runtime on a **random port** and opens a launcher window.

## 2. Build & run (IMPORTANT — these are the landmines)

- **Frontend cljs:** `cd frontend && corepack pnpm run build:app` (clean; clears the shadow cache — use this, not incremental `build:app:main`, to avoid cross-build chunk mismatch). Output → `frontend/resources/public/js/{main,shared,main-workspace,...}.js`.
- **Frontend CSS is SEPARATE:** `corepack pnpm run build:app:assets` → `frontend/resources/public/css/main.css`. `build:app:main` does **not** build CSS. If you change a `.scss`, you MUST run assets or the UI renders unstyled.
- **Headless engine:** `cd headless-core && corepack pnpm run build` (= `clojure -M:dev:shadow-cljs release headless`).
- **render-wasm:** `cd render-wasm && EMSDK_QUIET=1 source ~/emsdk/emsdk_env.sh && source ./_build_env && setup && build && copy_artifacts ../frontend/resources/public/js && copy_shared_artifact`. (The `build` wrapper hardcodes `/opt/emsdk`, which is wrong — emsdk is at `~/emsdk`.) Skia is prebuilt, so this is an incremental Rust+emscripten build. **Gitignored** outputs: `frontend/resources/public/js/render-wasm.{js,wasm}` and `frontend/src/app/render_wasm/api/shared.js`.
- The runtime serves all build outputs with `cache-control: no-store` (see `runtime/static.mjs`). Combined with the random port per launch, browser caching is mostly a non-issue — but historically a LOT of "my fix doesn't show up" was a build/cache/timezone confusion. The runtime now injects a **build stamp** into the page (console logs `pencilpot build <sha> · bundle <mtime>`, and `globalThis.pencilpotBuild` has `{commit, bundle, dist}`). NOTE: the bundle mtime is printed in **UTC** — don't mistake it for stale (01:32 IST == 20:02 UTC prior day).

## 3. Repo layout (the files that matter)

- `pencilpot/runtime/server.mjs` — HTTP server + routing (`/api/*`, `/assets/by-id/<id>` fonts, `/internal/gfonts/*`, `/pencilpot/live` SSE, `/pencilpot/terminal` WS, else static).
- `pencilpot/runtime/rpc.mjs` — get-file/update-file from the store + `encodeTransitFontVariants` (font variants incl. variable axes) + benign stubs for unknown SaaS RPCs (must return 200, never 4xx, or the SPA crashes).
- `pencilpot/runtime/static.mjs` — static file serving (`no-store`).
- `pencilpot/runtime/frontend.mjs` — injects `config.js` (publicURI, the live-update banner client, the build stamp).
- `pencilpot/runtime/live.mjs` — fs.watch the design dir; content-hash self-write suppression; SSE "external changes" banner (non-destructive; never auto-reloads).
- `pencilpot/runtime/terminal.mjs` — node-pty shell over WebSocket (Phase 4).
- `pencilpot/runtime/gfonts.mjs` — Google Fonts CSS2 proxy + `buildCSS2URL`.
- `pencilpot/store/fonts.mjs` — `readFonts`, `addFont`, `addVariableFont` (registers `custom-<slug>` VF with a 100–900 weight ramp sharing one file + `axes` metadata). `fvar.mjs` — dependency-free TTF fvar/name parser.
- `pencilpot/bin/pencilpot.mjs` — CLI: new/open/import/retarget-fonts/add-font/add-variable-font/add-google/fonts/…
- `headless-core/src/app/pencilpot/store.cljs` — the canonical-EDN serializer (`canonical-edn`, `read-edn`, geometry tagged-literals). Fast hand-rolled emitter (was `cljs.pprint`, ~3s → ~190ms).
- `headless-core/src/app/headless/session.cljs` — engine API (createSession, get-file/update-file, validate, retargetFonts, serializeStore).
- Frontend variable-font touch points: `common/src/app/common/types/text.cljc` (+`shape/text.cljc`) — `:font-variation-settings` attr; `frontend/src/app/render_wasm/api/{texts,fonts}.cljs` — wasm span serialization (RawTextSpan is 1412 bytes incl. variations) + font-id→uuid resolution; `render-wasm/src/shapes/text.rs` — `TextSpan::to_style` applies Skia `set_font_arguments`; `frontend/src/app/main/ui/workspace/sidebar/options/menus/typography.cljs(.scss)` — the "Variable axes" UI; `frontend/src/app/main/data/workspace/{texts,wasm_text}.cljs` — the live edit→repaint path.

## 4. What was done this session (all pushed)

Newest first (see `git log`):
- `d55e3b90e0` build stamp injection (diagnosis aid).
- `4a83402aa9` **repaint text on non-metric variable-font axis edits** (the attempted fix for the open bug — see §5).
- `dfcffa04b2`/`d391029bc2` **integrated terminal** (Phase 4): node-pty PTY ↔ WS ↔ xterm.js bottom dock, CWD = project dir. Toggle: **Ctrl+`** or View menu → "Show/Hide terminal". Backend test `pencilpot/test/terminal.test.mjs` (8/8). **This works and the user confirmed it.**
- `cf8ea25090` variable-font axes render fix + cold-boot font loading (see §5 root causes).
- `155ade7622` fixed an axis-panel crash (`::mf/wrap-props false` component was called with a cljs map → `on-change` undefined → the `$cljs$core$IFn$_invoke$arity$1$ of undefined` crash, which Penpot's `stale-asset-error?` heuristic *misreads* as a stale build and force-reloads — a giant red herring; see §6). Also: 2-column axis UI, `no-store` assets.
- `7cf0e68cfb` fast EDN serializer (3s→190ms) — fixed "every edit freezes / revn desync / edits revert".
- `bda37622d5`/`8793eb1a6c`/`72c3a7c30c`/`2a08f55e4a`/`fe17425422` — variable-font stack: model, render-wasm `set_font_arguments`, font registry axis metadata, the Stage-2 Google-Fonts/variable-font connector, UI.
- `15bc2e118f`/`07b3fc92db`/`2bb46a480f`/`d895cbd5aa` — live-update (fs-watch → non-destructive banner; content-hash self-write suppression).
- Earlier: feature-set as a SET, woff1-file-id fix, retargetFonts, getFileResponse :id string/uuid fix.

User's actual project: `/mnt/data/src/DefaultLauncher/DefaultLauncher.pencil` (an Android launcher repo with the design inside). Fonts: Google Sans Flex static instances (`custom-gsflex-*`, 5 families × 9 weights) **and** a registered variable font `custom-google-sans-flex` (one TTF, 100–900 ramp, axes wght/wdth/opsz/GRAD/ROND/slnt). NOTE: the frontend prefixes registered custom font-ids with another `custom-`, so the VF text's `:font-id` on disk is `custom-custom-google-sans-flex` (and statics are `custom-custom-gsflex-text`, etc.). The id resolver handles this (see §5).

## 5. THE OPEN BUG — variable-font live axis repaint (unsolved)

**Symptom (user, real browser):** select the VF text, change a non-weight axis → glyphs don't change. Weight changes do show.

**Root causes already found & fixed (these are real and committed):**
1. `cf8ea25090`: `normalize-font-id` (frontend `render_wasm/api/fonts.cljs`) ran `uuid/parse` on the slug after `custom-`; for non-UUID slugs (`custom-google-sans-flex`) it threw → fell back to `uuid/zero` (Source Sans Pro). So the text rendered as a *non-variable fallback* — weight "worked" via Skia weight-matching, but there was no variable typeface for `set_font_arguments` to attach axes to. Also `font-id->asset-id` compared a UUID object to a string (always false) → custom fonts never loaded into the wasm store on cold boot. Fixed with a shared resolver that hashes non-UUID slugs to a stable uuid (`uuid/from-unsigned-parts`; Penpot's `uuid/uuid` slice-parser *collides* distinct slugs — verified).
2. `4a83402aa9`: even after (1), only **metric-changing** edits repaint. In pencilpot the generic wasm content-sync (`render_wasm/shape.cljs process-shape-changes!`) is a **silent no-op** — it only records changes made through Penpot's `ShapeProxy`, but pencilpot's shapes are loaded from EDN as plain maps, so it always sees `{}`. The *only* repaint trigger left is `dwwt/resize-wasm-text` (`data/workspace/wasm_text.cljs`), which pushes the new content to wasm and then repaints **as a side effect of a non-identity resize modifier**. Weight + width change the auto-width box → non-identity resize → repaint. Non-metric axes (GRAD/ROND/opsz/slnt) leave the box unchanged → identity resize → **no repaint**. The fix adds a RAF-debounced `wasm.api/request-render` in `resize-wasm-text`'s `ptk/EffectEvent`.

**Why I believe the fixes are correct:** headless swiftshader Playwright, driving the *real* UI (select shape via layer row → type into `input[aria-label="Slant"]` → Enter), shows the selected "LAUNCHER" text clearly slant/condense/etc. Harness + assertions: `pencilpot/e2e/vf/ui-axis.mjs` (RMSE before/after per axis, asserts non-metric GRAD repaints). It passes. Screenshots were saved under `/tmp/vf-proof/` and `/tmp/slant-out/` (slnt=−10 visibly leans).

**Why it's still NOT solved:** the user says it still doesn't work — even on `/mnt/data/src/pencilpot-vftest/vf-proof.pencil`, a byte-identical fresh copy of their design, on a build whose stamp I confirmed is current. So my reproduction (headless, UI-driven by Playwright) diverges from the user's reality somewhere I could not observe.

**Concrete hypotheses for the next agent (untested / where I'd look):**
- **Edit-mode vs select-mode.** My harness selects the *shape* (single layer-row click). If the user double-clicks into the text (text-EDIT mode / `text-editor-wasm/v1`), the edit flows through a **different path**: `emit-update!` → `v3-update-text-editor-styles` (`data/workspace/texts_v3.cljs`, just merges into `:workspace-wasm-editor-styles`) and `apply-styles-to-selection` (`render_wasm/text_editor.cljs`, only runs when `text-editor-has-selection?`). The `resize-wasm-text` repaint fix may **not** be on that path. Reproduce by *double-clicking into the text* before changing the axis, and by changing the axis while a *character range is selected*. I suspect this is it.
- **The numeric-input commit.** The axis input is `numeric-input*` (`ui/components/numeric_input.cljs`); it fires `on-change(value, event)` and commits on blur/Enter. If the user drags/scrubs or doesn't blur, the commit may differ. Confirm the on-change actually fires and that the value type (number vs string) reaching `:font-variation-settings` is what the serializer expects.
- **request-render not enough.** `request-render` repaints, but if the content pushed to wasm for that shape is stale (the `set-shape-text-content` in `resize-wasm-text-modifiers` ran on old content, or didn't run on this path), it repaints the *old* glyphs. Verify, at the wasm boundary, that the span actually carries the new `:font-variation-settings` at paint time for the user's gesture. Instrument `render_wasm/api/texts.cljs write-span-variations` and `render-wasm/src/shapes/text.rs to_style` (log the variation coords Skia receives).
- **Multiple text nodes / paragraph vs leaf.** The VF text has `:font-variation-settings` on both the paragraph and leaf. Make sure the edit writes to the node(s) that actually get serialized/painted.

**How to reproduce headlessly (works today):**
```
cd /mnt/data/src/penpot/pencilpot
FID=$(node e2e/vf/seed.mjs /tmp/vftest '{}')          # seeds a copy of DefaultLauncher
node e2e/vf/ui-axis.mjs /tmp/vftest "$FID" /tmp/out    # drives UI, prints per-axis RMSE, screenshots in /tmp/out
```
Swiftshader flags that make the wasm canvas paint headlessly: `chromium.launch({headless:true,args:["--use-gl=angle","--use-angle=swiftshader","--enable-unsafe-swiftshader","--ignore-gpu-blocklist"]})`. **The next step I'd take:** extend `ui-axis.mjs` to *double-click into the text* (edit mode) and change the axis there, and see if THAT reproduces the user's failure. If it does, fix the `apply-styles-to-selection` / `v3` editor path to also `request-render` (or to push variations), mirroring the `resize-wasm-text` fix.

**Fresh A/B test project for the user:** `/mnt/data/src/pencilpot-vftest/vf-proof.pencil` (VF text shapes `a0b0c325…` "Text" and `d706b95b…`, font-id `custom-custom-google-sans-flex`).

## 6. Landmines / gotchas (will save you hours)

- **`$cljs$core$IFn$_invoke$arity$1$ of undefined` is NOT necessarily a stale build.** Penpot's `app.main.errors/stale-asset-error?` matches that exact signature and force-reloads (logging `"forcing page reload"`), so a *real* bug that calls `undefined` gets misclassified and reload-loops, hiding the stack. To debug: temporarily make the two `(stale-asset-error? cause)` branches in `errors.cljs` `console.error` the stack instead of reloading. The release build has `:pseudo-names true` + `:source-map true`, so `awk 'NR==<line>' resources/public/js/main-workspace.js` at the stack's line gives a readable call.
- **`::mf/wrap-props false` rumext components must be called with `#js {…}`, not a cljs map** — else props (e.g. `on-change`) are undefined.
- **EDN store correctness:** the canonical serializer must preserve Penpot geometry **records** (Matrix/Point/Rect) as tagged literals (`#penpot/matrix` etc.) — flattening them to plain maps gives `matrix(NaN)` on the canvas. See `store.cljs`.
- **render-wasm headless gotcha is avoidable** with swiftshader (above); the old "headless = read-only canvas" belief is wrong with those flags.
- **Unknown RPCs must return 200** (benign empty transit), never 4xx, or the SPA shows an internal-error screen.
- Commit identity rule (user's): author `Gurupungav Narayanan <28506515+guru-irl@users.noreply.github.com>`, and **no "Claude"/"Anthropic"/"Co-Authored-By" anywhere** in messages.

## 7. Other pending / not-done

- **Phase 5**: lean audit + packaging + final docs (not started).
- **AI in the terminal** (e.g. gh copilot) — the terminal works; AI layer not added.
- The variable-font connector's named-instance `coords` are emitted keyword-keyed in transit while `:font-variation-settings` is string-keyed — only matters if you wire "apply named instance".
- There may be stray debug/test files under `pencilpot/e2e/vf/` and `/tmp/*` from this session.

## 8. Memory / context

The previous agent kept notes under `/home/guru/.claude/projects/-mnt-data-src-penpot/memory/` (pencilpot.md, pencilpot-variable-fonts.md, pencilpot-edit-performance.md, pencilpot-frontend-debugging.md). They duplicate much of the above. Architecture docs: `docs/pencilpot/architecture/`.

**If you do nothing else: solve §5 by reproducing the user's *exact* gesture (almost certainly double-click-into-text edit mode), not a clean shape-select, and fix whichever repaint path that gesture takes.**
