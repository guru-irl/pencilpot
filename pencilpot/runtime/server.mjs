import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { attachWsStub } from "./proxy.mjs";
import { handleRpc } from "./rpc.mjs";
import { serveStatic } from "./static.mjs";

const PORT = Number(process.env.PENCILPOT_PORT ?? 7777);
export const CONFIG = {
  project: process.env.PENCILPOT_PROJECT ?? null,
  design: process.env.PENCILPOT_DESIGN ?? null,
};

// Derive fileId from the design manifest or env override.
function readFileId(designDir) {
  if (process.env.PENCILPOT_FILE_ID) return process.env.PENCILPOT_FILE_ID;
  if (!designDir) return null;
  try {
    const manifest = fs.readFileSync(path.join(designDir, "manifest.edn"), "utf8");
    const m = manifest.match(/:id\s+#uuid\s+"([^"]+)"/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

// Synthetic team-id used by the workspace URL and boot stubs.
const TEAM_ID = "0398e5fc-95c9-80d6-8008-29071f0fdaed";

const fileId = readFileId(CONFIG.design);

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
