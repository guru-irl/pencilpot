// Proxy an /api/* call to upstream and append the full exchange to recordings/.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "recordings");
fs.mkdirSync(DIR, { recursive: true });
const UPSTREAM = process.env.PENCILPOT_UPSTREAM ?? "http://localhost:9101";
let seq = 0;

const cmd = (url) => url.split("?")[0].split("/").filter(Boolean).pop(); // last path segment

// Headers that must be forwarded verbatim from upstream to the browser.
const FORWARD_HEADERS = ["set-cookie", "content-type", "location", "cache-control", "vary"];

export async function record(req, res, body) {
  const url = UPSTREAM + req.url;
  const headers = { ...req.headers, host: new URL(UPSTREAM).host };
  const upstream = await fetch(url, { method: req.method, headers, body, redirect: "manual" });
  const buf = Buffer.from(await upstream.arrayBuffer());
  const ct = upstream.headers.get("content-type") || "";

  const name = cmd(req.url);
  const n = String(seq++).padStart(3, "0");
  const meta = {
    seq: n, method: req.method, url: req.url, command: name,
    status: upstream.status, contentType: ct,
    reqBody: body ? body.toString("utf8").slice(0, 20000) : null,
  };
  fs.writeFileSync(path.join(DIR, `${n}-${name}.json`), JSON.stringify(meta, null, 2));
  fs.writeFileSync(path.join(DIR, `${n}-${name}.body`), buf);

  // Forward important response headers (especially Set-Cookie for auth).
  const outHeaders = {};
  for (const h of FORWARD_HEADERS) {
    const v = upstream.headers.get(h);
    if (v) outHeaders[h] = v;
  }
  res.writeHead(upstream.status, outHeaders);
  res.end(buf);
}
