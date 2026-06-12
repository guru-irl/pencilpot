/**
 * AI-flow sanity test for the headless MCP server.
 *
 * Unlike test/mcp-server.test.mjs (which drives the server in-process via
 * InMemoryTransport), this spawns the REAL stdio server — `node mcp/server.mjs` —
 * exactly the way Claude Code launches it, connects a real MCP client over stdio,
 * and runs the full agent loop end-to-end against penpot-hl:
 *
 *   checkout -> script(add board + nested rect) -> validate -> status -> commit
 *   -> re-checkout (fresh) -> verify the board persisted server-side.
 *
 * It prints a human-readable PASS/FAIL report and exits non-zero on any failure,
 * so it doubles as a quick "does the whole thing actually work?" check.
 *
 * Run:  cd headless-core && npm run sanity
 * Requires: penpot-hl up at PENPOT_HL_BASE (default :9101) and
 *           infra/penpot-hl/test-env.json (node test/setup-env.mjs).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.resolve(here, "../mcp/server.mjs");
const env = JSON.parse(readFileSync(path.resolve(here, "../../infra/penpot-hl/test-env.json")));
const BASE = process.env.PENPOT_HL_BASE ?? "http://localhost:9101";
const BOARD = `Sanity Board ${Date.now()}`; // unique per run so verification is exact

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "  ✓" : "  ✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};
const call = async (client, name, args = {}) => {
  const res = await client.callTool({ name, arguments: args });
  return JSON.parse(res.content[0].text);
};

async function main() {
  console.log(`penpot-headless sanity test → ${BASE} (file ${env.fileId})\n`);

  const transport = new StdioClientTransport({
    command: process.execPath, // node
    args: [serverPath],
    env: { ...process.env, PENPOT_TOKEN: env.token, PENPOT_HL_BASE: BASE },
    stderr: "inherit",
  });
  const client = new Client({ name: "sanity", version: "0" });
  await client.connect(transport);

  try {
    // 1. tools advertised
    const tools = (await client.listTools()).tools.map((t) => t.name).sort();
    const expected = ["checkout", "commit", "discard", "scene", "script", "status", "validate"];
    check(`tools/list exposes the 7 tools`, expected.every((t) => tools.includes(t)), tools.join(","));

    // 2. checkout
    const co = await call(client, "checkout", { fileId: env.fileId });
    check(`checkout returns revn + object count`, co.checkedOut === env.fileId && typeof co.revn === "number", `revn=${co.revn} objects=${co.objects}`);
    const beforeObjects = co.objects;

    // 3. script: add a board + nested rect in one shot
    const scr = await call(client, "script", {
      code:
        `const b = wc.addBoard({x:1100,y:140,width:240,height:160,name:${JSON.stringify(BOARD)}});` +
        `wc.addRect({x:1120,y:160,width:80,height:50,name:"Sanity Rect",parentId:b,fills:[{fillColor:"#0ea5e9"}]});` +
        `wc.closeBoard(); return wc.pendingChanges().length;`,
    });
    check(`script adds board+rect (2 pending)`, scr.result === 2, `pending=${scr.pending}`);

    // 4. validate with Penpot's own validator
    const errs = await call(client, "validate");
    check(`validate returns no errors`, Array.isArray(errs) && errs.length === 0, JSON.stringify(errs));

    // 5. status
    const st = await call(client, "status");
    check(`status reports 2 pending`, st.pending === 2, `pending=${st.pending} revn=${st.revn}`);

    // 6. commit
    const c = await call(client, "commit");
    check(`commit persists (revn advances)`, c.committed === true && c.revn === co.revn + 1, `revn ${co.revn} -> ${c.revn}`);

    // 7. re-checkout fresh -> prove server-side persistence
    const co2 = await call(client, "checkout", { fileId: env.fileId });
    check(`re-checkout shows +2 objects & advanced revn`, co2.objects === beforeObjects + 2 && co2.revn === c.revn, `objects ${beforeObjects} -> ${co2.objects}, revn=${co2.revn}`);

    // 8. verify the exact board persisted with correct geometry + nesting
    const v = await call(client, "script", {
      code:
        `const o=JSON.parse(wc.session.objects());` +
        `const b=Object.values(o).find(s=>s.name===${JSON.stringify(BOARD)});` +
        `const r=Object.values(o).find(s=>s.name==="Sanity Rect"&&s["parent-id"]===(b&&b.id));` +
        `return {pending:wc.pendingChanges().length, board:!!b, type:b&&b.type, w:b&&b.selrect&&b.selrect.width, rect:!!r, fill:r&&r.fills&&r.fills[0]&&r.fills[0]["fill-color"]};`,
    });
    const r = v.result || {};
    check(`board persisted as frame, width 240`, r.board === true && r.type === "frame" && r.w === 240, JSON.stringify(r));
    check(`nested rect persisted with fill`, r.rect === true && r.fill === "#0ea5e9", `fill=${r.fill}`);
    check(`fresh working copy is clean (0 pending)`, r.pending === 0);
  } finally {
    await client.close();
  }

  console.log(`\n${failures === 0 ? "PASS — headless MCP sanity OK" : `FAIL — ${failures} check(s) failed`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error("sanity error:", e); process.exit(1); });
