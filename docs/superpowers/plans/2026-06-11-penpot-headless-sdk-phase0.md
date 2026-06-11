# Penpot Headless SDK — Phase 0 (Engine Spike) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove that we can mutate a real Penpot file **headlessly** (no browser, no plugin) by compiling Penpot's own `common/**.cljc` to a Node ESM library, using it to build a geometry-complete `:add-obj` change, and persisting it via the `update-file` RPC — then see it reflected in the file (and a browser tab).

**Architecture:** A new `headless-core/` CLJS module (mirroring `library/`) compiles a thin facade over `app.common.types.shape` (`setup-shape`) + `app.common.files.changes-builder` (`pcb`) + `app.common.transit` to a `:target :esm :runtime :node` bundle. A small Node harness authenticates with an access token, reads `revn`/`vern`/`features`/`pageId` via `get-file` (JSON), asks the facade to build a transit-encoded `update-file` body, POSTs it, and verifies the board now exists.

**Tech Stack:** ClojureScript + shadow-cljs (`:esm`/`:node`), Clojure CLI + JDK (build only), Node ≥22 (ESM, built-in `fetch` + `node:test`), Docker Compose (isolated test instance).

**Spec:** `docs/superpowers/specs/2026-06-11-penpot-headless-sdk-design.md`

---

## HARD ISOLATION RULE (read first)

The owner is actively designing on the live instance: compose project **`penpot`**, port **9001**, volumes **`penpot_penpot_*`**, the deployed `penpot-mcp:local` image + mounted plugin, and the Claude Code `penpot` MCP config. **Never** run `docker compose -p penpot …` for test scaffolding, never touch those volumes/ports, never edit `~/.local/share/penpot/*`. All Phase 0 work uses a **separate** project `penpot-hl` on ports **9101/1180** with its own volumes, plus a dedicated git branch `feat/penpot-headless-sdk` (already created).

---

## File Structure

- `infra/penpot-hl/docker-compose.yaml` — isolated test stack (copy of the official compose, ports remapped, `enable-access-tokens` added). *Lives in the repo so it's versioned; does not affect the owner's `~/.local/share/penpot` stack.*
- `headless-core/deps.edn` — Clojure deps: `penpot/common {:local/root "../common"}`, shadow-cljs, clojurescript; `:dev`/`:shadow-cljs` aliases.
- `headless-core/shadow-cljs.edn` — one build `:headless` (`:target :esm`, `:runtime :node`) exporting facade fns.
- `headless-core/package.json` — `build`/`watch` scripts (`clojure -M:dev:shadow-cljs …`).
- `headless-core/src/app/headless/core.cljs` — the facade: `buildAddBoardBody` (+ `buildAddBoardChange` for unit testing).
- `headless-core/target/headless/penpot.js` — build output (gitignored).
- `headless-core/test/facade.test.mjs` — Node unit test of the facade (no network).
- `headless-core/test/roundtrip.test.mjs` — Node end-to-end test against `penpot-hl`.
- `headless-core/test/helpers.mjs` — tiny RPC client (login → token, get-file, update-file).
- `headless-core/.gitignore` — `target/`, `node_modules/`, `.cpcache/`, `.shadow-cljs/`.

---

## Task 1: Stand up the isolated test instance (`penpot-hl`)

**Files:**
- Create: `infra/penpot-hl/docker-compose.yaml`

- [ ] **Step 1: Copy the official compose and remap to an isolated instance**

Create `infra/penpot-hl/docker-compose.yaml` as a copy of `docker/images/docker-compose.yaml` with exactly these changes (leave everything else identical):
- `x-flags` line — add `enable-access-tokens`:
  ```yaml
  x-flags: &penpot-flags
    PENPOT_FLAGS: disable-email-verification enable-smtp enable-prepl-server disable-secure-session-cookies enable-mcp enable-access-tokens
  ```
- `x-uri`:
  ```yaml
  x-uri: &penpot-public-uri
    PENPOT_PUBLIC_URI: http://localhost:9101
  ```
- `penpot-frontend` ports:
  ```yaml
    ports:
      - 9101:8080
  ```
- `penpot-mailcatch` ports:
  ```yaml
    ports:
      - "1180:1080"
  ```
- Do **not** set `image: penpot-mcp:local` here — use the stock `penpotapp/mcp:${PENPOT_VERSION:-2.15}` so this instance is independent of the owner's custom image. (Phase 0 doesn't need the MCP service at all, but leaving it stock is harmless.)

Volumes inherit the compose `volumes:` names but are **project-prefixed** by `-p penpot-hl`, so they become `penpot-hl_penpot_postgres_v15` etc. — fully separate from the owner's `penpot_penpot_*`.

- [ ] **Step 2: Launch the isolated stack**

Run:
```bash
sudo docker compose -p penpot-hl -f infra/penpot-hl/docker-compose.yaml up -d
```
Expected: containers `penpot-hl-penpot-{frontend,backend,postgres,valkey,exporter,mcp,mailcatch}-1` created and started.

- [ ] **Step 3: Verify it's up and ISOLATED from the owner's instance**

Run:
```bash
curl -s -o /dev/null -w 'hl-frontend %{http_code}\n' http://localhost:9101
sudo docker volume ls | grep -E 'penpot(-hl)?_penpot_postgres_v15'
sudo docker compose -p penpot ps --format '{{.Service}}: {{.Status}}' | head -1
```
Expected: `hl-frontend 200`; TWO distinct volumes listed (`penpot_penpot_postgres_v15` AND `penpot-hl_penpot_postgres_v15`); the owner's `penpot` project still shows containers `Up` (untouched).

- [ ] **Step 4: Wait for the backend to finish migrations**

Run:
```bash
for i in $(seq 1 30); do c=$(curl -s -o /dev/null -w '%{http_code}' -X POST http://localhost:9101/api/rpc/command/get-profile); echo "try $i: $c"; [ "$c" = "200" ] && break; sleep 3; done
```
Expected: reaches `200` (backend migrated and serving).

- [ ] **Step 5: Commit the infra file**

```bash
git add infra/penpot-hl/docker-compose.yaml
git commit -m ":whale: Add isolated penpot-hl test instance (ports 9101/1180, access-tokens flag)"
```

---

## Task 2: Create a throwaway account, file, and access token on `penpot-hl`

**Files:**
- Create: `headless-core/test/helpers.mjs`
- Create: `infra/penpot-hl/test-env.json` (gitignored — holds ids/token for local testing)

- [ ] **Step 1: Add test-env to gitignore**

Append to `.gitignore` at repo root:
```
infra/penpot-hl/test-env.json
```

- [ ] **Step 2: Write the RPC client helper**

Create `headless-core/test/helpers.mjs`:
```javascript
// Minimal Penpot RPC client for Phase 0 tests. JSON in / JSON out.
const BASE = process.env.PENPOT_HL_BASE ?? "http://localhost:9101";

async function rpc(name, body, { token, method = "POST" } = {}) {
  const headers = { "Content-Type": "application/json", Accept: "application/json" };
  if (token) headers.Authorization = `Token ${token}`;
  const res = await fetch(`${BASE}/api/rpc/command/${name}`, {
    method,
    headers,
    body: JSON.stringify(body ?? {}),
  });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : undefined; } catch { json = text; }
  if (!res.ok) throw new Error(`${name} -> HTTP ${res.status}: ${text.slice(0, 400)}`);
  return { json, headers: res.headers };
}

// transit-typed responses (prepare-register) come back as ["^ ","~:token", "..."] arrays
function transitToken(json) {
  if (Array.isArray(json)) { const i = json.indexOf("~:token"); return i >= 0 ? json[i + 1] : undefined; }
  return json?.token;
}

export { BASE, rpc, transitToken };
```

- [ ] **Step 3: Write a one-shot setup script that provisions account+file+token**

Create `headless-core/test/setup-env.mjs`:
```javascript
import { writeFileSync } from "node:fs";
import { rpc, transitToken } from "./helpers.mjs";

const email = "hl@penpot.local", password = "penpot1234", fullname = "Headless Tester";

// 1. register (email verification disabled on this instance)
const prep = await rpc("prepare-register-profile", { email, password, fullname });
const regToken = transitToken(prep.json);
await rpc("register-profile", { token: regToken, fullname }).catch(() => {});

// 2. login to obtain an authenticated session cookie
const loginRes = await fetch(`${process.env.PENPOT_HL_BASE ?? "http://localhost:9101"}/api/rpc/command/login-with-password`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Accept: "application/json" },
  body: JSON.stringify({ email, password }),
});
if (!loginRes.ok) throw new Error(`login failed: ${loginRes.status}`);
const setCookie = loginRes.headers.get("set-cookie");
const authCookie = setCookie.split(";")[0]; // auth-token=...
const profile = await loginRes.json();

// helper that calls RPC with the session cookie
async function rpcCookie(name, body) {
  const res = await fetch(`${process.env.PENPOT_HL_BASE ?? "http://localhost:9101"}/api/rpc/command/${name}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", Cookie: authCookie },
    body: JSON.stringify(body ?? {}),
  });
  const t = await res.text();
  if (!res.ok) throw new Error(`${name} -> ${res.status}: ${t.slice(0,300)}`);
  return t ? JSON.parse(t) : undefined;
}

// 3. mint an access token (requires enable-access-tokens, set on penpot-hl)
const tok = await rpcCookie("create-access-token", { name: "headless-phase0" });
const token = tok.token;
if (!token) throw new Error("no access token returned — is enable-access-tokens set?");

// 4. create a project + file to edit
const projectId = profile.defaultProjectId;
const file = await rpcCookie("create-file", { name: "Headless Test File", projectId });

writeFileSync(new URL("../../infra/penpot-hl/test-env.json", import.meta.url),
  JSON.stringify({ token, fileId: file.id, projectId }, null, 2));
console.log("OK fileId=", file.id, "tokenLen=", token.length);
```

- [ ] **Step 4: Run setup and verify it provisions cleanly**

Run:
```bash
cd headless-core && node test/setup-env.mjs
```
Expected: prints `OK fileId=<uuid> tokenLen=<n>` and writes `infra/penpot-hl/test-env.json`. If it errors with "no access token", the `enable-access-tokens` flag from Task 1 didn't take — re-check Task 1 Step 1 and `docker compose ... up -d` to recreate the backend.

- [ ] **Step 5: Verify Token auth actually works (the flag gate)**

Run:
```bash
cd headless-core && node -e '
import("./test/helpers.mjs").then(async ({rpc})=>{
  const env=JSON.parse((await import("node:fs")).readFileSync("../infra/penpot-hl/test-env.json"));
  const {json}=await rpc("get-file",{id:env.fileId},{token:env.token});
  console.log("revn",json.revn,"vern",json.vern,"pages",json.data?.pages?.length);
});'
```
Expected: prints a `revn`, `vern`, and a page count ≥ 1 — proving `Authorization: Token` is accepted and `get-file` returns the document. (No commit — this writes only the gitignored `test-env.json`.)

---

## Task 3: Install the CLJS build toolchain (JDK + Clojure CLI)

**Files:** none (host toolchain)

- [ ] **Step 1: Install JDK and Clojure CLI**

Run:
```bash
sudo pacman -Sy --needed --noconfirm jdk-openjdk clojure rlwrap
```
Expected: installs an OpenJDK and the `clojure`/`clj` CLI. (Node is already present via Volta.)

- [ ] **Step 2: Verify the toolchain**

Run:
```bash
java -version 2>&1 | head -1
clojure --version 2>&1 | head -1
node --version
```
Expected: a Java version line (JDK ≥ 21), a Clojure CLI version line, and Node `v22.x`.

---

## Task 4: Scaffold the `headless-core` CLJS module

**Files:**
- Create: `headless-core/deps.edn`
- Create: `headless-core/shadow-cljs.edn`
- Create: `headless-core/package.json`
- Create: `headless-core/.gitignore`

- [ ] **Step 1: Write `headless-core/.gitignore`**
```
/target/
/node_modules/
/.cpcache/
/.shadow-cljs/
```

- [ ] **Step 2: Write `headless-core/deps.edn`** (mirrors `library/deps.edn`, common-only)
```clojure
{:deps {penpot/common {:local/root "../common"}}
 :aliases
 {:dev
  {:extra-deps {thheller/shadow-cljs {:mvn/version "3.2.2"}}
   :jvm-opts ["--sun-misc-unsafe-memory-access=allow"
              "--enable-native-access=ALL-UNNAMED"]}
  :shadow-cljs
  {:main-opts ["-m" "shadow.cljs.devtools.cli"]}}}
```
*Note:* shadow-cljs 3.2.2 transitively pulls a compatible ClojureScript, so we don't declare `org.clojure/clojurescript` explicitly. If `clojure` reports a shadow/cljs version conflict, copy the EXACT `thheller/shadow-cljs` `:mvn/version` from `frontend/deps.edn:50` (the version this repo is known to build with) rather than guessing.

- [ ] **Step 3: Write `headless-core/shadow-cljs.edn`** (`:esm` + `:node`, exporting the facade)
```clojure
{:deps {:aliases [:dev]}
 :builds
 {:headless
  {:target :esm
   :runtime :node
   :output-dir "target/headless"
   :devtools {:autoload false}
   :modules
   {:penpot
    {:exports {buildAddBoardChange app.headless.core/build-add-board-change
               buildAddBoardBody   app.headless.core/build-add-board-body}}}
   :js-options {:entry-keys ["module" "browser" "main"]
                :export-conditions ["module" "import" "browser" "require" "default"]}
   :compiler-options {:output-feature-set :es2020
                      :output-wrapper false
                      :warnings {:fn-deprecated false}}}}}
```

- [ ] **Step 4: Write `headless-core/package.json`**
```json
{
  "name": "@penpot/headless-core",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "clojure -M:dev:shadow-cljs release headless",
    "watch": "clojure -M:dev:shadow-cljs watch headless"
  }
}
```

- [ ] **Step 5: Commit the scaffold**
```bash
git add headless-core/deps.edn headless-core/shadow-cljs.edn headless-core/package.json headless-core/.gitignore
git commit -m ":seedling: Scaffold headless-core CLJS module (shadow :esm/:node)"
```

---

## Task 5: Write the facade — build a geometry-complete add-board change (unit-tested)

**Files:**
- Create: `headless-core/src/app/headless/core.cljs`
- Create: `headless-core/test/facade.test.mjs`

- [ ] **Step 1: Write the failing unit test**

Create `headless-core/test/facade.test.mjs`:
```javascript
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildAddBoardChange } from "../target/headless/penpot.js";

const PAGE = "00000000-0000-0000-0000-0000000000aa";

test("buildAddBoardChange returns a geometry-complete add-obj change", () => {
  // facade takes a JSON string of args, returns a JSON string of the (plain) change vector
  const out = JSON.parse(buildAddBoardChange(JSON.stringify({
    pageId: PAGE, x: 10, y: 20, width: 300, height: 200, name: "Board A",
  })));
  assert.ok(Array.isArray(out), "returns a vector of changes");
  assert.equal(out.length, 1);
  const ch = out[0];
  assert.equal(ch.type, "add-obj");
  assert.equal(ch.pageId, PAGE);
  assert.equal(ch.obj.type, "frame");           // a board is a frame
  // geometry was computed by Penpot's own setup-shape:
  assert.ok(ch.obj.selrect && ch.obj.selrect.width === 300, "selrect computed");
  assert.ok(Array.isArray(ch.obj.points) && ch.obj.points.length === 4, "points computed");
  assert.ok(ch.obj.transform && ch.obj.transformInverse, "transform present");
});
```

- [ ] **Step 2: Run it to verify it fails (no build yet)**

Run:
```bash
cd headless-core && node --test test/facade.test.mjs
```
Expected: FAIL — cannot find module `../target/headless/penpot.js` (not built yet).

- [ ] **Step 3: Write the facade namespace**

Create `headless-core/src/app/headless/core.cljs`:
```clojure
(ns app.headless.core
  (:require
   [app.common.types.shape :as cts]            ; setup-shape (geometry), "shape" transit handler
   [app.common.files.changes-builder :as pcb]  ; empty-changes, with-page-id, with-objects, add-object
   [app.common.transit :as t]                  ; encode-str / decode-str (wire format)
   [app.common.uuid :as uuid]                   ; uuid/next, uuid/zero
   [app.common.geom.matrix]                     ; side-effect: registers "matrix" transit handler
   [app.common.geom.point]))                    ; side-effect: registers "point" transit handler

;; Build a single geometry-complete :add-obj change for a board (frame).
;; Returns the :redo-changes vector (Penpot data: kebab keywords, Shape/Matrix/Point records).
(defn- add-board-change
  [{:keys [page-id x y width height name parent-id frame-id]}]
  (let [board-id (uuid/next)
        pid      (uuid/uuid page-id)
        parent   (if parent-id (uuid/uuid parent-id) uuid/zero)
        frame    (if frame-id (uuid/uuid frame-id) uuid/zero)
        shape    (cts/setup-shape
                  {:id board-id :type :frame :name (or name "Board")
                   :x x :y y :width width :height height
                   :parent-id parent :frame-id frame})
        changes  (-> (pcb/empty-changes nil pid)
                     (pcb/with-page-id pid)
                     (pcb/with-objects {})
                     (pcb/add-object shape))]
    (:redo-changes changes)))

;; JS-exported: args JSON string -> JSON string of the change vector (camelCase, plain values).
;; We round-trip through transit's JSON writer then read back as plain JS so callers can inspect it.
(defn ^:export build-add-board-change
  [args-json]
  (let [args (js->clj (js/JSON.parse args-json) :keywordize-keys true)
        redo (add-board-change args)]
    ;; encode with Penpot's transit (handles Shape/Matrix/Point), then re-read to plain JS,
    ;; then JSON.stringify so the test sees plain camelCase-ish data. For the wire we use
    ;; build-add-board-body below; this fn exists for inspection/unit-testing.
    (js/JSON.stringify (clj->js redo))))

;; JS-exported: build the FULL update-file params, transit-encoded, ready to POST as the body
;; with Content-Type: application/transit+json. Custom records serialize via their handlers.
(defn ^:export build-add-board-body
  [args-json]
  (let [{:keys [file-id session-id revn vern features] :as args}
        (js->clj (js/JSON.parse args-json) :keywordize-keys true)
        redo   (add-board-change args)
        params {:id (uuid/uuid file-id)
                :session-id (uuid/uuid session-id)
                :revn revn
                :vern vern
                :features (set features)
                :changes redo}]
    (t/encode-str params)))
```
*Note for the executor:* `clj->js` on a Shape record yields a JS object whose keys are the (kebab) keyword names. The unit test asserts on `selrect`/`points`/`transform`/`transformInverse`; if `clj->js` produces kebab keys (`transform-inverse`), adjust the test to match what the build actually emits (run Step 4, read the real keys, align the assertion). The geometry presence is the real assertion; key-casing is cosmetic and is handled properly on the wire by `build-add-board-body` (transit).

- [ ] **Step 4: Build the ESM bundle**

Run:
```bash
cd headless-core && npm run build
```
Expected: shadow-cljs compiles and writes `target/headless/penpot.js` (and shared chunks). First run downloads Maven deps (slow); subsequent runs are fast. If compilation fails on a missing namespace, the error names it — confirm it's a `common.*` ns (portable); if it's a frontend-only ns, remove that require.

- [ ] **Step 5: Run the unit test to verify it passes**

Run:
```bash
cd headless-core && node --test test/facade.test.mjs
```
Expected: PASS (1 test). If key-casing assertions fail, align them to the emitted keys per the Step 3 note, rebuild is NOT needed (test-only change), re-run.

- [ ] **Step 6: Commit**
```bash
git add headless-core/src/app/headless/core.cljs headless-core/test/facade.test.mjs
git commit -m ":sparkles: headless-core facade: geometry-complete add-board via Penpot's setup-shape"
```

---

## Task 6: End-to-end — headless `update-file` adds a board to a real file

**Files:**
- Create: `headless-core/test/roundtrip.test.mjs`

- [ ] **Step 1: Write the failing end-to-end test**

Create `headless-core/test/roundtrip.test.mjs`:
```javascript
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { buildAddBoardBody } from "../target/headless/penpot.js";

const BASE = process.env.PENPOT_HL_BASE ?? "http://localhost:9101";
const env = JSON.parse(readFileSync(new URL("../../infra/penpot-hl/test-env.json", import.meta.url)));

async function getFile() {
  const res = await fetch(`${BASE}/api/rpc/command/get-file`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: `Token ${env.token}` },
    body: JSON.stringify({ id: env.fileId }),
  });
  assert.ok(res.ok, `get-file ${res.status}`);
  return res.json();
}

test("headless update-file adds a board that persists", async () => {
  const before = await getFile();
  const pageId = before.data.pages[0];
  const objsBefore = Object.keys(before.data.pagesIndex[pageId].objects).length;

  // build the transit body with Penpot's own engine
  const body = buildAddBoardBody(JSON.stringify({
    fileId: env.fileId, sessionId: randomUUID(),
    revn: before.revn, vern: before.vern, features: before.features,
    pageId, x: 40, y: 40, width: 320, height: 240, name: "Headless Board",
  }));

  const res = await fetch(`${BASE}/api/rpc/command/update-file`, {
    method: "POST",
    headers: {
      "Content-Type": "application/transit+json",   // body is transit (full record fidelity)
      Accept: "application/json",                    // response as JSON
      Authorization: `Token ${env.token}`,
    },
    body,
  });
  const text = await res.text();
  assert.ok(res.ok, `update-file ${res.status}: ${text.slice(0, 400)}`);

  // verify persistence
  const after = await getFile();
  assert.equal(after.revn, before.revn + 1, "revn incremented");
  const objsAfter = Object.keys(after.data.pagesIndex[pageId].objects).length;
  assert.equal(objsAfter, objsBefore + 1, "exactly one object added");
  const added = Object.values(after.data.pagesIndex[pageId].objects)
    .find((s) => s.name === "Headless Board");
  assert.ok(added, "board present by name");
  assert.equal(added.type, "frame");
  assert.equal(added.selrect.width, 320, "geometry persisted");
});
```

- [ ] **Step 2: Run it to verify it fails meaningfully**

Run:
```bash
cd headless-core && node --test test/roundtrip.test.mjs
```
Expected: it runs (build + env exist from Tasks 2/5). It may FAIL on the first real attempt — capture the exact failure:
- HTTP 400 `:params-validation` → the transit body shape is off (e.g. `features` not a set, missing field). Read the `:explain`.
- HTTP 400 `:revn-conflict`/`:vern-conflict` → you sent stale values; re-read before building.
- HTTP 401/403 → Token/flag issue (revisit Task 2 Step 5).
This is the "watch it fail" step — note which.

- [ ] **Step 3: Fix the facade/body until update-file accepts it**

Most likely fixes (apply as needed, rebuild with `npm run build` after CLJS edits):
- Ensure `:features` is encoded as a **set** (it is, via `(set features)`); the backend wants the file's own features echoed — the test passes `before.features` through.
- If validation rejects the shape, compare `added`-style shapes from a real `get-file` to what `setup-shape` produced; add any missing required attr in the facade's `setup-shape` props.
- If transit decoding errors server-side, confirm the matrix/point requires in `core.cljs` are present (they register the handlers).

- [ ] **Step 4: Run it to verify it passes**

Run:
```bash
cd headless-core && node --test test/roundtrip.test.mjs
```
Expected: PASS — `revn` incremented, exactly one `frame` named "Headless Board" with `selrect.width === 320` persisted. **This is the Phase 0 success criterion: a real file mutated headlessly, no browser, geometry-complete.**

- [ ] **Step 5: (Manual, optional) confirm the live-update**

Open `http://localhost:9101` in a browser, log in as `hl@penpot.local` / `penpot1234`, open "Headless Test File". Re-run the test; confirm the new board appears (live if the tab was already open — validates the websocket broadcast claim in the spec §5.1).

- [ ] **Step 6: Commit**
```bash
git add headless-core/test/roundtrip.test.mjs
git commit -m ":white_check_mark: headless-core: prove headless update-file round-trip on penpot-hl"
```

---

## Task 7: Document Phase 0 results & teardown story

**Files:**
- Create: `headless-core/README.md`

- [ ] **Step 1: Write `headless-core/README.md`**

Document: what Phase 0 proved; how to build (`npm run build`, needs JDK+Clojure); how to run the tests (`node test/setup-env.mjs` once, then `node --test test/*.test.mjs`); the isolation rule (always `penpot-hl`, never `penpot`); how to stop/remove the test instance:
```bash
# stop without deleting data
sudo docker compose -p penpot-hl -f infra/penpot-hl/docker-compose.yaml stop
# full teardown incl. volumes (throwaway data)
sudo docker compose -p penpot-hl -f infra/penpot-hl/docker-compose.yaml down -v
```
Record the open questions resolved (JSON-in/transit-out, access-tokens flag) and what Phase 1 builds on (the facade pattern, the working-copy manager).

- [ ] **Step 2: Commit**
```bash
git add headless-core/README.md
git commit -m ":memo: Document headless-core Phase 0 (build, test, isolation, teardown)"
```

---

## Phase 0 Done = exit criteria

- `headless-core` builds Penpot's `common` CLJS to a Node ESM bundle (`npm run build`).
- `facade.test.mjs` passes: `setup-shape` produces geometry (selrect/points/transform) headlessly.
- `roundtrip.test.mjs` passes: a board is added to a real file via `update-file` with **no browser/plugin**, `revn` increments, geometry persists, (optionally) a browser tab updates live.
- All of it runs against the isolated `penpot-hl` instance; the owner's `penpot` instance is untouched.

**Next:** Phase 1 plan (online working-copy manager, scripting runtime, helpers, MCP server + `pp` CLI, skill) — written after Phase 0 validates the facade shape.
