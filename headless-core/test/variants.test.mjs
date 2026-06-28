// Wave 9 — component VARIANTS: makeVariant (promote a component instance into a
// variant set / variant-container) and addVariant (add a sibling variant).
// Asserted on fresh + fromStore-hydrated (the realistic AI-dev path).

import { test } from "node:test";
import assert from "node:assert/strict";
import { createSession } from "../target/headless/penpot.js";

// Build a file with one main component (a board promoted via createComponent).
// Returns the session, the main-instance (board) id, and the component id.
function withComponent(name) {
  const s = createSession(JSON.stringify({ empty: true, name }));
  const b = s.addBoard(JSON.stringify({ x: 0, y: 0, width: 120, height: 120, name: "Main" }));
  s.addRect(JSON.stringify({ x: 10, y: 10, width: 40, height: 40, name: "r" }));
  s.closeBoard();
  const c = s.createComponent(b, JSON.stringify({ name: "Btn" }));
  return { s, board: b, comp: c };
}

function obj(s, id) { return JSON.parse(s.objects())[id]; }

test("makeVariant promotes a component instance into a variant container", () => {
  const { s, board } = withComponent("MV");
  const vid = s.makeVariant(board, JSON.stringify({ name: "Btn" }));

  const container = obj(s, vid);
  assert.ok(container, "variant container shape exists");
  assert.equal(container["is-variant-container"], true, "container is a variant container");
  assert.ok((container.shapes || []).includes(board), "the instance is now a child of the container");

  const inst = obj(s, board);
  assert.equal(inst["variant-id"], vid, "the instance is tagged with the variant-id");
  assert.equal(inst["parent-id"], vid, "instance reparented under the container");
  assert.deepEqual(JSON.parse(s.validate()), [], "file validates after makeVariant");
});

test("addVariant adds a sibling variant to an existing variant set", () => {
  const { s, board } = withComponent("AV");
  const vid = s.makeVariant(board, JSON.stringify({ name: "Btn" }));
  const before = obj(s, vid).shapes.length;

  const newInst = s.addVariant(board);
  const container = obj(s, vid);
  assert.equal(container.shapes.length, before + 1, "container gained a sibling variant");
  assert.ok(container.shapes.includes(newInst), "the new variant is a child of the container");

  const a = obj(s, board);
  const b = obj(s, newInst);
  assert.ok(a["component-id"] && b["component-id"], "both variants reference a component");
  assert.notEqual(a["component-id"], b["component-id"], "the new variant is a distinct component");
  assert.equal(b["variant-id"], vid, "the new variant shares the variant-id");
  assert.deepEqual(JSON.parse(s.validate()), [], "file validates after addVariant");
});

test("makeVariant + addVariant work on a fromStore-hydrated session + round-trip", () => {
  const { s, board } = withComponent("Hyd");
  // hydrate from disk-shaped store (plain maps, :data :id dropped) BEFORE making the variant
  const s2 = createSession(JSON.stringify({ fromStore: JSON.parse(s.serializeStore()) }));

  const vid = s2.makeVariant(board, JSON.stringify({ name: "Btn" }));
  assert.equal(obj(s2, vid)["is-variant-container"], true, "hydrated makeVariant works");
  assert.deepEqual(JSON.parse(s2.validate()), [], "hydrated makeVariant validates");

  // addVariant on hydrated data exercises the component-duplication coercion path
  const newInst = s2.addVariant(board);
  assert.ok(obj(s2, vid).shapes.includes(newInst), "hydrated addVariant works");
  assert.deepEqual(JSON.parse(s2.validate()), [], "hydrated addVariant validates");

  // round-trip preserves the variant set
  const s3 = createSession(JSON.stringify({ fromStore: JSON.parse(s2.serializeStore()) }));
  const c3 = obj(s3, vid);
  assert.equal(c3["is-variant-container"], true, "variant container persists across round-trip");
  assert.equal(c3.shapes.length, 2, "both variants persist");
  assert.deepEqual(JSON.parse(s3.validate()), [], "validates after round-trip");
});
