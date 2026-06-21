import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { attachWsStub } from "./proxy.mjs";
import { handleRpc } from "./rpc.mjs";
import { serveStatic } from "./static.mjs";
import { resolveMediaAsset } from "./media.mjs";
import { resolveProject } from "../store/project.mjs";
import { readFonts } from "../store/fonts.mjs";
import { handleGfontsCSS, handleGfontsFont } from "./gfonts.mjs";
import { startLiveWatcher, handleLiveSse, noteSelfWrite, broadcastStatus } from "./live.mjs";
import { initWorktree, save as saveWorktree, discard as discardWorktree, status as worktreeStatus } from "./worktree.mjs";
import { attachTerminal } from "./terminal.mjs";

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

// Bind the in-memory working copy to the open design.  Manual-save model:
// update-file stages edits in memory; disk is written only on /pencilpot/save.
initWorktree(designDir);

export const CONFIG = {
  project: projectRoot ?? process.env.PENCILPOT_PROJECT ?? null,
  design: designDir,
};

// Start the live-update watcher for the open design directory.
const liveWatcher = startLiveWatcher(designDir);

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

// Map font variant id → absolute path of the font file in the project.
function resolveFontAsset(fileId) {
  if (!CONFIG.project) return null;
  // CONFIG.project may be a .pencil path or a project root dir.
  const projectRoot = CONFIG.project.endsWith(".pencil")
    ? path.dirname(CONFIG.project)
    : CONFIG.project;
  const variants = readFonts(projectRoot);
  const v = variants.find((v) => v.id === fileId);
  if (!v) return null;
  return { filePath: path.join(projectRoot, "fonts", v.file), format: v.format };
}

// Content-type by font format.
const FONT_CONTENT_TYPES = {
  woff2: "font/woff2",
  woff1: "font/woff",
  ttf:   "font/ttf",
  otf:   "font/otf",
};

const server = http.createServer(async (req, res) => {
  try {
    // Font asset route: GET /assets/by-id/<file-id>
    // Must be checked BEFORE serveStatic (which would return 404 for this path).
    if (req.method === "GET" && req.url.startsWith("/assets/by-id/")) {
      const fileId = decodeURIComponent(req.url.split("?")[0].replace("/assets/by-id/", ""));
      const asset = resolveFontAsset(fileId);
      if (asset && fs.existsSync(asset.filePath)) {
        const ct = FONT_CONTENT_TYPES[asset.format] ?? "application/octet-stream";
        res.writeHead(200, {
          "content-type": ct,
          "cache-control": "public, max-age=31536000, immutable",
        });
        fs.createReadStream(asset.filePath).pipe(res);
        return;
      }
      // Unknown file-id — fall through to 404
      res.writeHead(404);
      res.end("font not found");
      return;
    }

    // Image media route: GET /assets/by-file-media-id/<id> (+ /<id>/thumbnail)
    // The canvas requests image fills here (frontend resolve-file-media).  Media is
    // stored under <design>/media/<file-media-id>.<ext> (Option A).  Checked BEFORE
    // serveStatic so an unknown id 404s instead of falling through to the SPA index.
    if (req.method === "GET" && req.url.startsWith("/assets/by-file-media-id/")) {
      let rest = decodeURIComponent(req.url.split("?")[0].replace("/assets/by-file-media-id/", ""));
      let thumbnail = false;
      if (rest.endsWith("/thumbnail")) {
        thumbnail = true;
        rest = rest.slice(0, -"/thumbnail".length);
      }
      const asset = resolveMediaAsset(CONFIG.design, rest, { thumbnail });
      if (asset && fs.existsSync(asset.filePath)) {
        res.writeHead(200, {
          "content-type": asset.contentType,
          "cache-control": "public, max-age=31536000, immutable",
        });
        fs.createReadStream(asset.filePath).pipe(res);
        return;
      }
      res.writeHead(404);
      res.end("media not found");
      return;
    }

    // Google Fonts proxy routes — must be before static fallback.
    if (req.method === "GET" && req.url.startsWith("/internal/gfonts/css")) {
      return await handleGfontsCSS(req, res);
    }
    if (req.method === "GET" && req.url.startsWith("/internal/gfonts/font/")) {
      return await handleGfontsFont(req, res);
    }

    // Live-update SSE endpoint — must be before serveStatic.
    if (req.method === "GET" && req.url === "/pencilpot/live") {
      return handleLiveSse(req, res, liveWatcher);
    }

    // Authoritative dirty/revn status — lets a client reconcile after a save
    // (closes the window where a concurrent update-file's dirty echo was
    // suppressed while the client's own save was in flight).
    if (req.method === "GET" && req.url === "/pencilpot/status") {
      const s = worktreeStatus();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ dirty: s.dirty, revn: s.revn }));
      return;
    }

    // Manual save: flush the in-memory working copy to disk (Ctrl/Cmd+S).
    if (req.method === "POST" && req.url === "/pencilpot/save") {
      const r = saveWorktree();
      noteSelfWrite();                 // disk now == working copy → no false "external change"
      broadcastStatus(false, r.revn);  // clear the dirty indicator in all windows
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(r));
      return;
    }
    // Discard unsaved edits: revert the working copy to the on-disk version.
    if (req.method === "POST" && req.url === "/pencilpot/discard") {
      const r = discardWorktree();
      broadcastStatus(false, r.revn);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ...r, reload: true }));
      return;
    }
    // Current unsaved/saved status (initial sync / polling fallback).
    if (req.method === "GET" && req.url === "/pencilpot/status") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(worktreeStatus()));
      return;
    }

    if (req.url.startsWith("/api/")) return await handleRpc(req, res, CONFIG);
    return serveStatic(req, res, { fileId, teamId: TEAM_ID });
  } catch (err) {
    console.error("server error", req.method, req.url, err);
    res.writeHead(500); res.end(String(err));
  }
});
attachWsStub(server);
// Integrated terminal: PTY bridged over WS at /pencilpot/terminal, CWD = project dir.
attachTerminal(server, CONFIG);
server.listen(PORT, () => console.log(`pencilpot runtime on http://localhost:${PORT}  project=${CONFIG.project} design=${CONFIG.design} fileId=${fileId}`));
