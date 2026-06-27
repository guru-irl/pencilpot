// Verifies the workspace PLAY button opens the prototype viewer in a SEPARATE,
// closable window/tab (the stock Penpot behavior) — it must NOT take over the
// current workspace page, because the viewer has no in-app exit affordance back
// to the workspace, so the user closes that window/tab to return.
//
// Behavior it guards: data/common/go-to-viewer merges
// {::rt/new-window true ::rt/window-name "viewer-<id>"} into the nav options, so
// the router's `navigate` calls dom/open-new-window -> a new window/tab. The
// regression it prevents is the same-page nav (commit 3e167afd50, reverted by
// revision A): there navigate used bhistory/set-token! and the CURRENT page
// took over to #/view, trapping the user with no way out.
//
// Boots runtime/server.mjs on a throwaway COPY of DefaultLauncher/design (legacy
// PENCILPOT_DESIGN absolute-path mode), opens the workspace in Chromium, clicks
// the play button (a[title^="View mode"]), and asserts:
//   - the CURRENT page STAYS on /workspace (it did NOT navigate in-place to /view)
//
// NOTE: headless Chromium suppresses window.open, so the real new tab/window
// cannot be observed here — that the viewer actually opens (and renders) in a
// separate tab is verified MANUALLY and by verify-viewer.mjs (which navigates to
// /view directly). The observable, reliable discriminator in headless is that
// the workspace page is NOT taken over. Pre-fix (same-page nav) this FAILS: the
// current page's hash becomes /view.
//
// This test only checks WINDOW/navigation behavior, not prototype rendering.
//
// SKIPs (exit 0) if /mnt/data/src/DefaultLauncher/design is absent.
//
// Run: node pencilpot/e2e/vf/verify-viewer-window.mjs
import { chromium } from "../../node_modules/playwright/index.mjs";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME = path.resolve(HERE, "../../runtime/server.mjs");
const SRC_DESIGN = "/mnt/data/src/DefaultLauncher/design";
const TEAM = "0398e5fc-95c9-80d6-8008-29071f0fdaed";
const FID  = "67e207c3-ec3b-80d7-8008-252de1d3a44e";
const PID  = "a0b0c325-382e-80da-8008-238861a34c9c";
const CHROME_ARGS = ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"];

function waitForServer(url, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = async () => {
      try { const r = await fetch(url); if (r.ok) return resolve(); } catch {}
      if (Date.now() > deadline) return reject(new Error("server did not come up"));
      setTimeout(tick, 250);
    };
    tick();
  });
}

if (!fs.existsSync(SRC_DESIGN)) {
  console.log(`SKIP: ${SRC_DESIGN} not present — cannot run viewer-window e2e`);
  process.exit(0);
}

const dest = path.resolve(HERE, "../../../.scratch/pp-viewer-window-design");
fs.rmSync(dest, { recursive: true, force: true });
fs.cpSync(SRC_DESIGN, dest, { recursive: true });

const randomPort = () => 20000 + Math.floor(Math.random() * 40000);
function spawnServer(port) {
  const env = { ...process.env, PENCILPOT_DESIGN: dest, PENCILPOT_PORT: String(port) };
  return spawn(process.execPath, [RUNTIME], { env, stdio: ["ignore", "inherit", "inherit"] });
}
const wsUrl = (base) => `${base}/#/workspace?team-id=${TEAM}&file-id=${FID}&page-id=${PID}`;

let ok = true;
const check = (c, m) => { console.log(`${c ? "PASS" : "FAIL"}: ${m}`); if (!c) ok = false; };

let srv = null, browser = null;
try {
  const port = randomPort();
  srv = spawnServer(port);
  const base = `http://localhost:${port}`;
  await waitForServer(base + "/");

  browser = await chromium.launch({ headless: true, args: CHROME_ARGS });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await context.newPage();
  await page.goto(wsUrl(base), { waitUntil: "domcontentloaded" });

  // Wait for the workspace header to render the play button.
  await page.waitForSelector('a[title^="View mode"]', { state: "visible", timeout: 45000 });
  await page.waitForTimeout(1500);

  // Track any new page/popup opened AFTER the workspace page exists. A pre-fix
  // window.open fires a context 'page' event; the fix must produce none.
  const popups = [];
  context.on("page", (p) => popups.push(p));

  const pagesBefore = context.pages().length;
  const urlBefore = page.url();
  check(/\/workspace/.test(urlBefore), `precondition: started on the workspace (${urlBefore.split("#")[1] || urlBefore})`);

  await page.click('a[title^="View mode"]');
  // Give an (unwanted) in-place hash nav OR any new-tab event time to materialize.
  await page.waitForTimeout(3000);

  const pagesAfter = context.pages().length;
  const urlAfter = page.url();

  // Informational only: headless suppresses window.open, so the real new tab is
  // not reliably observable. Do NOT gate on these (counts may legitimately be 0).
  console.log(`INFO: popups observed=${popups.length}, context pages ${pagesBefore} -> ${pagesAfter} (new tab not assertable headless)`);

  // GATING discriminator: the viewer opens in a SEPARATE window, so the current
  // workspace page must NOT be taken over — its hash STAYS on /workspace.
  // Pre-fix (same-page nav) this FAILS: the current page's hash becomes /view.
  check(/\/workspace/.test(urlAfter) && !/\/view\b/.test(urlAfter),
    `current workspace page NOT taken over by viewer (stayed on ${urlAfter.split("#")[1] || urlAfter})`);

  await context.close();
  await browser.close(); browser = null;
} catch (e) {
  console.log("FAIL: harness error");
  console.error(e?.stack || String(e));
  ok = false;
} finally {
  if (browser) { try { await browser.close(); } catch {} }
  if (srv) { try { process.kill(srv.pid); } catch {} }
}

console.log(ok ? "\nALL CHECKS PASS" : "\nCHECKS FAILED");
process.exit(ok ? 0 : 1);
