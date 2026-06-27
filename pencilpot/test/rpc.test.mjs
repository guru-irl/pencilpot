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

test("rename-file accepts the transit OBJECT body shape rp/cmd! actually sends", async () => {
  // REGRESSION: the live SPA's (rp/cmd! :rename-file {:id :name}) encodes the
  // params as a transit JSON *object* — {"~:id":"~u..","~:name":".."} — NOT the
  // map-literal array form ["^ ","~:id",..,"~:name",..].  An earlier extractor
  // only handled the array form, so the real rename silently no-op'd on disk
  // (caught by the e2e verify harness, missed by array-only unit tests).
  const { dir } = seedDir();
  initWorktree(dir);
  const body = '{"~:id":"~u0398e5fc-95c9-80d6-8008-29088f3ee53a","~:name":"Object Form Name"}';
  const req = mockReq({ url: "/api/main/methods/rename-file", body });
  const res = mockRes();
  await handleRpc(req, res, { design: dir });

  assert.equal(res.statusCode, 200, "rename-file returns 200");
  assert.match(getStore(dir).manifest, /:name\s+"Object Form Name"/, "manifest :name updated from object-form body");
  assert.equal(status().dirty, true, "design marked dirty after rename");
});

test("rename-file does not interpret $-substitution in the new name", async () => {
  const { dir } = seedDir();
  initWorktree(dir);

  // A legal file name containing `$&` must NOT be expanded by String.replace's
  // special replacement patterns — the staged manifest must hold the EXACT name.
  const name = "Tom $& Jerry";
  const body = `["^ ","~:id","~u0398e5fc-95c9-80d6-8008-29088f3ee53a","~:name",${JSON.stringify(name)}]`;
  const req = mockReq({ url: "/api/main/methods/rename-file", body });
  const res = mockRes();
  await handleRpc(req, res, { design: dir });

  assert.equal(res.statusCode, 200, "rename-file returns 200");
  const manifest = getStore(dir).manifest;
  // Exact literal `:name "Tom $& Jerry"` — no injected match text.
  assert.ok(
    manifest.includes(`:name "Tom $& Jerry"`),
    `manifest should hold exact :name; got: ${manifest.slice(0, 200)}`,
  );
  // The matched substring (`:name "..."`) must NOT have been injected inside the name.
  assert.doesNotMatch(manifest, /Tom :name/, "no match-text injection");
  assert.equal(status().dirty, true, "design marked dirty after rename");
});

test("rename-file persists names with embedded quote and backslash (transit)", async () => {
  for (const name of ['Quote"Inside', "back\\slash"]) {
    const { dir } = seedDir();
    initWorktree(dir);

    // Transit-encoded body; JSON.stringify produces the proper transit/JSON
    // escaping for the embedded quote/backslash.
    const body = `["^ ","~:id","~u0398e5fc-95c9-80d6-8008-29088f3ee53a","~:name",${JSON.stringify(name)}]`;
    const req = mockReq({ url: "/api/main/methods/rename-file", body });
    const res = mockRes();
    await handleRpc(req, res, { design: dir });

    assert.equal(res.statusCode, 200, "rename-file returns 200");
    const manifest = getStore(dir).manifest;
    // The full name must be persisted, EDN-escaped (EDN escapes " and \ like JSON).
    const ednLiteral = `:name ${JSON.stringify(name)}`;
    assert.ok(
      manifest.includes(ednLiteral),
      `manifest should hold full EDN-escaped :name (${ednLiteral}); got: ${manifest.slice(0, 200)}`,
    );
    assert.equal(status().dirty, true, "design marked dirty after rename");
  }
});

// ---------------------------------------------------------------------------
// get-view-only-bundle: the prototype viewer's fetch-bundle. Must return a real
// transit bundle (file + team + permissions + fonts) so the viewer LOADS instead
// of hitting the benign `200 {}` unhandled-RPC stub (which yields a nil page ->
// viewer raises :not-found -> "doesn't exist" 404 screen).
// ---------------------------------------------------------------------------

test("get-view-only-bundle returns a real transit bundle (not the empty stub)", async () => {
  const { dir } = seedDir();
  initWorktree(dir);
  // Spy console.warn so we can prove the request is HANDLED (no unhandled-RPC warn).
  const warnings = [];
  const origWarn = console.warn;
  console.warn = (...a) => warnings.push(a.join(" "));
  let res;
  try {
    const req = mockReq({
      method: "GET",
      url: "/api/main/methods/get-view-only-bundle?file-id=abc&features=foo",
    });
    res = mockRes();
    await handleRpc(req, res, { design: dir });
  } finally {
    console.warn = origWarn;
  }

  assert.equal(res.statusCode, 200, "get-view-only-bundle returns 200");
  assert.match(
    res.headers["content-type"] || "",
    /transit\+json/,
    "responds transit+json",
  );
  // The body is a single transit document carrying the whole bundle.
  const body = res.body;
  assert.match(body, /~:file/, "bundle has :file");
  assert.match(body, /~:pages-index/, "bundle file carries an inline :pages-index");
  assert.match(body, /~:permissions/, "bundle has :permissions");
  assert.match(body, /~:can-edit/, "permissions grant :can-edit (local single-user)");
  assert.match(body, /~:fonts/, "bundle has :fonts (team fonts for view-mode rendering)");
  // No unhandled-RPC warning fired for this command.
  assert.ok(
    !warnings.some((w) => w.includes("unhandled RPC get-view-only-bundle")),
    `must be handled, not stubbed; warnings: ${JSON.stringify(warnings)}`,
  );
});

test("get-view-only-bundle :file :data :pages-index references a real page id", async () => {
  const { dir } = seedDir();
  initWorktree(dir);
  // The page id the file payload actually persisted (independent source).
  const { meta } = getFile(dir);
  const dataStr = typeof meta.data === "string" ? meta.data : JSON.stringify(meta.data);
  const pageId = (dataStr.match(/~:pages-index[^]*?~u([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/) || [])[1];
  assert.ok(pageId, "fixture has at least one page id");

  const req = mockReq({
    method: "GET",
    url: "/api/main/methods/get-view-only-bundle?file-id=abc",
  });
  const res = mockRes();
  await handleRpc(req, res, { design: dir });
  assert.ok(
    res.body.includes(pageId),
    "bundle inlines the real page id under :file :data :pages-index",
  );
});
