// Reverse-proxy helpers for penpot-hl's frontend: read request bodies and stub
// the upstream websocket so the SPA boots without a collab backend.
import { WebSocketServer } from "ws";

const UPSTREAM = process.env.PENCILPOT_UPSTREAM ?? "http://localhost:9101";

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
