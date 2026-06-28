// Wave 4 — components: swapComponent (replace an instance with another
// component) and detachInstance (unlink an instance from its component).
// Asserted on fresh + fromStore-hydrated (the realistic AI-dev path).

import { test } from "node:test";
import assert from "node:assert/strict";
import { createSession } from "../target/headless/penpot.js";

// Build a file with two main components (C1, C2) and return their ids + session.
function withTwoComponents(name) {
  const s = createSession(JSON.stringify({ empty: true, name }));
  const b1 = s.addBoard(JSON.stringify({ x: 0, y: 0, width: 120, height: 120, name: "C1-main" }));
  s.addRect(JSON.stringify({ x: 10, y: 10, width: 40, height: 40, name: "c1r" }));
  s.closeBoard();
  const c1 = s.createComponent(b1, JSON.stringify({ name: "C1" }));
  const b2 = s.addBoard(JSON.stringify({ x: 300, y: 0, width: 120, height: 120, name: "C2-main" }));
  s.addEllipse(JSON.stringify({ x: 10, y: 10, width: 40, height: 40, name: "c2e" }));
  s.closeBoard();
  const c2 = s.createComponent(b2, JSON.stringify({ name: "C2" }));
  return { s, c1, c2 };
}

test("swapComponent replaces an instance with another component", () => {
  const { s, c1, c2 } = withTwoComponents("Swap");
  const inst = s.instantiateComponent(c1, JSON.stringify({ x: 0, y: 300 }));
  assert.equal(JSON.parse(s.objects())[inst]["component-id"], c1, "instance starts on C1");

  const newRoot = s.swapComponent(inst, c2);
  const o = JSON.parse(s.objects())[newRoot];
  assert.equal(o["component-id"], c2, "instance now references C2");
  const kidNames = o.shapes.map((id) => JSON.parse(s.objects())[id].name);
  assert.ok(kidNames.some((n) => /c2e/.test(n)), "instance subtree swapped to C2's children");
  assert.deepEqual(JSON.parse(s.validate()), [], "validates after swap");
});

test("detachInstance unlinks an instance from its component", () => {
  const { s, c1 } = withTwoComponents("Detach");
  const inst = s.instantiateComponent(c1, JSON.stringify({ x: 0, y: 300 }));
  assert.equal(JSON.parse(s.objects())[inst]["component-id"], c1, "linked before detach");

  s.detachInstance(inst);
  const o = JSON.parse(s.objects())[inst];
  assert.ok(!o["component-id"], "component-id removed");
  assert.ok(!o["shape-ref"], "shape-ref removed");
  assert.deepEqual(JSON.parse(s.validate()), [], "validates after detach");
});

test("swap + detach work on a fromStore-hydrated session + round-trip", () => {
  const { s, c1, c2 } = withTwoComponents("Hyd");
  const inst = s.instantiateComponent(c1, JSON.stringify({ x: 0, y: 300 }));
  const parts = JSON.parse(s.serializeStore());

  const s2 = createSession(JSON.stringify({ fromStore: parts }));
  const newRoot = s2.swapComponent(inst, c2);
  assert.equal(JSON.parse(s2.objects())[newRoot]["component-id"], c2, "hydrated swap works");
  assert.deepEqual(JSON.parse(s2.validate()), [], "hydrated swap validates");

  // round-trip the swap result, then detach there
  const s3 = createSession(JSON.stringify({ fromStore: JSON.parse(s2.serializeStore()) }));
  assert.equal(JSON.parse(s3.objects())[newRoot]["component-id"], c2, "swap persisted across round-trip");
  s3.detachInstance(newRoot);
  assert.ok(!JSON.parse(s3.objects())[newRoot]["component-id"], "hydrated detach works");
  assert.deepEqual(JSON.parse(s3.validate()), [], "validates after hydrated detach");
});
