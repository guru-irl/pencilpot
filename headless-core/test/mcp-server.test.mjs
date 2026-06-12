import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createHeadlessMcp } from "../mcp/server.mjs";

const env = JSON.parse(readFileSync(new URL("../../infra/penpot-hl/test-env.json", import.meta.url)));
const parse = (res) => JSON.parse(res.content[0].text);

async function connected() {
  const server = createHeadlessMcp({ token: env.token, base: "http://localhost:9101" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(st), client.connect(ct)]);
  return client;
}

test("MCP: tools/list exposes the headless tools", async () => {
  const client = await connected();
  const names = (await client.listTools()).tools.map((t) => t.name).sort();
  for (const n of ["checkout", "script", "commit", "validate", "scene", "status", "discard"]) assert.ok(names.includes(n), `missing ${n}`);
});

test("MCP: checkout -> script(add board+rect) -> validate -> commit persists", async () => {
  const client = await connected();
  const co = parse(await client.callTool({ name: "checkout", arguments: { fileId: env.fileId } }));
  assert.equal(co.checkedOut, env.fileId);

  const scr = parse(await client.callTool({ name: "script", arguments: { code:
    "const b = wc.addBoard({x:900,y:60,width:280,height:180,name:'MCP Board'});" +
    "wc.addRect({x:920,y:80,width:100,height:60,parentId:b,fills:[{fillColor:'#3366ff'}]});" +
    "wc.closeBoard(); return wc.pendingChanges().length;" } }));
  assert.equal(scr.result, 2);

  assert.deepEqual(parse(await client.callTool({ name: "validate", arguments: {} })), []);
  const c = parse(await client.callTool({ name: "commit", arguments: {} }));
  assert.equal(c.committed, true);
  assert.ok(typeof c.revn === "number");
});

test("MCP: status reports pending count + revn; discard resets the working copy", async () => {
  const client = await connected();
  await client.callTool({ name: "checkout", arguments: { fileId: env.fileId } });

  // before any edit: zero pending, numeric revn
  const before = parse(await client.callTool({ name: "status", arguments: {} }));
  assert.equal(before.pending, 0);
  assert.ok(typeof before.revn === "number");

  // edit (no commit) -> status reflects pending changes
  parse(await client.callTool({ name: "script", arguments: { code:
    "wc.addBoard({x:100,y:100,width:120,height:80,name:'Status Probe'}); wc.closeBoard(); return wc.pendingChanges().length;" } }));
  const after = parse(await client.callTool({ name: "status", arguments: {} }));
  assert.equal(after.pending, 1, "pending change counted");

  // discard drops the working copy; subsequent tool calls must error until re-checkout
  const d = parse(await client.callTool({ name: "discard", arguments: {} }));
  assert.equal(d.discarded, true);
  const errRes = await client.callTool({ name: "status", arguments: {} });
  assert.match(errRes.content[0].text, /No file checked out/i, "discard cleared the working copy");
});
