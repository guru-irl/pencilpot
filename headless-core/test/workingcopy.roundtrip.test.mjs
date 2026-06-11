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
