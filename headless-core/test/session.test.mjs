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
