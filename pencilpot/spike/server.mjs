import http from "node:http";
import { proxyHttp, attachWsStub, readBody } from "./proxy.mjs";
import { record } from "./recorder.mjs";
import { handleApi } from "./api.mjs";

const MODE = process.env.PENCILPOT_MODE ?? "proxy";
const PORT = Number(process.env.PENCILPOT_PORT ?? 7777);

const server = http.createServer(async (req, res) => {
  const isApi = req.url.startsWith("/api/");
  try {
    if (isApi && MODE === "proxy") {
      const body = ["GET", "HEAD"].includes(req.method) ? undefined : await readBody(req);
      await record(req, res, body);
      return;
    }
    if (isApi) {
      return await handleApi(req, res, MODE);
    }
    return await proxyHttp(req, res);
  } catch (err) {
    console.error("server error", req.method, req.url, err);
    res.writeHead(500); res.end(String(err));
  }
});

attachWsStub(server);
server.listen(PORT, () => console.log(`pencilpot spike [${MODE}] on http://localhost:${PORT}`));
