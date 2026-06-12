# Pencilpot Phase 0 — Viability Spike Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove the riskiest assumption of the whole pencilpot program — that Penpot's stock designer SPA loads a real file, renders it, and round-trips an edit to disk when its *only* backend is a hand-rolled local Node server feeding from the filesystem via headless-core (no JVM, no Postgres, no auth).

**Architecture:** A local Node server on `http://localhost:7777` that (Stage A) reverse-proxies penpot-hl's already-compiled frontend + API while **recording** every `/api/*` exchange; then (Stage B) **replays** the boot/SaaS endpoints from captured fixtures so the SPA boots past login with penpot-hl's API unused; then (Stage C) replaces `get-file`/`update-file` with **headless-core + an on-disk file**, so reads come from disk (fully inline, no fragments) and an edit made in the canvas persists to disk and survives reload. Static assets stay proxied from penpot-hl's frontend container the entire time (building our own bundle is Phase 2/3, explicitly out of scope here).

**Tech Stack:** Node 20+ (built-in `http`, `fetch`), the `ws` package (websocket stub + proxy), the existing `headless-core` engine (`target/headless/penpot.js`, ESM) for transit-faithful hydrate/encode and change application. penpot-hl running on `:9101` (control: `penpot start`).

---

## Scope & boundaries

- **In scope:** the local server, the record/replay/mutate stages, one new engine method (`getFileResponse`) + a tiny disk store, automated tests for the engine/mutate paths, manual verification for canvas rendering, and a written go/no-go spike report.
- **Out of scope (later phases):** building/serving our own stripped frontend bundle (Phase 2/3), the exploded git-native directory format (Phase 1/S — the spike stores the file as a single transit blob + meta JSON), shared libraries (Phase 1), the terminal/AI panel (Phase 4), file association / `--app` packaging polish (Phase 3 — here we just launch a Chromium `--app` window by hand).
- **Decision this spike produces:** GO (the program is viable as specced) or NO-GO/REVISE (with the specific blocker), recorded in `pencilpot/spike/SPIKE-REPORT.md`.

## File structure

- Create: `pencilpot/spike/package.json` — spike package (type: module), deps `ws`, test script.
- Create: `pencilpot/spike/server.mjs` — the local server (proxy + record + replay + api router); mode via `PENCILPOT_MODE=proxy|replay|serve`.
- Create: `pencilpot/spike/proxy.mjs` — asset/API reverse-proxy + `config.js` rewrite + `/ws/notifications` stub.
- Create: `pencilpot/spike/recorder.mjs` — records `/api/*` request/response pairs to `recordings/`.
- Create: `pencilpot/spike/fixtures.mjs` — loads captured responses and replays them by command name.
- Create: `pencilpot/spike/store.mjs` — read/write the on-disk file (`store/<file-id>.transit` + `store/<file-id>.meta.json`).
- Create: `pencilpot/spike/api.mjs` — the `/api/*` router: get-file/update-file via engine+store, everything else via fixtures.
- Create: `pencilpot/spike/launch.mjs` — open a Chromium `--app` window at a given workspace URL.
- Create: `pencilpot/spike/test/engine-roundtrip.test.mjs`, `pencilpot/spike/test/mutate.test.mjs`.
- Create: `pencilpot/spike/recordings/` (gitignored), `pencilpot/spike/store/` (gitignored).
- Create: `pencilpot/spike/SPIKE-REPORT.md` — go/no-go report + the captured RPC contract.
- Create: `docs/pencilpot/architecture/00-phase0-spike.md` — architecture note for the spike (per the docs discipline).
- Modify: `headless-core/src/app/headless/session.cljs` — add `getFileResponse` (exposed on the session object).
- Modify: `headless-core/sdk/working-copy.mjs` — expose `getFileResponse()` wrapper (used by the store).
- Modify: `.gitignore` — ignore `pencilpot/spike/recordings/` and `pencilpot/spike/store/`.

---

## Task 0: Scaffold the spike package

**Files:**
- Create: `pencilpot/spike/package.json`
- Create: `pencilpot/spike/.gitignore`
- Modify: `.gitignore` (repo root)

- [ ] **Step 1: Create the package**

`pencilpot/spike/package.json`:
```json
{
  "name": "pencilpot-spike",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "proxy": "PENCILPOT_MODE=proxy node server.mjs",
    "replay": "PENCILPOT_MODE=replay node server.mjs",
    "serve": "PENCILPOT_MODE=serve node server.mjs",
    "test": "node --test test/"
  },
  "dependencies": {
    "ws": "^8.18.0"
  }
}
```

- [ ] **Step 2: Local + repo gitignore**

`pencilpot/spike/.gitignore`:
```
recordings/
store/
node_modules/
```

Append to repo-root `.gitignore`:
```
pencilpot/spike/recordings/
pencilpot/spike/store/
pencilpot/spike/node_modules/
```

- [ ] **Step 3: Install deps**

Run: `cd pencilpot/spike && npm install`
Expected: `ws` installed, `node_modules/` present, no errors.

- [ ] **Step 4: Commit**

```bash
git add pencilpot/spike/package.json pencilpot/spike/.gitignore .gitignore
git commit -m ":seedling: pencilpot spike: scaffold local-server package"
```

---

## Task 1: Asset reverse-proxy + config rewrite + ws stub (proxy mode)

**Goal:** Serve penpot-hl's compiled frontend from our origin (`:7777`) so the SPA's RPC comes to *us*, and a websocket connection never breaks boot.

**Files:**
- Create: `pencilpot/spike/proxy.mjs`
- Create: `pencilpot/spike/server.mjs`
- Create: `pencilpot/spike/launch.mjs`

- [ ] **Step 1: Proxy module**

`pencilpot/spike/proxy.mjs`:
```javascript
// Reverse-proxy penpot-hl's frontend + (in proxy mode) its API.
// Rewrites config so the SPA's public-uri is OUR origin, and stubs the websocket.
import { WebSocketServer } from "ws";

const UPSTREAM = process.env.PENCILPOT_UPSTREAM ?? "http://localhost:9101";

// Forward an incoming Node req to UPSTREAM and pipe the response back.
export async function proxyHttp(req, res, { rewriteConfig = true } = {}) {
  const url = UPSTREAM + req.url;
  const headers = { ...req.headers, host: new URL(UPSTREAM).host };
  const body = ["GET", "HEAD"].includes(req.method)
    ? undefined
    : await readBody(req);
  const upstream = await fetch(url, { method: req.method, headers, body, redirect: "manual" });
  let buf = Buffer.from(await upstream.arrayBuffer());
  const ct = upstream.headers.get("content-type") || "";

  // Force the SPA to treat OUR origin as the backend: neutralize any baked public-uri.
  if (rewriteConfig && req.url.includes("/js/config.js")) {
    let js = buf.toString("utf8");
    js += `\n;globalThis.penpotPublicURI=location.origin;globalThis.penpotFlags="";\n`;
    buf = Buffer.from(js, "utf8");
  }
  res.writeHead(upstream.status, { "content-type": ct, "cache-control": "no-store" });
  res.end(buf);
}

export function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

// Accept /ws/notifications and do nothing (no presence/collab in local mode).
export function attachWsStub(server) {
  const wss = new WebSocketServer({ server, path: "/ws/notifications" });
  wss.on("connection", (sock) => {
    // Swallow client messages; never push. Keeps the SPA happy without a collab backend.
    sock.on("message", () => {});
    sock.on("error", () => {});
  });
}
```

- [ ] **Step 2: Server entry (mode dispatch)**

`pencilpot/spike/server.mjs`:
```javascript
import http from "node:http";
import { proxyHttp, attachWsStub, readBody } from "./proxy.mjs";
import { record } from "./recorder.mjs";
import { handleApi } from "./api.mjs";

const MODE = process.env.PENCILPOT_MODE ?? "proxy";
const PORT = Number(process.env.PENCILPOT_PORT ?? 7777);

const server = http.createServer(async (req, res) => {
  const isApi = req.url.startsWith("/api/");
  try {
    if (isApi && MODE === "proxy") {
      // proxy + record: forward to upstream, log the exchange
      const body = ["GET", "HEAD"].includes(req.method) ? undefined : await readBody(req);
      await record(req, res, body);
      return;
    }
    if (isApi) {
      // replay / serve: answer from fixtures + engine
      return await handleApi(req, res, MODE);
    }
    // everything else: proxy the compiled frontend assets
    return await proxyHttp(req, res);
  } catch (err) {
    console.error("server error", req.method, req.url, err);
    res.writeHead(500); res.end(String(err));
  }
});

attachWsStub(server);
server.listen(PORT, () => console.log(`pencilpot spike [${MODE}] on http://localhost:${PORT}`));
```

> Note: `recorder.mjs` and `api.mjs` are created in later tasks. To run *this* task standalone, temporarily stub them: create `recorder.mjs` exporting `export async function record(){}` and `api.mjs` exporting `export async function handleApi(){}`. They get real bodies in Tasks 2 and 6–7.

- [ ] **Step 3: Launcher**

`pencilpot/spike/launch.mjs`:
```javascript
// Open a chromeless --app window at a URL. Usage: node launch.mjs "http://localhost:7777/..."
import { spawn } from "node:child_process";
const url = process.argv[2] ?? "http://localhost:7777/";
const browsers = ["vivaldi-stable", "microsoft-edge-stable", "google-chrome-stable", "chromium", "brave"];
for (const b of browsers) {
  try { spawn(b, [`--app=${url}`], { detached: true, stdio: "ignore" }).unref(); console.log("opened with", b); break; }
  catch {}
}
```

- [ ] **Step 4: Manual verification — SPA boots through our proxy**

Run (penpot-hl must be up: `penpot start`):
```bash
cd pencilpot/spike && PENCILPOT_MODE=proxy node server.mjs &
node launch.mjs "http://localhost:7777/"
```
Expected: a chromeless window opens showing penpot-hl's **login page**, served via `:7777`. Log in as `hl@penpot.local` / `penpot1234`. You reach the dashboard. This proves our proxy transparently serves the real SPA + API from our origin. (Leave the server running for Task 2.)

- [ ] **Step 5: Commit**

```bash
git add pencilpot/spike/proxy.mjs pencilpot/spike/server.mjs pencilpot/spike/launch.mjs
git commit -m ":sparkles: pencilpot spike: asset proxy + config rewrite + ws stub"
```

---

## Task 2: Record the boot + file-load RPC contract

**Goal:** Capture, verbatim, every `/api/*` exchange the SPA makes from boot through opening a real file — this *is* the contract the local server must satisfy, and the source of replay fixtures.

**Files:**
- Create: `pencilpot/spike/recorder.mjs`

- [ ] **Step 1: Recorder module**

`pencilpot/spike/recorder.mjs`:
```javascript
// Proxy an /api/* call to upstream and append the full exchange to recordings/.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "recordings");
fs.mkdirSync(DIR, { recursive: true });
const UPSTREAM = process.env.PENCILPOT_UPSTREAM ?? "http://localhost:9101";
let seq = 0;

const cmd = (url) => url.split("?")[0].split("/").filter(Boolean).pop(); // last path segment

export async function record(req, res, body) {
  const url = UPSTREAM + req.url;
  const headers = { ...req.headers, host: new URL(UPSTREAM).host };
  const upstream = await fetch(url, { method: req.method, headers, body, redirect: "manual" });
  const buf = Buffer.from(await upstream.arrayBuffer());
  const ct = upstream.headers.get("content-type") || "";

  const name = cmd(req.url);
  const n = String(seq++).padStart(3, "0");
  const meta = {
    seq: n, method: req.method, url: req.url, command: name,
    status: upstream.status, contentType: ct,
    reqBody: body ? body.toString("utf8").slice(0, 20000) : null,
  };
  fs.writeFileSync(path.join(DIR, `${n}-${name}.json`), JSON.stringify(meta, null, 2));
  fs.writeFileSync(path.join(DIR, `${n}-${name}.body`), buf);

  res.writeHead(upstream.status, { "content-type": ct });
  res.end(buf);
}
```

- [ ] **Step 2: Re-run the proxy with recording (already wired in server.mjs proxy mode)**

Restart the server in proxy mode if not running:
```bash
cd pencilpot/spike && rm -rf recordings && PENCILPOT_MODE=proxy node server.mjs &
node launch.mjs "http://localhost:7777/"
```

- [ ] **Step 3: Capture the sequence — open a real file**

In the window: log in, open the **"Headless Test File"** (the known penpot-hl file). Watch it render. Then make ONE trivial edit (move a rectangle a little) so an `update-file` is also recorded. Note the **workspace URL** from the address bar (format `…/#/workspace/<...>/<file-id>` or `/workspace/<project-id>/<file-id>` — record exactly).

- [ ] **Step 4: Manual verification — the contract is captured**

Run: `ls pencilpot/spike/recordings/`
Expected: numbered files including (names will vary by version) `*-get-profile.*`, `*-get-teams.*`, `*-get-file.*`, `*-get-fonts.*`, `*-get-file-libraries.*`, `*-get-file-object-thumbnails.*`, `*-get-project.*`, `*-get-team.*`, `*-retrieve-comment-threads.*` (or `get-comment-threads`), and one `*-update-file.*`.

Run: `node -e "for (const f of require('fs').readdirSync('recordings').filter(x=>x.endsWith('.json'))) {const m=require('./recordings/'+f); console.log(m.method, m.command, m.status, m.contentType)}"` (from `pencilpot/spike/`)
Expected: a printed list of every command, its method, status 200, and content-type. **This list is the implementation checklist for Task 6.** Confirm whether `get-file-fragment` appears (if the test file uses fragments) — note it in the report; our `serve` mode will return inline data to avoid it.

- [ ] **Step 5: Commit (metadata only — bodies are gitignored)**

```bash
git add -A pencilpot/spike
git commit -m ":sparkles: pencilpot spike: record boot+load RPC contract"
```

---

## Task 3: Build replay fixtures from the recording

**Goal:** Turn the captured exchanges into a lookup the server can answer from, keyed by command name, replaying the exact transit bytes.

**Files:**
- Create: `pencilpot/spike/fixtures.mjs`

- [ ] **Step 1: Fixtures loader**

`pencilpot/spike/fixtures.mjs`:
```javascript
// Replay captured /api responses by command name (verbatim bytes).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "recordings");

// Map command-name -> { status, contentType, body:Buffer }. Last write wins (latest capture).
function load() {
  const map = new Map();
  if (!fs.existsSync(DIR)) return map;
  for (const f of fs.readdirSync(DIR).filter((x) => x.endsWith(".json"))) {
    const meta = JSON.parse(fs.readFileSync(path.join(DIR, f), "utf8"));
    const body = fs.readFileSync(path.join(DIR, f.replace(/\.json$/, ".body")));
    map.set(meta.command, { status: meta.status, contentType: meta.contentType, body });
  }
  return map;
}

const FIXTURES = load();

export function replayFixture(command, res) {
  const fx = FIXTURES.get(command);
  if (!fx) { res.writeHead(404); res.end(`no fixture for ${command}`); return false; }
  res.writeHead(fx.status, { "content-type": fx.contentType });
  res.end(fx.body);
  return true;
}

export function hasFixture(command) { return FIXTURES.has(command); }
```

- [ ] **Step 2: Sanity check the loader**

Run (from `pencilpot/spike/`):
```bash
node -e "import('./fixtures.mjs').then(m=>console.log('get-profile?', m.hasFixture('get-profile'), 'get-file?', m.hasFixture('get-file')))"
```
Expected: `get-profile? true get-file? true`.

- [ ] **Step 3: Commit**

```bash
git add pencilpot/spike/fixtures.mjs
git commit -m ":sparkles: pencilpot spike: replay fixtures loader"
```

---

## Task 4: Replay mode — boot the SPA with the API served from fixtures

**Goal:** Prove the SPA boots all the way into the canvas with **penpot-hl's API unused** — every `/api/*` answered from captured fixtures (assets still proxied). This isolates "does the frontend work against a non-Penpot API source."

**Files:**
- Create (minimal): `pencilpot/spike/api.mjs` (fixture-only version; extended in Tasks 6–7)

- [ ] **Step 1: Minimal API router (fixtures only)**

`pencilpot/spike/api.mjs`:
```javascript
import { replayFixture } from "./fixtures.mjs";
import { readBody } from "./proxy.mjs";

const cmd = (url) => url.split("?")[0].split("/").filter(Boolean).pop();

export async function handleApi(req, res, mode) {
  if (!["GET", "HEAD"].includes(req.method)) await readBody(req); // drain
  const command = cmd(req.url);
  // serve mode overrides get-file/update-file in Task 6/7; until then, everything is a fixture.
  return replayFixture(command, res);
}
```

- [ ] **Step 2: Manual verification — canvas loads from fixtures, no upstream API**

Run:
```bash
cd pencilpot/spike && PENCILPOT_MODE=replay node server.mjs &
node launch.mjs "http://localhost:7777/<the workspace URL path captured in Task 2>"
```
Expected: the window navigates **straight into the workspace canvas** showing the file — no login redirect (the recorded `get-profile` carries a non-zero id), no crash from the missing websocket. The design renders from replayed bytes.

To *prove* the API isn't hitting penpot-hl: with the replay server running, stop only upstream API reachability is hard, so instead confirm in the server log that requests are answered locally (add a `console.log("[replay]", command)` in `handleApi` if needed) and that the canvas still renders. **Pass = canvas renders with all `/api/*` answered by `[replay]`.**

> If the canvas does NOT render here, capture the failing command/console error in `SPIKE-REPORT.md` — this is exactly the fidelity risk the spike exists to surface. Common fixable causes: a command returning GET vs POST mismatch, or a missing fixture (add it by re-recording that interaction).

- [ ] **Step 3: Commit**

```bash
git add pencilpot/spike/api.mjs
git commit -m ":sparkles: pencilpot spike: replay mode boots SPA into canvas from fixtures"
```

---

## Task 5: Engine — emit a get-file response from a file in memory (round-trip)

**Goal:** Give headless-core the ability to serialize a hydrated file back into a **get-file-compatible response** with fully-inline data (no fragments) and transit-encoded body — the core capability the `serve` mode and sub-project L need. TDD.

**Files:**
- Modify: `headless-core/src/app/headless/session.cljs`
- Modify: `headless-core/sdk/working-copy.mjs`
- Create: `pencilpot/spike/test/engine-roundtrip.test.mjs`

- [ ] **Step 1: Write the failing test**

`pencilpot/spike/test/engine-roundtrip.test.mjs`:
```javascript
import { test } from "node:test";
import assert from "node:assert/strict";
import { createSession } from "../../../headless-core/target/headless/penpot.js";

test("getFileResponse emits inline transit that re-hydrates to the same shapes", () => {
  const s = createSession(JSON.stringify({ empty: true }));
  const b = s.addBoard(JSON.stringify({ x: 0, y: 0, width: 100, height: 100, name: "B" }));
  s.addRect(JSON.stringify({ x: 10, y: 10, width: 20, height: 20, parentId: b }));
  s.closeBoard();

  const resp = JSON.parse(s.getFileResponse()); // { meta: {...}, transit: "<transit string>" }
  assert.ok(resp.meta.id, "has file id");
  assert.ok(typeof resp.transit === "string" && resp.transit.length > 0, "has transit body");

  // Re-hydrate from the emitted response and confirm the shapes survive.
  const s2 = createSession(JSON.stringify({ fromTransit: resp.transit, meta: resp.meta }));
  const objs = JSON.parse(s2.objects());
  assert.ok(objs[b], "board survived round-trip");
});
```

- [ ] **Step 2: Run it — expect failure**

Run: `cd headless-core && npm run build && node --test ../pencilpot/spike/test/engine-roundtrip.test.mjs`
Expected: FAIL — `s.getFileResponse is not a function` (and `createSession` won't accept `fromTransit`/`meta` yet).

- [ ] **Step 3: Implement `getFileResponse` + a transit-hydrate path in `session.cljs`**

In `headless-core/src/app/headless/session.cljs`, ensure `app.common.transit` is required (it already is for hydrate). Add to the exported session object a `getFileResponse` fn and teach `createSession` to accept `{:fromTransit <str> :meta <map>}`:

```clojure
;; inside make-session / the exported object map, alongside objects/validate/commitBody:
:getFileResponse
(fn []
  (let [data  (:data @state)
        meta  {:id (str file-id)
               :name (or (:name @state) "Pencilpot File")
               :revn (:revn @state 0)
               :vern (:vern @state 0)
               :features []
               ;; get-file returns :data inline here (no pointer fragments)
               :data {:pages (get data :pages)}}
        ;; full response object the frontend's get-file expects, data INLINE:
        resp  (assoc meta :data data)
        body  (ct/encode-str resp {:type :json-verbose})]
    (js/JSON.stringify (clj->js {:meta meta :transit body}))))
```

And in `createSession`, add a branch: if opts has `fromTransit`, hydrate via `(ct/decode-str fromTransit)` into `:data` and seed `:revn`/`:vern`/`file-id` from `meta` (mirror the existing get-file hydrate path used by WorkingCopy).

> Exact key names for the get-file response (`:data`, `:revn`, `:vern`, `:features`, `:pages`, `:pages-index`) must match what you decoded from the Task 2 `get-file` body. Decode it to confirm: `node -e "..."` using the engine's transit decode, or inspect via the WorkingCopy. Adjust the `resp`/`meta` map to match the recorded shape exactly.

- [ ] **Step 4: Expose it on WorkingCopy (used by the store)**

In `headless-core/sdk/working-copy.mjs`, add:
```javascript
  getFileResponse() { return this.session.getFileResponse(); }
```

- [ ] **Step 5: Run the test — expect pass**

Run: `cd headless-core && npm run build && node --test ../pencilpot/spike/test/engine-roundtrip.test.mjs`
Expected: PASS (3 assertions).

- [ ] **Step 6: Commit**

```bash
git add headless-core/src/app/headless/session.cljs headless-core/sdk/working-copy.mjs pencilpot/spike/test/engine-roundtrip.test.mjs
git commit -m ":sparkles: headless: getFileResponse (inline get-file emit) + transit re-hydrate"
```

---

## Task 6: Serve mode — `get-file` from disk via the engine

**Goal:** Replace the `get-file` fixture with a response generated by headless-core from an on-disk file. Reads now come from *our* store, not penpot-hl, not a static fixture.

**Files:**
- Create: `pencilpot/spike/store.mjs`
- Modify: `pencilpot/spike/api.mjs`

- [ ] **Step 1: Seed the on-disk store from the recording**

`pencilpot/spike/store.mjs`:
```javascript
// Spike store: a file lives as <id>.transit (file-data transit) + <id>.meta.json.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "store");
fs.mkdirSync(DIR, { recursive: true });

export function writeFile(id, transit, meta) {
  fs.writeFileSync(path.join(DIR, `${id}.transit`), transit);
  fs.writeFileSync(path.join(DIR, `${id}.meta.json`), JSON.stringify(meta, null, 2));
}
export function readFile(id) {
  const tp = path.join(DIR, `${id}.transit`);
  if (!fs.existsSync(tp)) return null;
  return {
    transit: fs.readFileSync(tp, "utf8"),
    meta: JSON.parse(fs.readFileSync(path.join(DIR, `${id}.meta.json`), "utf8")),
  };
}
export const FILE_ID = process.env.PENCILPOT_FILE_ID ?? null;
```

Seed it once from the captured `get-file` body (which is the file-data transit) + meta. Write a one-off script step:
```bash
# from pencilpot/spike/ — copy the recorded get-file transit body into the store as the seed file
node -e "
import('./store.mjs').then(s=>{
  const fs=require('fs');
  const j=fs.readdirSync('recordings').find(f=>f.includes('get-file')&&f.endsWith('.json'));
  const meta=JSON.parse(fs.readFileSync('recordings/'+j));
  const transit=fs.readFileSync('recordings/'+j.replace(/\.json$/, '.body'),'utf8');
  const id=process.env.PENCILPOT_FILE_ID; // set this to the test file id
  s.writeFile(id, transit, {id});
  console.log('seeded', id);
})"
```
Set `PENCILPOT_FILE_ID` to the file id from the Task 2 workspace URL before running.

- [ ] **Step 2: Wire `get-file` into the API router (serve mode)**

Replace `pencilpot/spike/api.mjs` `handleApi` body:
```javascript
import { replayFixture } from "./fixtures.mjs";
import { readBody } from "./proxy.mjs";
import { readFile, writeFile } from "./store.mjs";
import { WorkingCopy } from "../../headless-core/sdk/index.mjs";

const cmd = (url) => url.split("?")[0].split("/").filter(Boolean).pop();

// Build an in-memory session from a stored file (transit + meta).
async function sessionFor(id) {
  const f = readFile(id);
  if (!f) return null;
  // createSession({fromTransit, meta}) implemented in Task 5
  const { createSession } = await import("../../headless-core/target/headless/penpot.js");
  return createSession(JSON.stringify({ fromTransit: f.transit, meta: f.meta }));
}

export async function handleApi(req, res, mode) {
  const command = cmd(req.url);
  if (mode === "serve" && command === "get-file") {
    const id = (req.url.split("id=")[1] || "").split("&")[0] || process.env.PENCILPOT_FILE_ID;
    const s = await sessionFor(id);
    if (!s) return replayFixture("get-file", res); // fallback
    const { meta, transit } = JSON.parse(s.getFileResponse());
    const accept = req.headers["accept"] || "";
    if (accept.includes("transit")) {
      res.writeHead(200, { "content-type": "application/transit+json" });
      res.end(transit);
    } else {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(meta));
    }
    return true;
  }
  if (!["GET", "HEAD"].includes(req.method)) await readBody(req); // drain non-get-file writes for now
  return replayFixture(command, res);
}
```

- [ ] **Step 3: Manual verification — canvas renders from disk-backed get-file**

Run:
```bash
cd pencilpot/spike && PENCILPOT_FILE_ID=<file-id> PENCILPOT_MODE=serve node server.mjs &
node launch.mjs "http://localhost:7777/<workspace URL>"
```
Expected: the canvas renders the file, with `get-file` now produced by **headless-core from `store/<id>.transit`** (other boot endpoints still fixtures). Edit the server to `console.log("[serve] get-file from disk")` to confirm the path was taken.
**Pass = canvas renders correctly with get-file served from the engine+disk.**

- [ ] **Step 4: Commit**

```bash
git add pencilpot/spike/store.mjs pencilpot/spike/api.mjs
git commit -m ":sparkles: pencilpot spike: serve get-file from disk via headless-core"
```

---

## Task 7: Serve mode — `update-file` mutates the on-disk file (write round-trip)

**Goal:** Prove the decisive write path: an edit from the real canvas flows through `update-file`, is applied by headless-core, and is written back to disk — and survives reload. TDD for the mutate logic + manual e2e for the canvas.

**Files:**
- Modify: `pencilpot/spike/api.mjs`
- Create: `pencilpot/spike/test/mutate.test.mjs`

- [ ] **Step 1: Write the failing test (apply a change → disk updates)**

`pencilpot/spike/test/mutate.test.mjs`:
```javascript
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { writeFile, readFile } from "../store.mjs";
import { applyUpdate } from "../api.mjs";
import { createSession } from "../../../headless-core/target/headless/penpot.js";

test("applyUpdate moves a shape and persists the new position to disk", async () => {
  // seed a tiny file in the store
  const s = createSession(JSON.stringify({ empty: true }));
  const b = s.addBoard(JSON.stringify({ x: 0, y: 0, width: 100, height: 100, name: "B" }));
  const r = s.addRect(JSON.stringify({ x: 10, y: 10, width: 20, height: 20, parentId: b }));
  s.closeBoard();
  const { meta, transit } = JSON.parse(s.getFileResponse());
  const id = meta.id; writeFile(id, transit, meta);

  // a change that moves rect r to x=99 (mod-obj set :x)
  const changes = [{ type: "mod-obj", id: r, operations: [{ type: "set", attr: "x", val: 99 }] }];
  await applyUpdate(id, JSON.stringify({ changes }));

  // reload from disk, confirm x persisted
  const f = readFile(id);
  const s2 = createSession(JSON.stringify({ fromTransit: f.transit, meta: f.meta }));
  const moved = JSON.parse(s2.getShape(r));
  assert.equal(moved.x, 99, "moved x persisted to disk");
});
```

- [ ] **Step 2: Run it — expect failure**

Run: `cd headless-core && npm run build && node --test ../pencilpot/spike/test/mutate.test.mjs`
Expected: FAIL — `applyUpdate` is not exported.

- [ ] **Step 3: Implement `applyUpdate` + wire update-file into the router**

Add to `pencilpot/spike/api.mjs`:
```javascript
import { createSession } from "../../headless-core/target/headless/penpot.js";

// Apply a JSON {changes:[...]} to the stored file and write it back.
export async function applyUpdate(id, jsonBody) {
  const f = readFile(id);
  if (!f) throw new Error(`no stored file ${id}`);
  const s = createSession(JSON.stringify({ fromTransit: f.transit, meta: f.meta }));
  const { changes } = JSON.parse(jsonBody);
  s.applyChanges(JSON.stringify(changes)); // see note below
  const { meta, transit } = JSON.parse(s.getFileResponse());
  meta.revn = (f.meta.revn ?? 0) + 1;
  writeFile(id, transit, meta);
  return meta;
}
```

> The real `update-file` body from the SPA is **transit**, with changes in Penpot's change schema. Two integration realities to handle in this step:
> 1. Add a thin `applyChanges(jsonChanges)` to `session.cljs` (decode JSON change vector → `cfc/process-changes` via the existing `apply-changes!` path) so the spike can apply changes from JSON. For the *real* SPA body (transit), decode it with the engine's transit decoder first, then apply. Add a `session.applyTransitUpdate(transitBody)` that `ct/decode-str`s the body, pulls `:changes`, and applies — and call that from the router for live SPA traffic.
> 2. In `handleApi`, for `mode === "serve" && command === "update-file"`: read the body, call `session.applyTransitUpdate`, persist, and return the JSON `{ :revn }` response shape the SPA expects (confirm shape from the recorded `update-file` response body).

Router branch (add to `handleApi`, before the fixture fallback):
```javascript
  if (mode === "serve" && command === "update-file") {
    const body = (await readBody(req)).toString("utf8");
    const id = process.env.PENCILPOT_FILE_ID;
    const f = readFile(id);
    const s = createSession(JSON.stringify({ fromTransit: f.transit, meta: f.meta }));
    s.applyTransitUpdate(body);                 // decode transit + process-changes
    const { meta, transit } = JSON.parse(s.getFileResponse());
    meta.revn = (f.meta.revn ?? 0) + 1;
    writeFile(id, transit, meta);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ revn: meta.revn }));   // adjust to recorded shape
    return true;
  }
```

- [ ] **Step 4: Run the test — expect pass**

Run: `cd headless-core && npm run build && node --test ../pencilpot/spike/test/mutate.test.mjs`
Expected: PASS — moved x == 99 read back from disk.

- [ ] **Step 5: Manual verification — the decisive e2e**

Run:
```bash
cd pencilpot/spike && PENCILPOT_FILE_ID=<file-id> PENCILPOT_MODE=serve node server.mjs &
node launch.mjs "http://localhost:7777/<workspace URL>"
```
In the canvas: **move a shape**, wait for the autosave (`update-file`). Then **reload the window** (Ctrl-R). 
Expected: the shape stays in its new position — proving edit → `update-file` → headless-core → disk → reload round-trip with **no JVM/DB/cloud**. Confirm `store/<id>.transit` mtime changed and `store/<id>.meta.json` `revn` incremented.
**This is the GO/NO-GO moment.**

- [ ] **Step 6: Commit**

```bash
git add pencilpot/spike/api.mjs pencilpot/spike/test/mutate.test.mjs headless-core/src/app/headless/session.cljs
git commit -m ":sparkles: pencilpot spike: update-file mutates on-disk file via headless-core (write round-trip)"
```

---

## Task 8: Spike report + architecture doc + decision

**Goal:** Record the outcome, the captured RPC contract, fidelity issues found, and the GO/NO-GO decision — feeding the Phase 1 spec.

**Files:**
- Create: `pencilpot/spike/SPIKE-REPORT.md`
- Create: `docs/pencilpot/architecture/00-phase0-spike.md`

- [ ] **Step 1: Write the report**

`pencilpot/spike/SPIKE-REPORT.md` must contain:
- **Decision:** GO / NO-GO / REVISE, with the one-line reason.
- **RPC contract:** the full command list from Task 2 (method, status, whether fixture-stubbable vs disk-backed), and whether `get-file-fragment` was needed.
- **Fidelity findings:** anything that rendered wrong / any command that needed special handling; console errors tolerated vs fatal.
- **Inline-data verdict:** did returning fully-inline `get-file` (no fragments) work for the SPA? (key Phase 1 input)
- **Write round-trip:** confirmed yes/no, with the observed revn bump + disk change.
- **Gaps for Phase 1:** what the real runtime (sub-project L) must add beyond the spike (fragments? more commands? font handling?).

- [ ] **Step 2: Architecture doc (docs discipline)**

`docs/pencilpot/architecture/00-phase0-spike.md`: short living doc — the proxy/record/replay/serve design, the single-origin + public-uri-rewrite trick, the ws stub, the `getFileResponse` inline-emit approach, and a diagram. Link it from a `docs/pencilpot/architecture/README.md` index (create it).

- [ ] **Step 3: Per-changefile docs**

Add a `pencilpot/spike/README.md` listing each spike file and its one-line responsibility (purpose / interface / deps) per the per-changefile docs discipline.

- [ ] **Step 4: Commit**

```bash
git add pencilpot/spike/SPIKE-REPORT.md pencilpot/spike/README.md docs/pencilpot/architecture/
git commit -m ":memo: pencilpot spike: go/no-go report + architecture doc"
```

---

## Self-Review (against the spec)

- **Spec §3 keystone (one RPC chokepoint):** Tasks 1–7 validate it empirically — the SPA talks only to our origin; we satisfy its `/api/*`. ✓
- **Spec §3 (local server = headless-core + FS, subsumes SDK Phase 3):** Tasks 5–7 build exactly that (engine emits get-file, applies update-file, persists to disk). ✓
- **Spec §9 testing discipline (every change ships a test):** Tasks 5 & 7 are TDD with real automated tests; UI-rendering steps that can't be unit-tested have explicit manual pass/fail criteria (flagged as such, not hidden). ✓
- **Spec §9 documentation discipline:** Task 8 produces the architecture doc + per-changefile README + the report. ✓
- **Spec §8 phasing (Phase 0 single-file, de-risk core):** spike is single-file; format/shared-libs/terminal/packaging explicitly deferred (Scope & boundaries). ✓
- **Spec §10 risks:** risk 1 (frontend↔handrolled RPC) is the whole spike; risk 2 (diff-stable serialization) is deferred to S but the inline-emit verdict feeds it; risk 4 (canvas under Chromium --app) is exercised in Tasks 4/6/7. ✓
- **Commit hygiene:** all commits use the standard subject style; **no Claude attribution** (per [[git-commit-no-claude-attribution]]). ✓

**Type/name consistency:** `getFileResponse()` returns `{meta, transit}` everywhere (Tasks 5–7); `createSession({fromTransit, meta})` used consistently; `applyUpdate(id, jsonBody)` / `applyTransitUpdate(transitBody)` / `applyChanges(jsonChanges)` are distinct and each defined where used. ✓

**Known soft spots (acceptable for a spike, flagged for execution):** exact get-file/update-file response key shapes must be reconciled against the Task 2 recording (the plan says so at each such step); `applyChanges`/`applyTransitUpdate` need small `session.cljs` additions mirroring the existing `apply-changes!` path.
