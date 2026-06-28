// Wave 5 — grouping: groupShapes (wrap shapes in a new :group) and ungroupShape
// (dissolve a group, lifting children back). Asserted on fresh + fromStore.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createSession } from "../target/headless/penpot.js";

function frameWithRects(s) {
  const b = s.addBoard(JSON.stringify({ x: 0, y: 0, width: 400, height: 400, name: "F" }));
  const r1 = s.addRect(JSON.stringify({ x: 10, y: 10, width: 50, height: 50, name: "r1" }));
  const r2 = s.addRect(JSON.stringify({ x: 100, y: 100, width: 50, height: 50, name: "r2" }));
  s.closeBoard();
  return { b, r1, r2 };
}

test("groupShapes wraps shapes in a new group", () => {
  const s = createSession(JSON.stringify({ empty: true, name: "Group" }));
  const { b, r1, r2 } = frameWithRects(s);

  const g = s.groupShapes(JSON.stringify([r1, r2]), JSON.stringify({ name: "MyGroup" }));
  const objs = JSON.parse(s.objects());
  assert.equal(objs[g].type, "group", "a group shape was created");
  assert.equal(objs[g].name, "MyGroup");
  assert.deepEqual([...objs[g].shapes].sort(), [r1, r2].sort(), "group owns both shapes");
  assert.equal(objs[r1]["parent-id"], g, "r1 reparented into the group");
  assert.equal(objs[r2]["parent-id"], g, "r2 reparented into the group");
  assert.ok(objs[b].shapes.includes(g) && !objs[b].shapes.includes(r1), "board lists the group, not the rects");
  // group geometry spans the children
  assert.ok(objs[g].selrect.width >= 140 && objs[g].selrect.height >= 140, "group selrect spans children");
  assert.deepEqual(JSON.parse(s.validate()), [], "validates after grouping");
});

test("ungroupShape dissolves a group and lifts children back", () => {
  const s = createSession(JSON.stringify({ empty: true, name: "Ungroup" }));
  const { b, r1, r2 } = frameWithRects(s);
  const g = s.groupShapes(JSON.stringify([r1, r2]), JSON.stringify({}));

  s.ungroupShape(g);
  const objs = JSON.parse(s.objects());
  assert.ok(!objs[g], "group removed");
  assert.equal(objs[r1]["parent-id"], b, "r1 back under the board");
  assert.equal(objs[r2]["parent-id"], b, "r2 back under the board");
  assert.ok(objs[b].shapes.includes(r1) && objs[b].shapes.includes(r2), "board lists the rects again");
  assert.deepEqual(JSON.parse(s.validate()), [], "validates after ungrouping");
});

test("group/ungroup work on a fromStore-hydrated session + round-trip", () => {
  const s1 = createSession(JSON.stringify({ empty: true, name: "Hyd" }));
  const { b, r1, r2 } = frameWithRects(s1);

  const s2 = createSession(JSON.stringify({ fromStore: JSON.parse(s1.serializeStore()) }));
  const g = s2.groupShapes(JSON.stringify([r1, r2]), JSON.stringify({ name: "HG" }));
  assert.deepEqual(JSON.parse(s2.validate()), [], "hydrated grouping validates");

  const s3 = createSession(JSON.stringify({ fromStore: JSON.parse(s2.serializeStore()) }));
  const objs = JSON.parse(s3.objects());
  assert.equal(objs[g].type, "group", "group persisted across round-trip");
  assert.equal(objs[r1]["parent-id"], g, "membership persisted");

  s3.ungroupShape(g);
  assert.ok(!JSON.parse(s3.objects())[g], "hydrated ungroup removes the group");
  assert.deepEqual(JSON.parse(s3.validate()), [], "validates after hydrated ungroup");
});
