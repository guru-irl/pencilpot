# Penpot Headless SDK — Phase 1c-2 (Flex auto-layout) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Checkbox (`- [ ]`) steps.

**Goal:** `setFlexLayout(boardId, opts)` — give a board a flex layout AND reflow its children headlessly, so the file opens already-arranged. Reuses Penpot's own layout engine; validated + persisted.

**Architecture:** Two steps, both pure CLJC: (A) set Penpot's `initial-flex-layout` attrs on the board (a `:mod-obj` via `pcb/update-shapes`); (B) reflow by seeding a modifier tree `{boardId {:modifiers (ctm/reflow-modifiers)}}`, running `app.common.geom.modifiers/set-objects-modifiers`, and emitting `:mod-obj` changes for the affected shapes via `gsh/transform-shape` + `pcb/update-shapes`. Apply both to the working copy via `process-changes` and record. **Fallback:** if B (reflow) can't be made to work cleanly in runtime tests, ship A alone with a documented "arranges on first edit, not on open" caveat (still valid + persistable).

**Why A+B (not editor-on-open):** research confirmed the editor only reflows on explicit layout interaction, NOT on file open/render — so unlike text, we must pre-reflow for the file to look arranged.

**Tech Stack:** ClojureScript (`headless-core`), Node ESM, `node:test`, penpot-hl.

---

## HARD ISOLATION RULE
penpot-hl (:9101) only; never `penpot`/:9001. Branch `feat/penpot-headless-sdk`. Commits: identity `Gurupungav Narayanan <28506515+guru-irl@users.noreply.github.com>`, **NO `Co-Authored-By` / no "Claude" anywhere in messages** (memory `git-commit-no-claude-attribution`).

---

## File Structure
- `headless-core/src/app/headless/session.cljs` — add `:setFlexLayout` + a private `apply-changes!` helper + requires (`geom.modifiers`, `types.modifiers`, `geom.shapes`).
- `headless-core/sdk/working-copy.mjs` — add `setFlexLayout(boardId, opts)`.
- `headless-core/test/session.test.mjs` — unit: board + 3 rects → setFlexLayout(row, gap) → children repositioned contiguously + validate [].
- `headless-core/test/workingcopy.roundtrip.test.mjs` — live: arranged children persist.
- skill + README updates.

---

## Task 1: Engine — `setFlexLayout` (configure + reflow) [crux]

**Files:** Modify `session.cljs`, `test/session.test.mjs`.

- [ ] **Step 1: Failing unit test** — append to `test/session.test.mjs`:
```javascript
test("setFlexLayout arranges children in a row", () => {
  const s = createSession(JSON.stringify({ empty: true }));
  const b = s.addBoard(JSON.stringify({ x: 0, y: 0, width: 400, height: 120, name: "Row" }));
  // three rects placed at overlapping/arbitrary positions
  const ids = [0,1,2].map(i => s.addRect(JSON.stringify({ x: 0, y: 0, width: 80, height: 60, parentId: b })));
  s.closeBoard();
  const out = JSON.parse(s.setFlexLayout(b, JSON.stringify({ dir: "row", gap: 10, padding: 0 })));
  assert.ok(out.reflowed >= 3, "container + children reflowed");
  const objs = JSON.parse(s.objects());
  // board now carries the flex layout
  assert.equal(objs[b].layout, "flex");
  // children laid out left-to-right, non-overlapping, gap 10 (x: 0,90,180 within the board origin)
  const xs = ids.map(id => objs[id].selrect.x).sort((a,b)=>a-b);
  assert.ok(xs[1] - xs[0] >= 80 && xs[2] - xs[1] >= 80, `children spread by >=80 (got ${xs})`);
  assert.deepEqual(JSON.parse(s.validate()), []);
});
```

- [ ] **Step 2: Run → fail** — `cd headless-core && npm run build && node --test test/session.test.mjs` (FAIL: setFlexLayout missing).

- [ ] **Step 3: Implement** — in `session.cljs`:
  1. Add requires: `[app.common.geom.modifiers :as gm]`, `[app.common.types.modifiers :as ctm]`, `[app.common.geom.shapes :as gsh]`, and `[app.common.files.changes-builder :as pcb]` (if not already required).
  2. Add the default flex map (from `frontend/.../shape_layout.cljs` `initial-flex-layout`) and a private apply helper + the method:
```clojure
(def ^:private initial-flex-layout
  {:layout :flex :layout-flex-dir :row :layout-gap-type :multiple
   :layout-gap {:row-gap 0 :column-gap 0} :layout-align-items :start
   :layout-justify-content :start :layout-align-content :stretch
   :layout-wrap-type :nowrap :layout-padding-type :simple
   :layout-padding {:p1 0 :p2 0 :p3 0 :p4 0}})

(defn- objects-of [state] (get-in (:data @state) [:pages-index (:page-id @state) :objects]))

(defn- apply-changes! [state changes]
  (let [redo (:redo-changes changes)]
    (swap! state #(-> % (update :data cfc/process-changes redo false) (update :changes into redo)))
    redo))

;; inside make-session #js {...}:
       :setFlexLayout
       (fn [board-id opts-json]
         (let [{:keys [dir gap padding align justify wrap]} (args opts-json)
               bid  (uuid/parse board-id)
               pid  (:page-id @state)
               flex (cond-> initial-flex-layout
                      dir     (assoc :layout-flex-dir (keyword dir))
                      align   (assoc :layout-align-items (keyword align))
                      justify (assoc :layout-justify-content (keyword justify))
                      wrap    (assoc :layout-wrap-type (keyword wrap))
                      (some? gap)     (assoc :layout-gap {:row-gap gap :column-gap gap})
                      (some? padding) (assoc :layout-padding {:p1 padding :p2 padding :p3 padding :p4 padding}))
               ;; (A) set layout attrs on the board
               objs1 (objects-of state)
               ch1   (-> (pcb/empty-changes nil pid) (pcb/with-page-id pid) (pcb/with-objects objs1)
                         (pcb/update-shapes [bid] (fn [s] (merge s flex))))
               _     (apply-changes! state ch1)
               ;; (B) reflow children via Penpot's modifier engine
               objs2 (objects-of state)
               tree  {bid {:modifiers (ctm/reflow-modifiers)}}
               res   (gm/set-objects-modifiers tree objs2)
               ids   (vec (keys res))
               ch2   (-> (pcb/empty-changes nil pid) (pcb/with-page-id pid) (pcb/with-objects objs2)
                         (pcb/update-shapes ids (fn [s] (gsh/transform-shape s (get-in res [(:id s) :modifiers])))))
               _     (apply-changes! state ch2)]
           (js/JSON.stringify #js {:reflowed (count ids)})))
```
  *Executor verification (this is the risky part — verify each against real source, adapt, REPORT):*
  - `pcb/update-shapes` arity/behavior (`common/.../files/changes_builder.cljc:536`) — confirm `(update-shapes changes ids update-fn)` emits `:mod-obj` by diffing; confirm it needs `with-objects` (+ maybe `with-page-id`) set first.
  - `gm/set-objects-modifiers` (`common/.../geom/modifiers.cljc:325`) arity — research said `[modif-tree objects]`. Confirm and adapt if it needs a 3rd `params` arg.
  - `ctm/reflow-modifiers` (`common/.../types/modifiers.cljc:439`) — confirm it's the right empty-with-reflow seed.
  - `gsh/transform-shape` — research located it at `geom/shapes/transforms.cljc:483`; confirm the alias (`app.common.geom.shapes` vs `app.common.geom.shapes.transforms`) that exposes `transform-shape`, and its arity `(shape modifiers)`.
  - If `set-objects-modifiers` throws or returns empty (e.g. needs a bounds map / complete objects), debug with the in-memory session; if it can't be made to work after real effort, FALL BACK to Approach A: keep step (A) only, drop step (B), and adjust the test to assert the board has `:layout :flex` + validate [] (NOT child repositioning), and report DONE_WITH_CONCERNS noting reflow is deferred (children arrange on first edit in-editor).

- [ ] **Step 4: Build + run → pass** — `cd headless-core && npm run build && node --test test/session.test.mjs`. Iterate (edit cljs → rebuild → test). PASS when children are spread by ≥80 and validate []. Report the actual child x positions.

- [ ] **Step 5: Commit** — `git add headless-core/src/app/headless/session.cljs headless-core/test/session.test.mjs && git commit -m ":sparkles: headless session: setFlexLayout (configure + reflow children via Penpot's modifier engine)"` (NO Claude/Co-Authored-By).

---

## Task 2: WorkingCopy.setFlexLayout + live persist (TDD)

**Files:** Modify `sdk/working-copy.mjs`, `test/workingcopy.roundtrip.test.mjs`.

- [ ] **Step 1: Wrapper** — in `working-copy.mjs`: `setFlexLayout(boardId, opts) { return this.session.setFlexLayout(boardId, JSON.stringify(opts)); }`
- [ ] **Step 2: Failing live test** — add to `test/workingcopy.roundtrip.test.mjs`:
```javascript
test("WorkingCopy: flex layout arranges + persists", async () => {
  const wc = await new WorkingCopy(env.fileId, env.token).checkout();
  const b = wc.addBoard({ x: 1200, y: 60, width: 400, height: 120, name: "Flex Row" });
  const ids = [0,1,2].map(() => wc.addRect({ x: 0, y: 0, width: 80, height: 60, parentId: b }));
  wc.closeBoard();
  wc.setFlexLayout(b, { dir: "row", gap: 10 });
  assert.deepEqual(wc.validate(), []);
  await wc.commit();
  const after = await getFile(env.fileId, env.token);
  const board = after.raw.data.pagesIndex[after.pageId].objects[b];
  assert.equal(board.layout, "flex", "board persisted as flex container");
});
```
- [ ] **Step 3: Run → fix → pass** — `node --test test/workingcopy.roundtrip.test.mjs` (penpot-hl up). PASS when the flex board persists server-side with `layout:"flex"`. Report the server `:explain` if rejected.
- [ ] **Step 4: Commit** — `git add headless-core/sdk/working-copy.mjs headless-core/test/workingcopy.roundtrip.test.mjs && git commit -m ":white_check_mark: headless: WorkingCopy.setFlexLayout arranges + persists flex board"`

---

## Task 3: Skill + README + verify

- [ ] **Step 1: Full gate** — `cd headless-core && npm run verify && npm run sanity` → green. Report tails.
- [ ] **Step 2: Skill** (`~/.claude/skills/penpot-headless/SKILL.md`): add to the wc API: `wc.setFlexLayout(boardId, {dir:"row"|"column", gap, padding, align, justify, wrap})` → reflows children. Move "flex" from NOT-yet to supported (keep grid/ellipses/paths/components in NOT-yet). If Task 1 fell back to A-only, document the "arranges on first edit, not on open" caveat instead.
- [ ] **Step 3: README** — document `setFlexLayout`. Commit README only: `git add headless-core/README.md && git commit -m ":memo: headless: document setFlexLayout (Phase 1c flex)"` (no Claude).

---

## Phase 1c-2 Done = exit criteria
- `setFlexLayout` gives a board `:layout :flex` and (Approach B) reflows children into the flex arrangement; `validate()` `[]`.
- A flex board persists to penpot-hl with `layout:"flex"` (and, if B works, arranged child geometry).
- verify + sanity green; skill + README updated. If reflow was deferred (A-only), that's documented and flagged.

**Next:** Phase 1c-3 (`pp` CLI).
