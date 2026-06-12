import http from "node:http";
import { proxyHttp, attachWsStub } from "./proxy.mjs";
import { handleRpc } from "./rpc.mjs";

const PORT = Number(process.env.PENCILPOT_PORT ?? 7777);
export const CONFIG = {
  project: process.env.PENCILPOT_PROJECT ?? null,
  design: process.env.PENCILPOT_DESIGN ?? null,
};

const server = http.createServer(async (req, res) => {
  try {
    if (req.url.startsWith("/api/")) return await handleRpc(req, res, CONFIG);
    return await proxyHttp(req, res);
  } catch (err) {
    console.error("server error", req.method, req.url, err);
    res.writeHead(500); res.end(String(err));
  }
});
attachWsStub(server);
server.listen(PORT, () => console.log(`pencilpot runtime on http://localhost:${PORT}  project=${CONFIG.project} design=${CONFIG.design}`));
