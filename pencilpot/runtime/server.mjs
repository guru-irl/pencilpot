import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { attachWsStub } from "./proxy.mjs";
import { handleRpc } from "./rpc.mjs";
import { serveStatic } from "./static.mjs";
import { resolveProject } from "../store/project.mjs";

const PORT = Number(process.env.PENCILPOT_PORT ?? 7777);

// Resolve the design directory from env vars.
// PENCILPOT_PROJECT may be a .pencil path OR a project dir.
// PENCILPOT_DESIGN may be a design name (new) or an absolute design dir path (legacy).
function resolveDesignDir() {
  const projectEnv = process.env.PENCILPOT_PROJECT ?? null;
  const designEnv  = process.env.PENCILPOT_DESIGN  ?? null;

  // Legacy mode: PENCILPOT_DESIGN is an absolute path to a design dir (no project).
  // Detect: if it looks like an absolute path pointing to an existing dir, use it directly.
  if (designEnv && path.isAbsolute(designEnv) && fs.existsSync(designEnv)) {
    return { designDir: designEnv, projectRoot: null };
  }

  // New mode: resolve via project.
  if (projectEnv) {
    let proj;
    try {
      proj = resolveProject(projectEnv);
    } catch (e) {
      throw new Error(`Cannot resolve project from PENCILPOT_PROJECT=${projectEnv}: ${e.message}`);
    }
    // Pick design: by name from PENCILPOT_DESIGN, else project default.
    const designName = designEnv ?? proj.default;
    if (!designName) throw new Error("No design name — set PENCILPOT_DESIGN or add a design with addDesign()");
    const entry = proj.designs.find((d) => d.name === designName);
    if (!entry) throw new Error(`Design "${designName}" not found in project ${proj.root}`);
    return { designDir: entry.dir, projectRoot: proj.root };
  }

  // No project/design configured — serve without a file (stubs only).
  return { designDir: null, projectRoot: null };
}

const { designDir, projectRoot } = resolveDesignDir();

export const CONFIG = {
  project: projectRoot ?? process.env.PENCILPOT_PROJECT ?? null,
  design: designDir,
};

// Derive fileId from the design manifest or env override.
function readFileId(dir) {
  if (process.env.PENCILPOT_FILE_ID) return process.env.PENCILPOT_FILE_ID;
  if (!dir) return null;
  try {
    const manifest = fs.readFileSync(path.join(dir, "manifest.edn"), "utf8");
    const m = manifest.match(/:id\s+#uuid\s+"([^"]+)"/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

// Synthetic team-id used by the workspace URL and boot stubs.
const TEAM_ID = "0398e5fc-95c9-80d6-8008-29071f0fdaed";

const fileId = readFileId(designDir);

const server = http.createServer(async (req, res) => {
  try {
    if (req.url.startsWith("/api/")) return await handleRpc(req, res, CONFIG);
    return serveStatic(req, res, { fileId, teamId: TEAM_ID });
  } catch (err) {
    console.error("server error", req.method, req.url, err);
    res.writeHead(500); res.end(String(err));
  }
});
attachWsStub(server);
server.listen(PORT, () => console.log(`pencilpot runtime on http://localhost:${PORT}  project=${CONFIG.project} design=${CONFIG.design} fileId=${fileId}`));
