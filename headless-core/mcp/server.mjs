import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { WorkingCopy } from "../sdk/index.mjs";
import { diffObjects, formatDiff } from "../../pencilpot/store/diff.mjs";
import { runScript } from "../sdk/script.mjs";

const text = (v) => ({ content: [{ type: "text", text: typeof v === "string" ? v : JSON.stringify(v, null, 2) }] });

export function createHeadlessMcp({ token, base } = {}) {
  if (base) process.env.PENPOT_HL_BASE = base;
  const tok = token ?? process.env.PENPOT_TOKEN;
  const server = new McpServer(
    { name: "penpot-headless", version: "0.1.0" },
    { instructions: "Headless Penpot editing. checkout(fileId) a file, then script(code) to edit it, then commit(). The `wc` global can both BUILD (addBoard/addRect/addEllipse/addText/closeBoard/setFlexLayout/setGridLayout/setConstraints/createComponent/instantiateComponent/addInteraction/addToken) and EDIT EXISTING shapes (updateShape/deleteShape/reparentShape/reorderShape/moveShape/resizeShape/rotateShape/applyToken/swapComponent/detachInstance/groupShapes/ungroupShape/makeVariant/addVariant). No browser needed." }
  );
  let wc = null;
  const need = () => { if (!wc) throw new Error("No file checked out. Call checkout(fileId) first."); return wc; };
  let diffBaseline = null;

  server.registerTool("checkout",
    { description: "Load a Penpot file into a headless working copy by id.", inputSchema: { fileId: z.string().describe("Penpot file UUID") } },
    async ({ fileId }) => { wc = await new WorkingCopy(fileId, tok).checkout();
      const objs = JSON.parse(wc.session.objects());
      return text({ checkedOut: fileId, revn: wc.revn, objects: Object.keys(objs).length }); });

  server.registerTool("script",
    { description: "Run JS against the working copy. `wc` BUILDS (addBoard/addRect/addEllipse/addText/closeBoard/setFlexLayout/setGridLayout/setConstraints/setGrowType/createComponent/instantiateComponent/addInteraction/addToken/addColorToken) and EDITS existing shapes: updateShape(id,attrs) updateShapes(ids,attrs) deleteShape(id) reparentShape(id,parentId,{index?}) reorderShape(id,index) moveShape(id,{x?,y?,dx?,dy?}) resizeShape(id,{width?,height?}) rotateShape(id,{angle,cx?,cy?}) applyToken(id,{token,attributes}) unapplyToken(id,attributes) swapComponent(instanceId,newComponentId) detachInstance(id) groupShapes(ids,{name?}) ungroupShape(id) makeVariant(instanceId,{name?}) addVariant(variantShapeId). addToken({set?,name,type?=color,value}) supports all token types; addInteraction({shapeId,destination,eventType?,actionType?}) wires a prototype link. Also validate()/pendingChanges(). Do many edits in one call; return a value. No network until commit.",
      inputSchema: { code: z.string().min(1) } },
    async ({ code }) => { const w = need(); const r = await runScript(code, { wc: w });
      return text(r.ok ? { result: r.result, log: r.log, pending: w.pendingChanges().length } : { error: r.error, log: r.log }); });

  server.registerTool("scene",
    { description: "Return the working copy's object map (id -> shape).", inputSchema: {} },
    async () => text(JSON.parse(need().session.objects())));

  server.registerTool("render_shape",
    { description: "Render ONE shape/board/component to an image. format 'svg' returns the SVG string (browser-free, Penpot's renderer via react-dom server; now carries text as foreignObject). format 'png' rasterizes: fidelity 'fast' (default) uses rsvg-convert (browser-free, but text-LESS — librsvg ignores foreignObject); fidelity 'high' uses the bundled Chromium so TEXT renders (pass fontsDir = the project's fonts/ store to embed custom families). scale multiplies pixels. Use it to SEE what a shape looks like.",
      inputSchema: { shapeId: z.string(), format: z.enum(["svg", "png"]).optional(), scale: z.number().optional(),
                     fidelity: z.enum(["fast", "high"]).optional(), fontsDir: z.string().optional() } },
    async ({ shapeId, format = "png", scale = 1, fidelity = "fast", fontsDir }) => { const w = need();
      if (format === "svg") return text({ shapeId, svg: w.session.renderShape(shapeId) });
      if (fidelity === "high") return text({ shapeId, png: await w.renderShapePngHiFi(shapeId, { scale: scale > 1 ? scale : 2, fontsDir }), fidelity, scale });
      return text({ shapeId, png: w.renderShapePng(shapeId, { scale }), fidelity, scale }); });

  server.registerTool("outline",
    { description: "A compact, navigable INDEX of the whole design file so you can locate 'where's what' WITHOUT reading any files: every page with its boards (id/name/geometry/child-count), text shapes (id/name/text-snippet/frameId), and component instances; plus the file's components with their path + variant info (variantId/variant props + where the main instance lives). START HERE to orient before editing — e.g. to find a component, its board context, sibling components, or existing variants/versions.", inputSchema: {} },
    async () => text(need().outline()));

  server.registerTool("viewport",
    { description: "What the USER is currently looking at / has selected in the open pencilpot editor: {pageId, pageName, selected:[ids], shapes:[{id,name,type}], ts}. Use this to act on the user's CURRENT selection (e.g. render or edit the selected shape) instead of guessing. `selected` is empty when nothing is selected; ts=0 means the SPA hasn't reported yet (no editor open).", inputSchema: {} },
    async () => text(await need().viewport()));

  server.registerTool("diff_baseline",
    { description: "Capture the current object map as a diff baseline (in memory). Call this BEFORE the user edits in the open SPA, then call `diff` afterwards to see exactly what they changed.", inputSchema: {} },
    async () => { diffBaseline = JSON.parse(need().session.objects());
      return text({ baseline: true, objects: Object.keys(diffBaseline).length }); });

  server.registerTool("diff",
    { description: "What changed since the last `diff_baseline` (the user's edits, typically): added / removed / modified shapes with the changed semantic keys. Returns a structured diff plus a human-readable summary. Errors if no baseline was captured yet.", inputSchema: {} },
    async () => { const cur = JSON.parse(need().session.objects());
      if (!diffBaseline) return text({ error: "no baseline — call diff_baseline first" });
      const d = diffObjects(diffBaseline, cur);
      return text({ ...d, text: formatDiff(d) }); });

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
