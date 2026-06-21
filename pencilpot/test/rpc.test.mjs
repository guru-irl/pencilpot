import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { createSession } from "../../headless-core/target/headless/penpot.js";
import { writeDesign } from "../store/store.mjs";
import { getFile, updateFileJson, handleRpc } from "../runtime/rpc.mjs";
import { initWorktree, getStore, status } from "../runtime/worktree.mjs";
import { EventEmitter } from "node:events";

// ---------------------------------------------------------------------------
// Lightweight mock req/res helpers for driving handleRpc without an HTTP server
// ---------------------------------------------------------------------------

function mockReq({ method = "POST", url = "/api/main/methods/noop", headers = {}, body = "" } = {}) {
  const em = new EventEmitter();
  em.method = method;
  em.url = url;
  em.headers = { accept: "application/transit+json", "content-type": "application/transit+json", ...headers };
  // Schedule body emission so readBody's stream listeners are attached first.
  setImmediate(() => {
    em.emit("data", Buffer.from(body));
    em.emit("end");
  });
  return em;
}

function mockRes() {
  const res = {
    statusCode: null,
    headers: {},
    body: null,
    writeHead(status, hdrs = {}) { this.statusCode = status; Object.assign(this.headers, hdrs); },
    end(data) { this.body = data; },
  };
  return res;
}

function seedDir() {
  const s = createSession(JSON.stringify({ empty: true }));
  const b = s.addBoard(JSON.stringify({ x: 0, y: 0, width: 100, height: 100, name: "B" }));
  const r = s.addRect(JSON.stringify({ x: 10, y: 10, width: 20, height: 20, parentId: b }));
  s.closeBoard();
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pp-")), "home.penpot");
  writeDesign(dir, JSON.parse(s.serializeStore()));
  return { dir, r };
}

test("getFile loads the store and returns an envelope that re-hydrates", () => {
  const { dir } = seedDir();
  const { meta, transit } = getFile(dir);
  assert.ok(meta.id && meta.data, "envelope has id + data");
  const s2 = createSession(JSON.stringify({ fromTransit: transit, meta }));
  assert.ok(Object.keys(JSON.parse(s2.objects())).length >= 2, "re-hydrates shapes");
});

// ---------------------------------------------------------------------------
// Unhandled RPC: must return 200 with a benign empty-transit body (not 404)
// ---------------------------------------------------------------------------

test("handleRpc: unhandled command (update-profile-props) returns 200 not 404", async () => {
  const req = mockReq({ url: "/api/main/methods/update-profile-props", body: '["^ "]' });
  const res = mockRes();
  await handleRpc(req, res, {});
  assert.equal(res.statusCode, 200, `expected 200 but got ${res.statusCode}`);
});

test("handleRpc: unhandled command returns application/transit+json content-type", async () => {
  const req = mockReq({ url: "/api/main/methods/set-something", body: '["^ "]' });
  const res = mockRes();
  await handleRpc(req, res, {});
  assert.match(res.headers["content-type"] ?? "", /transit/, "content-type should include 'transit'");
});

test("handleRpc: unhandled command body decodes to empty transit map", async () => {
  const req = mockReq({ url: "/api/main/methods/update-profile-props", body: '["^ "]' });
  const res = mockRes();
  await handleRpc(req, res, {});
  // Transit empty map encodes as '["^ "]'
  const body = typeof res.body === "string" ? res.body : res.body?.toString("utf8");
  const parsed = JSON.parse(body);
  assert.ok(Array.isArray(parsed), "body should be a JSON array (transit encoding)");
  assert.equal(parsed[0], "^ ", "transit map marker should be '^ '");
  assert.equal(parsed.length, 1, "empty transit map should have length 1");
});

test("handleRpc: unhandled GET command also returns 200 transit empty map", async () => {
  const req = mockReq({ method: "GET", url: "/api/main/methods/some-unknown-query", body: "" });
  const res = mockRes();
  await handleRpc(req, res, {});
  assert.equal(res.statusCode, 200, `expected 200 but got ${res.statusCode}`);
  const body = typeof res.body === "string" ? res.body : res.body?.toString("utf8");
  const parsed = JSON.parse(body);
  assert.equal(parsed[0], "^ ", "should be transit empty map");
});

test("handleRpc: unhandled command with json accept header returns 200 application/json", async () => {
  const req = mockReq({
    url: "/api/main/methods/update-profile-props",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: "{}",
  });
  const res = mockRes();
  await handleRpc(req, res, {});
  assert.equal(res.statusCode, 200, `expected 200 but got ${res.statusCode}`);
  assert.match(res.headers["content-type"] ?? "", /json/, "content-type should include 'json'");
});

test("updateFileJson applies a change, persists to the store, bumps revn", () => {
  const { dir, r } = seedDir();
  const res = updateFileJson(dir, JSON.stringify([{ type: "mod-obj", id: r, operations: [{ type: "set", attr: "x", val: 99 }] }]));
  assert.equal(res.revn, 1, "revn bumped to 1");
  const { meta, transit } = getFile(dir);
  const s2 = createSession(JSON.stringify({ fromTransit: transit, meta }));
  assert.equal(JSON.parse(s2.getShape(r)).x, 99, "edit persisted to the store");
});

// ---------------------------------------------------------------------------
// rename-file: persists the new name into the working-copy manifest :name and
// marks the design dirty (written to disk on the next Save).
// ---------------------------------------------------------------------------

test("rename-file updates working-copy manifest :name and marks dirty", async () => {
  const { dir } = seedDir();
  // Bind the worktree to this dir so dirty-tracking applies (otherwise stage
  // would write-through to disk and never set the in-memory dirty flag).
  initWorktree(dir);
  // Establish the saved baseline from disk before mutating.
  assert.doesNotMatch(getStore(dir).manifest, /:name\s+"New Name"/, "precondition: not yet renamed");

  // Transit-encoded {id, name} as the SPA's (rp/cmd! :rename-file …) sends it.
  const body = '["^ ","~:id","~u0398e5fc-95c9-80d6-8008-29088f3ee53a","~:name","New Name"]';
  const req = mockReq({ url: "/api/main/methods/rename-file", body });
  const res = mockRes();
  await handleRpc(req, res, { design: dir });

  assert.equal(res.statusCode, 200, "rename-file returns 200");
  assert.match(getStore(dir).manifest, /:name\s+"New Name"/, "manifest :name updated");
  assert.equal(status().dirty, true, "design marked dirty after rename");
});
