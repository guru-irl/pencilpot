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

test("addText creates a valid text shape with content", () => {
  const s = createSession(JSON.stringify({ empty: true }));
  const id = s.addText(JSON.stringify({ x: 10, y: 10, width: 200, height: 30, characters: "Hello headless", fontSize: 18, fills: [{ fillColor: "#111827" }] }));
  assert.equal(typeof id, "string");
  const objs = JSON.parse(s.objects());
  const t = objs[id];
  assert.equal(t.type, "text");
  const runText = JSON.stringify(t.content);
  assert.match(runText, /Hello headless/);
  assert.deepEqual(JSON.parse(s.validate()), [], "text shape is Penpot-valid");
});

test("clearChanges resets recorded changes (no double-commit)", () => {
  const s = createSession(JSON.stringify({ empty: true }));
  s.addBoard(JSON.stringify({ x: 0, y: 0, width: 100, height: 100, name: "B" }));
  assert.equal(JSON.parse(s.pendingChanges()).length, 1);
  // simulate a commit: produce the body, then clear
  s.commitBody(JSON.stringify({ sessionId: "00000000-0000-0000-0000-000000000001", revn: 0, vern: 0 }));
  s.clearChanges();
  assert.equal(JSON.parse(s.pendingChanges()).length, 0);
  s.addRect(JSON.stringify({ x: 10, y: 10, width: 20, height: 20 }));
  assert.equal(JSON.parse(s.pendingChanges()).length, 1, "only the new change is pending");
});

test("setFlexLayout arranges children in a row", () => {
  const s = createSession(JSON.stringify({ empty: true }));
  const b = s.addBoard(JSON.stringify({ x: 0, y: 0, width: 400, height: 120, name: "Row" }));
  const ids = [0,1,2].map(() => s.addRect(JSON.stringify({ x: 0, y: 0, width: 80, height: 60, parentId: b })));
  s.closeBoard();
  const out = JSON.parse(s.setFlexLayout(b, JSON.stringify({ dir: "row", gap: 10, padding: 0 })));
  assert.ok(out.reflowed >= 3, "container + children reflowed");
  const objs = JSON.parse(s.objects());
  assert.equal(objs[b].layout, "flex");
  const xs = ids.map(id => objs[id].selrect.x).sort((a,bb)=>a-bb);
  assert.ok(xs[1]-xs[0] >= 80 && xs[2]-xs[1] >= 80, `children spread by >=80 (got ${xs})`);
  assert.deepEqual(JSON.parse(s.validate()), []);
});

test("setGridLayout arranges children into a 2-column grid", () => {
  const s = createSession(JSON.stringify({ empty: true }));
  const b = s.addBoard(JSON.stringify({ x: 0, y: 0, width: 400, height: 400, name: "Grid" }));
  const ids = [0,1,2,3].map(() => s.addRect(JSON.stringify({ x: 0, y: 0, width: 80, height: 60, parentId: b })));
  s.closeBoard();
  const out = JSON.parse(s.setGridLayout(b, JSON.stringify({ cols: 2, gap: 10 })));
  assert.ok(out.reflowed >= 4, "children reflowed");
  const objs = JSON.parse(s.objects());
  assert.equal(objs[b].layout, "grid");
  const xs = new Set(ids.map(id => Math.round(objs[id].selrect.x)));
  const ys = new Set(ids.map(id => Math.round(objs[id].selrect.y)));
  assert.equal(xs.size, 2, `2 distinct columns (xs=${[...xs]})`);
  assert.equal(ys.size, 2, `2 distinct rows (ys=${[...ys]})`);
  assert.deepEqual(JSON.parse(s.validate()), []);
});

test("addEllipse creates a valid circle shape", () => {
  const s = createSession(JSON.stringify({ empty: true }));
  const id = s.addEllipse(JSON.stringify({ x: 10, y: 10, width: 120, height: 80, name: "Dot", fills: [{ fillColor: "#22c55e" }] }));
  const objs = JSON.parse(s.objects());
  assert.equal(objs[id].type, "circle");
  assert.equal(objs[id].selrect.width, 120);
  assert.deepEqual(JSON.parse(s.validate()), []);
});

test("setGrowType changes a text shape's grow-type", () => {
  const s = createSession(JSON.stringify({ empty: true }));
  const t = s.addText(JSON.stringify({ x: 0, y: 0, width: 100, height: 30, characters: "Hi" }));
  s.setGrowType(t, "fixed");
  const o = JSON.parse(s.objects());
  assert.equal(o[t]["grow-type"], "fixed");
  assert.deepEqual(JSON.parse(s.validate()), []);
});

test("addColorToken creates a token set + color token", () => {
  const s = createSession(JSON.stringify({ empty: true }));
  s.addColorToken(JSON.stringify({ set: "core", name: "color.primary", value: "#3366ff" }));
  const toks = JSON.parse(s.tokens());          // accessor returning the lib summary
  assert.ok(toks.sets.includes("core"), `sets=${JSON.stringify(toks.sets)}`);
  assert.ok(toks.tokens.some(t => t.name === "color.primary" && t.value === "#3366ff"), `tokens=${JSON.stringify(toks.tokens)}`);
  assert.deepEqual(JSON.parse(s.validate()), []);
});

test("setConstraints sets horizontal + vertical constraints", () => {
  const s = createSession(JSON.stringify({ empty: true }));
  const b = s.addBoard(JSON.stringify({ x: 0, y: 0, width: 200, height: 200 }));
  const r = s.addRect(JSON.stringify({ x: 10, y: 10, width: 50, height: 50, parentId: b }));
  s.closeBoard();
  s.setConstraints(r, JSON.stringify({ h: "right", v: "bottom" }));
  const o = JSON.parse(s.objects());
  assert.equal(o[r]["constraints-h"], "right");
  assert.equal(o[r]["constraints-v"], "bottom");
  assert.deepEqual(JSON.parse(s.validate()), []);
});

test("createComponent promotes a board to a main component", () => {
  const s = createSession(JSON.stringify({ empty: true }));
  const b = s.addBoard(JSON.stringify({ x: 0, y: 0, width: 200, height: 120, name: "Card" }));
  s.addRect(JSON.stringify({ x: 10, y: 10, width: 80, height: 40, parentId: b }));
  s.closeBoard();
  const cid = s.createComponent(b, JSON.stringify({ name: "Card" }));
  assert.equal(typeof cid, "string");
  const o = JSON.parse(s.objects());
  assert.equal(o[b]["main-instance"], true);
  assert.equal(o[b]["component-id"], cid);
  assert.equal(o[b]["component-root"], true);
  assert.deepEqual(JSON.parse(s.validate()), []);
});

test("instantiateComponent creates a copy of a component", () => {
  const s = createSession(JSON.stringify({ empty: true }));
  const b = s.addBoard(JSON.stringify({ x: 0, y: 0, width: 200, height: 120, name: "Card" }));
  s.addRect(JSON.stringify({ x: 10, y: 10, width: 80, height: 40, parentId: b }));
  s.closeBoard();
  const cid = s.createComponent(b, JSON.stringify({ name: "Card" }));
  const copyId = s.instantiateComponent(cid, JSON.stringify({ x: 400, y: 0 }));
  assert.equal(typeof copyId, "string");
  const o = JSON.parse(s.objects());
  assert.ok(o[copyId], "copy root exists");
  assert.equal(o[copyId]["component-id"], cid);
  assert.deepEqual(JSON.parse(s.validate()), []);
});
