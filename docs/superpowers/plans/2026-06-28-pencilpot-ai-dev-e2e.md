# Plan: Pencilpot AI-driven development — end-to-end capability audit

**Date:** 2026-06-28
**Base commit:** `4d66fb1c8a` (branch `pencilpot`)
**Skill regime:** subagent-driven-development, test-driven-development, systematic-debugging, context-mode, pi-subagents.

## Goal

Exercise *every* AI-facing surface of pencilpot end-to-end and produce (a) a reusable
harness under `pencilpot/e2e/ai/` and (b) an authoritative **findings ledger**
`.superpowers/sdd/pencilpot-ai-dev-findings.md` cataloguing each capability as
**WORKS / PARTIAL / GAP** with the exact invocation, expected result, and gotchas.
This ledger is the ground truth that the pencilpot *skill* (separate task) is written from.

This is simultaneously an **integration test** (does the MCP actually drive a local
design?) and a **capability audit** (what can an AI build, and where are the walls?).

## Surfaces under test (from recon)

### A. CLI (`pencilpot/bin/pencilpot.mjs`)
`new`, `import`, `open`, `fonts`, `retarget-fonts`, `map-variable`, `install-desktop`/`uninstall-desktop`.

### B. `penpot-headless` MCP (`headless-core/mcp/server.mjs`) — stdio JSON-RPC
Tools: `checkout(fileId)`, `script(code)`, `scene()`, `map_fonts_variable(mapping)`,
`validate()`, `status()`, `commit()`, `discard()`.
Connects to a backend at `PENPOT_HL_BASE` (default `http://localhost:9101`) with optional
`PENPOT_TOKEN`. **Hypothesis: set `PENPOT_HL_BASE` to the live pencilpot runtime URL and it
drives the local design.** `getFile` = JSON-meta + transit pair on `/api/rpc/command/get-file`;
`updateFile` = transit on `/api/rpc/command/update-file`.

### C. WorkingCopy SDK (`headless-core/sdk/working-copy.mjs`) — same engine the MCP wraps
`addBoard/addRect/addEllipse/addText/closeBoard`, `setFlexLayout/setGridLayout/setGrowType/setConstraints`,
`createComponent/instantiateComponent`, `addColorToken/tokens`, `mapFontsToVariable/retargetFonts/serializeStore`,
`getFileResponse/validate/pendingChanges/commit/discard`.

### D. Runtime (`pencilpot/runtime/`) — the live server browser + MCP talk to
RPCs: `get-file`, `update-file`, `get-file-libraries`, `get-font-variants`, `rename-file`,
`upload-file-media-object`, `create-file-media-object-from-url`, `clone-file-media-object`,
`get-view-only-bundle`. Endpoints: `/pencilpot/status|save|discard|live`, `/assets/by-id`,
`/assets/by-file-media-id`, `/internal/gfonts/*`, `/api/*`, WS `/pencilpot/terminal`.

### E. Viewer / prototype (frontend `/view`)
`get-view-only-bundle` → native viewer renders imported prototype interactions.

## Constraints
- NO INJECTION; work on COPIES of designs (never the canonical DefaultLauncher design except read-only checkout).
- Reuse the existing boot pattern: spawn `runtime/server.mjs` with `PENCILPOT_DESIGN`/`PENCILPOT_PORT`,
  wait for the banner, then set `PENPOT_HL_BASE=http://localhost:<port>`.
- Every harness: SKIP exit 0 if the canonical design `/mnt/data/src/DefaultLauncher/design` is absent.
- No new npm deps. Keep `node run-tests.mjs --unit` green.
- Scratch under `.scratch/` (never `/tmp`).

## Tasks (each: fresh-context implementer, TDD, → fresh-context reviewer → ledger entry → toggle)

### Task A1 — MCP transport proof (the integration spine)
Prove the **real `penpot-headless` MCP** drives the local runtime. Harness
`pencilpot/e2e/ai/mcp-roundtrip.mjs`: boot runtime on a COPY of DefaultLauncher; spawn the MCP
server (`node headless-core/mcp/server.mjs`) with `PENPOT_HL_BASE=<runtime>`; over stdio JSON-RPC
call `checkout(FID)` → assert objects>0/revn; `script` to add one board+rect; `validate` (empty);
`status` (pending>0); `commit` → assert revn bump; then GET `/api/rpc/command/get-file` directly and
assert the new board is present in the served file. Document the **save gap**: after commit the edit
is staged in runtime memory; POST `/pencilpot/save` to persist, then assert the on-disk EDN changed.
Findings: does the MCP transport work as-is against pencilpot? exact env, the save step, any shape mismatches.

### Task A2 — SDK breadth audit: shapes + layout + constraints
Harness `pencilpot/e2e/ai/sdk-shapes.mjs` using `WorkingCopy` directly (PENPOT_HL_BASE=runtime).
Exercise: `addBoard`→`addRect`/`addEllipse`/`addText`→`closeBoard`; `setFlexLayout`,
`setGridLayout`, `setGrowType`, `setConstraints`. After each group: `validate()` empty,
`pendingChanges()` count, `commit()`, re-`getFile` and assert geometry/structure. Render-check:
boot a browser on `/workspace` and confirm the new shapes paint on the STABLE SVG renderer.
Ledger each method WORKS/PARTIAL/GAP with the exact opts JSON it accepts.

### Task A3 — Components
Harness `pencilpot/e2e/ai/sdk-components.mjs`: build a board, `createComponent(boardId, opts)`,
`instantiateComponent(componentId, opts)` at a second position; `validate`; `commit`; re-getFile and
assert (1) a component exists in `:components`, (2) an instance (`:component-id`/`:shape-ref`) exists
on the page; render-check both the main component and the instance in the workspace. Findings:
what `opts` are honoured (name, main-instance placement), variant/swap support (likely GAP).

### Task A4 — Tokens
Harness `pencilpot/e2e/ai/sdk-tokens.mjs`: `addColorToken({...})`, `tokens()` lists it; `commit`;
re-getFile and assert the token-set + token landed in `:tokens-lib`; apply the token to a shape fill if
supported. Probe other token types (typography/spacing/dimension) and **document them as GAP** if only
color is wired. Confirm tokens survive `/pencilpot/save` + cold reopen.

### Task A5 — Variable fonts (CLI + MCP) end-to-end
Harness `pencilpot/e2e/ai/variable-fonts.mjs`: on a COPY, run `pencilpot map-variable <project> --font-id …
--map "Family=wdth:..,opsz:.."`; assert the CLI rewrites EDN + validation clean. Then boot runtime + viewer
and confirm the mapped family renders at the real axis width on the STABLE SVG renderer (reuse the GSF
assertions from `verify-viewer.mjs`). Also exercise the MCP `map_fonts_variable` tool against the runtime
and document that it is a working-copy `:data` transform that does NOT round-trip `commit()` (persist via CLI).
Cross-reference `pencilpot fonts` / `retarget-fonts`.

### Task A6 — Prototypes / interactions (audit + viewer)
Harness `pencilpot/e2e/ai/prototypes.mjs`: confirm there is **no SDK/MCP method to author interactions**
(grep session.cljs; attempt and document the wall). Then prove the *consumption* path: `get-view-only-bundle`
renders the imported design's existing interactions in `/view` (reuse `verify-viewer.mjs` evidence; assert an
interaction click navigates between frames if the canonical design has one). Ledger: authoring = GAP (with the
exact missing surface), viewing/playing = WORKS.

### Task A7 — Persistence & lifecycle
Harness `pencilpot/e2e/ai/lifecycle.mjs`: full loop on a COPY — `pencilpot new` (or import) → boot runtime →
SDK edit → `commit` (staged) → `/pencilpot/status` shows dirty → `/pencilpot/save` → on-disk EDN updated →
restart runtime → reopen clean (dirty=false), edit visible. Assert `/pencilpot/discard` reverts staged edits.
Confirm `:position-data`/`:revn` stripping keeps a no-op reopen non-dirty (cross-ref `verify-positiondata.mjs`).

### Task A8 — Findings consolidation
Merge all per-task ledger fragments into `.superpowers/sdd/pencilpot-ai-dev-findings.md`: a capability matrix
(surface × WORKS/PARTIAL/GAP), the canonical "AI dev loop" recipe (boot → connect → edit → commit → save →
view), every env var, every gotcha (save gap, font persistence, interaction-authoring gap, token types), and
copy-pasteable invocations. This file is the single source the skill is written from.

## Parallelization
A1 first (establishes the boot+connect harness helper the rest import). A2–A6 parallel (disjoint harness files,
shared read-only helper). A7 after A2 (reuses an edit). A8 last (consolidation). Reviewer is fresh-context,
read-only, per task; whole-set capstone at the end.

## Done when
- All `pencilpot/e2e/ai/*.mjs` pass (or SKIP cleanly) and run twice deterministically.
- `pencilpot-ai-dev-findings.md` is complete and accurate (capability matrix + recipe + gotchas).
- `node run-tests.mjs --unit` still green; no canonical design mutated.
