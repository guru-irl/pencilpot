import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { buildAddBoardBody } from "../target/headless/penpot.js";

const BASE = process.env.PENPOT_HL_BASE ?? "http://localhost:9101";
const env = JSON.parse(readFileSync(new URL("../../infra/penpot-hl/test-env.json", import.meta.url)));

async function getFile() {
  const res = await fetch(`${BASE}/api/rpc/command/get-file`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: `Token ${env.token}` },
    body: JSON.stringify({ id: env.fileId }),
  });
  assert.ok(res.ok, `get-file ${res.status}`);
  return res.json();
}

test("headless update-file adds a board that persists", async () => {
  const before = await getFile();
  const pageId = before.data.pages[0];
  const objsBefore = Object.keys(before.data.pagesIndex[pageId].objects).length;

  const body = buildAddBoardBody(JSON.stringify({
    fileId: env.fileId, sessionId: randomUUID(),
    revn: before.revn, vern: before.vern, features: before.features,
    pageId, x: 40, y: 40, width: 320, height: 240, name: "Headless Board",
  }));

  const res = await fetch(`${BASE}/api/rpc/command/update-file`, {
    method: "POST",
    headers: {
      "Content-Type": "application/transit+json",
      Accept: "application/json",
      Authorization: `Token ${env.token}`,
    },
    body,
  });
  const text = await res.text();
  assert.ok(res.ok, `update-file ${res.status}: ${text.slice(0, 400)}`);

  const after = await getFile();
  assert.equal(after.revn, before.revn + 1, "revn incremented");
  const objsAfter = Object.keys(after.data.pagesIndex[pageId].objects).length;
  assert.equal(objsAfter, objsBefore + 1, "exactly one object added");
  const added = Object.values(after.data.pagesIndex[pageId].objects).find((s) => s.name === "Headless Board");
  assert.ok(added, "board present by name");
  assert.equal(added.type, "frame");
  assert.equal(added.selrect.width, 320, "geometry persisted");
});
