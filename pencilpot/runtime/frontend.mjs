import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

export function distDir() {
  return process.env.PENCILPOT_FRONTEND || path.resolve(HERE, "../../frontend/resources/public");
}

// Runtime-injected config.js body (replaces the env-templated one in stock Penpot).
export function configJs({ publicUri = "", fileId = null, teamId = null } = {}) {
  return `globalThis.penpotPublicURI=${publicUri ? JSON.stringify(publicUri) : "location.origin"};`
    + `globalThis.penpotFlags="";`
    + `globalThis.pencilpotFile=${JSON.stringify({ fileId, teamId })};`
    + liveUpdateScript();
}

/**
 * Tiny inline script that opens an EventSource to /pencilpot/live and
 * reloads the page when an external edit is detected.
 *
 * Guards:
 * - Only one reload is triggered per event (reload storms prevented server-side
 *   by the 250 ms debounce and self-write suppression).
 * - The EventSource is only started once (idempotent via window flag).
 */
function liveUpdateScript() {
  return `
;(function pencilpotLive() {
  if (window.__pencilpotLiveStarted) return;
  window.__pencilpotLiveStarted = true;
  var es = new EventSource("/pencilpot/live");
  es.addEventListener("reload", function(e) {
    // Guard: ignore stale events that arrive during a reload already in progress.
    if (window.__pencilpotReloading) return;
    window.__pencilpotReloading = true;
    console.log("[pencilpot live] external edit detected (rev=" + e.data + ") — reloading");
    location.reload();
  });
  es.onerror = function() {
    // Reconnection is automatic via the browser's EventSource retry logic.
  };
})();`;
}
