import { replayFixture } from "./fixtures.mjs";
import { readBody } from "./proxy.mjs";
import { readFile } from "./store.mjs";

const cmd = (url) => url.split("?")[0].split("/").filter(Boolean).pop();

async function sessionFor(id) {
  const f = readFile(id);
  if (!f) return null;
  const { createSession } = await import("../../headless-core/target/headless/penpot.js");
  return createSession(JSON.stringify({ fromTransit: f.transit, meta: f.meta }));
}

export async function handleApi(req, res, mode) {
  const command = cmd(req.url);
  if (mode === "serve" && command === "get-file") {
    const id = (req.url.split("id=")[1] || "").split("&")[0] || process.env.PENCILPOT_FILE_ID;
    const s = await sessionFor(id);
    if (!s) return replayFixture("get-file", res);
    const { meta, transit } = JSON.parse(s.getFileResponse());
    const accept = req.headers["accept"] || "";
    if (accept.includes("transit")) {
      res.writeHead(200, { "content-type": "application/transit+json", "x-pencilpot-source": "disk" });
      res.end(transit);
    } else {
      res.writeHead(200, { "content-type": "application/json", "x-pencilpot-source": "disk" });
      res.end(JSON.stringify(meta));
    }
    return true;
  }
  if (!["GET", "HEAD"].includes(req.method)) await readBody(req);
  return replayFixture(command, res);
}
