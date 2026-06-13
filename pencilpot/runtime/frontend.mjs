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
  // IDLE-GATED reload: never reload while the user is actively interacting.
  // A reload only happens once the user has been idle for IDLE_MS — so an
  // external edit (AI/CLI) refreshes the view soon after you pause, but can
  // NEVER interrupt an in-progress edit (font change, drag, typing, etc.).
  var IDLE_MS = 2500;
  var lastActivity = Date.now();
  var pending = false;
  ["pointerdown","keydown","input","wheel"].forEach(function(ev){
    window.addEventListener(ev, function(){ lastActivity = Date.now(); }, true);
  });
  function tick() {
    if (!pending || window.__pencilpotReloading) return;
    if (Date.now() - lastActivity >= IDLE_MS) {
      window.__pencilpotReloading = true;
      console.log("[pencilpot live] external edit — refreshing (idle)");
      location.reload();
    } else {
      setTimeout(tick, 800);   // still interacting — check again shortly
    }
  }
  var es = new EventSource("/pencilpot/live");
  es.addEventListener("reload", function(e) {
    console.log("[pencilpot live] external edit detected (rev=" + e.data + ") — will refresh when idle");
    if (!pending) { pending = true; tick(); }
  });
  es.onerror = function() {
    // Reconnection is automatic via the browser's EventSource retry logic.
  };
})();`;
}
