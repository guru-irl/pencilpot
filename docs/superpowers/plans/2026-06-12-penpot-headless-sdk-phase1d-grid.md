# Penpot Headless SDK — Phase 1d (Grid auto-layout) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Checkbox steps.

**Goal:** `setGridLayout(boardId, opts)` — make a board a grid container, assign children to cells, and reflow them into the grid headlessly. Reuses the *exact* flex reflow machinery + adds cell assignment.

**Architecture:** Same shape as `setFlexLayout`: (A) set Penpot's `initial-grid-layout` attrs on the board, add `cols` grid columns (`ctl/add-grid-column`), assign children to cells (`ctl/assign-cells` — creates rows + fills), `ctl/reorder-grid-children` — emit as a `:mod-obj` via `pcb/update-shapes`; (B) reflow via `set-objects-modifiers` seeded with `reflow-modifiers` (the `:grid` branch fires automatically) → `:mod-obj` via `gsh/transform-shape`. All pure CLJC. **Fallback:** if reflow is finicky, ship A-only (grid attrs+cells set, valid+persists; arranges on first in-editor edit), documented.

**Tech Stack:** ClojureScript (`headless-core`), Node ESM, `node:test`, penpot-hl.

---

## HARD ISOLATION RULE
penpot-hl (:9101) only; never `penpot`/:9001. Branch `feat/penpot-headless-sdk`. Commits: identity `Gurupungav Narayanan <28506515+guru-irl@users.noreply.github.com>`, **NO `Co-Authored-By` / no "Claude" in messages**.

---

## File Structure
- `headless-core/src/app/headless/session.cljs` — add `:setGridLayout` + `[app.common.types.shape.layout :as ctl]` require + `initial-grid-layout` def.
- `headless-core/sdk/working-copy.mjs` — add `setGridLayout(boardId, opts)`.
- `headless-core/test/session.test.mjs` — unit: board + 4 rects → setGridLayout(cols 2) → 2×2 grid (2 distinct x, 2 distinct y) + validate [].
- `headless-core/test/workingcopy.roundtrip.test.mjs` — live: grid board persists with `layout:"grid"`.
- skill + README updates.

---

## Task 1: Engine — `setGridLayout` (configure + assign cells + reflow) [crux]

**Files:** Modify `session.cljs`, `test/session.test.mjs`.

- [ ] **Step 1: Failing unit test** — append to `test/session.test.mjs`:
```javascript
test("setGridLayout arranges children into a 2-column grid", () => {
  const s = createSession(JSON.stringify({ empty: true }));
  const b = s.addBoard(JSON.stringify({ x: 0, y: 0, width: 400, height: 400, name: "Grid" }));
  const ids = [0,1,2,3].map(() => s.addRect(JSON.stringify({ x: 0, y: 0, width: 80, height: 60, parentId: b })));
  s.closeBoard();
  const out = JSON.parse(s.setGridLayout(b, JSON.stringify({ cols: 2, gap: 10 })));
  assert.ok(out.reflowed >= 4, "children reflowed");
  const objs = JSON.parse(s.objects());
  assert.equal(objs[b].layout, "grid");
  const xs = new Set(ids.map(id => Math.round(objs[id].selrect.x)));
  const ys = new Set(ids.map(id => Math.round(objs[id].selrect.y)));
  assert.equal(xs.size, 2, `2 distinct columns (xs=${[...xs]})`);
  assert.equal(ys.size, 2, `2 distinct rows (ys=${[...ys]})`);
  assert.deepEqual(JSON.parse(s.validate()), []);
});
```

- [ ] **Step 2: Run → fail** — `cd headless-core && npm run build && node --test test/session.test.mjs`.

- [ ] **Step 3: Implement** in `session.cljs`:
  1. Add require `[app.common.types.shape.layout :as ctl]`. (gm/ctm/gsh/pcb already present from flex.)
  2. Add the default grid map (from `frontend/.../shape_layout.cljs` `initial-grid-layout`):
```clojure
(def ^:private initial-grid-layout
  {:layout :grid :layout-grid-dir :row :layout-gap-type :multiple
   :layout-gap {:row-gap 0 :column-gap 0} :layout-align-items :start
   :layout-justify-items :start :layout-align-content :stretch
   :layout-justify-content :stretch :layout-padding-type :simple
   :layout-padding {:p1 0 :p2 0 :p3 0 :p4 0}
   :layout-grid-cells {} :layout-grid-rows [] :layout-grid-columns []})
```
  3. Add the `:setGridLayout` method to `make-session`:
```clojure
       :setGridLayout
       (fn [board-id opts-json]
         (let [{:keys [cols gap padding dir]} (args opts-json)
               bid  (uuid/parse board-id)
               pid  (:page-id @state)
               ncols (max 1 (or cols 2))
               grid (cond-> initial-grid-layout
                      dir (assoc :layout-grid-dir (keyword dir))
                      (some? gap)     (assoc :layout-gap {:row-gap gap :column-gap gap})
                      (some? padding) (assoc :layout-padding {:p1 padding :p2 padding :p3 padding :p4 padding}))
               ;; (A) set grid attrs + columns + assign cells on the board
               objs1 (objects-of state)
               board0 (get objs1 bid)
               gridboard (-> board0
                             (merge grid)
                             (as-> b (reduce (fn [acc _] (ctl/add-grid-column acc ctl/default-track-value)) b (range ncols)))
                             (ctl/assign-cells objs1)
                             (ctl/reorder-grid-children))
               ch1   (-> (pcb/empty-changes nil pid) (pcb/with-page-id pid) (pcb/with-objects objs1)
                         (pcb/update-shapes [bid] (fn [_] gridboard)))
               _     (apply-changes! state ch1)
               ;; (B) reflow (grid branch fires automatically)
               objs2 (objects-of state)
               tree  {bid {:modifiers (ctm/reflow-modifiers)}}
               res   (gm/set-objects-modifiers tree objs2)
               ids   (vec (keys res))
               ch2   (-> (pcb/empty-changes nil pid) (pcb/with-page-id pid) (pcb/with-objects objs2)
                         (pcb/update-shapes ids (fn [s] (gsh/transform-shape s (get-in res [(:id s) :modifiers])))))
               _     (apply-changes! state ch2)]
           (js/JSON.stringify #js {:reflowed (count ids)})))
```
  *Executor verification (verify against source; adapt; REPORT):*
  - `ctl/add-grid-column` (`layout.cljc:796`) — arity `(parent track)`? confirm it takes `ctl/default-track-value` (`:647`, `{:type :flex :value 1}`) and synthesizes cells; if its signature differs, use `ctl/add-grid-track`.
  - `ctl/assign-cells` (`layout.cljc:1202`) — `(assign-cells parent objects)` → updated parent; it creates rows + fills empty cells with the board's `:shapes` children, `:position :auto`. The board's `:shapes` must list child ids (they do — added via addRect parentId). Watch the `overlapping-cells` assert (1×1 cells avoid it).
  - `ctl/reorder-grid-children` (`layout.cljc:1512`) — `(reorder-grid-children parent)`.
  - If `update-shapes` with a `(fn [_] gridboard)` doesn't emit the layout attrs as `:mod-obj` ops (it diffs old vs new — should capture the new layout keys + cells/tracks), verify the emitted change includes `:layout-grid-cells`/`-rows`/`-columns`. 
  - If the reflow (B) doesn't position children into distinct rows/cols (e.g. all same x), debug: print a child's modifiers + the board's cells; ensure `:layout-grid-columns` has `ncols` tracks and cells were assigned. If reflow can't be made correct after real effort, FALL BACK to A-only: keep the attrs+cells, drop reflow, change the test to assert `objs[b].layout==="grid"` + cells assigned + validate [] (drop the distinct-x/y asserts), return `{reflowed:0, configured:true}`, report DONE_WITH_CONCERNS.

- [ ] **Step 4: Build + run → pass** — iterate (edit cljs → rebuild → test). PASS when children occupy 2 distinct columns AND 2 distinct rows, validate []. Report the actual child x/y sets.

- [ ] **Step 5: Commit** — `git add headless-core/src/app/headless/session.cljs headless-core/test/session.test.mjs && git commit -m ":sparkles: headless session: setGridLayout (grid attrs + assign-cells + reflow)"` (NO Claude/Co-Authored-By).

---

## Task 2: WorkingCopy.setGridLayout + live persist (TDD)

**Files:** Modify `sdk/working-copy.mjs`, `test/workingcopy.roundtrip.test.mjs`.

- [ ] **Step 1: Wrapper** — `setGridLayout(boardId, opts) { return this.session.setGridLayout(boardId, JSON.stringify(opts)); }`
- [ ] **Step 2: Failing live test** — add to `test/workingcopy.roundtrip.test.mjs`:
```javascript
test("WorkingCopy: grid layout arranges + persists", async () => {
  const wc = await new WorkingCopy(env.fileId, env.token).checkout();
  const b = wc.addBoard({ x: 1700, y: 60, width: 400, height: 400, name: "Grid Board" });
  const ids = [0,1,2,3].map(() => wc.addRect({ x: 0, y: 0, width: 80, height: 60, parentId: b }));
  wc.closeBoard();
  wc.setGridLayout(b, { cols: 2, gap: 10 });
  assert.deepEqual(wc.validate(), []);
  await wc.commit();
  const after = await getFile(env.fileId, env.token);
  const objs = after.raw.data.pagesIndex[after.pageId].objects;
  assert.equal(objs[b].layout, "grid", "board persisted as grid container");
  const xs = new Set(ids.map(id => Math.round(objs[id].selrect.x)));
  assert.equal(xs.size, 2, `2 columns persisted (xs=${[...xs]})`);
});
```
- [ ] **Step 3: Run → fix → pass** — `node --test test/workingcopy.roundtrip.test.mjs` (penpot-hl up). PASS when grid persists with `layout:"grid"` + 2 distinct columns. Report server `:explain` if rejected.
- [ ] **Step 4: Commit** — `git add headless-core/sdk/working-copy.mjs headless-core/test/workingcopy.roundtrip.test.mjs && git commit -m ":white_check_mark: headless: WorkingCopy.setGridLayout arranges + persists grid board"`

---

## Task 3: Skill + README + verify

- [ ] **Step 1: Full gate** — `cd headless-core && npm run verify && npm run sanity` → green. Report tails.
- [ ] **Step 2: Skill** (`~/.claude/skills/penpot-headless/SKILL.md`): add `wc.setGridLayout(boardId, {cols, gap, padding, dir})` to the wc API; move "grid" from NOT-yet into supported. NOT-yet line now just "ellipses/paths, components."
- [ ] **Step 3: README** — document `setGridLayout`. Commit README only: `git add headless-core/README.md && git commit -m ":memo: headless: document setGridLayout (Phase 1d grid)"` (no Claude).

---

## Phase 1d Done = exit criteria
- `setGridLayout` gives a board `:layout :grid`, assigns children to cells, and reflows them into a grid (distinct rows + columns); `validate()` `[]`.
- A grid board persists to penpot-hl with `layout:"grid"`. verify + sanity green; skill + README updated. (If reflow deferred, documented A-only.)

**Next:** ellipses/paths, then components; or wire the headless MCP to a real instance.
