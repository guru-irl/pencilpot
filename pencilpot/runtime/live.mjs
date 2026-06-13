// pencilpot live-update: fs-watch the open design dir and push SSE "reload"
// events to all connected browser clients when external changes are detected.
//
// Self-write suppression: the SPA's own update-file writes must NOT trigger a
// reload loop.  Call noteSelfWrite() immediately before any write that
// originates from the SPA (rpc.mjs update-file handler) — changes detected
// within SELF_WRITE_WINDOW_MS of that call are silently ignored.

import fs from "node:fs";
import path from "node:path";

// ── Tunables ──────────────────────────────────────────────────────────────────

/** Debounce interval (ms): coalesce rapid file writes before emitting. */
const DEBOUNCE_MS = 250;

/** Settle period (ms): once a self-write starts, suppression stays active and is
 *  EXTENDED by every fs event it causes; it clears only after this many ms of quiet.
 *  This covers writes of ANY duration (a large design rewrites many page files over
 *  several seconds), so the SPA's own save never reloads.  A genuine external edit
 *  (after the self-write has settled) still reloads. */
const SELF_WRITE_SETTLE_MS = 1500;

/** SSE keepalive comment interval (ms).  Keeps the connection alive through
 *  proxies and prevents the browser from timing out. */
const KEEPALIVE_MS = 20_000;

// ── Shared self-write state (module-level singleton) ────────────────────────
// noteSelfWrite() starts a self-write; the watcher's isSelfWriteSuppressed()
// reads (and extends) it so a multi-file write of any duration stays suppressed.
let _selfWriting = false;
let _settleTimer = null;

function _armSettle() {
  if (_settleTimer) clearTimeout(_settleTimer);
  _settleTimer = setTimeout(() => { _selfWriting = false; _settleTimer = null; }, SELF_WRITE_SETTLE_MS);
}

/**
 * Note that a write is being performed by the SPA (via update-file).
 * Suppression stays active (and is extended by each resulting fs event) until
 * the file activity goes quiet for SELF_WRITE_SETTLE_MS.
 */
export function noteSelfWrite() {
  _selfWriting = true;
  _armSettle();
}

/**
 * True while a self-write is in progress.  When true, EXTENDS the settle window
 * (each suppressed fs event pushes the clear-timer back), so even a slow,
 * many-file write never leaks a reload event.
 */
function isSelfWriteSuppressed() {
  if (_selfWriting) { _armSettle(); return true; }
  return false;
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
    if (isSelfWriteSuppressed()) {
      // SPA's own write — do not relay.
      return;
    }
    // Debounce: collapse rapid multi-file writes (manifest + several pages)
    // into a single reload event.
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      if (closed) return;
      if (isSelfWriteSuppressed()) return; // re-check after debounce delay
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
