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
