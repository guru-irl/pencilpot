// Reverse-proxy penpot-hl's frontend + (in proxy mode) its API.
// Rewrites config so the SPA's public-uri is OUR origin, and stubs the websocket.
import { WebSocketServer } from "ws";

const UPSTREAM = process.env.PENCILPOT_UPSTREAM ?? "http://localhost:9101";

// Forward an incoming Node req to UPSTREAM and pipe the response back.
export async function proxyHttp(req, res, { rewriteConfig = true } = {}) {
  const url = UPSTREAM + req.url;
  const headers = { ...req.headers, host: new URL(UPSTREAM).host };
  const body = ["GET", "HEAD"].includes(req.method) ? undefined : await readBody(req);
  const upstream = await fetch(url, { method: req.method, headers, body, redirect: "manual" });
  let buf = Buffer.from(await upstream.arrayBuffer());
  const ct = upstream.headers.get("content-type") || "";

  // Force the SPA to treat OUR origin as the backend: neutralize any baked public-uri.
  if (rewriteConfig && req.url.includes("/js/config.js")) {
    let js = buf.toString("utf8");
    js += `\n;globalThis.penpotPublicURI=location.origin;globalThis.penpotFlags="";\n`;
    buf = Buffer.from(js, "utf8");
  }
  // Forward important upstream response headers (Set-Cookie, etc.).
  const outHeaders = { "content-type": ct, "cache-control": "no-store" };
  const setCookie = upstream.headers.get("set-cookie");
  if (setCookie) outHeaders["set-cookie"] = setCookie;
  res.writeHead(upstream.status, outHeaders);
  res.end(buf);
}

export function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

// Accept /ws/notifications and do nothing (no presence/collab in local mode).
//
// Uses a `noServer` WS server with explicit path-routed upgrade handoff so it
// coexists with the other WS endpoints attached to the same HTTP server (e.g.
// the integrated terminal at /pencilpot/terminal).  A `{ server, path }` server
// would install an `upgrade` listener that rejects (HTTP 400) any upgrade whose
// path doesn't match — clobbering sibling endpoints.
export function attachWsStub(server) {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    let pathname;
    try {
      pathname = new URL(req.url, "http://localhost").pathname;
    } catch {
      return;
    }
    if (pathname !== "/ws/notifications") return; // not ours — ignore
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  wss.on("connection", (sock) => {
    sock.on("message", () => {});
    sock.on("error", () => {});
  });
}
