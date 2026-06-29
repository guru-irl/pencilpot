import { FID, SCRATCH, designPresent, copyDesign, spawnRuntime, loadWorkingCopy, kill } from "./_boot.mjs";
import fs from "node:fs";
import path from "node:path";

if (!designPresent()) { console.log("SKIP: canonical design absent"); process.exit(0); }
const OUT = path.join(SCRATCH, "shots");
fs.mkdirSync(OUT, { recursive: true });
let srv;
try {
  const dir = copyDesign("shot-all");
  const r = await spawnRuntime(dir);
  srv = r.proc;
  const WorkingCopy = await loadWorkingCopy(r.base);
  const wc = await new WorkingCopy(FID, "local").checkout();
  const objs = JSON.parse(wc.session.objects());
  const ROOT = "00000000-0000-0000-0000-000000000000";
  const boards = Object.values(objs).filter(o => o.type === "frame" && o["frame-id"] === ROOT);
  console.log(`boards: ${boards.length}`);
  for (const b of boards) {
    const safe = (b.name || b.id).replace(/[^\w.-]+/g, "_").slice(0, 40);
    const out = path.join(OUT, `${safe}-${b.id.slice(0, 8)}.png`);
    try { wc.renderShapePng(b.id, { scale: 1, out }); console.log(`OK ${b.name} -> ${path.basename(out)}`); }
    catch (e) { console.log(`ERR ${b.name}: ${e.message}`); }
  }
} finally { kill(srv); }
