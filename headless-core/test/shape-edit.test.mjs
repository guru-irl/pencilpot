// Wave 1 — structural editing of EXISTING shapes (closes the "append-only" gap):
//   updateShapes (generic attribute edit), deleteShapes, reparentShape, reorderShape.
// Every behaviour is asserted on a fromStore-hydrated (plain-map) session too —
// the realistic AI-dev path the pencilpot runtime serves.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createSession } from "../target/headless/penpot.js";

const board = (s, p) => { const id = s.addBoard(JSON.stringify(p)); return id; };

test("updateShapes merges attrs + keyword-coerces enums; validates", () => {
  const s = createSession(JSON.stringify({ empty: true, name: "Edit2" }));
  const b = board(s, { x: 0, y: 0, width: 400, height: 400, name: "Frame" });
  const r = s.addRect(JSON.stringify({ x: 10, y: 10, width: 100, height: 50, name: "rect" }));
  s.closeBoard();

  const count = s.updateShapes(JSON.stringify([r]), JSON.stringify({
    name: "renamed", opacity: 0.5,
    fills: [{ "fill-color": "#ff0066", "fill-opacity": 1 }],
    "constraints-h": "center",
  }));
  assert.equal(count, 1, "one shape updated");

  const o = JSON.parse(s.objects())[r];
  assert.equal(o.name, "renamed");
  assert.equal(o.opacity, 0.5);
  assert.equal(o.fills[0]["fill-color"], "#ff0066");
  assert.equal(o["constraints-h"], "center", "enum value coerced to a keyword and serialized back");
  assert.deepEqual(JSON.parse(s.validate()), [], "file validates after the edit");
});

test("updateShapes refuses structural/geometry keys (fail-fast)", () => {
  const s = createSession(JSON.stringify({ empty: true, name: "Guard" }));
  const b = board(s, { x: 0, y: 0, width: 400, height: 400, name: "Frame" });
  const r = s.addRect(JSON.stringify({ x: 10, y: 10, width: 100, height: 50, name: "rect" }));
  s.closeBoard();
  for (const bad of [{ x: 5 }, { width: 9 }, { "parent-id": b }, { type: "circle" }, { shapes: [] }, { selrect: {} }]) {
    assert.throws(() => s.updateShapes(JSON.stringify([r]), JSON.stringify(bad)),
      /structural\/geometry/, `rejects ${JSON.stringify(bad)}`);
  }
});

test("deleteShapes removes an existing shape", () => {
  const s = createSession(JSON.stringify({ empty: true, name: "Del" }));
  const b = board(s, { x: 0, y: 0, width: 400, height: 400, name: "Frame" });
  const keep = s.addRect(JSON.stringify({ x: 0, y: 0, width: 50, height: 50, name: "keep" }));
  const gone = s.addRect(JSON.stringify({ x: 60, y: 0, width: 50, height: 50, name: "gone" }));
  s.closeBoard();

  const n = s.deleteShapes(JSON.stringify([gone]));
  assert.equal(n, 1);
  const objs = JSON.parse(s.objects());
  assert.ok(!objs[gone], "deleted shape is gone");
  assert.ok(objs[keep], "sibling remains");
  assert.ok(!JSON.parse(s.objects())[b].shapes.includes(gone), "parent no longer references it");
  assert.deepEqual(JSON.parse(s.validate()), [], "validates after delete");
});

test("reparentShape moves a shape under a new parent", () => {
  const s = createSession(JSON.stringify({ empty: true, name: "Reparent" }));
  const a = board(s, { x: 0, y: 0, width: 300, height: 300, name: "A" });
  const r = s.addRect(JSON.stringify({ x: 10, y: 10, width: 40, height: 40, name: "movable" }));
  s.closeBoard();
  const bb = board(s, { x: 400, y: 0, width: 300, height: 300, name: "B" });
  s.closeBoard();

  s.reparentShape(r, JSON.stringify({ parentId: bb }));
  const objs = JSON.parse(s.objects());
  assert.equal(objs[r]["parent-id"] ?? objs[r].parentId, bb, "parent-id updated");
  assert.ok(objs[bb].shapes.includes(r), "new parent lists the shape");
  assert.ok(!objs[a].shapes.includes(r), "old parent dropped it");
  assert.deepEqual(JSON.parse(s.validate()), [], "validates after reparent");
});

test("reorderShape changes z-order within the parent", () => {
  const s = createSession(JSON.stringify({ empty: true, name: "Reorder" }));
  const b = board(s, { x: 0, y: 0, width: 300, height: 300, name: "Frame" });
  const r0 = s.addRect(JSON.stringify({ x: 0, y: 0, width: 30, height: 30, name: "r0" }));
  const r1 = s.addRect(JSON.stringify({ x: 40, y: 0, width: 30, height: 30, name: "r1" }));
  const r2 = s.addRect(JSON.stringify({ x: 80, y: 0, width: 30, height: 30, name: "r2" }));
  s.closeBoard();

  const before = JSON.parse(s.objects())[b].shapes;
  s.reorderShape(r2, JSON.stringify({ index: 0 }));
  const after = JSON.parse(s.objects())[b].shapes;
  assert.notDeepEqual(after, before, "child order changed");
  assert.equal(after[0], r2, "moved child is first");
  assert.deepEqual(JSON.parse(s.validate()), [], "validates after reorder");
});

test("all edits work on a fromStore-hydrated (plain-map) session + round-trip", () => {
  const s1 = createSession(JSON.stringify({ empty: true, name: "Hydrated" }));
  const a = board(s1, { x: 0, y: 0, width: 300, height: 300, name: "A" });
  const r = s1.addRect(JSON.stringify({ x: 10, y: 10, width: 40, height: 40, name: "r" }));
  const del = s1.addRect(JSON.stringify({ x: 60, y: 10, width: 40, height: 40, name: "del" }));
  s1.closeBoard();
  const b = board(s1, { x: 400, y: 0, width: 300, height: 300, name: "B" });
  s1.closeBoard();

  // Re-hydrate the way the runtime does (plain-map shapes, no :data :id).
  const s2 = createSession(JSON.stringify({ fromStore: JSON.parse(s1.serializeStore()) }));
  s2.updateShapes(JSON.stringify([r]), JSON.stringify({ name: "edited", opacity: 0.25 }));
  s2.reparentShape(r, JSON.stringify({ parentId: b }));
  s2.deleteShapes(JSON.stringify([del]));
  assert.deepEqual(JSON.parse(s2.validate()), [], "hydrated edits validate");

  // round-trip through the canonical store.
  const s3 = createSession(JSON.stringify({ fromStore: JSON.parse(s2.serializeStore()) }));
  const objs = JSON.parse(s3.objects());
  assert.equal(objs[r].name, "edited", "edit persisted across store round-trip");
  assert.equal(objs[r].opacity, 0.25);
  assert.equal(objs[r]["parent-id"], b, "reparent persisted");
  assert.ok(!objs[del], "delete persisted");
});
