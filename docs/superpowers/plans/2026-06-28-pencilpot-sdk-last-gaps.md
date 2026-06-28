# Pencilpot SDK — close the last four AI-dev GAPs

Date: 2026-06-28
Branch: `pencilpot`
Plan owner: orchestrator (this session). Execution: subagent-driven TDD, one wave
at a time, single-writer on `headless-core/src/app/headless/session.cljs`.

## Context

The SDK full-control work (`267c9dadc5`..`8fe3190c8d`) turned "append-only" into full
structural editing. Four documented gaps remain (`docs/pencilpot/ai-dev-capabilities.md §3`):

1. **Rotate** — no `rotateShape`; raw `:rotation` is (correctly) refused by `updateShapes`.
2. **`mapFontsToVariable` round-trip** — it's a direct `(swap! state update :data postwalk)`,
   not a recorded change, so `commit()` (the MCP `map_fonts_variable` tool) doesn't persist it;
   only the `map-variable` CLI persists (it writes `serializeStore()` straight to disk).
3. **Token value RESOLUTION** — `applyToken` records the `:applied-tokens` binding but never
   resolves the token's value onto the actual shape attribute, so headless renders the old value.
4. **Component variants** — `swapComponent` works, but there is no verb to CREATE a variant set
   or add a sibling variant.

Each verb is a thin wrapper over an existing `common` generator + `apply-changes!` — the proven
recipe. Verbs that don't instantiate are plain-map safe (no `cts/check-shape`).

## Engine primitives confirmed (recon)

- **Rotate**: `ctm/rotation-modifiers [shape center angle]` (modifiers.cljc:424) → feed through
  `gm/set-objects-modifiers` + `gsh/transform-shape` exactly like the existing `resizeShape`.
  `center` = `gco/shape->center shape` for a single shape. Records via `pcb/update-shapes`.
- **Fonts**: current `:mapFontsToVariable` postwalks the whole `:data` and `swap!`s it directly.
  Refactor to walk each page's objects and emit `pcb/update-shapes [id] transform-node` per changed
  shape (covers shape-level font attrs + nested `:content` tree + `:position-data` strip), so the
  edit is a recorded `:mod-obj` and `commit()` persists. File-level `:typographies` (assets, not
  shapes) — handle via a library-data change if a clean `pcb` op exists, else keep the direct
  `:data` mutation for typographies only (the CLI already persists those; rendering depends on the
  shape changes). The `map-variable` CLI and the VF e2e harnesses MUST stay green.
- **Token resolution**: StyleDictionary lives only in the frontend (JS), so full resolution
  (references `{…}` / math) is out of scope headlessly. Resolve **literal** values only, mirroring
  `frontend/.../tokens/application.cljs` per-attribute setters (`update-fill`, `update-stroke-color`,
  `update-shape-radius`, `update-opacity`, `update-rotation`, `update-stroke-width`,
  `update-shape-dimensions`, font-size, spacing/gap/padding). `cft/parse-token-value` (files/tokens.cljc:310)
  splits `{:value :unit}`. References/math → record the binding only (documented).
- **Variants**: `clv/generate-add-new-variant [changes shape variant-id new-component-id new-shape-id prop-num]`
  (variants.cljc:16) is a clean generator — wrap it as `addVariant`. `transform-in-variant`
  (variants.cljs:402) is **event-driven** (devs' own TODO: "Refactor … to generate changes instead
  of call the events") → NOT cleanly replicable; bootstrap a variant set with the lower-level
  `clvp/generate-make-shapes-variant` (variant_properties.cljc:188) if it composes cleanly under TDD,
  else ship `addVariant` and document the bootstrap as the one residual UI step.

## Waves (each: failing test → verb → SDK wrapper → MCP advertise → rebuild → serial tests → review → commit)

### Wave 6 — `rotateShape(id, {angle, cx?, cy?})`  [FULL, high confidence]
Mirror `resizeShape`: `ctm/rotation-modifiers` over the shape (center = shape center unless cx/cy
given), `gm/set-objects-modifiers` → `gsh/transform-shape`, record via `pcb/update-shapes`. Keep
`:rotation` in the `updateShapes` denylist (rotateShape is the geometry-correct path). Tests on
fresh + `fromStore`-hydrated; assert `:rotation` set AND `:selrect`/`:points` rotated (not a raw set).

### Wave 7 — `mapFontsToVariable` recorded round-trip  [FULL]
Refactor the verb to emit recorded `pcb/update-shapes` changes per matching shape (+ typographies
handled or documented). Add a headless test that maps a family, `commitBody()`/`pendingChanges()`
is non-empty, and a store round-trip shows the new font. Re-run the `map-variable` CLI path + VF
harness checks to prove no regression.

### Wave 8 — `applyToken` literal resolution  [PARTIAL: literal values]
After recording the `:applied-tokens` binding, if the token's value is literal (not a reference /
math), resolve it onto the bound attributes (color → fills/stroke-color; number/dimension → r1..r4,
width/height, opacity, rotation, stroke-width, p1..p4/gap, font-size). Reference/math tokens record
the binding only. Test: bind a literal color token to `:fill` → shape's fill actually changes AND
`:applied-tokens` is set; bind a reference token → only the binding is recorded.

### Wave 9 — variants  [addVariant FULL; makeVariant best-effort]
`addVariant(shapeId, {propValue?})` wraps `clv/generate-add-new-variant` (shape must be in a variant
set). `makeVariant(componentInstanceId)` bootstraps a variant set via `clvp/generate-make-shapes-variant`
if it composes; otherwise document the UI bootstrap. Tests build a component, make it a variant set,
add a variant; assert the variant container + two components + `:variant-id`/`:variant-properties`.

## Cross-cutting finish
Fresh-context review of all engine changes (read-only); update `pencilpot/skills/pencilpot/SKILL.md`,
`docs/pencilpot/ai-dev-capabilities.md`, `docs/pencilpot/architecture/12-headless-engine-and-ai-dev.md`,
and the `sdk-edit.mjs` live harness; run the full headless suite serially (must stay green) + pencilpot
unit suite; **push `pencilpot` → `origin/pencilpot` and force-update `origin/main`**.

## Constraints
- Single writer: every wave touches `session.cljs` + rebuilds `penpot.js` (`clojure -M:dev:shadow-cljs
  release headless`, then `git add -f headless-core/target/headless/penpot.js`). Waves are sequential.
- Tests run serially: `node --test --test-concurrency=1 test/*.test.mjs`.
- Verbs that instantiate (none here except possibly variants) reuse the `coerce-data-for-validation`
  + `(assoc :id file-id)` pattern; update/relocate/modifier verbs are plain-map safe.
- No new npm deps. No frontend injection. SVG renderer only.
