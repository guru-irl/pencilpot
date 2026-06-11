import { test } from "node:test";
import assert from "node:assert/strict";
import { buildAddBoardChange } from "../target/headless/penpot.js";

const PAGE = "00000000-0000-0000-0000-0000000000aa";

test("buildAddBoardChange returns a geometry-complete add-obj change", () => {
  const out = JSON.parse(buildAddBoardChange(JSON.stringify({
    pageId: PAGE, x: 10, y: 20, width: 300, height: 200, name: "Board A",
  })));
  assert.ok(Array.isArray(out), "returns a vector of changes");
  assert.equal(out.length, 1);
  const ch = out[0];
  // clj->js keys come through kebab-case (e.g. "page-id", "transform-inverse"),
  // and the :add-obj keyword serializes to the string "add-obj".
  assert.equal(ch.type, "add-obj");
  assert.equal(ch["page-id"], PAGE);
  assert.equal(ch.obj.type, "frame");
  assert.ok(ch.obj.selrect && ch.obj.selrect.width === 300, "selrect computed");
  assert.ok(Array.isArray(ch.obj.points) && ch.obj.points.length === 4, "points computed");
  assert.ok(ch.obj.transform && ch.obj["transform-inverse"], "transform present");
});
