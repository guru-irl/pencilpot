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

  // ── external-changes banner (CLI/MCP edits on disk) ───────────────────────
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

  // ── manual-save UX (Ctrl/Cmd+S, dirty indicator, unload guard) ────────────
  // pencilpot does NOT auto-save to disk; update-file stages edits in the
  // runtime's in-memory working copy.  The user saves explicitly, like a text
  // file.  The runtime pushes 'status' SSE events ({dirty,revn}) that drive
  // this indicator; Ctrl/Cmd+S POSTs /pencilpot/save.
  var dirty = false, saving = false, baseTitle = null;
  function ensureBadge() {
    var b = document.getElementById("pencilpot-save-badge");
    if (b || !document.body) return b;
    b = document.createElement("div");
    b.id = "pencilpot-save-badge";
    b.style.cssText = "position:fixed;left:16px;bottom:16px;z-index:2147483647;font:12px/1.3 system-ui,-apple-system,sans-serif;padding:7px 11px;border-radius:7px;box-shadow:0 4px 16px rgba(0,0,0,.35);display:none;gap:9px;align-items:center;cursor:default;user-select:none;border:1px solid #3a3a42;background:#1f1f24;color:#fff";
    var dot = document.createElement("span");
    dot.id = "pencilpot-save-dot";
    dot.style.cssText = "width:8px;height:8px;border-radius:50%;background:#f5a623;display:inline-block;flex:none";
    var label = document.createElement("span");
    label.id = "pencilpot-save-label";
    label.textContent = "Unsaved changes";
    var btn = document.createElement("button");
    btn.id = "pencilpot-save-btn";
    btn.textContent = navigator.platform.indexOf("Mac") >= 0 ? "Save  ⌘S" : "Save  Ctrl+S";
    btn.style.cssText = "background:#7b61ff;color:#fff;border:0;border-radius:6px;padding:4px 10px;cursor:pointer;font:inherit;font-weight:600";
    btn.onclick = function(){ doSave(); };
    b.appendChild(dot); b.appendChild(label); b.appendChild(btn);
    document.body.appendChild(b);
    return b;
  }
  function render() {
    if (baseTitle === null) baseTitle = document.title || "pencilpot";
    var b = ensureBadge();
    if (!b) { setTimeout(render, 300); return; }
    var dot = document.getElementById("pencilpot-save-dot");
    var label = document.getElementById("pencilpot-save-label");
    var btn = document.getElementById("pencilpot-save-btn");
    if (saving) {
      b.style.display = "flex"; dot.style.background = "#7b61ff";
      label.textContent = "Saving…"; btn.style.display = "none";
      document.title = "… " + baseTitle;
    } else if (dirty) {
      b.style.display = "flex"; dot.style.background = "#f5a623";
      label.textContent = "Unsaved changes"; btn.style.display = "";
      document.title = "● " + baseTitle;
    } else {
      b.style.display = "none";
      document.title = baseTitle;
    }
  }
  function toast(msg) {
    if (!document.body) return;
    var t = document.createElement("div");
    t.textContent = msg;
    t.style.cssText = "position:fixed;left:16px;bottom:16px;z-index:2147483647;font:12px/1.3 system-ui,sans-serif;padding:7px 11px;border-radius:7px;background:#2c7a3f;color:#fff;box-shadow:0 4px 16px rgba(0,0,0,.35);transition:opacity .4s";
    document.body.appendChild(t);
    setTimeout(function(){ t.style.opacity = "0"; }, 900);
    setTimeout(function(){ t.remove(); }, 1400);
  }
  function doSave() {
    if (saving || !dirty) return;
    saving = true; render();
    fetch("/pencilpot/save", { method: "POST" })
      .then(function(r){ return r.json(); })
      .then(function(){ saving = false; dirty = false; render(); toast("✓ Saved to disk"); })
      .catch(function(){ saving = false; render(); alert("pencilpot: save failed — check the runtime log."); });
  }
  window.pencilpotSave = doSave;

  // Ctrl/Cmd+S — capture phase so it beats any SPA handler; never let the
  // browser "Save page as…" dialog appear.
  window.addEventListener("keydown", function(e) {
    var s = (e.key === "s" || e.key === "S");
    if (s && (e.ctrlKey || e.metaKey) && !e.altKey) {
      e.preventDefault(); e.stopPropagation();
      doSave();
    }
  }, true);

  // Warn before closing/reloading with unsaved edits.
  window.addEventListener("beforeunload", function(e) {
    if (dirty && !window.__pencilpotReloading) { e.preventDefault(); e.returnValue = ""; return ""; }
  });

  // ── single EventSource for both reload + status events ────────────────────
  var es = new EventSource("/pencilpot/live");
  es.addEventListener("reload", function(e) {
    console.log("[pencilpot live] external edit detected (rev=" + e.data + ")");
    showBanner(e.data);
  });
  es.addEventListener("status", function(e) {
    try {
      var st = JSON.parse(e.data);
      if (!saving) { dirty = !!st.dirty; render(); }
    } catch (err) {}
  });
  es.onerror = function() {
    // Reconnection is automatic via the browser's EventSource retry logic.
  };
  render();
})();`;
}
