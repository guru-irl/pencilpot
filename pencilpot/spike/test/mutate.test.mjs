import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile, readFile } from "../store.mjs";
import { applyUpdate } from "../api.mjs";
import { createSession } from "../../../headless-core/target/headless/penpot.js";

test("applyUpdate moves a shape and persists the new position to disk", async () => {
  const s = createSession(JSON.stringify({ empty: true }));
  const b = s.addBoard(JSON.stringify({ x: 0, y: 0, width: 100, height: 100, name: "B" }));
  const r = s.addRect(JSON.stringify({ x: 10, y: 10, width: 20, height: 20, parentId: b }));
  s.closeBoard();
  const { meta, transit } = JSON.parse(s.getFileResponse());
  const id = meta.id;
  writeFile(id, transit, meta);

  const changes = [{ type: "mod-obj", id: r, operations: [{ type: "set", attr: "x", val: 99 }] }];
  await applyUpdate(id, JSON.stringify({ changes }));

  const f = readFile(id);
  const s2 = createSession(JSON.stringify({ fromTransit: f.transit, meta: f.meta }));
  const moved = JSON.parse(s2.getShape(r));
  assert.equal(moved.x, 99, "moved x persisted to disk");
});
