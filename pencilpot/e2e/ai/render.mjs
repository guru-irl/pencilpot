// AI-dev live proof — native, browser-free RENDER of a shape to PNG via the
// real runtime working copy. Builds a board+rect, renderShape -> SVG, then
// renderShapePng -> a real PNG the agent can read. No Playwright.
//
// SKIP (exit 0) if the canonical design is absent. Run: node pencilpot/e2e/ai/render.mjs
import { FID, SCRATCH, designPresent, copyDesign, spawnRuntime, loadWorkingCopy, kill, makeChecks } from "./_boot.mjs";
import fs from "node:fs";
import path from "node:path";

if (!designPresent()) { console.log("SKIP: canonical design absent — render live proof"); process.exit(0); }

const { check, passed } = makeChecks();
let srv, dir;
try {
  dir = copyDesign("ai-render");
  const r = await spawnRuntime(dir);
  srv = r.proc;
  const WorkingCopy = await loadWorkingCopy(r.base);
  const wc = await new WorkingCopy(FID, "local").checkout();

  const board = wc.addBoard({ x: 9000, y: 9000, width: 240, height: 160, name: "RENDER-AUDIT" });
  wc.addRect({ x: 30, y: 30, width: 120, height: 90, name: "rr", fills: [{ "fill-color": "#22aa55", "fill-opacity": 1 }] });
  wc.closeBoard();

  const svg = wc.renderShape(board);
  check(svg.startsWith("<svg") && (svg.match(/<rect/g) || []).length >= 2, "renderShape returns structured SVG (frame + children)");

  const png = path.join(SCRATCH, "ai-render.png");
  const out = wc.renderShapePng(board, { scale: 2, out: png });
  const buf = fs.readFileSync(out);
  check(buf[0] === 0x89 && buf[1] === 0x50, "renderShapePng wrote a real PNG (magic bytes)");
  check(buf.length > 200, `PNG non-trivial size (${buf.length}B)`);
  console.log(passed() ? "\nALL CHECKS PASS" : "\nSOME CHECKS FAILED");
} finally { kill(srv); }
process.exit(passed() ? 0 : 1);
