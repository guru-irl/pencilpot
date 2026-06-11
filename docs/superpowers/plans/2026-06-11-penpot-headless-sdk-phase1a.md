# Penpot Headless SDK — Phase 1a (Working-Copy Core) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** A headless **working-copy** you can `checkout(fileId) → edit locally (instant, geometry-correct) → commit`, reusing Penpot's own engine, with the 3 test layers (Penpot's `common` suite as a gate + `validate-file!` parity + a live round-trip) behind one `npm run verify`.

**Architecture:** A stateful CLJS **session** (`app.headless.session`) holds the file-data value in an atom; each edit builds an `:add-obj`/`:mod-obj` change via `cts/setup-shape` (geometry) + replicates `app.common.files.builder`'s `commit-shape` (parent/frame wiring), applies it to the working copy via `app.common.files.changes/process-changes`, AND records it. `commit` transit-encodes the recorded changes into an `update-file` body. The session is exposed to JS as a plain `#js {…}` of closures over the atom (no `app.util.object`/frontend dep). A small ESM toolkit (`sdk/`) wraps it with an RPC client + `WorkingCopy` (checkout/commit with conflict re-fetch+replay).

**Tech Stack:** ClojureScript + shadow-cljs `:esm`/`:node` (engine), plain Node ESM (`.mjs`) toolkit + `node:test` (no TS build in 1a — matches Phase 0; TS typings deferred), the isolated `penpot-hl` instance for integration.

**Spec:** `docs/superpowers/specs/2026-06-11-penpot-headless-sdk-design.md` · **Builds on:** Phase 0 (`headless-core/`).

**Scope (1a):** board, rect, solid fill, stroke, absolute position, multi-op sessions, working-copy + commit (with conflict rebase), validate-as-parity, engine gate, round-trip, `verify`.
**Deferred to 1b:** text (`position-data` needs DOM), flex/grid reflow (`set-objects-modifiers` orchestration), the `script(js)` sandbox runtime, the `pp` CLI, the MCP server, the skill, golden `dump-file` snapshots. (1a ships the typed helper API — `addBoard`/`addRect`/… — which the `script()` runtime and CLI/MCP will wrap in 1b.)

---

## HARD ISOLATION RULE
All integration runs against the isolated **`penpot-hl`** instance (project `penpot-hl`, ports 9101/1180). NEVER touch the owner's `penpot`/9001 instance, its volumes, or `~/.local/share/penpot/*`. Build artifacts (`target/`, `node_modules`) under `headless-core/` are gitignored. Work on branch `feat/penpot-headless-sdk`.

---

## File Structure
- `headless-core/src/app/headless/session.cljs` — stateful session (`create-session` + edit/lookup/validate/commit-body), exported to JS.
- `headless-core/shadow-cljs.edn` — add `createSession` to `:exports`.
- `headless-core/sdk/rpc.mjs` — RPC client (get-file transit, update-file transit, Token auth).
- `headless-core/sdk/working-copy.mjs` — `WorkingCopy` (checkout/commit with conflict re-fetch+replay) over the CLJS session.
- `headless-core/sdk/index.mjs` — re-exports.
- `headless-core/test/session.test.mjs` — engine unit: build a session, add board+rect, assert objects + `validate()` passes (parity).
- `headless-core/test/workingcopy.roundtrip.test.mjs` — live: checkout penpot-hl file → add board+rect → commit → get-file confirms persistence.
- `headless-core/scripts/test-engine.mjs` — runs Penpot's `common` geometry+changes suite (the gate).
- `headless-core/package.json` — add `test:engine`, `test:unit`, `verify` scripts.
- `headless-core/README.md` — Phase 1a section.

---

## Task 1: Stateful session namespace (engine core)

**Files:** Create `headless-core/src/app/headless/session.cljs`; Modify `headless-core/shadow-cljs.edn`.

- [ ] **Step 1: Write the failing unit test** — `headless-core/test/session.test.mjs`
```javascript
import { test } from "node:test";
import assert from "node:assert/strict";
import { createSession } from "../target/headless/penpot.js";

// create a session over an EMPTY page (no transit hydrate needed for the unit test)
function newSession() {
  return createSession(JSON.stringify({ empty: true, name: "Test" }));
}

test("session adds a board and a nested rect with real geometry; validates", () => {
  const s = newSession();
  const boardId = s.addBoard(JSON.stringify({ x: 0, y: 0, width: 400, height: 300, name: "Board" }));
  assert.equal(typeof boardId, "string");
  const rectId = s.addRect(JSON.stringify({ x: 20, y: 20, width: 100, height: 60, name: "R", parentId: boardId, fills: [{ fillColor: "#ff0000" }] }));
  s.closeBoard();

  const objs = JSON.parse(s.objects());          // id -> shape map (plain)
  assert.ok(objs[boardId] && objs[boardId].type === "frame");
  assert.ok(objs[rectId] && objs[rectId].type === "rect");
  assert.equal(objs[rectId].selrect.width, 100);  // geometry from setup-shape
  assert.equal(objs[rectId].parentId, boardId);   // nesting wired

  const errs = JSON.parse(s.validate());          // Penpot's own validator
  assert.deepEqual(errs, [], "headless edits produce a Penpot-valid file");

  const changes = JSON.parse(s.pendingChanges()); // recorded changes
  assert.equal(changes.length, 2);
  assert.ok(changes.every((c) => c.type === "add-obj"));
});
```

- [ ] **Step 2: Run to verify it fails** — `cd headless-core && node --test test/session.test.mjs` → FAIL (`createSession` not exported / build missing).

- [ ] **Step 3: Implement** `headless-core/src/app/headless/session.cljs`
```clojure
(ns app.headless.session
  (:require
   [app.common.types.shape :as cts]              ; setup-shape (geometry)
   [app.common.files.changes :as cfc]            ; process-changes (apply to file-data)
   [app.common.files.validate :as cfv]           ; validate-file-schema! (parity oracle)
   [app.common.types.file :as ctf]               ; make-file-data, update-file-data
   [app.common.transit :as t]                    ; decode-str / encode-str (wire + record handlers)
   [app.common.uuid :as uuid]
   [app.common.geom.matrix]                       ; side-effect: transit handler
   [app.common.geom.point]                        ; side-effect: transit handler
   [clojure.walk :as walk]))

(def ^:private root-frame uuid/zero)              ; page root frame id

;; --- helpers ---------------------------------------------------------------
(defn- stringify-uuids [x] (walk/postwalk #(if (uuid? %) (str %) %) x))
(defn- ->plain-js [x] (-> x stringify-uuids clj->js))
(defn- args [json] (js->clj (js/JSON.parse json) :keywordize-keys true))

(defn- empty-data []
  ;; a single-page empty file-data with a page whose root frame is uuid/zero
  (let [page-id (uuid/next)]
    (-> (ctf/make-file-data (uuid/next) page-id)  ; (file-id page-id) -> data w/ that page
        (with-meta {::page-id page-id}))))

(defn- page-id-of [data] (-> data meta ::page-id))

;; Build + apply + record one :add-obj change (mirrors files.builder/commit-shape).
(defn- add-shape! [state shape]
  (let [{:keys [data page-id frame-id stack]} @state
        change {:type :add-obj :id (:id shape) :page-id page-id
                :parent-id (peek stack) :frame-id frame-id :obj shape}]
    (swap! state #(-> %
                      (update :data cfc/process-changes [change] false)
                      (update :changes conj change)))
    (str (:id shape))))

(defn- mk-shape [state type {:keys [x y width height name parentId fills strokes]}]
  (let [{:keys [stack frame-id]} @state]
    (cts/setup-shape
     (cond-> {:id (uuid/next) :type type :name (or name (clojure.core/name type))
              :x x :y y :width width :height height
              :parent-id (if parentId (uuid/uuid parentId) (peek stack))
              :frame-id frame-id}
       (seq fills)   (assoc :fills (mapv (fn [f] {:fill-color (:fillColor f)
                                                  :fill-opacity (or (:fillOpacity f) 1)}) fills))
       (seq strokes) (assoc :strokes strokes)))))

;; --- the JS-facing session object ------------------------------------------
(defn- make-session [state file-id features]
  #js {:addBoard
       (fn [json]
         (let [shape (mk-shape state :frame (args json))
               id    (add-shape! state shape)]
           ;; entering a board: push it as the parent + active frame
           (swap! state #(-> % (update :stack conj (:id shape)) (assoc :frame-id (:id shape))))
           id))
       :closeBoard
       (fn []
         (swap! state (fn [s]
                        (let [stack (pop (:stack s))]
                          (assoc s :stack stack :frame-id (or (peek stack) root-frame)))))
         js/undefined)
       :addRect  (fn [json] (add-shape! state (mk-shape state :rect (args json))))
       :objects  (fn [] (js/JSON.stringify (->plain-js (get-in (:data @state) [:pages-index (:page-id @state) :objects]))))
       :getShape (fn [id] (js/JSON.stringify (->plain-js (get-in (:data @state) [:pages-index (:page-id @state) :objects (uuid/uuid id)]))))
       :validate (fn []
                   (let [file {:id file-id :data (:data @state) :features features}]
                     (try (cfv/validate-file-schema! file) (js/JSON.stringify #js [])
                          (catch :default e (js/JSON.stringify #js [(ex-message e)])))))
       :pendingChanges (fn [] (js/JSON.stringify (->plain-js (:changes @state))))
       :commitBody
       (fn [json]
         (let [{:keys [sessionId revn vern]} (args json)
               params {:id file-id :session-id (uuid/uuid sessionId)
                       :revn revn :vern vern :features (set features) :changes (:changes @state)}]
           (t/encode-str params)))})

(defn ^:export create-session
  "args-json: either {empty:true,name} for a fresh file, or
   {dataTransit, fileId, features} hydrated from get-file (transit)."
  [args-json]
  (let [{:keys [empty dataTransit fileId features]} (args args-json)
        file-id (if fileId (uuid/uuid fileId) (uuid/next))
        data    (if empty (empty-data) (t/decode-str dataTransit))
        page-id (or (page-id-of data) (first (:pages data)))
        feats   (or features ["components/v2" "fdata/shape-data-type" "fdata/path-data"
                              "styles/v2" "layout/grid" "plugins/runtime"])]
    (make-session (atom {:data data :page-id page-id :frame-id root-frame
                         :stack [root-frame] :changes []})
                  file-id (set feats))))
```
*Executor notes (verify against real APIs; adjust minimally and report):*
- Confirm `ctf/make-file-data` arity and that it seeds `:pages`/`:pages-index` with the page id; if its signature differs (research said `make-file-data` exists), inspect `common/src/app/common/types/file.cljc` and adapt `empty-data` (you may instead build via `app.common.types.file/make-file` then read `:data`). The page's root objects must contain the root frame at `uuid/zero` for `:add-obj` parenting to validate — if not, seed it the way `make-file-data` does for a normal page.
- `clojure.set` needs requiring if you use `rename-keys`; or map fills manually. Keep fills minimal (`:fill-color`, `:fill-opacity`).
- `setup-shape` for `:frame` = board (Phase 0 confirmed). For `:rect`, same path.
- If `validate-file-schema!` is too strict on a partial file (e.g. missing required file keys), fall back to wrapping a fuller file map or use `cfv/validate-file-affected!`; report what you used.

- [ ] **Step 4: Add the export** — in `headless-core/shadow-cljs.edn` `:exports`, add: `createSession app.headless.session/create-session` (keep the existing `buildAddBoardChange`/`buildAddBoardBody`).

- [ ] **Step 5: Build** — `cd headless-core && npm run build` → 0 warnings, `target/headless/penpot.js` updated.

- [ ] **Step 6: Run the unit test** — `cd headless-core && node --test test/session.test.mjs` → PASS. Align plain-JS key casing in the test to what `clj->js` emits (kebab, e.g. `parent-id`, `selrect`) per Phase 0's learning; keep the semantic assertions (board=frame, rect geometry width 100, nested parent, validate empty, 2 changes).

- [ ] **Step 7: Commit** — `git add headless-core/src/app/headless/session.cljs headless-core/shadow-cljs.edn headless-core/test/session.test.mjs && git commit -m ":sparkles: headless-core: stateful working-copy session (board/rect, validate, changes)"`

---

## Task 2: RPC client (transit get-file/update-file)

**Files:** Create `headless-core/sdk/rpc.mjs`.

- [ ] **Step 1: Implement** `headless-core/sdk/rpc.mjs`
```javascript
// Penpot RPC client for the headless toolkit.
// Reads: get-file as transit (so the engine hydrates real records). Writes: update-file as transit.
const BASE = process.env.PENPOT_HL_BASE ?? "http://localhost:9101";

async function call(name, { token, body, contentType = "application/json", accept = "application/json" }) {
  const res = await fetch(`${BASE}/api/rpc/command/${name}`, {
    method: "POST",
    headers: { "Content-Type": contentType, Accept: accept, ...(token ? { Authorization: `Token ${token}` } : {}) },
    body,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${name} -> HTTP ${res.status}: ${text.slice(0, 500)}`);
  return { text, contentType: res.headers.get("content-type") || "" };
}

// get-file as TRANSIT (returns the raw transit string of the file) + revn/vern/features parsed from a JSON call.
export async function getFile(fileId, token) {
  // meta (revn/vern/features) via JSON (easy to read)
  const meta = JSON.parse((await call("get-file", { token, body: JSON.stringify({ id: fileId }) })).text);
  // data as transit so the engine can decode records faithfully
  const transit = (await call("get-file", {
    token, body: JSON.stringify({ id: fileId }), accept: "application/transit+json",
  })).text;
  return { revn: meta.revn, vern: meta.vern, features: meta.features, pageId: meta.data.pages[0], dataTransit: transit, raw: meta };
}

// update-file with a transit body produced by the session's commitBody().
export async function updateFile(transitBody, token) {
  const { text } = await call("update-file", {
    token, body: transitBody, contentType: "application/transit+json", accept: "application/json",
  });
  return JSON.parse(text); // { revn, lagged }
}

export { BASE };
```
*Note:* the transit `get-file` returns the WHOLE file as transit (including `data`); the session's `create-session` expects just the file `data` transit. In Task 3 the WorkingCopy will pass the transit through to the session, and the session decodes it — confirm whether `decode-str` of the full get-file transit yields a map with `:data`, and if so adjust the session to read `(:data decoded)`. (Resolve this concretely in Task 3 Step 3; it's the one integration seam.)

- [ ] **Step 2: Commit** — `git add headless-core/sdk/rpc.mjs && git commit -m ":sparkles: headless sdk: transit RPC client (get-file/update-file)"`

---

## Task 3: WorkingCopy (checkout → edit → commit, with conflict rebase)

**Files:** Create `headless-core/sdk/working-copy.mjs`, `headless-core/sdk/index.mjs`.

- [ ] **Step 1: Implement** `headless-core/sdk/working-copy.mjs`
```javascript
import { randomUUID } from "node:crypto";
import { createSession } from "../target/headless/penpot.js";
import { getFile, updateFile } from "./rpc.mjs";

export class WorkingCopy {
  constructor(fileId, token) { this.fileId = fileId; this.token = token; this._ops = []; }

  // checkout: pull current file (transit) into a fresh engine session
  async checkout() {
    const f = await getFile(this.fileId, this.token);
    this.revn = f.revn; this.vern = f.vern; this.features = f.features;
    this.session = createSession(JSON.stringify({ dataTransit: f.dataTransit, fileId: this.fileId, features: f.features }));
    this._ops = [];
    return this;
  }

  // record + apply an op so it can be replayed on conflict rebase
  _do(method, payload) { this._ops.push([method, payload]); return this.session[method](payload === undefined ? undefined : JSON.stringify(payload)); }
  addBoard(p) { return this._do("addBoard", p); }
  addRect(p)  { return this._do("addRect", p); }
  closeBoard(){ return this._do("closeBoard", undefined); }

  validate() { return JSON.parse(this.session.validate()); }
  pendingChanges() { return JSON.parse(this.session.pendingChanges()); }

  // commit recorded changes; on revn/vern conflict, re-checkout and replay ops once
  async commit({ retries = 1 } = {}) {
    const errs = this.validate();
    if (errs.length) throw new Error(`refusing to commit invalid file: ${errs.join("; ")}`);
    const body = this.session.commitBody(JSON.stringify({ sessionId: randomUUID(), revn: this.revn, vern: this.vern }));
    try {
      const res = await updateFile(body, this.token);
      this.revn = res.revn + 1;
      return res;
    } catch (e) {
      if (retries > 0 && /revn-conflict|vern-conflict/.test(String(e.message))) {
        const ops = this._ops.slice();
        await this.checkout();                 // rebase: fresh state
        for (const [m, p] of ops) this.session[m](p === undefined ? undefined : JSON.stringify(p));
        this._ops = ops;
        return this.commit({ retries: retries - 1 });
      }
      throw e;
    }
  }
}
```
- [ ] **Step 2: Implement** `headless-core/sdk/index.mjs` → `export { WorkingCopy } from "./working-copy.mjs"; export * as rpc from "./rpc.mjs";`

- [ ] **Step 3: Resolve the transit seam** — Write a 6-line probe: checkout the penpot-hl file (from `infra/penpot-hl/test-env.json`) and `console.log(wc.session.objects().length>0)`. If `create-session` fails to find the page/objects, the issue is the full-get-file transit vs just-`:data`: in `session.cljs` `create-session`, change `(t/decode-str dataTransit)` to read the file `:data` from the decoded map (e.g. `(:data (t/decode-str dataTransit))`), rebuild, re-probe. Commit the working fix to `session.cljs` if changed. Report what the decoded shape was.

- [ ] **Step 4: Commit** — `git add headless-core/sdk/working-copy.mjs headless-core/sdk/index.mjs && git commit -m ":sparkles: headless sdk: WorkingCopy checkout/commit with conflict rebase"`

---

## Task 4: Engine gate (run Penpot's common suite)

**Files:** Create `headless-core/scripts/test-engine.mjs`; Modify `headless-core/package.json`.

- [ ] **Step 1: Implement** `headless-core/scripts/test-engine.mjs`
```javascript
// Run Penpot's own common geometry + changes test suite headlessly as a parity gate.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
const common = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../common");
const NS = [
  "geom-rect-test","geom-point-test","geom-shapes-test","geom-shapes-constraints-test",
  "geom-shapes-corners-test","geom-shapes-intersect-test","geom-modifiers-test",
  "files-changes-test","files.validate-test","types.shape-decode-encode-test","types.shape-layout-test",
].map((n) => `common-tests.${n}`.replace("common-tests.types.", "common-tests.types."));
// build once, then run focused namespaces
execFileSync("corepack", ["pnpm", "run", "build:test"], { cwd: common, stdio: "inherit" });
for (const ns of NS) {
  console.log(`\n=== ${ns} ===`);
  execFileSync("node", ["target/tests/test.js", "--focus", ns], { cwd: common, stdio: "inherit" });
}
console.log("\nengine gate OK");
```
*Note:* `corepack`/`pnpm` must be on PATH (Phase 0 used a shim). If `corepack pnpm` isn't directly invocable, call `node` against shadow via `clojure -M:dev:shadow-cljs compile test` instead — match whatever Phase-0/common used. Confirm the focused namespace names against `common/test/common_tests/runner.cljc` (the research listed them) and fix any mismatches. The script must exit non-zero if any namespace fails (execFileSync throws on non-zero — good).

- [ ] **Step 2: Add scripts** to `headless-core/package.json`:
```json
"test:unit": "node --test test/session.test.mjs test/facade.test.mjs",
"test:engine": "node scripts/test-engine.mjs",
"test:roundtrip": "node --test test/workingcopy.roundtrip.test.mjs",
"verify": "npm run build && npm run test:unit && npm run test:engine && npm run test:roundtrip"
```
- [ ] **Step 3: Run** `cd headless-core && npm run test:engine` → all focused namespaces pass; prints "engine gate OK".
- [ ] **Step 4: Commit** — `git add headless-core/scripts/test-engine.mjs headless-core/package.json && git commit -m ":white_check_mark: headless-core: engine parity gate (Penpot common geom/changes suite)"`

---

## Task 5: Live round-trip via WorkingCopy

**Files:** Create `headless-core/test/workingcopy.roundtrip.test.mjs`.

- [ ] **Step 1: Implement the test**
```javascript
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { WorkingCopy } from "../sdk/index.mjs";
import { getFile } from "../sdk/rpc.mjs";

const env = JSON.parse(readFileSync(new URL("../../infra/penpot-hl/test-env.json", import.meta.url)));

test("WorkingCopy: checkout -> add board+rect -> commit -> persists & validates", async () => {
  const before = await getFile(env.fileId, env.token);
  const beforeCount = Object.keys(before.raw.data.pagesIndex[before.pageId].objects).length;

  const wc = await new WorkingCopy(env.fileId, env.token).checkout();
  const boardId = wc.addBoard({ x: 600, y: 60, width: 300, height: 200, name: "WC Board" });
  wc.addRect({ x: 620, y: 80, width: 120, height: 80, name: "WC Rect", parentId: boardId, fills: [{ fillColor: "#00aa55" }] });
  wc.closeBoard();
  assert.deepEqual(wc.validate(), [], "valid before commit");
  assert.equal(wc.pendingChanges().length, 2);

  const res = await wc.commit();
  assert.ok(typeof res.revn === "number");

  const after = await getFile(env.fileId, env.token);
  const afterCount = Object.keys(after.raw.data.pagesIndex[after.pageId].objects).length;
  assert.equal(afterCount, beforeCount + 2, "two objects added");
  const board = Object.values(after.raw.data.pagesIndex[after.pageId].objects).find((s) => s.name === "WC Board");
  assert.ok(board && board.type === "frame" && board.selrect.width === 300);
});
```
- [ ] **Step 2: Run & fix** — `cd headless-core && node --test test/workingcopy.roundtrip.test.mjs` (penpot-hl must be up; `test-env.json` present). Diagnose any update-file rejection from the `:explain` (most likely: changes for nested rect need the board's `:add-obj` to precede it — the session records in insertion order, so board-before-rect holds; or features mismatch — echo `before.features`). Report the first failure + fix. PASS when two objects persist and the board's geometry is correct.
- [ ] **Step 3: Commit** — `git add headless-core/test/workingcopy.roundtrip.test.mjs && git commit -m ":white_check_mark: headless-core: live WorkingCopy round-trip (board+rect persist)"`

---

## Task 6: One-command verify + docs

**Files:** Modify `headless-core/README.md`.

- [ ] **Step 1: Run the full gate** — `cd headless-core && npm run verify`. Expected: build (0 warnings) → unit (session+facade) → engine gate (common namespaces) → round-trip — all green. Fix any wiring so the single command passes end-to-end.
- [ ] **Step 2: Document** — add a "Phase 1a — working copy" section to `headless-core/README.md`: the `WorkingCopy` API (`checkout/addBoard/addRect/closeBoard/validate/commit`), the session model (local edits + accumulated changes + transit commit), `npm run verify` (and what each layer checks), and the 1b deferrals (text/flex/CLI/MCP/skill).
- [ ] **Step 2: Commit** — `git add headless-core/README.md && git commit -m ":memo: headless-core: document Phase 1a working-copy + verify"`

---

## Phase 1a Done = exit criteria
- `createSession`/`WorkingCopy` support checkout → add board+rect (geometry-correct, nested) → `validate()` (Penpot's own) returns no errors → `commit()` persists to a real file (revn increments, objects appear).
- `npm run verify` runs build + unit + Penpot's common engine gate + live round-trip, all green, one command.
- Conflict path: a `revn`/`vern` conflict triggers re-checkout + replay (covered by the WorkingCopy logic; exercised opportunistically).
- Runs only against `penpot-hl`; owner instance untouched.

**Next:** Phase 1b (text + flex/grid reflow, the `pp` CLI, the MCP server so Claude Code drives it directly, the skill, golden `dump-file` parity).
