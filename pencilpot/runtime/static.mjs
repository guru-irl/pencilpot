import fs from "node:fs";
import path from "node:path";
import { distDir, configJs } from "./frontend.mjs";

const TYPES = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".mjs": "application/javascript",
  ".css": "text/css",
  ".wasm": "application/wasm",
  ".map": "application/json",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".gif": "image/gif",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".ico": "image/x-icon",
};

export function serveStatic(req, res, cfg = {}) {
  let urlPath = decodeURIComponent(req.url.split("?")[0]);

  // config.js is injected, not read from disk (match the path index.html requests)
  if (urlPath === "/js/config.js" || urlPath === "/config.js") {
    const body = configJs({ fileId: cfg.fileId, teamId: cfg.teamId });
    res.writeHead(200, { "content-type": "application/javascript", "cache-control": "no-store" });
    return res.end(body);
  }

  if (urlPath === "/" || urlPath === "") urlPath = "/index.html";

  const base = distDir();
  const file = path.join(base, urlPath);

  // prevent path traversal
  if (!file.startsWith(base)) {
    res.writeHead(403);
    return res.end("forbidden");
  }

  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404);
      return res.end("not found: " + urlPath);
    }
    const ext = path.extname(file).toLowerCase();
    const headers = { "content-type": TYPES[ext] || "application/octet-stream" };
    if (urlPath === "/index.html") headers["cache-control"] = "no-store";
    res.writeHead(200, headers);
    res.end(buf);
  });
}
