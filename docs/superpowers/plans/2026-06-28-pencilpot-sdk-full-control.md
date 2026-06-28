# Plan — Pencilpot SDK: full structural control for AI

**Date:** 2026-06-28
**Branch:** `pencilpot`
**Goal:** Close the remaining headless-SDK/MCP capability gaps so an AI can edit a design the way the
Penpot UI can — not just append. Add thin verbs over the engine's existing high-level generators
(`app.common.logic.shapes`, `app.common.logic.libraries`, `app.common.types.tokens-lib`). Each verb is
the same recipe already proven by `instantiateComponent` + `addInteraction`.

## Why this is bounded
The engine IS the real Penpot `common` model. Every operation already has a high-level generator that
handles the edge cases (component sync, parent registration, geometry cascade). We only add JS-facing
methods that call them and record the resulting changes via the existing `apply-changes!` path
(applies to working-copy data + records pending → `commit()` → `/pencilpot/save` persists).

Key engine entrypoints (verified):
- `cls/generate-update-shapes [changes ids update-fn objects opts]` — generic attribute edit.
- `cls/generate-delete-shapes [changes file page objects ids options]` — delete (handles children/components).
- `cls/generate-relocate [changes parent-id to-index ids & {:keys [cell ignore-parents?]}]` — reparent AND reorder.
- `gsh` move/`ctm/change-dimensions-modifiers` + `gsh/transform-shape` — geometry move/resize (mirror `transforms.cljs`).
- `ctob/make-token [& {:as attrs}]` — type-agnostic token; current `addColorToken` hardcodes `:type :color`.
- `cto` applied-tokens helpers — bind/unbind a token on a shape's `:applied-tokens`.
- `cll/generate-component-swap [changes objects shape file page libraries id-new-component index target-cell keep-props-values ignore-swapped?]`.
- `cll/generate-detach-instance [changes container libraries shape-id]`.

## Conventions for every verb
- Read-only on live `@state`: build changes, then `(apply-changes! state ch)` (which records pending).
- Operate on the session's current page (`:page-id @state`); coerce incoming string ids → uuid.
- For generators that run `cts/check-shape`, coerce hydrated data to records the same way
  `instantiateComponent` does (`coerce-data-for-validation` + restore `:data :id`) where needed; prefer
  generators that work on plain maps. TDD on a `fromStore`-hydrated session (the real disk path) in every test.
- Return a small JSON-friendly value (id / count / new shape id).
- Surface on `working-copy.mjs` (thin wrappers) and advertise in `mcp/server.mjs` tool descriptions.
- Rebuild `headless-core/target/headless/penpot.js` and `git add -f` it with each engine change.
- Tests run serially: `node --test --test-concurrency=1`.

## Waves (each = TDD verb → rebuild → serial tests → commit)

### Wave 1 — Edit / delete / restructure existing shapes  (highest leverage)
- `updateShape(id, attrs)` / `updateShapes(ids, attrs)` — `cls/generate-update-shapes`; sets any attr
  (fills, strokes, opacity, rotation, name, blend-mode, border-radius/rx/ry, constraints-h/v, hidden,
  blocked, proportion-lock, …). Keyword-coerce known enum attrs.
- `deleteShape(id)` / `deleteShapes(ids)` — `cls/generate-delete-shapes`.
- `reparentShape(id, parentId, {index?})` — `cls/generate-relocate` (to-index, default append).
- `reorderShape(id, index)` — `cls/generate-relocate` into the same parent at `index`.

### Wave 2 — Geometry
- `moveShape(id, {x?, y?, dx?, dy?})` — absolute or relative; move the shape + descendants.
- `resizeShape(id, {width?, height?})` — dimension modifiers; cascades to children.

### Wave 3 — Tokens (all types) + binding
- `addToken({set, name, type, value})` — generalize; keep `addColorToken` as a `:type :color` alias.
- `applyToken(shapeId, {name|id, attrs})` / `unapplyToken(shapeId, attrs)` — write `:applied-tokens`.

### Wave 4 — Components
- `swapComponent(instanceId, newComponentId)` — `cll/generate-component-swap`.
- `detachInstance(id)` — `cll/generate-detach-instance`.

### Wave 5 — Grouping (stretch; bespoke — no single common generate-fn)
- `groupShapes(ids, {name?})` — create a `:group` shape with the children's bounding selrect under their
  common parent, then `generate-relocate` the children into it.
- `ungroupShape(id)` — relocate children to the group's parent, delete the group.
  *If this proves materially more involved than Waves 1–4, deliver it as a tracked follow-up rather than block them.*

## Cross-cutting finish (after the verb waves)
- Fresh-context review of all engine changes (schema-safety, hydrated-path fidelity, no live-state mutation).
- Update `pencilpot/skills/pencilpot/SKILL.md` (method tables + remove/replace the GAPs section).
- Update `docs/pencilpot/ai-dev-capabilities.md` (WORKS rows; shrink the GAP list).
- Update `docs/pencilpot/architecture/12-headless-engine-and-ai-dev.md` (method table + GAP narrative).
- Update the B-audit harnesses (`pencilpot/e2e/ai/sdk-structure.mjs`) to exercise the new verbs.
- MCP `server.mjs` instructions/tool descriptions list the new verbs.

## Verification
- Per wave: new `headless-core/test/*.test.mjs` covering a `fromStore`-hydrated round-trip (author → verb →
  validate clean → commit → serialize→reload persists), run serially, EXIT 0.
- End: full headless suite serial EXIT 0; pencilpot unit suite EXIT 0; one live runtime e2e proving a verb
  persists to on-disk EDN across a cold reopen.
