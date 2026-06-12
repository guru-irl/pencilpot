# Penpot Headless SDK — Phase 1b (Headless MCP Server) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** A **headless MCP server** that lets any MCP client (Claude Code, Copilot) edit a Penpot file directly — `checkout → script/edit → commit` — with **no browser and no in-app plugin**. It wraps the Phase 1a `WorkingCopy` + a JS `script()` sandbox and holds the working copy stateful across tool calls.

**Architecture:** A stdio MCP server (`@modelcontextprotocol/sdk` `McpServer` + `StdioServerTransport`) holds one stateful `WorkingCopy` per process. Tools: `checkout`, `script` (run JS with `wc` + helpers bound — the speed primitive), `scene`, `validate`, `commit`, `status`, `discard`. Auth/base via env (`PENPOT_TOKEN`, `PENPOT_HL_BASE`). The server logic is factored so it can be driven in-process via the SDK's `InMemoryTransport` for tests.

**Tech Stack:** Node ESM, `@modelcontextprotocol/sdk` (^1.24, already in the repo), `zod` (input schemas), the Phase 1a toolkit (`sdk/index.mjs`), `node:test`. Tested against the isolated `penpot-hl` instance.

**Spec:** `docs/superpowers/specs/2026-06-11-penpot-headless-sdk-design.md` · **Builds on:** Phase 1a (`headless-core/sdk/`).

**Scope (1b):** the stdio MCP server + `script()` sandbox + the tool surface + Claude Code registration + tests/verify.
**Deferred:** text & flex/grid helpers (need 1a-engine extension), the `pp` CLI, the full teaching skill (a follow-up — README usage only here), HTTP/multi-user transport, golden snapshots.

---

## HARD ISOLATION RULE
The MCP server reads `PENPOT_HL_BASE` (default `http://localhost:9101`) + `PENPOT_TOKEN`. For all dev/testing it targets **penpot-hl only**. NEVER point it at or otherwise touch the owner's `penpot`/:9001 instance or its data. Build artifacts gitignored. Branch `feat/penpot-headless-sdk`.

---

## File Structure
- `headless-core/sdk/script.mjs` — `runScript(code, bindings)`: async sandbox (`new Function`) with bound globals + captured console.
- `headless-core/mcp/server.mjs` — `createHeadlessMcp({token, base})` returns a configured `McpServer`; plus a `main()` that wires `StdioServerTransport` when run directly.
- `headless-core/package.json` — add deps `@modelcontextprotocol/sdk`, `zod`; add scripts `mcp` (start stdio) and `test:mcp`.
- `headless-core/test/script.test.mjs` — unit: sandbox runs code, returns value, captures logs, surfaces errors.
- `headless-core/test/mcp-server.test.mjs` — integration: in-memory MCP client → checkout/script/validate/commit against penpot-hl.
- `headless-core/README.md` — Phase 1b section + Claude Code registration.

---

## Task 1: `script()` sandbox

**Files:** Create `headless-core/sdk/script.mjs`, `headless-core/test/script.test.mjs`.

- [ ] **Step 1: Failing test** — `headless-core/test/script.test.mjs`
```javascript
import { test } from "node:test";
import assert from "node:assert/strict";
import { runScript } from "../sdk/script.mjs";

test("runScript returns the value and captures console output", async () => {
  const fakeWc = { n: 0, addRect() { this.n++; return "id"; } };
  const r = await runScript("console.log('hi', 2); for (let i=0;i<3;i++) wc.addRect({}); return wc.n;", { wc: fakeWc });
  assert.equal(r.result, 3);
  assert.match(r.log, /hi 2/);
});

test("runScript surfaces errors with message", async () => {
  const r = await runScript("throw new Error('boom');", {});
  assert.equal(r.ok, false);
  assert.match(r.error, /boom/);
});

test("runScript supports top-level await", async () => {
  const r = await runScript("const x = await Promise.resolve(41); return x + 1;", {});
  assert.equal(r.result, 42);
});
```

- [ ] **Step 2: Run → fail** — `cd headless-core && node --test test/script.test.mjs` (module missing).

- [ ] **Step 3: Implement** `headless-core/sdk/script.mjs`
```javascript
// Run AI-authored JS against the headless working copy in one shot.
// Globals provided: whatever is passed in `bindings` (e.g. wc, helpers) + a capturing console.
export async function runScript(code, bindings = {}) {
  let log = "";
  const console = {
    log: (...a) => { log += a.map(fmt).join(" ") + "\n"; },
    warn: (...a) => { log += "[warn] " + a.map(fmt).join(" ") + "\n"; },
    error: (...a) => { log += "[error] " + a.map(fmt).join(" ") + "\n"; },
  };
  const ctx = { console, ...bindings };
  try {
    const fn = new Function(...Object.keys(ctx), `return (async () => { ${code} })();`);
    const result = await fn(...Object.values(ctx));
    return { ok: true, result, log };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? `${e.name}: ${e.message}` : String(e), log };
  }
}

function fmt(v) {
  if (typeof v === "string") return v;
  try { return JSON.stringify(v); } catch { return String(v); }
}
```

- [ ] **Step 4: Run → pass** — `cd headless-core && node --test test/script.test.mjs` → 3 pass.
- [ ] **Step 5: Commit** — `git add headless-core/sdk/script.mjs headless-core/test/script.test.mjs && git commit -m ":sparkles: headless sdk: JS script() sandbox (bound globals, captured console)"`

---

## Task 2: The headless MCP server

**Files:** Create `headless-core/mcp/server.mjs`; Modify `headless-core/package.json` (deps + scripts). Requires `npm install` for the SDK + zod.

- [ ] **Step 1: Add deps + scripts** to `headless-core/package.json`:
- dependencies: `"@modelcontextprotocol/sdk": "^1.24.0"`, `"zod": "^4.3.6"` (confirmed: matches `mcp/packages/server` which uses zod 4; the installed SDK exposes `registerTool(name, config, cb)`, and transports at `@modelcontextprotocol/sdk/server/stdio.js` + `@modelcontextprotocol/sdk/inMemory.js` + client at `@modelcontextprotocol/sdk/client/index.js`).
- scripts: `"mcp": "node mcp/server.mjs"`, `"test:mcp": "node --test test/mcp-server.test.mjs"`.
- Run `cd headless-core && npm install`.

- [ ] **Step 2: Implement** `headless-core/mcp/server.mjs`
```javascript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { WorkingCopy } from "../sdk/index.mjs";
import { runScript } from "../sdk/script.mjs";

const text = (v) => ({ content: [{ type: "text", text: typeof v === "string" ? v : JSON.stringify(v, null, 2) }] });

// Build a configured McpServer holding one stateful working copy.
export function createHeadlessMcp({ token, base } = {}) {
  if (base) process.env.PENPOT_HL_BASE = base;            // rpc.mjs reads this
  const tok = token ?? process.env.PENPOT_TOKEN;
  const server = new McpServer(
    { name: "penpot-headless", version: "0.1.0" },
    { instructions: "Headless Penpot editing. checkout(fileId) a file, then script(code) to edit it (globals: wc, with wc.addBoard/addRect/closeBoard/validate/pendingChanges), then commit(). No browser needed." }
  );
  let wc = null;
  const need = () => { if (!wc) throw new Error("No file checked out. Call checkout(fileId) first."); return wc; };

  server.registerTool("checkout",
    { description: "Load a Penpot file into a headless working copy by id.", inputSchema: { fileId: z.string().describe("Penpot file UUID") } },
    async ({ fileId }) => { wc = await new WorkingCopy(fileId, tok).checkout();
      const objs = JSON.parse(wc.session.objects());
      return text({ checkedOut: fileId, revn: wc.revn, objects: Object.keys(objs).length }); });

  server.registerTool("script",
    { description: "Run JS against the working copy. Globals: `wc` (addBoard/addRect/closeBoard/validate/pendingChanges). Do many edits in one call; return a value. No network until commit.",
      inputSchema: { code: z.string().min(1) } },
    async ({ code }) => { const w = need(); const r = await runScript(code, { wc: w });
      return text(r.ok ? { result: r.result, log: r.log, pending: w.pendingChanges().length } : { error: r.error, log: r.log }); });

  server.registerTool("scene",
    { description: "Return the working copy's object map (id -> shape).", inputSchema: {} },
    async () => text(JSON.parse(need().session.objects())));

  server.registerTool("validate",
    { description: "Validate the working copy with Penpot's own validator (empty array = valid).", inputSchema: {} },
    async () => text(need().validate()));

  server.registerTool("status",
    { description: "Pending (uncommitted) change count + current revn.", inputSchema: {} },
    async () => { const w = need(); return text({ pending: w.pendingChanges().length, revn: w.revn }); });

  server.registerTool("commit",
    { description: "Persist accumulated edits to the file via update-file.", inputSchema: {} },
    async () => { const w = need(); const errs = w.validate(); if (errs.length) return text({ error: "invalid; not committed", errs });
      const res = await w.commit(); return text({ committed: true, revn: res.revn + 1 }); });

  server.registerTool("discard",
    { description: "Discard the working copy (re-checkout to start over).", inputSchema: {} },
    async () => { wc = null; return text({ discarded: true }); });

  return server;
}

async function main() {
  const server = createHeadlessMcp();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
// run as stdio server when invoked directly
if (import.meta.url === `file://${process.argv[1]}`) { main().catch((e) => { console.error(e); process.exit(1); }); }
```
*Executor notes:* verify the SDK import paths against `mcp/packages/server/node_modules/@modelcontextprotocol/sdk` (the existing server imports `server/mcp.js`; stdio is `server/stdio.js`). Confirm `registerTool(name, {description, inputSchema}, handler)` matches the installed SDK (it's how `PenpotMcpServer` registers). Match the `zod` major to the existing server. If `McpServer.registerTool` differs in this SDK version, adapt to the version's API and report.

- [ ] **Step 3: Smoke-test the server boots** — `cd headless-core && node -e 'import("./mcp/server.mjs").then(({createHeadlessMcp})=>{const s=createHeadlessMcp({token:"x"}); console.log("server built:", !!s);})'` → prints `server built: true` (no transport connect needed for this check).
- [ ] **Step 4: Commit** — `git add headless-core/mcp/server.mjs headless-core/package.json headless-core/package-lock.json && git commit -m ":sparkles: headless mcp: stdio server (checkout/script/scene/validate/commit) over WorkingCopy"`

---

## Task 3: In-memory integration test (drive the tools end-to-end)

**Files:** Create `headless-core/test/mcp-server.test.mjs`.

- [ ] **Step 1: Implement** using the SDK's in-memory transport + Client:
```javascript
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createHeadlessMcp } from "../mcp/server.mjs";

const env = JSON.parse(readFileSync(new URL("../../infra/penpot-hl/test-env.json", import.meta.url)));
const parse = (res) => JSON.parse(res.content[0].text);

async function connected() {
  const server = createHeadlessMcp({ token: env.token, base: "http://localhost:9101" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(st), client.connect(ct)]);
  return client;
}

test("MCP: tools/list exposes the headless tools", async () => {
  const client = await connected();
  const names = (await client.listTools()).tools.map((t) => t.name).sort();
  for (const n of ["checkout", "script", "commit", "validate", "scene", "status", "discard"]) assert.ok(names.includes(n), `missing ${n}`);
});

test("MCP: checkout -> script(add board+rect) -> validate -> commit persists", async () => {
  const client = await connected();
  const co = parse(await client.callTool({ name: "checkout", arguments: { fileId: env.fileId } }));
  assert.equal(co.checkedOut, env.fileId);

  const scr = parse(await client.callTool({ name: "script", arguments: { code:
    "const b = wc.addBoard({x:900,y:60,width:280,height:180,name:'MCP Board'});" +
    "wc.addRect({x:920,y:80,width:100,height:60,parentId:b,fills:[{fillColor:'#3366ff'}]});" +
    "wc.closeBoard(); return wc.pendingChanges().length;" } }));
  assert.equal(scr.result, 2);

  assert.deepEqual(parse(await client.callTool({ name: "validate", arguments: {} })), []);
  const c = parse(await client.callTool({ name: "commit", arguments: {} }));
  assert.equal(c.committed, true);
  assert.ok(typeof c.revn === "number");
});
```
- [ ] **Step 2: Run & fix** — `cd headless-core && node --test test/mcp-server.test.mjs` (penpot-hl up; test-env.json present). Diagnose any SDK client/transport import mismatch (the InMemoryTransport path is `@modelcontextprotocol/sdk/inMemory.js`; Client is `client/index.js` — verify against the installed SDK and adapt). PASS when tools list contains the 7 tools and the checkout→script→validate→commit flow persists (commit returns a revn).
- [ ] **Step 3: Commit** — `git add headless-core/test/mcp-server.test.mjs && git commit -m ":white_check_mark: headless mcp: in-memory integration (checkout/script/commit persists)"`

---

## Task 4: Register with Claude Code + docs + verify

**Files:** Modify `headless-core/package.json` (verify includes test:mcp), `headless-core/README.md`.

- [ ] **Step 1: Add to verify** — update the `verify` script to also run `test:mcp` and `test:script`: `"verify": "npm run build && npm run test:unit && node --test test/script.test.mjs && npm run test:engine && npm run test:roundtrip && npm run test:mcp"`.
- [ ] **Step 2: Run full verify** — `cd headless-core && npm run verify` → all layers green (build, unit, script, engine gate, roundtrip, mcp). Fix wiring as needed.
- [ ] **Step 3: Register the server with Claude Code** (stdio), pointed at penpot-hl with the test token:
```
TOKEN=$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync("/mnt/data/src/penpot/infra/penpot-hl/test-env.json")).token)')
claude mcp add penpot-headless -s user -e PENPOT_TOKEN=$TOKEN -e PENPOT_HL_BASE=http://localhost:9101 -- node /mnt/data/src/penpot/headless-core/mcp/server.mjs
claude mcp list 2>&1 | grep penpot-headless
```
Expected: `penpot-headless` listed and Connected. (This points at penpot-hl ONLY — never the owner's :9001.) Report the output. Note: the registered token is the penpot-hl test token; document that for a different instance the user supplies a different `PENPOT_TOKEN`/`PENPOT_HL_BASE` (and that instance needs the `enable-access-tokens` flag).
- [ ] **Step 4: Document** — add a "Phase 1b — Headless MCP server" section to `headless-core/README.md`: the tool list, the `checkout → script → commit` flow with an example `script` payload, the env config (`PENPOT_TOKEN`/`PENPOT_HL_BASE`), the Claude Code `claude mcp add` command, and the isolation note (penpot-hl by default; other instances need access-tokens enabled). List 1c deferrals (text/flex helpers, `pp` CLI, teaching skill).
- [ ] **Step 5: Commit** — `git add headless-core/package.json headless-core/README.md && git commit -m ":memo: headless mcp: wire into verify + Claude Code registration + docs"`

---

## Phase 1b Done = exit criteria
- A stdio MCP server exposes `checkout/script/scene/validate/commit/status/discard` over the headless `WorkingCopy`.
- In-memory integration test: `checkout → script(add board+rect) → validate([]) → commit` persists to a real penpot-hl file.
- `npm run verify` runs build + unit + script + engine gate + roundtrip + mcp — all green.
- Registered as `penpot-headless` in Claude Code (pointed at penpot-hl), tools list connects.
- Owner's `penpot`/:9001 instance untouched.

**Next (1c):** extend the engine with text + flex/grid helpers; a `pp` CLI; the teaching skill; point a vetted instance at it for real-design editing.
