import { test } from "node:test";
import assert from "node:assert/strict";
import { diffObjects, formatDiff } from "../store/diff.mjs";

const base = {
  a: { id: "a", type: "rect", name: "Box", x: 0, y: 0, width: 100, height: 50, fills: [{ "fill-color": "#fff" }] },
  b: { id: "b", type: "circle", name: "Dot", x: 10, y: 10, width: 20, height: 20 },
  c: { id: "c", type: "text", name: "Label", x: 5, y: 5, content: { t: "hi" } },
};

test("diff: no changes → empty", () => {
  const d = diffObjects(base, base);
  assert.equal(d.summary.changed, 0);
  assert.deepEqual([d.added, d.removed, d.modified].map((x) => x.length), [0, 0, 0]);
});

test("diff: detects a moved shape and reports the changed keys", () => {
  const after = structuredClone(base);
  after.a.x = 200; after.a.y = 75;
  const d = diffObjects(base, after);
  assert.equal(d.summary.modified, 1);
  const m = d.modified[0];
  assert.equal(m.id, "a");
  assert.deepEqual(m.keys.sort(), ["x", "y"]);
  assert.equal(m.changes.x.from, "0");
  assert.equal(m.changes.x.to, "200");
});

test("diff: detects added and removed shapes", () => {
  const after = structuredClone(base);
  delete after.b;                                  // removed
  after.d = { id: "d", type: "rect", name: "New" }; // added
  const d = diffObjects(base, after);
  assert.equal(d.added.length, 1);
  assert.equal(d.added[0].id, "d");
  assert.equal(d.removed.length, 1);
  assert.equal(d.removed[0].id, "b");
});

test("diff: deep fills/content change is detected; derived keys ignored", () => {
  const after = structuredClone(base);
  after.a.fills = [{ "fill-color": "#000" }];      // semantic change
  after.a.selrect = { x: 999 };                    // derived/volatile — NOT compared
  after.c.content = { t: "bye" };                  // text content change
  const d = diffObjects(base, after);
  const ma = d.modified.find((m) => m.id === "a");
  const mc = d.modified.find((m) => m.id === "c");
  assert.deepEqual(ma.keys, ["fills"]);            // selrect did not register
  assert.deepEqual(mc.keys, ["content"]);
});

test("diff: reparent (frame-id) is reported", () => {
  const after = structuredClone(base);
  after.b["frame-id"] = "a";
  const d = diffObjects(base, after);
  assert.ok(d.modified.some((m) => m.id === "b" && m.keys.includes("frame-id")));
});

test("formatDiff: renders +/-/~ lines and a summary", () => {
  const after = structuredClone(base);
  after.a.x = 1; delete after.c; after.z = { id: "z", type: "rect", name: "Z" };
  const out = formatDiff(diffObjects(base, after));
  assert.match(out, /\+ rect "Z"/);
  assert.match(out, /- text "Label"/);
  assert.match(out, /~ rect "Box".*x/);
  assert.match(out, /1 added, 1 removed, 1 modified/);
});
