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
    { instructions: "Headless Penpot editing. checkout(fileId) a file, then script(code) to edit it, then commit(). The `wc` global can both BUILD (addBoard/addRect/addEllipse/addText/closeBoard/setFlexLayout/setGridLayout/setConstraints/createComponent/instantiateComponent/addInteraction/addToken) and EDIT EXISTING shapes (updateShape/deleteShape/reparentShape/reorderShape/moveShape/resizeShape/rotateShape/applyToken/swapComponent/detachInstance/groupShapes/ungroupShape). No browser needed." }
  );
  let wc = null;
  const need = () => { if (!wc) throw new Error("No file checked out. Call checkout(fileId) first."); return wc; };

  server.registerTool("checkout",
    { description: "Load a Penpot file into a headless working copy by id.", inputSchema: { fileId: z.string().describe("Penpot file UUID") } },
    async ({ fileId }) => { wc = await new WorkingCopy(fileId, tok).checkout();
      const objs = JSON.parse(wc.session.objects());
      return text({ checkedOut: fileId, revn: wc.revn, objects: Object.keys(objs).length }); });

  server.registerTool("script",
    { description: "Run JS against the working copy. `wc` BUILDS (addBoard/addRect/addEllipse/addText/closeBoard/setFlexLayout/setGridLayout/setConstraints/setGrowType/createComponent/instantiateComponent/addInteraction/addToken/addColorToken) and EDITS existing shapes: updateShape(id,attrs) updateShapes(ids,attrs) deleteShape(id) reparentShape(id,parentId,{index?}) reorderShape(id,index) moveShape(id,{x?,y?,dx?,dy?}) resizeShape(id,{width?,height?}) rotateShape(id,{angle,cx?,cy?}) applyToken(id,{token,attributes}) unapplyToken(id,attributes) swapComponent(instanceId,newComponentId) detachInstance(id) groupShapes(ids,{name?}) ungroupShape(id). addToken({set?,name,type?=color,value}) supports all token types; addInteraction({shapeId,destination,eventType?,actionType?}) wires a prototype link. Also validate()/pendingChanges(). Do many edits in one call; return a value. No network until commit.",
      inputSchema: { code: z.string().min(1) } },
    async ({ code }) => { const w = need(); const r = await runScript(code, { wc: w });
      return text(r.ok ? { result: r.result, log: r.log, pending: w.pendingChanges().length } : { error: r.error, log: r.log }); });

  server.registerTool("scene",
    { description: "Return the working copy's object map (id -> shape).", inputSchema: {} },
    async () => text(JSON.parse(need().session.objects())));

  server.registerTool("map_fonts_variable",
    { description: "Map text families onto a variable font WITH per-family axis settings (wdth/opsz/GRAD/ROND/slnt) and strip stale position-data so the new widths re-layout. mapping: {\"Family Name\": {fontId, family, axes:{wdth:62.5, opsz:120}}}. Whole-file :data transform — does NOT round-trip through commit(); persist with the `pencilpot map-variable` CLI for local designs.",
      inputSchema: { mapping: z.record(z.object({ fontId: z.string(), family: z.string().optional(), axes: z.record(z.number()).optional() })) } },
    async ({ mapping }) => { const w = need(); w.mapFontsToVariable(mapping);
      return text({ mappedFamilies: Object.keys(mapping), validation: w.validate(), note: "applied to working copy :data; persist via `pencilpot map-variable` CLI" }); });

  server.registerTool("validate",
    { description: "Validate the working copy with Penpot's own validator. Returns the full error array (empty = valid). NOTE: an IMPORTED design may carry PRE-EXISTING issues that render fine but trip the strict whole-file schema; commit() only blocks on errors YOUR edits INTRODUCE (see the commit tool's `introduced` vs `preExisting`).", inputSchema: {} },
    async () => text(need().validate()));

  server.registerTool("status",
    { description: "Pending (uncommitted) change count, current revn, and the count of pre-existing (baseline) validation issues that will NOT block commit.", inputSchema: {} },
    async () => { const w = need(); return text({ pending: w.pendingChanges().length, revn: w.revn, preExistingValidationIssues: (w.baselineErrs ?? []).length }); });

  server.registerTool("commit",
    { description: "Persist accumulated edits via update-file. Blocks ONLY if your edits INTRODUCE new validation errors; pre-existing issues from an imported design do not block.", inputSchema: {} },
    async () => { const w = need();
      const introduced = w.newValidationErrors();
      const preExisting = (w.baselineErrs ?? []).length;
      if (introduced.length) return text({ error: "edits introduce invalidity; not committed", introduced, preExisting });
      const res = await w.commit(); return text({ committed: true, revn: res.revn + 1, preExisting }); });

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
