import { test } from "node:test";
import assert from "node:assert/strict";
import { createSession } from "../target/headless/penpot.js";

function newSession() {
  return createSession(JSON.stringify({ empty: true, name: "Test" }));
}

test("session adds a board and a nested rect with real geometry; validates", () => {
  const s = newSession();
  const boardId = s.addBoard(JSON.stringify({ x: 0, y: 0, width: 400, height: 300, name: "Board" }));
  assert.equal(typeof boardId, "string");
  const rectId = s.addRect(JSON.stringify({ x: 20, y: 20, width: 100, height: 60, name: "R", parentId: boardId, fills: [{ fillColor: "#ff0000" }] }));
  s.closeBoard();

  const objs = JSON.parse(s.objects());
  assert.ok(objs[boardId] && objs[boardId].type === "frame");
  assert.ok(objs[rectId] && objs[rectId].type === "rect");
  assert.equal(objs[rectId].selrect.width, 100);
  // parent linkage: key casing from clj->js may be "parent-id" (kebab) — adjust the key, keep the assertion
  assert.equal(objs[rectId]["parent-id"] ?? objs[rectId].parentId, boardId);

  const errs = JSON.parse(s.validate());
  assert.deepEqual(errs, [], "headless edits produce a Penpot-valid file");

  const changes = JSON.parse(s.pendingChanges());
  assert.equal(changes.length, 2);
  assert.ok(changes.every((c) => c.type === "add-obj"));
});

test("addRect honors parentId pointing at a non-top-of-stack board", () => {
  const s = createSession(JSON.stringify({ empty: true }));
  const b1 = s.addBoard(JSON.stringify({ x: 0, y: 0, width: 200, height: 200, name: "B1" }));
  s.closeBoard();
  const b2 = s.addBoard(JSON.stringify({ x: 300, y: 0, width: 200, height: 200, name: "B2" }));
  s.closeBoard();
  // stack is now back to root; place a rect explicitly under B1
  const r = s.addRect(JSON.stringify({ x: 10, y: 10, width: 50, height: 50, parentId: b1 }));
  const objs = JSON.parse(s.objects());
  assert.equal(objs[r]["parent-id"] ?? objs[r].parentId, b1, "rect parented under the requested board, not the stack top/root");
  assert.deepEqual(JSON.parse(s.validate()), []);
});
