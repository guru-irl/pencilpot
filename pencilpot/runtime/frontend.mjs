import path from "node:path";
import fs from "node:fs";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");

export function distDir() {
  return process.env.PENCILPOT_FRONTEND || path.resolve(HERE, "../../frontend/resources/public");
}

/**
 * Build identity stamp: the git commit the runtime is on + the mtime of the
 * served workspace bundle. Printed to the browser console so it's unambiguous
 * which build a window is actually running (stale-bundle diagnosis).
 */
function buildStamp() {
  let commit = "unknown";
  try { commit = execSync("git rev-parse --short HEAD", { cwd: REPO }).toString().trim(); } catch { /* not a git repo */ }
  let bundle = "?";
  try {
    const st = fs.statSync(path.join(distDir(), "js", "main-workspace.js"));
    bundle = new Date(st.mtimeMs).toISOString().replace("T", " ").slice(0, 19);
  } catch { /* not built */ }
  return { commit, bundle, dist: distDir() };
}

// Runtime-injected config.js body (replaces the env-templated one in stock Penpot).
export function configJs({ publicUri = "", fileId = null, teamId = null } = {}) {
  const stamp = buildStamp();
  return `globalThis.penpotPublicURI=${publicUri ? JSON.stringify(publicUri) : "location.origin"};`
    // `disable-render-wasm-info` strips the upstream dev default that paints a
    // "WebGL rendering" debug label on the wasm canvas every frame. penpotFlags=""
    // would otherwise inherit common/flags `default` (a dev flag set), leaving the
    // debug overlay visible in a shipped pencilpot session.
    + `globalThis.penpotFlags="disable-render-wasm-info";`
    + `globalThis.pencilpotFile=${JSON.stringify({ fileId, teamId })};`
    + `globalThis.pencilpotBuild=${JSON.stringify(stamp)};`
    + `console.log("%c pencilpot %c build ${stamp.commit} · bundle ${stamp.bundle} ","background:#7b61ff;color:#fff;border-radius:3px","color:#7b61ff");`
    + liveUpdateScript();
}

/**
 * Tiny inline script that opens an EventSource to /pencilpot/live and shows a
 * NON-DESTRUCTIVE "external changes" banner when an external edit is detected.
 *
 * Design: pencilpot NEVER auto-reloads the page.  A full reload re-boots the SPA
 * and throws away in-progress UI state (selection, in-flight font/colour edits,
 * undo history), so it must be user-initiated.  Instead we surface a small
 * click-to-refresh banner; the user pulls in external changes when they're ready.
 *
 * The server only emits a reload event when the .edn content actually differs
 * from what the runtime last wrote (content-signature suppression in live.mjs),
 * so the SPA's own saves never raise the banner — only genuine CLI/MCP edits do.
 *
 * Guards:
 * - The EventSource is started once (idempotent via window flag).
 * - Only one banner is shown at a time (idempotent via element id).
 */
function liveUpdateScript() {
  return `
;(function pencilpotLive() {
  if (window.__pencilpotLiveStarted) return;
  window.__pencilpotLiveStarted = true;
  function showBanner(rev) {
    if (!document.body) { setTimeout(function(){ showBanner(rev); }, 500); return; }
    if (document.getElementById("pencilpot-live-banner")) return;
    var d = document.createElement("div");
    d.id = "pencilpot-live-banner";
    d.style.cssText = "position:fixed;right:16px;bottom:16px;z-index:2147483647;background:#1f1f24;color:#fff;font:13px/1.4 system-ui,-apple-system,sans-serif;padding:10px 12px;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.4);display:flex;gap:10px;align-items:center;border:1px solid #3a3a42";
    var span = document.createElement("span");
    span.textContent = "External changes on disk";
    var btn = document.createElement("button");
    btn.textContent = "Refresh";
    btn.style.cssText = "background:#7b61ff;color:#fff;border:0;border-radius:6px;padding:5px 11px;cursor:pointer;font:inherit;font-weight:600";
    btn.onclick = function(){ window.__pencilpotReloading = true; location.reload(); };
    var x = document.createElement("button");
    x.textContent = "✕";
    x.title = "Dismiss";
    x.style.cssText = "background:transparent;color:#aaa;border:0;cursor:pointer;font:inherit;padding:2px 4px";
    x.onclick = function(){ d.remove(); };
    d.appendChild(span); d.appendChild(btn); d.appendChild(x);
    document.body.appendChild(d);
  }
  var es = new EventSource("/pencilpot/live");
  es.addEventListener("reload", function(e) {
    console.log("[pencilpot live] external edit detected (rev=" + e.data + ")");
    showBanner(e.data);
  });
  es.onerror = function() {
    // Reconnection is automatic via the browser's EventSource retry logic.
  };
})();`;
}
