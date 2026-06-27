// Verifies the workspace PLAY button opens the prototype viewer IN THE SAME
// browser window (no new window/tab/popup).
//
// Root cause it guards: data/common/go-to-viewer used to merge
// {::rt/new-window true ::rt/window-name "viewer-<id>"} into the nav options,
// so the router's `navigate` called dom/open-new-window -> a NEW browser window.
// The fix drops ::rt/new-window so navigate uses the same-window
// bhistory/set-token! branch (in-window hash navigation to #/view).
//
// Boots runtime/server.mjs on a throwaway COPY of DefaultLauncher/design (legacy
// PENCILPOT_DESIGN absolute-path mode), opens the workspace in Chromium, clicks
// the play button (a[title^="View mode"]), and asserts:
//   (1) NO new page/popup opened (browser context page count unchanged)
//   (2) the CURRENT page navigated in-window: url hash is now /view (not /workspace)
//
// Pre-fix this FAILS: window.open fires a context 'page'/popup event (popups>0)
// and the workspace page's url stays on /workspace.
//
// This test only checks WINDOW behavior — view mode itself still renders the
// not-found page until the get-view-only-bundle handler lands (Tasks 2-3); we do
// NOT assert prototype rendering here.
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
  // Give both an in-window hash nav and any (unwanted) popup time to materialize.
  await page.waitForTimeout(3000);

  const pagesAfter = context.pages().length;
  const urlAfter = page.url();

  // (1) same window: no popup/new page opened.
  check(popups.length === 0, `no new window/popup opened on play (popups=${popups.length})`);
  check(pagesAfter === pagesBefore, `browser context page count unchanged (${pagesBefore} -> ${pagesAfter})`);

  // (2) in-window navigation happened: the workspace page's hash is now /view.
  check(/\/view\b/.test(urlAfter) && !/\/workspace/.test(urlAfter),
    `same page navigated in-window to viewer (${urlAfter.split("#")[1] || urlAfter})`);

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
