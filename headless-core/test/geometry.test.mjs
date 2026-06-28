// Wave 2 — geometry: moveShape (absolute/relative, carries the subtree) and
// resizeShape (via the modifier engine, children reflow). Asserted on a
// fromStore-hydrated session + store round-trip.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createSession } from "../target/headless/penpot.js";

const sel = (s, id) => JSON.parse(s.objects())[id].selrect;

test("moveShape to an absolute position", () => {
  const s = createSession(JSON.stringify({ empty: true, name: "Move" }));
  const b = s.addBoard(JSON.stringify({ x: 0, y: 0, width: 400, height: 400, name: "F" }));
  const r = s.addRect(JSON.stringify({ x: 10, y: 10, width: 50, height: 50, name: "r" }));
  s.closeBoard();

  s.moveShape(r, JSON.stringify({ x: 100, y: 200 }));
  const sr = sel(s, r);
  assert.equal(Math.round(sr.x), 100, "x moved to absolute target");
  assert.equal(Math.round(sr.y), 200, "y moved to absolute target");
  assert.deepEqual(JSON.parse(s.validate()), [], "validates after move");
});

test("moveShape by a relative delta carries child shapes", () => {
  const s = createSession(JSON.stringify({ empty: true, name: "MoveGroup" }));
  const b = s.addBoard(JSON.stringify({ x: 0, y: 0, width: 600, height: 600, name: "F" }));
  const child = s.addRect(JSON.stringify({ x: 20, y: 20, width: 40, height: 40, name: "child" }));
  s.closeBoard();

  const childBefore = sel(s, child);
  const boardBefore = sel(s, b);
  s.moveShape(b, JSON.stringify({ dx: 50, dy: 70 }));
  const childAfter = sel(s, child);
  const boardAfter = sel(s, b);
  assert.equal(Math.round(boardAfter.x - boardBefore.x), 50, "board moved by dx");
  assert.equal(Math.round(childAfter.x - childBefore.x), 50, "child moved with the board (subtree)");
  assert.equal(Math.round(childAfter.y - childBefore.y), 70, "child moved by dy");
  assert.deepEqual(JSON.parse(s.validate()), [], "validates after subtree move");
});

test("resizeShape changes width and height", () => {
  const s = createSession(JSON.stringify({ empty: true, name: "Resize" }));
  const b = s.addBoard(JSON.stringify({ x: 0, y: 0, width: 400, height: 400, name: "F" }));
  const r = s.addRect(JSON.stringify({ x: 0, y: 0, width: 50, height: 50, name: "r" }));
  s.closeBoard();

  s.resizeShape(r, JSON.stringify({ width: 120, height: 80 }));
  const sr = sel(s, r);
  assert.equal(Math.round(sr.width), 120, "width applied");
  assert.equal(Math.round(sr.height), 80, "height applied");
  assert.deepEqual(JSON.parse(s.validate()), [], "validates after resize");
});

const pointsOf = (s, id) => JSON.parse(s.objects())[id].points;

test("rotateShape rotates about the shape center (real geometry, not a raw :rotation set)", () => {
  const s = createSession(JSON.stringify({ empty: true, name: "Rotate" }));
  const b = s.addBoard(JSON.stringify({ x: 0, y: 0, width: 400, height: 400, name: "F" }));
  const r = s.addRect(JSON.stringify({ x: 100, y: 100, width: 80, height: 40, name: "r" }));
  s.closeBoard();

  const before = pointsOf(s, r);
  s.rotateShape(r, JSON.stringify({ angle: 45 }));
  const shape = JSON.parse(s.objects())[r];

  const rot = ((shape.rotation % 360) + 360) % 360;
  assert.ok(Math.abs(rot - 45) < 0.5, `:rotation is ~45 (got ${shape.rotation})`);

  // a real rotation moves the corner points; a raw attribute set would not
  const after = shape.points;
  const moved = after.some((p, i) => Math.abs(p.x - before[i].x) > 1 || Math.abs(p.y - before[i].y) > 1);
  assert.ok(moved, "corner :points changed (geometry-correct rotation, not a no-op)");

  // the rotation is about the shape's own center, so the center is preserved
  const c0 = before.reduce((a, p) => ({ x: a.x + p.x / 4, y: a.y + p.y / 4 }), { x: 0, y: 0 });
  const c1 = after.reduce((a, p) => ({ x: a.x + p.x / 4, y: a.y + p.y / 4 }), { x: 0, y: 0 });
  assert.ok(Math.abs(c0.x - c1.x) < 1 && Math.abs(c0.y - c1.y) < 1, "center preserved");

  assert.deepEqual(JSON.parse(s.validate()), [], "validates after rotate");
});

test("rotateShape about an explicit pivot moves the shape center", () => {
  const s = createSession(JSON.stringify({ empty: true, name: "RotatePivot" }));
  const b = s.addBoard(JSON.stringify({ x: 0, y: 0, width: 600, height: 600, name: "F" }));
  const r = s.addRect(JSON.stringify({ x: 100, y: 100, width: 40, height: 40, name: "r" }));
  s.closeBoard();

  const before = sel(s, r);
  s.rotateShape(r, JSON.stringify({ angle: 90, cx: 0, cy: 0 }));
  const after = sel(s, r);
  // rotating about (0,0) by 90deg moves the shape away from its origin position
  const movedFar = Math.abs(after.x - before.x) > 50 || Math.abs(after.y - before.y) > 50;
  assert.ok(movedFar, "explicit pivot relocates the shape");
  assert.deepEqual(JSON.parse(s.validate()), [], "validates after pivot rotate");
});

test("rotateShape persists on a fromStore-hydrated session + round-trip", () => {
  const s1 = createSession(JSON.stringify({ empty: true, name: "RotHydrated" }));
  const b = s1.addBoard(JSON.stringify({ x: 0, y: 0, width: 400, height: 400, name: "F" }));
  const r = s1.addRect(JSON.stringify({ x: 50, y: 50, width: 60, height: 60, name: "r" }));
  s1.closeBoard();

  const s2 = createSession(JSON.stringify({ fromStore: JSON.parse(s1.serializeStore()) }));
  s2.rotateShape(r, JSON.stringify({ angle: 30 }));
  assert.deepEqual(JSON.parse(s2.validate()), [], "hydrated rotate validates");

  const s3 = createSession(JSON.stringify({ fromStore: JSON.parse(s2.serializeStore()) }));
  const rot = ((JSON.parse(s3.objects())[r].rotation % 360) + 360) % 360;
  assert.ok(Math.abs(rot - 30) < 0.5, `rotation persisted across round-trip (got ${rot})`);
});

test("geometry edits persist on a fromStore-hydrated session + round-trip", () => {
  const s1 = createSession(JSON.stringify({ empty: true, name: "Hydrated" }));
  const b = s1.addBoard(JSON.stringify({ x: 0, y: 0, width: 400, height: 400, name: "F" }));
  const r = s1.addRect(JSON.stringify({ x: 10, y: 10, width: 50, height: 50, name: "r" }));
  s1.closeBoard();

  const s2 = createSession(JSON.stringify({ fromStore: JSON.parse(s1.serializeStore()) }));
  s2.moveShape(r, JSON.stringify({ x: 90, y: 90 }));
  s2.resizeShape(r, JSON.stringify({ width: 70, height: 70 }));
  assert.deepEqual(JSON.parse(s2.validate()), [], "hydrated geometry edits validate");

  const s3 = createSession(JSON.stringify({ fromStore: JSON.parse(s2.serializeStore()) }));
  const sr = sel(s3, r);
  assert.equal(Math.round(sr.x), 90, "move persisted across store round-trip");
  assert.equal(Math.round(sr.width), 70, "resize persisted across store round-trip");
});
