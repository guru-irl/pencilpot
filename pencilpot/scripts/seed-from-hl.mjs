// Seed a pencilpot EDN project from the real penpot-hl file.
// Run from pencilpot/: node scripts/seed-from-hl.mjs
import fs from "node:fs";
import path from "node:path";
import { getFile } from "../../headless-core/sdk/rpc.mjs";
import { createSession } from "../../headless-core/target/headless/penpot.js";
import { initProject, addDesign } from "../store/project.mjs";
import { writeDesign } from "../store/store.mjs";

const env = JSON.parse(fs.readFileSync(new URL("../../infra/penpot-hl/test-env.json", import.meta.url)));
const root = path.join(process.cwd(), ".scratch", "proj");

fs.rmSync(root, { recursive: true, force: true });
initProject(root, "demo");
const designDir = addDesign(root, "home");

console.log("fetching file", env.fileId, "from penpot-hl...");
const f = await getFile(env.fileId, env.token);   // { dataTransit, raw:{...meta} }
console.log("fetched: revn=%d vern=%d features=%d pages=%d",
  f.revn, f.vern, (f.features || []).length,
  (f.raw?.data?.pages || []).length || "?");

const s = createSession(JSON.stringify({ fromTransit: f.dataTransit, meta: f.raw }));
const parts = JSON.parse(s.serializeStore());

// Report fidelity metrics
const pageCount = Object.keys(parts.pages).length;
const componentCount = Object.keys(parts.components).length;
console.log("serialized: pages=%d components=%d", pageCount, componentCount);

if (pageCount === 0) {
  console.error("ERROR: serialized design has 0 pages — fidelity bug in EDN serializer");
  process.exit(1);
}

writeDesign(designDir, parts);

// Verify files written
const manifestSize = fs.statSync(path.join(designDir, "manifest.edn")).size;
console.log("seeded", designDir);
console.log("  manifest.edn:", manifestSize, "bytes");
console.log("  pages:", fs.readdirSync(path.join(designDir, "pages")).join(", "));
if (componentCount > 0)
  console.log("  components:", componentCount);
console.log("fileId", env.fileId);
