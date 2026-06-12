import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { WorkingCopy } from "../sdk/index.mjs";
import { getFile } from "../sdk/rpc.mjs";

const env = JSON.parse(readFileSync(new URL("../../infra/penpot-hl/test-env.json", import.meta.url)));

test("WorkingCopy: checkout -> add board+rect -> commit -> persists & validates", async () => {
  const before = await getFile(env.fileId, env.token);
  const beforeCount = Object.keys(before.raw.data.pagesIndex[before.pageId].objects).length;

  const wc = await new WorkingCopy(env.fileId, env.token).checkout();
  const boardId = wc.addBoard({ x: 600, y: 60, width: 300, height: 200, name: "WC Board" });
  wc.addRect({ x: 620, y: 80, width: 120, height: 80, name: "WC Rect", parentId: boardId, fills: [{ fillColor: "#00aa55" }] });
  wc.closeBoard();
  assert.deepEqual(wc.validate(), [], "valid before commit");
  assert.equal(wc.pendingChanges().length, 2);

  const res = await wc.commit();
  assert.ok(typeof res.revn === "number");

  const after = await getFile(env.fileId, env.token);
  const afterCount = Object.keys(after.raw.data.pagesIndex[after.pageId].objects).length;
  assert.equal(afterCount, beforeCount + 2, "two objects added");
  const board = Object.values(after.raw.data.pagesIndex[after.pageId].objects).find((s) => s.name === "WC Board");
  assert.ok(board && board.type === "frame" && board.selrect.width === 300);
});

test("WorkingCopy: add text persists with content", async () => {
  const before = await getFile(env.fileId, env.token);
  const beforeCount = Object.keys(before.raw.data.pagesIndex[before.pageId].objects).length;

  const wc = await new WorkingCopy(env.fileId, env.token).checkout();
  const id = wc.addText({ x: 700, y: 360, width: 240, height: 40, characters: "Headless Heading", fontSize: 24, fills: [{ fillColor: "#7c3aed" }] });
  assert.deepEqual(wc.validate(), []);
  await wc.commit();

  const after = await getFile(env.fileId, env.token);
  const afterCount = Object.keys(after.raw.data.pagesIndex[after.pageId].objects).length;
  assert.equal(afterCount, beforeCount + 1, "text object persisted");
  const t = Object.values(after.raw.data.pagesIndex[after.pageId].objects).find((s) => s.id === id);
  assert.ok(t && t.type === "text", "persisted shape is text");
});

test("WorkingCopy: flex layout arranges + persists", async () => {
  const wc = await new WorkingCopy(env.fileId, env.token).checkout();
  const b = wc.addBoard({ x: 1200, y: 60, width: 400, height: 120, name: "Flex Row" });
  const ids = [0,1,2].map(() => wc.addRect({ x: 0, y: 0, width: 80, height: 60, parentId: b }));
  wc.closeBoard();
  wc.setFlexLayout(b, { dir: "row", gap: 10 });
  assert.deepEqual(wc.validate(), []);
  await wc.commit();
  const after = await getFile(env.fileId, env.token);
  const objs = after.raw.data.pagesIndex[after.pageId].objects;
  assert.equal(objs[b].layout, "flex", "board persisted as flex container");
  // children arranged left-to-right (persisted reflow)
  const xs = ids.map(id => objs[id].selrect.x).sort((a,bb)=>a-bb);
  assert.ok(xs[1]-xs[0] >= 80 && xs[2]-xs[1] >= 80, `children spread persisted (got ${xs})`);
});
