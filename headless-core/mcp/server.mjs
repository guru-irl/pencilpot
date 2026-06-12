import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { WorkingCopy } from "../sdk/index.mjs";
import { runScript } from "../sdk/script.mjs";

const text = (v) => ({ content: [{ type: "text", text: typeof v === "string" ? v : JSON.stringify(v, null, 2) }] });

export function createHeadlessMcp({ token, base } = {}) {
  if (base) process.env.PENPOT_HL_BASE = base;
  const tok = token ?? process.env.PENPOT_TOKEN;
  const server = new McpServer(
    { name: "penpot-headless", version: "0.1.0" },
    { instructions: "Headless Penpot editing. checkout(fileId) a file, then script(code) to edit it (globals: wc, with wc.addBoard/addRect/addEllipse/addText/closeBoard/validate/pendingChanges), then commit(). No browser needed." }
  );
  let wc = null;
  const need = () => { if (!wc) throw new Error("No file checked out. Call checkout(fileId) first."); return wc; };

  server.registerTool("checkout",
    { description: "Load a Penpot file into a headless working copy by id.", inputSchema: { fileId: z.string().describe("Penpot file UUID") } },
    async ({ fileId }) => { wc = await new WorkingCopy(fileId, tok).checkout();
      const objs = JSON.parse(wc.session.objects());
      return text({ checkedOut: fileId, revn: wc.revn, objects: Object.keys(objs).length }); });

  server.registerTool("script",
    { description: "Run JS against the working copy. Globals: `wc` (addBoard/addRect/addEllipse/addText/closeBoard/validate/pendingChanges). Do many edits in one call; return a value. No network until commit.",
      inputSchema: { code: z.string().min(1) } },
    async ({ code }) => { const w = need(); const r = await runScript(code, { wc: w });
      return text(r.ok ? { result: r.result, log: r.log, pending: w.pendingChanges().length } : { error: r.error, log: r.log }); });

  server.registerTool("scene",
    { description: "Return the working copy's object map (id -> shape).", inputSchema: {} },
    async () => text(JSON.parse(need().session.objects())));

  server.registerTool("validate",
    { description: "Validate the working copy with Penpot's own validator (empty array = valid).", inputSchema: {} },
    async () => text(need().validate()));

  server.registerTool("status",
    { description: "Pending (uncommitted) change count + current revn.", inputSchema: {} },
    async () => { const w = need(); return text({ pending: w.pendingChanges().length, revn: w.revn }); });

  server.registerTool("commit",
    { description: "Persist accumulated edits to the file via update-file.", inputSchema: {} },
    async () => { const w = need(); const errs = w.validate(); if (errs.length) return text({ error: "invalid; not committed", errs });
      const res = await w.commit(); return text({ committed: true, revn: res.revn + 1 }); });

  server.registerTool("discard",
    { description: "Discard the working copy (re-checkout to start over).", inputSchema: {} },
    async () => { wc = null; return text({ discarded: true }); });

  return server;
}

async function main() {
  const server = createHeadlessMcp();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
if (import.meta.url === `file://${process.argv[1]}`) { main().catch((e) => { console.error(e); process.exit(1); }); }
