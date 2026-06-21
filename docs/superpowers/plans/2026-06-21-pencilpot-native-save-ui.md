# Pencilpot Native Save UI + Injection Teardown — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace pencilpot's injected save-manager chrome with native Penpot CLJS/SCSS — driving the real workspace header for save status and rename — and remove all DOM/script injection left over from earlier work.

**Architecture:** The runtime keeps the manual-save model (update-file stages edits in an in-memory working copy; explicit Save flushes to disk; `/pencilpot/live` SSE pushes `status`/`reload` events). Today a string of injected JS (`frontend.mjs` `liveUpdateScript`) renders a save badge, a toast, an external-changes banner, Ctrl/Cmd+S handling and a tab-title dot. We move ALL of that behavior into a native CLJS namespace (`app.main.data.pencilpot`) and Penpot's own header (`left_header.cljs`) + File menu (`main_menu.cljs`), fix two real runtime bugs (spurious dirty; non-persisting rename), and polish the variable-axes panel. The served `config.js` keeps only legitimate bootstrap globals already consumed by native CLJS.

**Tech Stack:** ClojureScript (rumext/React, shadow-cljs), SCSS modules (`stl/css`), Node ESM runtime (pencilpot/runtime), node:test.

## Global Constraints

- **No DOM/script injection.** All UI behavior lives in native Penpot CLJS/SCSS. The only allowed injected `config.js` content is bootstrap config globals already consumed natively: `penpotPublicURI`, `penpotFlags`, `pencilpotFile` (read by `frontend/src/app/main/ui/routes.cljs:43`). The `gfonts.mjs` gstatic URL rewrite is a network font proxy, NOT DOM injection — it stays.
- **SVG renderer**, never wasm. Do not enable render-wasm.
- **Frontend rebuild command** (run from `frontend/`): `clojure -M:dev:shadow-cljs release main worker`. Output lands in `frontend/resources/public/js/` (served by `pencilpot/runtime/static.mjs`).
- **Save model:** update-file stages into the in-memory working copy (`worktree.mjs`); disk is written only on `POST /pencilpot/save`. Dirty must be true ONLY when staged content actually differs from the last-saved content.
- **Dot colors:** orange (`#f5a623`) = unsaved, green (`#2c7a3f`) = saved, blue (`#7b61ff`) = saving.
- **Design copies only.** Never edit the canonical `.penpot` or the user's original design during verification — use a throwaway import under `/tmp`.
- **Pencilpot mode signal:** native CLJS gates on `(goog.object/get js/globalThis "pencilpotFile")` being non-nil (same check `routes.cljs` already uses). No new global is introduced.
- **edit tool:** each edits[] entry contains ONLY `oldText`/`newText`.

---

## File Structure

**Runtime (Node, no rebuild):**
- `pencilpot/runtime/worktree.mjs` — add content-signature dirty detection (T1).
- `pencilpot/runtime/rpc.mjs` — add `:rename-file` RPC handler (T2).
- `pencilpot/runtime/frontend.mjs` — strip injected behavior; keep config globals (T6).
- `pencilpot/runtime/proxy.mjs` — remove dead `proxyHttp` config-rewrite (T6).
- `pencilpot/test/worktree.test.mjs`, `pencilpot/test/rpc.test.mjs` (new) — Node tests (T1, T2).

**Frontend (CLJS/SCSS, requires rebuild):**
- `frontend/src/app/main/data/pencilpot.cljs` (new) — native save client (T3).
- `frontend/src/app/main.cljs` — start the client in `init` (T3).
- `frontend/src/app/main/ui/workspace/left_header.cljs` + `.scss` — title + status subtitle + dot + rename trigger (T4).
- `frontend/src/app/main/ui/workspace/main_menu.cljs` — File > Save, Rename (T5).
- `frontend/src/app/main/ui/workspace/sidebar/options/menus/typography.scss` — axes padding (T7).
- `frontend/src/app/main/ui/workspace/sidebar/options/menus/typography.cljs` — axis tooltip (T8).

**Injection inventory (T6 removes/migrates all objectionable items):**

| Injected item | Location | Disposition |
|---|---|---|
| Save badge (bottom-left) | `frontend.mjs` liveUpdateScript | Remove → native header status (T3/T4) |
| Saved toast | `frontend.mjs` liveUpdateScript | Remove (issue 4) |
| External-changes banner | `frontend.mjs` liveUpdateScript | Migrate → CLJS notification (T3) |
| Ctrl/Cmd+S handler | `frontend.mjs` liveUpdateScript | Migrate → CLJS (T3) |
| beforeunload guard | `frontend.mjs` liveUpdateScript | Migrate → CLJS (T3) |
| Tab-title `●`/`…` dot | `frontend.mjs` liveUpdateScript | Remove (status now in header) |
| `pencilpotBuild` global + console build-stamp | `frontend.mjs` configJs | Remove (cosmetic) |
| `window.__pencilpot*` flags | `frontend.mjs` | Remove with the script |
| Dead `proxyHttp` config-rewrite | `proxy.mjs` | Remove (unused; `readBody`/`attachWsStub` stay) |
| `penpotPublicURI`, `penpotFlags`, `pencilpotFile` globals | `configJs`/`static.mjs` | **Keep** (native bootstrap config) |
| gstatic font URL rewrite | `gfonts.mjs` | **Keep** (network proxy, not injection) |

---

## Task Dependency Order

T1, T2 (runtime, independent) → T3 (CLJS client) → T4, T5 (consume client) → T6 (teardown, after CLJS client exists) → T7, T8 (typography, independent of save) → T9 (build + verify + commit). T7/T8 may be done any time before T9.

---

### Task 1: Content-signature dirty detection

**Files:**
- Modify: `pencilpot/runtime/worktree.mjs` (`stage`, `save`, `status`, module state)
- Test: `pencilpot/test/worktree.test.mjs`

**Interfaces:**
- Consumes: existing `stage(dir, parts, revn)`, `save()`, `status()`.
- Produces: `stage` sets `_dirty` true ONLY when `sig(parts) !== _savedSig`; `save()` updates `_savedSig` to the just-written content; `status()` unchanged shape `{dirty, revn, savedRevn, design}`.

**Background:** Today `rpc.mjs persistChanges` calls `broadcastStatus(true)` on EVERY update-file, and `worktree.stage` sets `_dirty = true` unconditionally. The SPA fires update-file for non-content events (load, viewport, selection), so the design goes dirty spuriously. Fix: compute a stable content signature of the serialized working copy and compare to the last-saved signature.

- [ ] **Step 1: Write the failing test**

Add to `pencilpot/test/worktree.test.mjs` (create if absent; mirror existing test style — it imports from `../runtime/worktree.mjs`). The signature must be order-stable over `parts.pages`/`parts.components` maps.

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { open, stage, save, status } from "../runtime/worktree.mjs";

function tmpDesign() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pp-wt-"));
  fs.writeFileSync(path.join(dir, "manifest.edn"), '{:name "X"}');
  fs.mkdirSync(path.join(dir, "pages"));
  return dir;
}
const parts = (name) => ({ manifest: `{:name "${name}"}`, pages: { p1: "{:a 1}" }, components: {}, media: [] });

test("staging identical content does not mark dirty", () => {
  const dir = tmpDesign();
  open(dir);
  stage(dir, parts("X"), 1);          // same content as saved baseline
  assert.equal(status().dirty, false, "no-op stage must not be dirty");
});

test("staging changed content marks dirty; save clears it", () => {
  const dir = tmpDesign();
  open(dir);
  stage(dir, parts("Y"), 2);          // changed
  assert.equal(status().dirty, true, "changed content is dirty");
  save();
  assert.equal(status().dirty, false, "save clears dirty");
  stage(dir, parts("Y"), 3);          // same as just-saved
  assert.equal(status().dirty, false, "re-staging saved content is not dirty");
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run (from `pencilpot/`): `node --test test/worktree.test.mjs`
Expected: FAIL (staging identical content currently reports dirty=true). If `open` is named differently in worktree.mjs, read the file and use the actual init export.

- [ ] **Step 3: Implement signature-based dirty**

In `worktree.mjs`: add a module-level `_savedSig` and a `computeSig(parts)` helper (stable JSON of manifest + sorted page/component entries + media). In `stage`, set `_dirty = (computeSig(parts) !== _savedSig)` instead of `_dirty = true`. On `open`/load, set `_savedSig = computeSig(currentParts)` from the freshly-read design. In `save`, after `writeDesign`, set `_savedSig = computeSig(_store)`.

```js
import crypto from "node:crypto";
function computeSig(parts) {
  if (!parts) return "";
  const norm = {
    manifest: parts.manifest || "",
    pages: Object.keys(parts.pages || {}).sort().map((k) => [k, parts.pages[k]]),
    components: Object.keys(parts.components || {}).sort().map((k) => [k, parts.components[k]]),
    media: [...(parts.media || [])].sort(),
  };
  return crypto.createHash("sha1").update(JSON.stringify(norm)).digest("hex");
}
```

Wire `_savedSig` at the three points above. Keep `broadcastStatus` callers as-is for now; `persistChanges` should broadcast the ACTUAL `status().dirty` after `stage`, not a hardcoded `true` — adjust `rpc.mjs persistChanges` to `broadcastStatus(status().dirty, revn)` (import `status` from worktree).

- [ ] **Step 4: Run the test, verify it passes**

Run: `node --test test/worktree.test.mjs`
Expected: PASS (3/3). Also run the full unit tier: `node run-tests.mjs --unit` → 0 failures.

- [ ] **Step 5: Commit**

```bash
git add pencilpot/runtime/worktree.mjs pencilpot/runtime/rpc.mjs pencilpot/test/worktree.test.mjs
git commit -m "fix(pencilpot): mark design dirty only when staged content actually differs"
```

---

### Task 2: Rename-file persistence

**Files:**
- Modify: `pencilpot/runtime/rpc.mjs` (add `:rename-file` command handler before the unknown-RPC fallback)
- Test: `pencilpot/test/rpc.test.mjs` (new)

**Interfaces:**
- Consumes: `getStore`/`stage` from `worktree.mjs`, `broadcastStatus` from `live.mjs`, `status()` from T1.
- Produces: `POST /api/rpc/command/rename-file` with transit/JSON `{id, name}` updates the working-copy `manifest.edn` `:name` and marks the design dirty (saved on next Save). Returns benign 200.

**Background:** The SPA's `dw/rename-file` (workspace.cljs:564) optimistically updates SPA state then calls `(rp/cmd! :rename-file {:id :name})`. Pencilpot currently drops it via the unknown-RPC fallback (rpc.mjs:322), so the new name never reaches disk. The design name lives as the top-level `:name` in `manifest.edn` (see `store/store.mjs`).

- [ ] **Step 1: Write the failing test**

`pencilpot/test/rpc.test.mjs`: stage a working copy, invoke the rename handler with a new name, assert the staged manifest's `:name` changed and status is dirty. (Read `rpc.mjs` first to call the handler the way the suite already does — either through the exported HTTP handler or a direct helper. If only the HTTP handler is exported, drive it with a minimal mock `req`/`res` like existing tests do.)

```js
import { test } from "node:test";
import assert from "node:assert/strict";
// ... set up a tmp design via worktree.open, then POST rename-file ...
test("rename-file updates working-copy manifest :name and marks dirty", async () => {
  // arrange: open tmp design with manifest {:name "Old"}
  // act: call rename handler with {id, name:"New Name"}
  // assert: getStore(dir).manifest matches /:name\s+"New Name"/ ; status().dirty === true
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `node --test test/rpc.test.mjs` → FAIL (no rename handler; name unchanged).

- [ ] **Step 3: Implement the handler**

In `rpc.mjs`, before the unknown-RPC fallback (line ~322), add:

```js
if (command === "rename-file") {
  const body = (await readBody(req)).toString("utf8");
  // name arrives as transit ~:name or JSON :name; extract robustly
  const m = body.match(/"~:name"\s*,?\s*"([^"]*)"/) || body.match(/:name\s+"([^"]*)"/);
  const newName = m ? m[1] : null;
  const store = getStore(cfg.design);
  if (newName != null && store) {
    // top-level manifest :name — replace the first :name "..." occurrence
    store.manifest = store.manifest.replace(/(:name\s+)"(?:[^"\\]|\\.)*"/, `$1${JSON.stringify(newName)}`);
    stage(cfg.design, store, /* revn */ undefined);
    broadcastStatus(status().dirty, 0);
  }
  res.writeHead(200, { "content-type": "application/transit+json" });
  return res.end('["^ "]');
}
```

Verify the manifest `:name` regex against a real `manifest.edn` (read one first — confirm the top-level `:name` is the file name, not a nested one; if nested names exist, anchor the replace to the first occurrence which is the file name). If `stage`'s signature requires a revn, pass the current `status().revn`.

- [ ] **Step 4: Run the test, verify it passes**

Run: `node --test test/rpc.test.mjs` → PASS. Full unit tier: `node run-tests.mjs --unit` → 0 failures.

- [ ] **Step 5: Commit**

```bash
git add pencilpot/runtime/rpc.mjs pencilpot/test/rpc.test.mjs
git commit -m "feat(pencilpot): persist file rename to manifest via rename-file RPC"
```

---

### Task 3: Native pencilpot save client (CLJS)

**Files:**
- Create: `frontend/src/app/main/data/pencilpot.cljs`
- Modify: `frontend/src/app/main.cljs` (call `start-client!` in `^:export init`)

**Interfaces:**
- Produces (consumed by T4, T5):
  - `app.main.data.pencilpot/status` — a cljs atom holding `{:dirty bool :saving bool}` (IWatchable → `mf/deref`-able).
  - `app.main.data.pencilpot/rename-request` — a cljs atom (integer tick); `request-rename!` bumps it.
  - `app.main.data.pencilpot/save!` — `(fn [] …)` POSTs `/pencilpot/save`.
  - `app.main.data.pencilpot/enabled?` — true when `globalThis.pencilpotFile` is set.
  - `app.main.data.pencilpot/start-client!` — idempotent; opens SSE, binds Ctrl/Cmd+S + beforeunload.

- [ ] **Step 1: Create the namespace**

```clojure
(ns app.main.data.pencilpot
  "Native pencilpot manual-save integration: save status, Ctrl/Cmd+S, the
   external-change notification and the File>Rename trigger. Replaces the former
   injected save-manager script. Active only when the served config.js set
   globalThis.pencilpotFile (same signal app.main.ui.routes uses)."
  (:require
   [app.main.data.notifications :as ntf]
   [app.main.store :as st]
   [app.util.i18n :refer [tr]]
   [goog.object :as gobj]))

(defn enabled? []
  (some? (gobj/get js/globalThis "pencilpotFile")))

;; {:dirty bool :saving bool} — plain atom so the header can mf/deref it.
(defonce status (atom {:dirty false :saving false}))

;; Bumped to ask the header to enter file-name editing (File > Rename).
(defonce rename-request (atom 0))
(defn request-rename! [] (swap! rename-request inc))

(defn save! []
  (let [{:keys [dirty saving]} @status]
    (when (and dirty (not saving))
      (swap! status assoc :saving true)
      (-> (js/fetch "/pencilpot/save" #js {:method "POST"})
          (.then  (fn [_] (reset! status {:dirty false :saving false})))
          (.catch (fn [_] (swap! status assoc :saving false)
                    (js/alert "pencilpot: save failed — check the runtime log.")))))))

(defn- on-status [ev]
  (let [d (js/JSON.parse (gobj/get ev "data"))]
    ;; ignore status echoes while our own save is in flight
    (when-not (:saving @status)
      (swap! status assoc :dirty (boolean (gobj/get d "dirty"))))))

(defn- on-reload [_ev]
  ;; external CLI/MCP edit on disk — offer a reload (no auto-reload: it would
  ;; throw away in-progress UI state). Use Penpot's notification system; read
  ;; app.main.data.notifications for the exact action shape (ntf/show with
  ;; :actions, or ntf/info as a minimal fallback).
  (st/emit! (ntf/info (tr "pencilpot.external-changes"))))

(defonce ^:private started? (atom false))

(defn start-client! []
  (when (and (enabled?) (not @started?))
    (reset! started? true)
    (let [es (js/EventSource. "/pencilpot/live")]
      (.addEventListener es "status" on-status)
      (.addEventListener es "reload" on-reload))
    (.addEventListener
     js/window "keydown"
     (fn [e]
       (when (and (or (.-ctrlKey e) (.-metaKey e)) (not (.-altKey e))
                  (or (= (.-key e) "s") (= (.-key e) "S")))
         (.preventDefault e) (.stopPropagation e) (save!)))
     true)
    (.addEventListener
     js/window "beforeunload"
     (fn [e] (when (:dirty @status) (set! (.-returnValue e) "") "")))))
```

Notes for the implementer: if `app.util.i18n` has no `pencilpot.external-changes` key, either add it to the translations or pass a literal string to `ntf/info`. Prefer a notification with a "Refresh" action if the notification schema supports `:actions` (read `notifications.cljs`); the literal-string `ntf/info` is the minimum acceptable.

- [ ] **Step 2: Start the client from app init**

In `frontend/src/app/main.cljs`, require the namespace and call `start-client!` near the end of `^:export init` (after `init-ui`):

```clojure
;; in the ns :require
[app.main.data.pencilpot :as pencilpot]
;; in init, after (init-ui):
(pencilpot/start-client!)
```

- [ ] **Step 3: Compile-check**

Run (from `frontend/`): `clojure -M:dev:shadow-cljs release main worker` and confirm 0 warnings/errors for these namespaces. (Full browser verification happens in T9; this step is a compile gate.)

- [ ] **Step 4: Commit**

```bash
git add frontend/src/app/main/data/pencilpot.cljs frontend/src/app/main.cljs
git commit -m "feat(pencilpot): native save client (status, Ctrl/Cmd+S, SSE) replacing injected script"
```

---

### Task 4: Native header — title + save-status subtitle + dot (issue 2) + rename trigger

**Files:**
- Modify: `frontend/src/app/main/ui/workspace/left_header.cljs`
- Modify: `frontend/src/app/main/ui/workspace/left_header.scss`

**Interfaces:**
- Consumes: `app.main.data.pencilpot/status`, `/rename-request`, `/enabled?` (T3); existing `editing*` state + `start-editing-name`/`handle-blur` rename flow already in this file.
- Produces: header renders file name as the title with a status subtitle below it: a colored dot (orange/green/blue) + "Unsaved changes" / "Saved" / "Saving…". Pencilpot status REPLACES the native `persistence-status` icon widget when `pencilpot/enabled?`.

**Background:** `left_header.cljs` already has double-click-to-rename (`:on-double-click start-editing-name` → `editing*` → `dw/rename-file`). The native `persistence-status` widget (the `(case persistence-status …)` block) is the duplicate indicator. Replace it (under pencilpot) with the pencilpot status subtitle + dot. Add an effect that watches `pencilpot/rename-request` to enter editing mode (so File>Rename works).

- [ ] **Step 1: Require the client + read status**

Add to the `:require`: `[app.main.data.pencilpot :as pencilpot]`. In the `let`, add:
```clojure
pp-enabled? (pencilpot/enabled?)
pp-status   (mf/deref pencilpot/status)
pp-rename   (mf/deref pencilpot/rename-request)
```

- [ ] **Step 2: Trigger editing from File > Rename**

Add an effect that enters editing mode when `rename-request` changes (skip the initial 0):
```clojure
(mf/with-effect [pp-rename]
  (when (and pp-enabled? (pos? pp-rename))
    (reset! editing* true)))
```

- [ ] **Step 3: Replace the persistence widget with pencilpot status (subtitle + dot)**

In the non-editing branch (the `:file-name` div), restructure so the file name is the title and a status row sits below it. Under `pp-enabled?`, render the pencilpot status instead of the native `(case persistence-status …)` icon:

```clojure
[:div {:class (stl/css :file-name)
       :title file-name
       :on-double-click start-editing-name}
 [:div {:class (stl/css :file-name-label)} file-name]
 (when ^boolean pp-enabled?
   (let [{:keys [dirty saving]} pp-status
         state (cond saving :saving dirty :unsaved :else :saved)]
     [:div {:class (stl/css :pp-save-status)}
      [:span {:class (stl/css :pp-save-dot
                              (case state :saving :pp-dot-saving
                                          :unsaved :pp-dot-unsaved
                                          :pp-dot-saved))}]
      [:span {:class (stl/css :pp-save-text)}
       (case state :saving "Saving…" :unsaved "Unsaved changes" "Saved")]]))]
```

Keep the original native `persistence-status` block as the `(when-not pp-enabled? …)` fallback so stock Penpot is unaffected.

- [ ] **Step 4: SCSS — title up, subtitle below, dot left**

In `left_header.scss` add:
```scss
.pp-save-status {
  display: flex;
  align-items: center;
  gap: var(--sp-xs);
  margin-block-start: 2px;
}
.pp-save-dot {
  inline-size: 8px;
  block-size: 8px;
  border-radius: 50%;
  flex: none;
}
.pp-dot-unsaved { background: #f5a623; }
.pp-dot-saved   { background: #2c7a3f; }
.pp-dot-saving  { background: #7b61ff; }
.pp-save-text {
  @include t.use-typography("body-small");
  color: var(--color-foreground-secondary);
}
```
Adjust the existing `.file-name` rule so it stacks the label (title) above `.pp-save-status` (e.g. `flex-direction: column; align-items: flex-start;`). Read the current `.file-name`/`.file-name-label` rules first and integrate, don't blindly append.

- [ ] **Step 5: Compile-check + commit**

Run (from `frontend/`): `clojure -M:dev:shadow-cljs release main worker` → 0 errors. Visual verification in T9.
```bash
git add frontend/src/app/main/ui/workspace/left_header.cljs frontend/src/app/main/ui/workspace/left_header.scss
git commit -m "feat(pencilpot): show save status (dot + Unsaved/Saved) under file title in workspace header"
```

---

### Task 5: File menu — Save + Rename items (issue 5)

**Files:**
- Modify: `frontend/src/app/main/ui/workspace/main_menu.cljs` (`file-menu*`, defc at line ~554)

**Interfaces:**
- Consumes: `app.main.data.pencilpot/save!`, `/request-rename!`, `/enabled?` (T3).
- Produces: two new `dropdown-menu-item*` entries in `file-menu*` — "Save" (calls `pencilpot/save!`) and "Rename" (calls `pencilpot/request-rename!`), shown only when `pencilpot/enabled?`.

- [ ] **Step 1: Require + handlers**

Add to `:require`: `[app.main.data.pencilpot :as pencilpot]`. In the `file-menu*` `let`, add handlers mirroring the existing `on-*`/`on-*-key-down` pattern:
```clojure
pp-enabled? (pencilpot/enabled?)
on-pp-save  (mf/use-fn (fn [_] (pencilpot/save!)))
on-pp-save-key-down (mf/use-fn (mf/deps on-pp-save) (fn [e] (when (kbd/enter? e) (on-pp-save e))))
on-pp-rename (mf/use-fn (fn [_] (pencilpot/request-rename!)))
on-pp-rename-key-down (mf/use-fn (mf/deps on-pp-rename) (fn [e] (when (kbd/enter? e) (on-pp-rename e))))
```

- [ ] **Step 2: Render the items**

At the top of the `dropdown-menu*` body in `file-menu*`, add (under `pp-enabled?`):
```clojure
(when ^boolean pp-enabled?
  [:*
   [:> dropdown-menu-item* {:class (stl/css :base-menu-item :submenu-item)
                            :on-click on-pp-save :on-key-down on-pp-save-key-down
                            :id "file-menu-pencilpot-save"}
    [:span {:class (stl/css :item-name)} "Save"]]
   [:> dropdown-menu-item* {:class (stl/css :base-menu-item :submenu-item)
                            :on-click on-pp-rename :on-key-down on-pp-rename-key-down
                            :id "file-menu-pencilpot-rename"}
    [:span {:class (stl/css :item-name)} "Rename"]]])
```
Match the exact markup of neighboring items (read 2-3 existing `dropdown-menu-item*` in this file and copy their `:span`/class structure). If a shortcut hint is shown by siblings, add "⌘S/Ctrl+S" to Save consistently.

- [ ] **Step 3: Compile-check + commit**

Run: `clojure -M:dev:shadow-cljs release main worker` → 0 errors.
```bash
git add frontend/src/app/main/ui/workspace/main_menu.cljs
git commit -m "feat(pencilpot): add Save and Rename items to the workspace File menu"
```

---

### Task 6: Injection teardown (issue 4 + no-injection directive)

**Files:**
- Modify: `pencilpot/runtime/frontend.mjs` (remove `liveUpdateScript`; trim `configJs`)
- Modify: `pencilpot/runtime/proxy.mjs` (remove dead `proxyHttp` config-rewrite)
- Modify: `pencilpot/test/*` if any test asserts on the injected script (update/remove)

**Interfaces:**
- Consumes: nothing new.
- Produces: served `config.js` body = ONLY `penpotPublicURI`, `penpotFlags`, `pencilpotFile` globals (no `pencilpotBuild`, no console stamp, no `liveUpdateScript`). `proxy.mjs` exports `readBody` + `attachWsStub` unchanged; the unused `proxyHttp` config-rewrite is gone.

**Background:** Must land AFTER T3 (native client) so save/Ctrl+S/status are not lost. Confirm `proxyHttp` is unused: `grep -rn proxyHttp runtime/` shows only its definition. `readBody` and `attachWsStub` are the only imported members of `proxy.mjs`.

- [ ] **Step 1: Trim `configJs`**

In `frontend.mjs`, reduce `configJs` to the kept globals and delete `buildStamp`/`pencilpotBuild`/the `console.log` stamp/`liveUpdateScript()`:
```js
export function configJs({ publicUri = "", fileId = null, teamId = null } = {}) {
  return `globalThis.penpotPublicURI=${publicUri ? JSON.stringify(publicUri) : "location.origin"};`
    + `globalThis.penpotFlags="disable-render-wasm-info";`
    + `globalThis.pencilpotFile=${JSON.stringify({ fileId, teamId })};`;
}
```

- [ ] **Step 2: Delete `liveUpdateScript` and `buildStamp`**

Remove the entire `liveUpdateScript()` function and the `buildStamp()` helper (and any now-unused imports: `execSync`, `fs`, `path` if no longer referenced — check before removing each import).

- [ ] **Step 3: Remove dead `proxyHttp` config-rewrite**

In `proxy.mjs`, delete the `proxyHttp` export (lines ~8-19, the function with the `rewriteConfig`/`/js/config.js` append). Leave `readBody` and `attachWsStub` intact. Confirm nothing imports `proxyHttp` first.

- [ ] **Step 4: Verify no injection remains + tests pass**

Run (from `pencilpot/`):
```bash
grep -rnE "createElement|liveUpdateScript|pencilpotBuild|__pencilpot|proxyHttp" runtime/ | grep -v node_modules
```
Expected: no DOM-injection / removed-symbol hits (only comments referencing history are acceptable — update stale comments in `live.mjs`/`frontend.mjs` that mention "the injected save-manager script").
Run: `node run-tests.mjs --unit` → 0 failures (fix/remove any test asserting the old injected script).

- [ ] **Step 5: Commit**

```bash
git add pencilpot/runtime/frontend.mjs pencilpot/runtime/proxy.mjs pencilpot/test
git commit -m "refactor(pencilpot): remove injected save-manager + dead config-rewrite; keep only native config globals"
```

---

### Task 7: Variable-axes panel padding (issue 6)

**Files:**
- Modify: `frontend/src/app/main/ui/workspace/sidebar/options/menus/typography.scss` (`.variation-axis`, `.variation-grid`)

**Interfaces:** none (pure SCSS).

**Background:** In `font-variation-options` (typography.cljs) each `.variation-axis` cell has `padding-inline-start: var(--sp-s)` but no inline-end padding, so the numeric value sits flush against the right edge / the adjacent field. Add inline-end padding (and confirm grid gap) so values don't stick to the right.

- [ ] **Step 1: Add inline-end padding**

```scss
.variation-axis {
  @extend %input-element;
  @include t.use-typography("body-small");
  gap: var(--sp-xs);
  padding-inline-start: var(--sp-s);
  padding-inline-end: var(--sp-s);   // ← values no longer stick to the right
}
```
If after a visual check the value still crowds the field, also give `.variation-axis-input` `padding-inline-end: var(--sp-xs);` and/or bump `.variation-grid { gap: var(--sp-s); }`. Decide from the rendered result in T9.

- [ ] **Step 2: Compile-check + commit**

Run: `clojure -M:dev:shadow-cljs release main worker` → 0 errors.
```bash
git add frontend/src/app/main/ui/workspace/sidebar/options/menus/typography.scss
git commit -m "style(typography): pad variable-axes fields so values don't stick to the right edge"
```

---

### Task 8: Variable-axis hover tooltip + range (issue 7)

**Files:**
- Modify: `frontend/src/app/main/ui/workspace/sidebar/options/menus/typography.cljs` (`axis-label`, the `:title` on `.variation-axis` / input)

**Interfaces:** none (self-contained component change).

**Background:** Today the axis cell has `:title (axis-label axis)` (the human label only). Make the tooltip explain the axis and its range, e.g. `Width (wdth): 50–151`. Each `axis` map has `:tag`, `:min`, `:max`, `:default`, and a human label resolvable via `axis-label`. Provide friendly descriptions for the standard registered axes and fall back to the tag.

- [ ] **Step 1: Add a tooltip builder**

```clojure
(def ^:private axis-descriptions
  {"wght" "Weight" "wdth" "Width" "opsz" "Optical size"
   "ital" "Italic" "slnt" "Slant" "GRAD" "Grade" "ROND" "Roundness"})

(defn- axis-tooltip
  "Human description + tag + numeric range for a variable-font axis."
  [{:keys [tag min max default] :as axis}]
  (let [name (or (get axis-descriptions tag) (axis-label axis))]
    (str name " (" tag ")"
         (when (and (some? min) (some? max)) (str ": " min "–" max))
         (when (some? default) (str ", default " default)))))
```

- [ ] **Step 2: Use it as the cell title**

In `font-variation-options`, change the axis cell's `:title (axis-label axis)` to `:title (axis-tooltip axis)`. If `min`/`max` are not present on the axis map (verify by reading how `:axes` is built upstream — `(:axes font)`), guard with `some?` as above so the tooltip degrades to `Name (tag)`.

- [ ] **Step 3: Compile-check + commit**

Run: `clojure -M:dev:shadow-cljs release main worker` → 0 errors.
```bash
git add frontend/src/app/main/ui/workspace/sidebar/options/menus/typography.cljs
git commit -m "feat(typography): explain each variable axis and its range on hover"
```

---

### Task 9: Full build + browser verification + final commit

**Files:** none new (verification + any fixups surfaced).

**Interfaces:** consumes all prior tasks.

**Background:** This is the integration gate. Use a THROWAWAY design copy (re-import the original `.penpot` under `/tmp`, map to the variable font) — never the user's working design. Reuse the established harness: boot `runtime/server.mjs` with `PENCILPOT_PROJECT`/`PENCILPOT_PORT`; chromium headless `--use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader`; playwright from `pencilpot/node_modules/playwright`; `pkill -9 -f 'runtime/server[.]mjs'` after.

- [ ] **Step 1: Build the frontend**

From `frontend/`: `clojure -M:dev:shadow-cljs release main worker`. Expected: build completes, 0 errors. (Note: heavy build, allow several minutes.)

- [ ] **Step 2: Verify each issue in the browser**

Open a throwaway design and confirm:
1. **No spurious dirty / no duplicate indicator** — on a clean open the header shows green "Saved"; no bottom-left badge exists; the browser tab title has no `●`. Idle / pan / select does NOT flip to "Unsaved".
2. **Status in title area** — file name is the title; "Unsaved changes" (orange dot) appears below on edit; "Saving…" (blue) during save; "Saved" (green) after.
3. **Rename via double-click persists** — double-click title, type a new name, Enter; reopen the design → `manifest.edn` `:name` is the new name.
4. **No toast** — saving shows no green toast popup (status reflects only in the header).
5. **File menu** — File > Save triggers a save (header → Saving… → Saved); File > Rename puts the title into edit mode.
6. **Axes padding** — open a text shape with the variable font; the variable-axes values have breathing room on the right (not flush).
7. **Axis tooltip** — hover an axis field → tooltip shows e.g. "Width (wdth): 50–151".

- [ ] **Step 3: Regression gates**

```bash
cd pencilpot && node run-tests.mjs --unit          # 0 failures
node e2e/vf/vf-render-svg.mjs                       # VF render gate PASS
```
Confirm GSF still loads and text renders (the font/position-data fixes are not regressed by the header/menu changes).

- [ ] **Step 4: Final commit**

```bash
git add -f frontend/resources/public/js   # built bundle (tracked like prior frontend builds)
git add -A
git commit -m "build(pencilpot): native save UI + injection teardown + axes polish (issues 1-7)"
```

---

## Self-Review

**Spec coverage:**
- Issue 1 (dirty pops up / twice) → T1 (content-signature) + T3/T4 (single native indicator) + T6 (remove badge/tab-dot). ✅
- Issue 2 (status in title + dot) → T4. ✅
- Issue 3 (rename via title) → existing double-click + T2 (persistence) + T4 (rename trigger). ✅
- Issue 4 (remove toast) → T6 (and T3 doesn't reintroduce it). ✅
- Issue 5 (File > Rename/Save) → T5. ✅
- Issue 6 (axes padding) → T7. ✅
- Issue 7 (axis tooltip + range) → T8. ✅
- "Remove all injection gymnastics" → T6 (full inventory in File Structure table). ✅

**Type/name consistency:** `app.main.data.pencilpot` exposes `status`, `rename-request`, `request-rename!`, `save!`, `enabled?`, `start-client!` — used identically in T4 (header), T5 (menu), T3 (init). SCSS class names `pp-save-status`/`pp-save-dot`/`pp-dot-*`/`pp-save-text` defined in T4 SCSS and referenced in T4 CLJS.

**Known soft spots (resolve during implementation, not blockers):**
- Notification action shape in T3 `on-reload` — read `notifications.cljs`; literal-string `ntf/info` is the accepted minimum.
- Manifest `:name` regex in T2 — verify against a real `manifest.edn`; anchor to the first/top-level `:name`.
- `.file-name` SCSS currently lays out label + icon inline — T4 must integrate the column layout, not blindly append.
