// Test for addInteraction — the prototype interaction-authoring verb.
//
// Closes the B3-audit GAP: there was no way to author prototype interactions
// (only view/play existing ones). addInteraction wires a click->navigate (or
// other) interaction onto a shape's :interactions vector. We assert the
// interaction is schema-valid, survives validate(), and round-trips through the
// canonical-EDN store (fromStore) the way the pencilpot runtime persists it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createSession } from "../target/headless/penpot.js";

test("addInteraction wires a click->navigate link and validates", () => {
  const s = createSession(JSON.stringify({ empty: true, name: "Proto" }));
  const src = s.addBoard(JSON.stringify({ x: 0, y: 0, width: 200, height: 200, name: "Home" }));
  s.closeBoard();
  const dst = s.addBoard(JSON.stringify({ x: 400, y: 0, width: 200, height: 200, name: "Details" }));
  s.closeBoard();

  const inter = JSON.parse(s.addInteraction(JSON.stringify({ shapeId: src, destination: dst })));
  // defaults: click + navigate
  assert.equal(inter["event-type"] ?? inter.eventType, "click");
  assert.equal(inter["action-type"] ?? inter.actionType, "navigate");
  assert.equal(inter.destination, dst, "destination points at the target frame");

  // persisted on the shape
  const objs = JSON.parse(s.objects());
  const ints = objs[src].interactions;
  assert.ok(Array.isArray(ints) && ints.length === 1, "interaction appended to the shape");
  assert.equal(ints[0].destination, dst);

  assert.deepEqual(JSON.parse(s.validate()), [], "file validates with the interaction");
});

test("addInteraction works on a fromStore-hydrated (plain-map) session and survives round-trip", () => {
  // Build two frames + a link, serialize to the canonical store, re-hydrate.
  const s1 = createSession(JSON.stringify({ empty: true, name: "Proto2" }));
  const a = s1.addBoard(JSON.stringify({ x: 0, y: 0, width: 200, height: 200, name: "A" }));
  s1.closeBoard();
  const b = s1.addBoard(JSON.stringify({ x: 400, y: 0, width: 200, height: 200, name: "B" }));
  s1.closeBoard();
  const parts = JSON.parse(s1.serializeStore());

  // Re-hydrate the way the runtime does (plain-map shapes, no :data :id) and
  // author the interaction THERE — this is the realistic AI-dev path.
  const s2 = createSession(JSON.stringify({ fromStore: parts }));
  s2.addInteraction(JSON.stringify({ shapeId: a, destination: b, preserveScroll: true }));
  const objs = JSON.parse(s2.objects());
  assert.equal(objs[a].interactions[0].destination, b);
  assert.equal(objs[a].interactions[0]["preserve-scroll"] ?? objs[a].interactions[0].preserveScroll, true);
  assert.deepEqual(JSON.parse(s2.validate()), [], "hydrated file validates after authoring an interaction");

  // round-trip again: the interaction persists through the store
  const parts2 = JSON.parse(s2.serializeStore());
  const s3 = createSession(JSON.stringify({ fromStore: parts2 }));
  const objs3 = JSON.parse(s3.objects());
  assert.equal(objs3[a].interactions[0].destination, b, "interaction survives a store round-trip");
});
