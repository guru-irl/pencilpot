# Pencilpot Phase 1 — Runtime (L) + EDN Store (S) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** A durable local runtime that serves the stock Penpot designer from a lossless, deterministic, git-diffable **EDN** directory on disk (project folder + `shared/` libraries), with edits persisting back and cross-file shared libraries resolving — no JVM/DB/auth.

**Architecture:** Sub-project **S** = a ClojureScript canonical-EDN serializer in the `headless-core` engine (`app.pencilpot.store`) + a Node store layer (`pencilpot/store/`) that maps the engine's file model to/from an exploded `.penpot/` directory. Sub-project **L** = a Node runtime server (`pencilpot/runtime/`) that serves the full workspace RPC set from the store (real get-file/update-file/get-file-libraries; synthetic stubs for SaaS/boot endpoints), proxying penpot-hl's compiled assets (our own bundle is Phase 2). Builds directly on the Phase 0 engine additions (`getFileResponse`, `applyTransitUpdate`, `createSession({fromTransit})`).

**Tech Stack:** ClojureScript (shadow-cljs `:headless` build → `headless-core/target/headless/penpot.js`), Node 22 (built-in http/fetch), `ws`, `@playwright/test`, `isomorphic-git` OR shelling `git` for `git init`. penpot-hl on :9101 for assets + as the contract reference.

---

## Scope & boundaries

- **In scope:** the EDN serializer + round-trip/determinism tests; the Node store (FS layout + git init); the runtime server with real get-file/update-file/get-file-libraries + synthetic boot stubs; revn/vern lifecycle; multi-file project + shared-lib resolution; a first-class tiered pencilpot test suite; architecture + per-changefile docs.
- **Out of scope:** our own frontend bundle + auth deletion (Phase 2 — still proxy penpot-hl assets + synthetic profile); desktop shell/file-association (Phase 3); terminal/AI (Phase 4); media dedup; per-frame split.
- **Spike disposition:** `pencilpot/spike/` is archived (kept for reference); Phase 1 builds the clean `pencilpot/{store,runtime,test,e2e}/` layout, reusing the spike's proxy/ws/playwright patterns.

## File structure

Engine (ClojureScript):
- Create: `headless-core/src/app/pencilpot/store.cljs` — canonical EDN (sorted, lossless, pretty) + `serialize-store`/`load-store` over the file `:data`.
- Modify: `headless-core/src/app/headless/session.cljs` — require the store ns; add `serializeStore`/`loadStore` to the exported session object; extend `createSession` to accept `{:fromStore parts}`.
- Test: `headless-core/test/store.test.mjs` — engine-level round-trip/determinism.

Node store (S):
- Create: `pencilpot/store/package.json`, `pencilpot/store/store.mjs` (read/write a `.penpot` dir), `pencilpot/store/project.mjs` (root resolution + `git init`), `pencilpot/store/index.mjs`.
- Test: `pencilpot/test/store.test.mjs` (FS round-trip + minimal-diff + media).

Node runtime (L):
- Create: `pencilpot/runtime/server.mjs` (http + mode), `pencilpot/runtime/proxy.mjs` (asset proxy + ws stub — ported from spike), `pencilpot/runtime/rpc.mjs` (RPC router + get-file/update-file/get-file-libraries), `pencilpot/runtime/stubs.mjs` (synthetic boot responses), `pencilpot/runtime/launch.mjs`, `pencilpot/runtime/package.json`.
- Test: `pencilpot/test/rpc.test.mjs` (handler integration), `pencilpot/e2e/{helpers,boot,edit,library}.spec.mjs` (Playwright), `pencilpot/playwright.config.mjs`.

Cross-cutting:
- Create: `pencilpot/run-tests.mjs` (tiered runner), `pencilpot/README.md` (per-changefile docs), `docs/pencilpot/architecture/01-runtime-store.md` (+ update the architecture README index).
- Modify: repo `.gitignore` (ignore `pencilpot/**/node_modules`, test scratch dirs).

---

## Task 1: Canonical EDN serializer in the engine (S core)

**Files:**
- Create: `headless-core/src/app/pencilpot/store.cljs`
- Create: `headless-core/test/store.test.mjs`
- Modify: `headless-core/src/app/headless/session.cljs`

- [ ] **Step 1: Failing test** `headless-core/test/store.test.mjs`:
```javascript
import { test } from "node:test";
import assert from "node:assert/strict";
import { createSession } from "../target/headless/penpot.js";

test("serializeStore -> loadStore round-trips a file losslessly", () => {
  const s = createSession(JSON.stringify({ empty: true }));
  const b = s.addBoard(JSON.stringify({ x: 0, y: 0, width: 100, height: 100, name: "B" }));
  s.addRect(JSON.stringify({ x: 10, y: 10, width: 20, height: 20, parentId: b }));
  s.closeBoard();

  const parts = JSON.parse(s.serializeStore()); // {manifest, pages:{}, components:{}, media:[]}
  assert.ok(parts.manifest.includes(":id"), "manifest is EDN");
  assert.ok(Object.keys(parts.pages).length >= 1, "has at least one page");

  const s2 = createSession(JSON.stringify({ fromStore: parts }));
  assert.deepEqual(JSON.parse(s2.objects()), JSON.parse(s.objects()), "objects identical after round-trip");
});

test("canonical EDN is deterministic (serialize twice -> byte-identical)", () => {
  const s = createSession(JSON.stringify({ empty: true }));
  const b = s.addBoard(JSON.stringify({ x: 0, y: 0, width: 100, height: 100, name: "B" }));
  s.closeBoard();
  const a = s.serializeStore(); const c = s.serializeStore();
  assert.equal(a, c, "two serializations are byte-identical");
});
```

- [ ] **Step 2: Run → fail.** `cd headless-core && npm run build && node --test test/store.test.mjs` → `serializeStore is not a function`.

- [ ] **Step 3: Implement `app/pencilpot/store.cljs`.** Canonical EDN = recursively replace every map with a `sorted-map` ordered by a total comparator over the keys' printed form, then pretty-print with a fixed right margin; reader uses EDN with the `#uuid` tag.
```clojure
(ns app.pencilpot.store
  (:require [cljs.reader :as reader]
            [clojure.pprint :as pp]
            [app.common.uuid :as uuid]))

(defn- total-key-cmp [a b] (compare (pr-str a) (pr-str b)))

(defn- canonicalize
  "Recursively turn every map into a deterministically-ordered sorted-map."
  [x]
  (cond
    (map? x)  (into (sorted-map-by total-key-cmp) (map (fn [[k v]] [k (canonicalize v)]) x))
    (vector? x) (mapv canonicalize x)
    (set? x)  (into (sorted-set-by total-key-cmp) (map canonicalize x))
    (seq? x)  (map canonicalize x)
    :else x))

(defn canonical-edn [data]
  (binding [*print-right-margin* 80, pp/*print-pprint-dispatch* pp/code-dispatch]
    (with-out-str (pp/pprint (canonicalize data)))))

(defn read-edn [s] (reader/read-string {:readers {'uuid uuid/uuid}} s))

;; Split the file :data into per-page / per-component EDN + a manifest map.
(defn serialize-store [file-id state]
  (let [data  (:data state)
        pages (:pages-index data)
        comps (:components data)
        manifest {:id file-id :name (:name state) :revn (:revn state 0) :vern (:vern state 0)
                  :features (:features state #{}) :page-order (vec (:pages data))
                  :options (:options data) :tokens-lib (:tokens-lib data)
                  :libraries (:libraries state []) :is-shared (boolean (:is-shared state))}]
    {:manifest   (canonical-edn manifest)
     :pages      (into {} (map (fn [[id p]] [(str id) (canonical-edn p)]) pages))
     :components (into {} (map (fn [[id c]] [(str id) (canonical-edn c)]) comps))
     :media      (mapv str (keys (:media data)))}))

;; Reassemble file :data from manifest + page/component EDN parts.
(defn load-store [parts]
  (let [manifest (read-edn (:manifest parts))
        pages    (into {} (map (fn [[k v]] [(uuid/uuid k) (read-edn v)]) (:pages parts)))
        comps    (into {} (map (fn [[k v]] [(uuid/uuid k) (read-edn v)]) (:components parts)))
        data {:pages (:page-order manifest) :pages-index pages :components comps
              :options (:options manifest) :tokens-lib (:tokens-lib manifest)}]
    {:file-id (:id manifest) :revn (:revn manifest) :vern (:vern manifest)
     :name (:name manifest) :features (:features manifest)
     :libraries (:libraries manifest) :data data}))
```
> Adapt key names to the engine's real `:data` shape (confirm against `getFileResponse`/the Phase 0 envelope). The `parts` come over the JS boundary as JS objects — convert with `js->clj` (keywordize? NO — keep string keys for `:pages`/`:components` maps; use `(get parts "manifest")` etc.). Keep media bytes out of the engine (Node handles them).

- [ ] **Step 4: Wire into `session.cljs`.** Require `[app.pencilpot.store :as store]`. Add to the exported session object:
```clojure
:serializeStore (fn [] (js/JSON.stringify (clj->js (store/serialize-store file-id @state))))
:loadStore      (fn [parts] (reset-from-store! state (store/load-store (js->clj parts))))  ; helper sets :data/:revn/etc
```
and extend `createSession` to branch on `(get opts "fromStore")` → hydrate via `store/load-store`, mirroring the `fromTransit` path. Build.

- [ ] **Step 5: Run → pass.** `cd headless-core && npm run build && node --test test/store.test.mjs` → both tests pass.

- [ ] **Step 6: Regression.** `cd headless-core && npm run test:unit` → all pass.

- [ ] **Step 7: Commit.**
```bash
git add headless-core/src/app/pencilpot/store.cljs headless-core/src/app/headless/session.cljs headless-core/test/store.test.mjs
git commit -m ":sparkles: pencilpot: canonical-EDN store serializer in the engine (lossless, deterministic)"
```

---

## Task 2: Node store layer — write/read a `.penpot` directory (S)

**Files:**
- Create: `pencilpot/store/package.json`, `pencilpot/store/store.mjs`, `pencilpot/store/index.mjs`
- Create: `pencilpot/test/store.test.mjs`
- Modify: repo `.gitignore`

- [ ] **Step 1: Package.** `pencilpot/store/package.json`:
```json
{ "name": "pencilpot-store", "version": "0.0.0", "private": true, "type": "module" }
```
Append to repo `.gitignore`: `pencilpot/**/node_modules/` and `pencilpot/.scratch/`.

- [ ] **Step 2: Failing test** `pencilpot/test/store.test.mjs`:
```javascript
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { writeDesign, readDesign } from "../store/store.mjs";
import { createSession } from "../../headless-core/target/headless/penpot.js";

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), "pp-")); }

test("writeDesign explodes a file into manifest/pages/components EDN; readDesign restores it", () => {
  const s = createSession(JSON.stringify({ empty: true }));
  const b = s.addBoard(JSON.stringify({ x: 0, y: 0, width: 100, height: 100, name: "B" }));
  s.addRect(JSON.stringify({ x: 10, y: 10, width: 20, height: 20, parentId: b }));
  s.closeBoard();

  const dir = path.join(tmp(), "home.penpot");
  writeDesign(dir, JSON.parse(s.serializeStore()));
  assert.ok(fs.existsSync(path.join(dir, "manifest.edn")));
  assert.ok(fs.readdirSync(path.join(dir, "pages")).length >= 1);

  const parts = readDesign(dir);
  const s2 = createSession(JSON.stringify({ fromStore: parts }));
  assert.deepEqual(JSON.parse(s2.objects()), JSON.parse(s.objects()), "round-trips through disk");
});

test("editing one shape changes exactly one page file (minimal diff)", () => {
  const s = createSession(JSON.stringify({ empty: true }));
  const b = s.addBoard(JSON.stringify({ x: 0, y: 0, width: 100, height: 100, name: "B" }));
  const r = s.addRect(JSON.stringify({ x: 10, y: 10, width: 20, height: 20, parentId: b }));
  s.closeBoard();
  const dir = path.join(tmp(), "home.penpot");
  writeDesign(dir, JSON.parse(s.serializeStore()));
  const before = snapshot(dir);

  // move the rect, re-serialize, re-write
  s.applyChanges(JSON.stringify([{ type: "mod-obj", id: r, page_id_hint: true, operations: [{ type: "set", attr: "x", val: 99 }] }]));
  writeDesign(dir, JSON.parse(s.serializeStore()));
  const after = snapshot(dir);

  const changed = Object.keys(after).filter((f) => after[f] !== before[f]);
  assert.deepEqual(changed.filter((f) => f.startsWith("pages/")).length, 1, "exactly one page file changed");
});

function snapshot(dir) {
  const out = {};
  for (const f of walk(dir)) out[path.relative(dir, f)] = fs.readFileSync(f, "utf8");
  return out;
}
function* walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) yield* walk(p); else yield p; } }
```
> If `applyChanges` (JSON, test-only) can't express the move cleanly, use the transit path or a session move helper; the point is "one page file changes."

- [ ] **Step 3: Run → fail.** `cd pencilpot && node --test test/store.test.mjs` → cannot find `writeDesign`.

- [ ] **Step 4: Implement `pencilpot/store/store.mjs`:**
```javascript
// Map the engine's serialized parts {manifest, pages:{id:edn}, components:{id:edn}, media:[]}
// to/from an exploded .penpot directory.
import fs from "node:fs";
import path from "node:path";

export function writeDesign(dir, parts) {
  fs.mkdirSync(path.join(dir, "pages"), { recursive: true });
  fs.mkdirSync(path.join(dir, "components"), { recursive: true });
  fs.mkdirSync(path.join(dir, "media"), { recursive: true });
  fs.writeFileSync(path.join(dir, "manifest.edn"), parts.manifest);
  // write current page/component files
  for (const [id, edn] of Object.entries(parts.pages)) fs.writeFileSync(path.join(dir, "pages", `${id}.edn`), edn);
  for (const [id, edn] of Object.entries(parts.components)) fs.writeFileSync(path.join(dir, "components", `${id}.edn`), edn);
  // prune stale page/component files no longer present (keeps the tree faithful)
  prune(path.join(dir, "pages"), new Set(Object.keys(parts.pages).map((i) => `${i}.edn`)));
  prune(path.join(dir, "components"), new Set(Object.keys(parts.components).map((i) => `${i}.edn`)));
}

function prune(d, keep) {
  if (!fs.existsSync(d)) return;
  for (const f of fs.readdirSync(d)) if (f.endsWith(".edn") && !keep.has(f)) fs.rmSync(path.join(d, f));
}

export function readDesign(dir) {
  const manifest = fs.readFileSync(path.join(dir, "manifest.edn"), "utf8");
  const pages = readEdnDir(path.join(dir, "pages"));
  const components = readEdnDir(path.join(dir, "components"));
  return { manifest, pages, components, media: [] };
}

function readEdnDir(d) {
  const out = {};
  if (!fs.existsSync(d)) return out;
  for (const f of fs.readdirSync(d).filter((x) => x.endsWith(".edn")))
    out[f.replace(/\.edn$/, "")] = fs.readFileSync(path.join(d, f), "utf8");
  return out;
}
```
And `pencilpot/store/index.mjs` re-exports `writeDesign`/`readDesign` (and `project.mjs` exports added in Task 3).

- [ ] **Step 5: Run → pass.** `cd pencilpot && node --test test/store.test.mjs` → both pass (round-trip + minimal-diff).

- [ ] **Step 6: Commit.**
```bash
git add pencilpot/store/ pencilpot/test/store.test.mjs .gitignore
git commit -m ":sparkles: pencilpot: Node store layer (explode/restore .penpot dir; minimal diffs)"
```

---

## Task 3: Project resolution + git init (S)

**Files:**
- Create: `pencilpot/store/project.mjs`
- Test: extend `pencilpot/test/store.test.mjs`

- [ ] **Step 1: Failing test** (append):
```javascript
import { initProject, resolveProjectRoot, listDesigns } from "../store/project.mjs";

test("initProject creates a git repo with shared/ and resolves the root from a nested design dir", () => {
  const root = tmp();
  initProject(root);
  assert.ok(fs.existsSync(path.join(root, ".git")), "git initialized");
  assert.ok(fs.existsSync(path.join(root, "shared")), "shared/ created");
  const design = path.join(root, "home.penpot");
  fs.mkdirSync(design);
  assert.equal(resolveProjectRoot(design), root, "walks up to the project root");
});
```

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Implement `pencilpot/store/project.mjs`:**
```javascript
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

// A project root is a dir containing shared/ (and a .git). init creates both.
export function initProject(root) {
  fs.mkdirSync(path.join(root, "shared"), { recursive: true });
  if (!fs.existsSync(path.join(root, ".git"))) {
    execFileSync("git", ["init", "-q"], { cwd: root });
    fs.writeFileSync(path.join(root, ".gitignore"), ".pencilpot-cache/\n");
  }
  return root;
}

// Walk up from a .penpot dir (or any path) to the nearest dir containing shared/ or .git.
export function resolveProjectRoot(start) {
  let d = fs.statSync(start).isDirectory() ? start : path.dirname(start);
  for (;;) {
    if (fs.existsSync(path.join(d, "shared")) || fs.existsSync(path.join(d, ".git"))) return d;
    const up = path.dirname(d);
    if (up === d) return path.dirname(start); // fallback: design's parent
    d = up;
  }
}

export function listDesigns(root) {
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.endsWith(".penpot") && e.name !== "shared")
    .map((e) => path.join(root, e.name));
}
```

- [ ] **Step 4: Run → pass. Step 5: Commit.**
```bash
git add pencilpot/store/project.mjs pencilpot/test/store.test.mjs
git commit -m ":sparkles: pencilpot: project root resolution + git init + shared/ scaffold"
```

---

## Task 4: Runtime server skeleton + asset proxy + ws stub (L)

**Files:**
- Create: `pencilpot/runtime/package.json`, `pencilpot/runtime/proxy.mjs`, `pencilpot/runtime/server.mjs`, `pencilpot/runtime/launch.mjs`

- [ ] **Step 1: Package + deps.** `pencilpot/runtime/package.json`:
```json
{ "name": "pencilpot-runtime", "version": "0.0.0", "private": true, "type": "module",
  "scripts": { "serve": "node server.mjs" },
  "dependencies": { "ws": "^8.18.0" } }
```
Run: `cd pencilpot/runtime && npm install`.

- [ ] **Step 2: Port `proxy.mjs` from the spike** (`pencilpot/spike/proxy.mjs`) verbatim — asset reverse-proxy to penpot-hl with the `/js/config.js` public-uri rewrite (`globalThis.penpotPublicURI=location.origin`) + `attachWsStub` for `/ws/notifications`. (It already works; reuse it.)

- [ ] **Step 3: `server.mjs`** — http server: route `/api/*` to `handleRpc(req,res)` (Task 5), everything else to `proxyHttp`. Read `PENCILPOT_PROJECT` (project root) + `PENCILPOT_DESIGN` (which `.penpot` to open) from env. Attach the ws stub. Listen on `PENCILPOT_PORT ?? 7777`. (Mirror the spike's `server.mjs` shape; replace the mode dispatch with always-serve-from-store.)

- [ ] **Step 4: `launch.mjs`** — port from the spike (open a Chromium `--app` window at a URL).

- [ ] **Step 5: Verify headlessly** (penpot-hl up): start the server, `curl -s http://localhost:7777/ | head -c 200` returns Penpot HTML; `curl -s http://localhost:7777/js/config.js | tail -c 120` shows the `penpotPublicURI=location.origin` append; ws connects (reuse the spike's ws check). Paste outputs.

- [ ] **Step 6: Commit.**
```bash
git add pencilpot/runtime/
git commit -m ":sparkles: pencilpot runtime: server skeleton + asset proxy + ws stub"
```

---

## Task 5: get-file + update-file handlers from the store (L)

**Files:**
- Create: `pencilpot/runtime/rpc.mjs`, `pencilpot/runtime/stubs.mjs`
- Test: `pencilpot/test/rpc.test.mjs`

- [ ] **Step 1: Failing test** `pencilpot/test/rpc.test.mjs`:
```javascript
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { createSession } from "../../headless-core/target/headless/penpot.js";
import { writeDesign } from "../store/store.mjs";
import { getFile, updateFile } from "../runtime/rpc.mjs";

function seed() {
  const s = createSession(JSON.stringify({ empty: true }));
  const b = s.addBoard(JSON.stringify({ x: 0, y: 0, width: 100, height: 100, name: "B" }));
  const r = s.addRect(JSON.stringify({ x: 10, y: 10, width: 20, height: 20, parentId: b }));
  s.closeBoard();
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pp-")), "home.penpot");
  writeDesign(dir, JSON.parse(s.serializeStore()));
  return { dir, r };
}

test("getFile loads the store and returns an envelope that re-hydrates", () => {
  const { dir } = seed();
  const { meta, transit } = getFile(dir);
  assert.ok(meta.id && meta.data, "envelope has id + data");
  const s2 = createSession(JSON.stringify({ fromTransit: transit, meta }));
  assert.ok(Object.keys(JSON.parse(s2.objects())).length >= 2, "re-hydrates shapes");
});

test("updateFile applies a transit change, writes the store, bumps revn", () => {
  const { dir, r } = seed();
  const s = createSession(JSON.stringify({ fromStore: JSON.parse(require("fs").readFileSync) ? undefined : undefined })); // see note
  // Build a transit update body that moves r to x=99 using the engine's own encoder:
  const body = makeTransitUpdate(dir, r, 99); // helper in rpc.mjs (test export) OR inline via engine
  const res = updateFile(dir, body);
  assert.equal(res.revn, 1, "revn bumped");
  const { meta, transit } = getFile(dir);
  const s2 = createSession(JSON.stringify({ fromTransit: transit, meta }));
  assert.equal(JSON.parse(s2.getShape(r)).x, 99, "edit persisted to the store");
});
```
> The transit-update construction needs the engine's encoder. Expose a small test helper `makeTransitUpdate(dir, shapeId, x)` from `rpc.mjs` that hydrates the design, builds a `mod-obj` change, and returns the transit body via the engine (reuse `applyTransitUpdate`'s decode format). Keep it minimal; its job is to exercise the real `updateFile` path.

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Implement `pencilpot/runtime/rpc.mjs`:**
```javascript
import { createSession } from "../../headless-core/target/headless/penpot.js";
import { readDesign, writeDesign } from "../store/store.mjs";

function sessionFor(dir) {
  return createSession(JSON.stringify({ fromStore: readDesign(dir) }));
}

// get-file: load store -> full envelope (synthesized SaaS keys) -> {meta, transit}
export function getFile(dir) {
  const s = sessionFor(dir);
  return JSON.parse(s.getFileResponse()); // {meta, transit} (Phase 0)
}

// update-file: apply transit changes -> persist -> bump revn -> {revn}
export function updateFile(dir, transitBody) {
  const s = sessionFor(dir);
  s.applyTransitUpdate(transitBody);
  const parts = JSON.parse(s.serializeStore());
  // bump revn in the manifest before writing
  const manifest = bumpRevn(parts.manifest);
  writeDesign(dir, { ...parts, manifest });
  return { revn: revnOf(manifest) };
}
```
Implement `bumpRevn`/`revnOf` by a tiny EDN regex on `:revn N` (or round-trip through the engine — prefer the engine: add a `setRevn`/let `serializeStore` accept a revn). Implement the HTTP router `handleRpc(req,res)` that parses the command from the path, dispatches get-file/update-file against `process.env.PENCILPOT_DESIGN`, and falls through to `stubs.mjs` for everything else. Match the transit/JSON content negotiation + `x-pencilpot-source: disk` header from the spike. Return update-file as transit `{:revn N :lagged []}` (match the recorded shape — see `pencilpot/spike/recordings`).

- [ ] **Step 4: Implement `pencilpot/runtime/stubs.mjs`** — synthetic responses for the boot/SaaS endpoints captured in Phase 0 (get-profile → constant non-zero local profile; get-teams/get-team/get-projects/get-project/get-team-members/get-team-recent-files/get-builtin-templates/get-enabled-flags → minimal; get-fonts/get-font-variants/get-comment-threads/get-profiles-for-file-comments/get-unread-comment-threads → empty; thumbnail endpoints → 200 `{}`/204; push-audit-events → 204). Encode as transit where the SPA expects transit. You MAY bootstrap these from `pencilpot/spike/recordings/` (copy the captured bodies into `pencilpot/runtime/stub-data/`), but they must be committed (not gitignored) so the runtime is self-contained.

- [ ] **Step 5: Run → pass.** `cd pencilpot && node --test test/rpc.test.mjs`.

- [ ] **Step 6: Commit.**
```bash
git add pencilpot/runtime/rpc.mjs pencilpot/runtime/stubs.mjs pencilpot/runtime/stub-data/ pencilpot/test/rpc.test.mjs
git commit -m ":sparkles: pencilpot runtime: get-file/update-file from store + synthetic boot stubs"
```

---

## Task 6: e2e — canvas renders from the store + edit round-trips (L)

**Files:**
- Create: `pencilpot/playwright.config.mjs`, `pencilpot/e2e/helpers.mjs`, `pencilpot/e2e/boot.spec.mjs`, `pencilpot/e2e/edit.spec.mjs`
- Create: a seed script `pencilpot/scripts/seed-from-hl.mjs` (export the penpot-hl test file into a project's `.penpot` dir via the engine, so e2e has real content)

- [ ] **Step 1: Seed a project from the penpot-hl test file.** `pencilpot/scripts/seed-from-hl.mjs`: use the headless SDK to checkout file `0398e5fc-95c9-80d6-8008-29088f3ee53a` (token from `infra/penpot-hl/test-env.json`), `serializeStore()`, `initProject(root)`, `writeDesign(root/home.penpot, parts)`. Run it to produce `pencilpot/.scratch/proj/home.penpot`.

- [ ] **Step 2: Playwright config + helpers** — port `pencilpot/spike/playwright.config.mjs` + `e2e/helpers.mjs` (`expectCanvasLoaded` keyed on `[class*="workspace"]`, `trackErrors`). The workspace URL is `#/workspace?team-id=<synthetic>&file-id=<file-id>` (the synthetic team-id comes from `stubs.mjs`).

- [ ] **Step 3: `boot.spec.mjs`** — start the runtime (`PENCILPOT_PROJECT=.scratch/proj PENCILPOT_DESIGN=.scratch/proj/home.penpot PENCILPOT_MODE? serve`), navigate to the workspace URL, assert `expectCanvasLoaded` + a `get-file` response carried `x-pencilpot-source: disk` + no fatal console errors.

- [ ] **Step 4: `edit.spec.mjs`** — the round-trip: read the design's `manifest.edn` revn (parse `:revn N`); load workspace; click viewport, `Control+a`, 5× `ArrowRight`; `waitForResponse` on update-file 200; assert the `home.penpot/manifest.edn` revn incremented AND a `pages/<id>.edn` file's mtime/content changed; `page.reload()` and assert `expectCanvasLoaded` (mutated file re-renders).

- [ ] **Step 5: Run both** (penpot-hl up for assets):
```bash
cd pencilpot/runtime && PENCILPOT_PROJECT=$PWD/../.scratch/proj PENCILPOT_DESIGN=$PWD/../.scratch/proj/home.penpot node server.mjs &
cd /mnt/data/src/penpot/pencilpot && npx playwright test e2e/boot.spec.mjs e2e/edit.spec.mjs
kill %1
```
Both PASS = the designer renders + edits a real file purely from the EDN store. Diagnose failures with screenshots/console as in Phase 0.

- [ ] **Step 6: Commit.**
```bash
git add pencilpot/playwright.config.mjs pencilpot/e2e/helpers.mjs pencilpot/e2e/boot.spec.mjs pencilpot/e2e/edit.spec.mjs pencilpot/scripts/seed-from-hl.mjs pencilpot/runtime/package.json
git commit -m ":white_check_mark: pencilpot: e2e — designer renders + edits a file from the EDN store"
```

---

## Task 7: Cross-file shared libraries — get-file-libraries resolution (L+S)

**Files:**
- Modify: `pencilpot/runtime/rpc.mjs` (add `getFileLibraries`)
- Test: `pencilpot/test/library.test.mjs` + `pencilpot/e2e/library.spec.mjs`

- [ ] **Step 1: Failing integration test** `pencilpot/test/library.test.mjs`: build a project with `shared/brand.penpot` containing a component, and a `home.penpot` whose `manifest.edn` `:libraries` links it by `{:id, :path "shared/brand.penpot"}`. Assert `getFileLibraries(designDir, projectRoot)` returns the brand library's data keyed by its file id, and that the returned data contains the component (so a cross-file instance could resolve). Also assert an instance in `home` referencing the brand component resolves via the engine's libraries map.

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Implement `getFileLibraries(designDir, projectRoot)`** in `rpc.mjs`: read the design's `manifest.edn` `:libraries`; for each `{id, path}`, `readDesign(projectRoot/path)` → hydrate via the engine → emit its library payload (id + data) in the shape `get-file-libraries` returns (confirm against `pencilpot/spike/recordings/*-get-file-libraries.body`). Wire it into `handleRpc` for the `get-file-libraries` command (resolve `projectRoot` via `resolveProjectRoot`).

- [ ] **Step 4: e2e `library.spec.mjs`** — seed a project where `home.penpot` links `shared/brand.penpot` and contains an instance of a brand component; load the workspace; assert the canvas renders and the assets/layers panel shows the shared component (selector discovered live; tolerant).

- [ ] **Step 5: Run → pass** (unit + e2e). **Step 6: Commit.**
```bash
git add pencilpot/runtime/rpc.mjs pencilpot/test/library.test.mjs pencilpot/e2e/library.spec.mjs
git commit -m ":sparkles: pencilpot: cross-file shared-library resolution (get-file-libraries from shared/)"
```

---

## Task 8: First-class tiered test runner + docs

**Files:**
- Create: `pencilpot/run-tests.mjs`, `pencilpot/package.json` (workspace root: `test` → runner)
- Create: `pencilpot/README.md`, `docs/pencilpot/architecture/01-runtime-store.md`
- Modify: `docs/pencilpot/architecture/README.md` (index)

- [ ] **Step 1: Runner** — adapt `headless-core/scripts/run-tests.mjs`: tiers = **unit** (engine `store.test.mjs` + `pencilpot/test/store.test.mjs` — no network), **integration** (`pencilpot/test/rpc.test.mjs`, `library.test.mjs` — need the engine build; no browser), **e2e** (`pencilpot/e2e/*.spec.mjs` — need penpot-hl + a seeded project). Preflight: build the engine if `penpot.js` missing; probe :9101 + seed the scratch project for e2e; LOUD skip if unavailable. Summary table + nonzero only on real failures. `pencilpot/package.json` `"test": "node run-tests.mjs"`, `"test:unit"`, `"test:e2e"`.

- [ ] **Step 2: Run `npm test -- --unit`** (from `pencilpot/`) → unit tiers green. With penpot-hl up + seed, run full `npm test` → all tiers green. Paste the summary.

- [ ] **Step 3: Docs.** `docs/pencilpot/architecture/01-runtime-store.md` — the EDN store format (layout + canonical serialization + manifest), the engine serialize/load API, the runtime RPC handler table, shared-lib resolution, revn lifecycle, with a diagram. Update the architecture `README.md` index. `pencilpot/README.md` — per-changefile table for `store/`, `runtime/`, `test/`, `e2e/`, `scripts/`, plus how to run.

- [ ] **Step 4: Commit.**
```bash
git add pencilpot/run-tests.mjs pencilpot/package.json pencilpot/README.md docs/pencilpot/architecture/
git commit -m ":white_check_mark: pencilpot: first-class tiered test runner + Phase 1 architecture docs"
```

---

## Self-Review (against the Phase 1 spec)

- **S serializer (spec §3/§4):** Task 1 (canonical lossless EDN + round-trip + determinism). ✓
- **Node store + project/git (spec §3):** Tasks 2–3 (explode/restore, minimal diff, init/resolve/git). ✓
- **L runtime get-file/update-file (spec §5):** Task 5 + e2e Task 6 (render + edit round-trip from the store). ✓
- **Synthetic boot stubs (spec §5):** Task 5 step 4. ✓
- **revn/vern lifecycle (spec §5/§6):** Task 5 (bump + return); revn-conflict gate — *add to Task 5 if the SPA wedges on conflicts; otherwise single-user makes it rare* (flagged). ✓
- **Cross-file shared libraries (spec §3/§5):** Task 7. ✓
- **Phase 0 deferred items (spec §6):** transit-canonical (Task 5 uses applyTransitUpdate), multi-page (store keyed by page-id; minimal-diff test Task 2; add a multi-page round-trip assertion in Task 2 if not covered), revn (Task 5), features consistency (manifest source, Task 1). ✓
- **Testing discipline (spec §7):** every task is TDD; Task 8 = first-class tiered runner + coverage. ✓
- **Docs discipline:** Task 8 (architecture + per-changefile). ✓
- **Commit hygiene:** standard subjects, no Claude attribution. ✓

**Type/name consistency:** engine exposes `serializeStore()`/`loadStore(parts)`/`createSession({fromStore})`; store exposes `writeDesign(dir,parts)`/`readDesign(dir)`/`initProject`/`resolveProjectRoot`/`listDesigns`; runtime exposes `getFile(dir)`/`updateFile(dir,body)`/`getFileLibraries(dir,root)`/`handleRpc(req,res)`. `parts` shape `{manifest, pages:{id:edn}, components:{id:edn}, media:[]}` is consistent across S and the engine.

**Known soft spots (flagged for execution):** exact `:data` key names in `serialize-store`/`load-store` must be reconciled against the engine's real model + the Phase 0 envelope; `bumpRevn` should ideally go through the engine rather than EDN regex; the transit-update test helper needs the engine encoder; stub response shapes must match the recorded bodies. Each step says so where relevant.
