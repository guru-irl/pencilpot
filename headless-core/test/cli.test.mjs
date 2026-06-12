import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { getFile } from "../sdk/rpc.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const pp = path.resolve(here, "../bin/pp.mjs");
const env = JSON.parse(readFileSync(path.resolve(here, "../../infra/penpot-hl/test-env.json")));
const run = (args) => execFileSync(process.execPath, [pp, ...args],
  { env: { ...process.env, PENPOT_TOKEN: env.token, PENPOT_HL_BASE: "http://localhost:9101" }, encoding: "utf8" });

test("pp run: checkout -> script -> commit persists", async () => {
  const before = await getFile(env.fileId, env.token);
  const beforeCount = Object.keys(before.raw.data.pagesIndex[before.pageId].objects).length;

  const out = run(["run", env.fileId, "-e",
    "const b=wc.addBoard({x:1500,y:60,width:200,height:120,name:'CLI Board'}); wc.addRect({x:1520,y:80,width:60,height:40,parentId:b}); wc.closeBoard(); return wc.pendingChanges().length;"]);
  assert.match(out, /committed/i);

  const after = await getFile(env.fileId, env.token);
  const afterCount = Object.keys(after.raw.data.pagesIndex[after.pageId].objects).length;
  assert.equal(afterCount, beforeCount + 2, "CLI run persisted 2 objects");
});

test("pp scene: prints object map without committing", async () => {
  const before = await getFile(env.fileId, env.token);
  const out = run(["scene", env.fileId]);
  const objs = JSON.parse(out);
  assert.ok(typeof objs === "object" && Object.keys(objs).length >= 1);
  const after = await getFile(env.fileId, env.token);
  assert.equal(after.revn, before.revn, "scene is read-only (revn unchanged)");
});
