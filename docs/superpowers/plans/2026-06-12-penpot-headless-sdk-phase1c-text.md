# Penpot Headless SDK — Phase 1c-1 (Text helper) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Add `addText` to the headless engine so an AI can place real text via `script`/`WorkingCopy` — built with Penpot's *own* `txt/change-text` + `setup-shape`, validated by Penpot's validator, persisted via `commit`.

**Architecture:** Extend the stateful session (`app.headless.session`) with an `addText` method using the verified canonical recipe (mirrors the plugin API `createText`): `cts/setup-shape {:type :text …}` → `(update :content app.common.types.text/change-text characters styles)` → `(dissoc :position-data)`, then the existing `add-shape!` (build `:add-obj` change + `process-changes` + record). Surface it on `WorkingCopy` (delegates to the session) so it works inside the MCP `script` tool. Honest limitation: `position-data` (font-metric layout) can't be computed headlessly — text is **schema-valid and persists**, and the editor recomputes precise layout on open.

**Tech Stack:** ClojureScript (`headless-core`), Node ESM toolkit, `node:test`, penpot-hl.

**Spec/prior:** `docs/superpowers/specs/2026-06-11-penpot-headless-sdk-design.md`; builds on Phase 1a/1b.

---

## HARD ISOLATION RULE
penpot-hl (:9101) only; never the owner's `penpot`/:9001. Branch `feat/penpot-headless-sdk`. Commits: identity already set to `Gurupungav Narayanan <28506515+guru-irl@users.noreply.github.com>`; **no `Co-Authored-By` / Claude mentions in messages** (see memory `git-commit-no-claude-attribution`).

---

## File Structure
- `headless-core/src/app/headless/session.cljs` — add `:addText` method + `[app.common.types.text :as txt]` require.
- `headless-core/sdk/working-copy.mjs` — add `addText(p)` delegating to the session.
- `headless-core/test/session.test.mjs` — add an addText unit test (validates, text type, content present).
- `headless-core/test/workingcopy.roundtrip.test.mjs` — extend to add+persist text (or a new test).
- `~/.claude/skills/penpot-headless/SKILL.md` — move text from "NOT yet" to supported; document `wc.addText`.
- `headless-core/README.md` — note addText in the wc API.

---

## Task 1: Engine — `addText` on the session (TDD)

**Files:** Modify `headless-core/src/app/headless/session.cljs`, `headless-core/test/session.test.mjs`.

- [ ] **Step 1: Failing unit test** — append to `headless-core/test/session.test.mjs`:
```javascript
test("addText creates a valid text shape with content", () => {
  const s = createSession(JSON.stringify({ empty: true }));
  const id = s.addText(JSON.stringify({ x: 10, y: 10, width: 200, height: 30, characters: "Hello headless", fontSize: 18, fills: [{ fillColor: "#111827" }] }));
  assert.equal(typeof id, "string");
  const objs = JSON.parse(s.objects());
  const t = objs[id];
  assert.equal(t.type, "text");
  // content is a root -> paragraph-set -> paragraph -> run with our text
  const runText = JSON.stringify(t.content);
  assert.match(runText, /Hello headless/);
  assert.deepEqual(JSON.parse(s.validate()), [], "text shape is Penpot-valid");
});
```

- [ ] **Step 2: Run → fail** — `cd headless-core && npm run build && node --test test/session.test.mjs` (FAIL: `s.addText` is not a function).

- [ ] **Step 3: Implement** — in `session.cljs`:
  1. Add to the `:require`: `[app.common.types.text :as txt]`.
  2. Add an `:addText` entry to the `#js {…}` in `make-session` (alongside `:addRect`):
```clojure
       :addText
       (fn [json]
         (let [{:keys [x y width height name characters fontSize fontId fills growType parentId]} (args json)
               {:keys [stack frame-id]} @state
               styles (cond-> {}
                        (seq fills) (assoc :fills (mapv (fn [f] {:fill-color (:fillColor f)
                                                                 :fill-opacity (or (:fillOpacity f) 1)}) fills))
                        fontSize    (assoc :font-size (str fontSize))
                        fontId      (assoc :font-id fontId :font-family fontId))
               shape (-> (cts/setup-shape
                          {:id (uuid/next) :type :text :name (or name "Text")
                           :x x :y y :width (or width 200) :height (or height 30)
                           :grow-type (keyword (or growType "auto-width"))
                           :parent-id (if parentId (uuid/parse parentId) (peek stack))
                           :frame-id frame-id})
                         (update :content txt/change-text (or characters "") styles)
                         (dissoc :position-data))]
           (add-shape! state shape)))
```
  *Notes:* `txt/change-text` (`common/src/app/common/types/text.cljc`) takes `(content text styles-map)` and applies `default-text-attrs` (font `sourcesanspro`, size "14", etc.); passing a `styles` map overrides per-run attrs (mirrors `frontend/.../plugins/api.cljs` createText). `:position-data` is intentionally omitted (optional; editor computes it on open). `add-shape!` already uses `(:parent-id shape)` for the change. If `change-text`'s arity rejects a trailing map (older Clojure variadic-kwargs), call it as `(update :content txt/change-text (or characters "") :fills (:fills styles) :font-size (:font-size styles))` style instead — verify against the real fn signature and adapt; report what you used.

- [ ] **Step 4: Build + run → pass** — `cd headless-core && npm run build && node --test test/session.test.mjs` → all pass (incl. the new test). If `validate()` flags the text shape, capture the error and fix the content/attrs against `schema:content`; report.

- [ ] **Step 5: Commit** — `git add headless-core/src/app/headless/session.cljs headless-core/test/session.test.mjs && git commit -m ":sparkles: headless session: addText via Penpot's txt/change-text (validates headlessly)"`

---

## Task 2: WorkingCopy.addText + live persistence (TDD)

**Files:** Modify `headless-core/sdk/working-copy.mjs`, `headless-core/test/workingcopy.roundtrip.test.mjs`.

- [ ] **Step 1: Add the wrapper** — in `working-copy.mjs`, alongside `addRect`:
```javascript
  addText(p) { return this.session.addText(JSON.stringify(p)); }
```

- [ ] **Step 2: Failing live test** — add to `headless-core/test/workingcopy.roundtrip.test.mjs`:
```javascript
test("WorkingCopy: add text persists with content", async () => {
  const before = await getFile(env.fileId, env.token);
  const beforeCount = Object.keys(before.raw.data.pagesIndex[before.pageId].objects).length;

  const wc = await new WorkingCopy(env.fileId, env.token).checkout();
  const id = wc.addText({ x: 700, y: 360, width: 240, height: 40, characters: "Headless Heading", fontSize: 24, fills: [{ fillColor: "#7c3aed" }] });
  assert.deepEqual(wc.validate(), []);
  await wc.commit();

  const after = await getFile(env.fileId, env.token);
  const afterCount = Object.keys(after.raw.data.pagesIndex[after.pageId].objects).length;
  assert.equal(afterCount, beforeCount + 1, "text object persisted");
  const t = Object.values(after.raw.data.pagesIndex[after.pageId].objects).find((s) => s.id === id);
  assert.ok(t && t.type === "text", "persisted shape is text");
});
```

- [ ] **Step 3: Run → fix → pass** — `cd headless-core && node --test test/workingcopy.roundtrip.test.mjs` (penpot-hl up; mutates the throwaway file — fine). Diagnose any `update-file` rejection from the server `:explain` (text content/attrs). PASS when the text persists server-side as `type:"text"`. Report the first failure + fix.

- [ ] **Step 4: Commit** — `git add headless-core/sdk/working-copy.mjs headless-core/test/workingcopy.roundtrip.test.mjs && git commit -m ":white_check_mark: headless: WorkingCopy.addText persists text on penpot-hl"`

---

## Task 3: Update skill + README + verify

**Files:** Modify `~/.claude/skills/penpot-headless/SKILL.md`, `headless-core/README.md`.

- [ ] **Step 1: Run full verify + sanity** — `cd headless-core && npm run verify && npm run sanity` → all green (the new text tests included in unit + roundtrip). Fix wiring if needed.
- [ ] **Step 2: Update the skill** — in `~/.claude/skills/penpot-headless/SKILL.md`:
  - Add to the `wc` API list: `wc.addText({x, y, width, height, characters, fontSize, fontId, fills, parentId, growType})` → returns the text shape id.
  - In "Current capabilities", MOVE text from "NOT yet" to "Supported now", but ADD a one-line caveat: *text is schema-valid and persists, but precise typographic layout (`position-data`) is computed by the editor when the file is opened (headless can't measure font metrics).* Keep flex/grid + ellipses/paths/components in "NOT yet".
- [ ] **Step 3: Update README** — add `addText` to the Phase 1b/wc API section with the same caveat.
- [ ] **Step 4: Commit** — `git add headless-core/README.md && git commit -m ":memo: headless: document addText (Phase 1c)"` (the skill lives in ~/.claude/skills, outside the repo — note it's updated; no repo commit for it).

---

## Phase 1c-1 Done = exit criteria
- `wc.addText(...)` / `session.addText(...)` create a Penpot-valid text shape headlessly; `validate()` returns `[]`.
- A text shape persists to penpot-hl via `commit` as `type:"text"` with the given characters.
- `npm run verify` + `npm run sanity` green; skill + README document `addText` with the position-data caveat.

**Next:** Phase 1c-2 (flex/grid auto-layout), then 1c-3 (`pp` CLI).
