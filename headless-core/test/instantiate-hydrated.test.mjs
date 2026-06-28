// Regression test for the instantiateComponent GAP on HYDRATED designs.
//
// Bug: a session rehydrated from disk (the canonical-EDN store, via fromStore —
// the exact path the pencilpot runtime uses) carries:
//   (a) plain-map shapes (not Shape records), and
//   (b) a :data map WITHOUT an :id key (load-store doesn't restore it).
// cll/generate-instantiate-component then (a) clones plain maps that fail
// pcb/add-object's cts/check-shape ([:fn shape?]) and (b) stamps the instance
// root with :component-file (:id data) = nil (schema wants a uuid), so
// instantiateComponent threw "expected valid shape".
//
// Fix (session.cljs :instantiateComponent): coerce shapes -> records AND restore
// :data :id = file-id before calling the generator. This test reproduces the
// hydration path and asserts instantiate now succeeds + validates.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createSession } from "../target/headless/penpot.js";

test("instantiateComponent works on a fromStore-hydrated session (no :id, plain-map shapes)", () => {
  // 1) Build a component in a fresh session.
  const s1 = createSession(JSON.stringify({ empty: true, name: "Hydrate" }));
  const b = s1.addBoard(JSON.stringify({ x: 0, y: 0, width: 200, height: 120, name: "Src" }));
  s1.addRect(JSON.stringify({ x: 10, y: 10, width: 80, height: 40, parentId: b }));
  s1.closeBoard();
  const cid = s1.createComponent(b, JSON.stringify({ name: "Card" }));
  assert.equal(typeof cid, "string");

  // 2) Serialize to the canonical-EDN store and 3) re-hydrate via fromStore
  //    (this is what the pencilpot runtime does: data has NO :id, shapes are maps).
  const parts = JSON.parse(s1.serializeStore());
  const s2 = createSession(JSON.stringify({ fromStore: parts }));

  // sanity: the rehydrated session is otherwise valid and the component survived
  assert.deepEqual(JSON.parse(s2.validate()), [], "rehydrated file validates");

  // 4) Instantiate the component on the hydrated session — used to throw.
  const copyId = s2.instantiateComponent(cid, JSON.stringify({ x: 400, y: 0 }));
  assert.equal(typeof copyId, "string", "instantiate returns a copy root id");

  // 5) The copy is present, references the component, and the file stays valid.
  const objs = JSON.parse(s2.objects());
  assert.ok(objs[copyId], "copy root present in objects");
  const copy = objs[copyId];
  assert.equal(copy["component-id"] ?? copy.componentId, cid,
    "copy references the source component");
  // The exact bug: :component-file used to be nil here (schema wants a uuid).
  const compFile = copy["component-file"] ?? copy.componentFile;
  assert.ok(compFile, "copy :component-file is a non-nil uuid (was nil before the fix)");
  assert.deepEqual(JSON.parse(s2.validate()), [], "file still validates after instantiate");
});
