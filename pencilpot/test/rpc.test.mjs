import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { createSession } from "../../headless-core/target/headless/penpot.js";
import { writeDesign } from "../store/store.mjs";
import { getFile, updateFileJson } from "../runtime/rpc.mjs";

function seedDir() {
  const s = createSession(JSON.stringify({ empty: true }));
  const b = s.addBoard(JSON.stringify({ x: 0, y: 0, width: 100, height: 100, name: "B" }));
  const r = s.addRect(JSON.stringify({ x: 10, y: 10, width: 20, height: 20, parentId: b }));
  s.closeBoard();
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pp-")), "home.penpot");
  writeDesign(dir, JSON.parse(s.serializeStore()));
  return { dir, r };
}

test("getFile loads the store and returns an envelope that re-hydrates", () => {
  const { dir } = seedDir();
  const { meta, transit } = getFile(dir);
  assert.ok(meta.id && meta.data, "envelope has id + data");
  const s2 = createSession(JSON.stringify({ fromTransit: transit, meta }));
  assert.ok(Object.keys(JSON.parse(s2.objects())).length >= 2, "re-hydrates shapes");
});

test("updateFileJson applies a change, persists to the store, bumps revn", () => {
  const { dir, r } = seedDir();
  const res = updateFileJson(dir, JSON.stringify([{ type: "mod-obj", id: r, operations: [{ type: "set", attr: "x", val: 99 }] }]));
  assert.equal(res.revn, 1, "revn bumped to 1");
  const { meta, transit } = getFile(dir);
  const s2 = createSession(JSON.stringify({ fromTransit: transit, meta }));
  assert.equal(JSON.parse(s2.getShape(r)).x, 99, "edit persisted to the store");
});
