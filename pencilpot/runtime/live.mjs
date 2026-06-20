// pencilpot live-update: fs-watch the open design dir and push SSE "reload"
// events to all connected browser clients when external changes are detected.
//
// Self-write suppression is CONTENT-BASED, not timing-based.  The runtime keeps
// a signature (content hash of every .edn file) of the design as it last wrote /
// observed it.  A reload is broadcast only when the on-disk content actually
// DIFFERS from that signature — so the SPA's own multi-file update-file write can
// never trigger a reload, regardless of how the OS batches/delays inotify events.
// (The previous timing-window approach broke on large designs: Linux recursive
// fs.watch delivers events in bursts that can outlast any fixed settle window,
// leaking a false "external edit" and re-loading the page in a loop.)

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { status as worktreeStatus } from "./worktree.mjs";

// ── Tunables ──────────────────────────────────────────────────────────────────

/** Debounce interval (ms): coalesce rapid file writes before emitting. */
const DEBOUNCE_MS = 250;

/** SSE keepalive comment interval (ms).  Keeps the connection alive through
 *  proxies and prevents the browser from timing out. */
const KEEPALIVE_MS = 20_000;

// ── Content-signature self-write suppression (module-level singleton) ─────────
// _baselineSig is the content hash the runtime "knows about": set at watcher
// start, refreshed by noteSelfWrite() after every SPA write, and advanced when a
// genuine external change is broadcast.  The watcher reloads iff current != baseline.
let _watchedDir = null;
let _baselineSig = null;

/**
 * Content hash of every .edn file under `dir` (path + bytes, sorted for
 * determinism).  Cheap enough to recompute on each debounced change event.
 */
function computeSig(dir) {
  if (!dir) return null;
  const files = [];
  (function walk(d) {
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".edn")) files.push(p);
    }
  })(dir);
  files.sort();
  const h = crypto.createHash("sha1");
  for (const f of files) {
    h.update(f);
    try { h.update(fs.readFileSync(f)); } catch { /* vanished mid-read — skip */ }
  }
  return h.digest("hex");
}

/**
 * Adopt the current on-disk content as the runtime's baseline.  Call this from
 * the SPA write path (rpc.mjs persistChanges) immediately AFTER writeDesign, so
 * the fs events that write generates resolve to the same signature → no reload.
 */
export function noteSelfWrite() {
  if (_watchedDir) _baselineSig = computeSig(_watchedDir);
}

// ── Client set type ──────────────────────────────────────────────────────────
// Each entry: { write(data: string): void }
// The SSE handler adds/removes these.

/**
 * Create a live-update watcher for a design directory.
 *
 * @param {string|null} designDir  Absolute path to the open design dir.
 * @returns {{ clients: Set, close(): void }}
 */
export function createLiveWatcher(designDir) {
  const clients = new Set();

  // No-op watcher when no design directory is configured.
  if (!designDir) {
    return { clients, close() {} };
  }

  // Establish the content baseline for this design dir.
  _watchedDir = designDir;
  _baselineSig = computeSig(designDir);

  let debounceTimer = null;
  let watcher = null;
  let closed = false;

  /**
   * Emit a reload event to all connected SSE clients.
   * @param {number} rev  Monotonic revision counter included in the event data.
   */
  function broadcast(rev) {
    const payload = `event: reload\ndata: ${rev}\n\n`;
    for (const client of clients) {
      try {
        client.write(payload);
      } catch (e) {
        // Client gone — remove it.
        clients.delete(client);
      }
    }
  }

  let _rev = 0;

  function onFileChange() {
    if (closed) return;
    // Debounce: collapse rapid multi-file writes (manifest + several pages)
    // into a single signature check.
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      if (closed) return;
      // Content-based suppression: only react if the .edn content actually
      // differs from what the runtime last wrote/observed.  The SPA's own
      // writes leave the content == baseline (refreshed by noteSelfWrite),
      // so they never reload — no matter how the OS batches inotify events.
      const sig = computeSig(_watchedDir);
      if (sig === _baselineSig) return;   // our write / no-op change
      _baselineSig = sig;                 // adopt external state (don't re-fire)
      _rev++;
      broadcast(_rev);
    }, DEBOUNCE_MS);
  }

  // Watch the design dir recursively.
  try {
    watcher = fs.watch(designDir, { recursive: true }, (event, filename) => {
      if (!filename) return;
      // Only react to EDN files (manifest, pages/, components/).
      if (!filename.endsWith(".edn")) return;
      onFileChange();
    });
    watcher.on("error", (err) => {
      // Watcher errors (dir deleted, etc.) are non-fatal — log and stop.
      console.warn("[pencilpot live] watcher error:", err.message || err);
      if (!closed) close();
    });
  } catch (err) {
    // fs.watch may throw synchronously on unsupported platforms or bad paths.
    console.warn("[pencilpot live] could not start watcher:", err.message || err);
  }

  function close() {
    if (closed) return;
    closed = true;
    if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
    if (watcher) { try { watcher.close(); } catch { /* ignore */ } watcher = null; }
  }

  return { clients, close };
}

// ── Singleton watcher instance (used by server.mjs) ─────────────────────────
let _globalWatcher = null;

/**
 * Initialise (or return the existing) global watcher for the given design dir.
 * Call once from server.mjs after resolving the design dir.
 */
export function startLiveWatcher(designDir) {
  if (_globalWatcher) return _globalWatcher;
  _globalWatcher = createLiveWatcher(designDir);
  return _globalWatcher;
}

/**
 * Return the global watcher (or a no-op if not started yet).
 */
export function getLiveWatcher() {
  if (!_globalWatcher) return { clients: new Set(), close() {} };
  return _globalWatcher;
}

/**
 * Broadcast the design's unsaved/saved status to every connected SSE client.
 * The injected save-manager script (frontend.mjs) listens for these `status`
 * events to drive the dirty indicator, Ctrl/Cmd+S handling and the unload guard.
 */
export function broadcastStatus(dirty, revn) {
  const payload = `event: status\ndata: ${JSON.stringify({ dirty: !!dirty, revn: revn ?? 0 })}\n\n`;
  const { clients } = getLiveWatcher();
  for (const client of clients) {
    try { client.write(payload); } catch { clients.delete(client); }
  }
}

// ── HTTP handler for GET /pencilpot/live (SSE) ───────────────────────────────

/**
 * Handle a GET /pencilpot/live request as an SSE stream.
 * Registers the response as an SSE client and removes it on disconnect.
 *
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 * @param {{ clients: Set, close(): void }} watcher  The live watcher instance.
 */
export function handleLiveSse(req, res, watcher) {
  res.writeHead(200, {
    "content-type":  "text/event-stream",
    "cache-control": "no-cache, no-transform",
    "connection":    "keep-alive",
    "x-accel-buffering": "no",         // nginx: disable proxy buffering
  });

  // Send an initial comment to flush headers and confirm the stream is open.
  res.write(": pencilpot-live\n\n");

  // Send the current unsaved/saved status so a freshly-loaded SPA shows the
  // correct dirty indicator without waiting for the next edit.
  try {
    const st = worktreeStatus();
    res.write(`event: status\ndata: ${JSON.stringify({ dirty: !!st.dirty, revn: st.revn ?? 0 })}\n\n`);
  } catch { /* worktree not initialised yet — ignore */ }

  const client = {
    write(data) { res.write(data); },
  };
  watcher.clients.add(client);

  // Keepalive: send a SSE comment every KEEPALIVE_MS so proxies don't drop the conn.
  const keepaliveTimer = setInterval(() => {
    try { res.write(": ka\n\n"); } catch { cleanup(); }
  }, KEEPALIVE_MS);

  function cleanup() {
    clearInterval(keepaliveTimer);
    watcher.clients.delete(client);
    try { res.end(); } catch { /* already closed */ }
  }

  req.on("close",  cleanup);
  req.on("error",  cleanup);
  res.on("close",  cleanup);
  res.on("error",  cleanup);
}
