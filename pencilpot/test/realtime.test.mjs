// Wave R1 — realtime broadcast of AI edits over the /pencilpot/live SSE channel.
//
// When the AI (MCP/SDK) commits via update-file with Accept: application/json,
// the runtime must push the change to every connected SSE client (event:changes)
// so the open SPA can apply it live. SPA-originated edits (Accept: transit+json)
// must NOT broadcast — they are already applied locally (no echo loop).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { createSession } from "../../headless-core/target/headless/penpot.js";
import { writeDesign } from "../store/store.mjs";
import { handleRpc } from "../runtime/rpc.mjs";
import { initWorktree } from "../runtime/worktree.mjs";
import { broadcastChanges, getLiveWatcher, startLiveWatcher } from "../runtime/live.mjs";

// ── helpers ──────────────────────────────────────────────────────────────────

function fakeClient() {
  return { writes: [], write(s) { this.writes.push(s); } };
}

// Parse a single SSE frame ("event: X\ndata: Y\n\n") into { ev, data }.
function parseSse(frame) {
  const ev = (frame.match(/^event: (.+)$/m) || [])[1];
  const data = (frame.match(/^data: (.+)$/m) || [])[1];
  return { ev, data };
}

function mockReq({ method = "POST", url = "/api/main/methods/noop", headers = {}, body = "" } = {}) {
  const em = new EventEmitter();
  em.method = method;
  em.url = url;
  em.headers = { accept: "application/transit+json", "content-type": "application/transit+json", ...headers };
  setImmediate(() => { em.emit("data", Buffer.from(body)); em.emit("end"); });
  return em;
}

function mockRes() {
  return {
    statusCode: null, headers: {}, body: null,
    writeHead(status, hdrs = {}) { this.statusCode = status; Object.assign(this.headers, hdrs); },
    end(data) { this.body = data; },
  };
}

// Seed a dir with a board + rect; return { dir, r }.
function seedDir(session) {
  const b = session.addBoard(JSON.stringify({ x: 0, y: 0, width: 100, height: 100, name: "B" }));
  const r = session.addRect(JSON.stringify({ x: 10, y: 10, width: 20, height: 20, parentId: b }));
  session.closeBoard();
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pp-rt-")), "home.penpot");
  writeDesign(dir, JSON.parse(session.serializeStore()));
  return { dir, r };
}

// ── Test A — broadcastChanges unit (hard assertion) ───────────────────────────

test("broadcastChanges emits exactly one 'changes' SSE frame with revn + round-trip body", () => {
  startLiveWatcher(null);                 // shared clients set, no fs.watch
  const c = fakeClient();
  getLiveWatcher().clients.add(c);
  const input = '{"~:id":"~uX","~:changes":[]}';
  try {
    broadcastChanges(input, 9);
  } finally {
    getLiveWatcher().clients.delete(c);
  }
  assert.equal(c.writes.length, 1, "exactly one frame written");
  const { ev, data } = parseSse(c.writes[0]);
  assert.equal(ev, "changes", "event type is 'changes'");
  const payload = JSON.parse(data);
  assert.equal(payload.revn, 9, "revn carried in payload");
  assert.equal(payload.body, input, "transit body round-trips verbatim");
});

// ── Test B — update-file branch discrimination through handleRpc ──────────────

test("update-file via handleRpc: JSON accept broadcasts 'changes'; transit accept does NOT", async () => {
  startLiveWatcher(null);
  const s = createSession(JSON.stringify({ empty: true }));
  const { dir, r } = seedDir(s);
  initWorktree(dir);

  // Record a move on the seed session and encode the transit update-file body
  // (this is exactly the shape the SPA / SDK send over the wire).
  s.moveShape(r, JSON.stringify({ x: 77 }));
  const body = s.commitBody(JSON.stringify({ sessionId: randomUUID(), revn: 0, vern: 0 }));
  assert.ok(body.includes("~:changes"), "precondition: commitBody carries :changes");

  // JSON accept (AI/MCP/SDK) → must broadcast exactly one 'changes' frame.
  {
    const c = fakeClient();
    getLiveWatcher().clients.add(c);
    const req = mockReq({
      url: "/api/main/methods/update-file",
      headers: { accept: "application/json", "content-type": "application/transit+json" },
      body,
    });
    const res = mockRes();
    await handleRpc(req, res, { design: dir });
    getLiveWatcher().clients.delete(c);
    assert.equal(res.statusCode, 200, "JSON update-file returns 200");
    const changesFrames = c.writes.filter((w) => /event: changes/.test(w));
    assert.equal(changesFrames.length, 1, "JSON branch broadcasts exactly one 'changes' frame");
    const { data } = parseSse(changesFrames[0]);
    assert.ok(JSON.parse(data).body.includes("~:changes"), "broadcast body carries the changes");
  }

  // Transit accept (SPA's own edit) → must NOT broadcast a 'changes' frame.
  {
    const c = fakeClient();
    getLiveWatcher().clients.add(c);
    const req = mockReq({
      url: "/api/main/methods/update-file",
      headers: { accept: "application/transit+json", "content-type": "application/transit+json" },
      body,
    });
    const res = mockRes();
    await handleRpc(req, res, { design: dir });
    getLiveWatcher().clients.delete(c);
    assert.equal(res.statusCode, 200, "transit update-file returns 200");
    const changesFrames = c.writes.filter((w) => /event: changes/.test(w));
    assert.equal(changesFrames.length, 0, "transit branch does NOT broadcast 'changes' (no echo loop)");
  }
});
