import { test } from "node:test";
import assert from "node:assert/strict";
import { createSession } from "../../../headless-core/target/headless/penpot.js";

test("getFileResponse emits inline transit that re-hydrates to the same shapes", () => {
  const s = createSession(JSON.stringify({ empty: true }));
  const b = s.addBoard(JSON.stringify({ x: 0, y: 0, width: 100, height: 100, name: "B" }));
  s.addRect(JSON.stringify({ x: 10, y: 10, width: 20, height: 20, parentId: b }));
  s.closeBoard();

  const resp = JSON.parse(s.getFileResponse()); // { meta: {...}, transit: "<transit string>" }
  assert.ok(resp.meta.id, "has file id");
  assert.ok(typeof resp.transit === "string" && resp.transit.length > 0, "has transit body");

  const s2 = createSession(JSON.stringify({ fromTransit: resp.transit, meta: resp.meta }));
  const objs = JSON.parse(s2.objects());
  assert.ok(objs[b], "board survived round-trip");
});
