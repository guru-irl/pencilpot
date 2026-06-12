import { test } from "node:test";
import assert from "node:assert/strict";
import { createSession } from "../target/headless/penpot.js";

test("serializeStore -> loadStore round-trips a file losslessly", () => {
  const s = createSession(JSON.stringify({ empty: true }));
  const b = s.addBoard(JSON.stringify({ x: 0, y: 0, width: 100, height: 100, name: "B" }));
  s.addRect(JSON.stringify({ x: 10, y: 10, width: 20, height: 20, parentId: b }));
  s.closeBoard();
  const parts = JSON.parse(s.serializeStore()); // {manifest, pages:{id:edn}, components:{id:edn}, media:[]}
  assert.ok(parts.manifest.includes(":id"), "manifest is EDN");
  assert.ok(Object.keys(parts.pages).length >= 1, "has >=1 page");
  const s2 = createSession(JSON.stringify({ fromStore: parts }));
  assert.deepEqual(JSON.parse(s2.objects()), JSON.parse(s.objects()), "objects identical after round-trip");
});

test("canonical EDN is deterministic (serialize twice -> byte-identical)", () => {
  const s = createSession(JSON.stringify({ empty: true }));
  const b = s.addBoard(JSON.stringify({ x: 0, y: 0, width: 100, height: 100, name: "B" }));
  s.closeBoard();
  assert.equal(s.serializeStore(), s.serializeStore(), "two serializations byte-identical");
});
