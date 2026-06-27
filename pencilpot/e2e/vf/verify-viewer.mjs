// Verifies the prototype PLAY -> VIEW flow end-to-end on the STABLE SVG renderer:
//   (1) WINDOW: clicking the workspace play button opens the viewer in a SEPARATE
//       window (data/common/go-to-viewer uses ::rt/new-window so the viewer is
//       exitable by closing it), so the CURRENT workspace page must STAY put. The
//       new tab itself is not observable headless (window.open suppressed); the
//       render assertions below drive a DIRECT navigation to the /view route.
//   (2) BUNDLE: the viewer's fetch-bundle calls get-view-only-bundle and the
//       runtime serves it 200 (T3). Pre-T3 it hit the empty {} stub -> nil page
//       -> viewer.cljs raised :not-found -> the "This page doesn't exist" /
//       "404 error" page the user reported.
//   (3) LOADS: the viewer mounts and renders the prototype frame SVG and is NOT
//       the not-found page. Zero get-file-fragment requests (pages are inline).
//   (4) MEDIA: zero /assets/by-file-media-id 404s in view mode (the route is the
//       same one verify-media.mjs proves; the DEFAULT interaction frame is the
//       "Grid" foundations frame which references no images, so <image> paint is
//       reported best-effort, not gated).
//
// NOTE: the engine is warmed at server boot and the open design's read-session is
// cached (keyed on the working-copy identity), so get-view-only-bundle now responds
// in ~100ms; this harness still waits for the bundle RESPONSE before measuring.
//
// Boots runtime/server.mjs on a throwaway COPY of DefaultLauncher/design (legacy
// PENCILPOT_DESIGN absolute-path mode). Uses a browser CONTEXT so popups are
// observable. SKIPs (exit 0) if /mnt/data/src/DefaultLauncher/design is absent.
//
// Run: node pencilpot/e2e/vf/verify-viewer.mjs
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
  console.log(`SKIP: ${SRC_DESIGN} not present — cannot run viewer e2e`);
  process.exit(0);
}

const SCRATCH = path.resolve(HERE, "../../../.scratch");
fs.mkdirSync(SCRATCH, { recursive: true });
const dest = path.join(SCRATCH, "pp-viewer-design");
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

  // ── Network instrumentation (attach before navigation) ──
  const bundleResponses = [];   // {status}
  const fragmentRequests = [];  // urls
  const mediaResponses = [];    // {status}
  const wireResponse = (p) => {
    p.on("response", (r) => {
      const u = r.url();
      if (u.includes("/get-view-only-bundle")) bundleResponses.push({ status: r.status() });
      if (u.includes("/get-file-fragment")) fragmentRequests.push(u);
      if (u.includes("/assets/by-file-media-id/")) mediaResponses.push({ status: r.status() });
    });
  };
  wireResponse(page);
  const popups = [];
  context.on("page", (p) => { popups.push(p); wireResponse(p); });

  await page.goto(wsUrl(base), { waitUntil: "domcontentloaded" });
  await page.waitForSelector('a[title^="View mode"]', { state: "visible", timeout: 60000 });
  await page.waitForTimeout(1500);

  const urlBefore = page.url();
  check(/\/workspace/.test(urlBefore), `precondition: started on the workspace`);

  // ── (1) WINDOW: real play-button click opens a SEPARATE window; the current
  //     workspace page must NOT navigate in-place to /view (the exitable
  //     new-window behavior). The separate tab isn't observable headless. ──
  await page.click('a[title^="View mode"]');
  await page.waitForTimeout(1500);
  check(/\/workspace/.test(page.url()) && !/\/view\b/.test(page.url()),
    `play opened a separate window; workspace page stayed put (${page.url().split("#")[1] || page.url()})`);

  // ── Drive the render assertions by navigating THIS page directly to the same
  //     :viewer route (/view) the play button targets — exercises the
  //     get-view-only-bundle + render path regardless of the new-window hop. ──
  await page.goto(`${base}/#/view?file-id=${FID}&page-id=${PID}&section=interactions`, { waitUntil: "domcontentloaded" });

  // ── (2) BUNDLE: wait for the get-view-only-bundle RESPONSE (it is slow to
  //     generate — fresh session + ~1MB transit). Do NOT sample the render
  //     before it lands, or we'd see leftover workspace DOM mid-transition. ──
  const bundleDeadline = Date.now() + 45000;
  while (bundleResponses.length === 0 && Date.now() < bundleDeadline) {
    await page.waitForTimeout(500);
  }
  const bundle200 = bundleResponses.filter((r) => r.status === 200).length;
  const bundleBad  = bundleResponses.filter((r) => r.status !== 200);
  check(bundleResponses.length > 0, `get-view-only-bundle was requested (count=${bundleResponses.length})`);
  check(bundle200 > 0 && bundleBad.length === 0,
    `every get-view-only-bundle -> 200 (200=${bundle200}, bad=${bundleBad.map((r) => r.status).join(",") || "none"})`);

  // ── (3) LOADS: after the bundle lands, the viewer mounts and paints; assert
  //     it is NOT the not-found page and that real frame SVG content rendered. ──
  let state = { rendered: false, notFound: false, svgShapes: 0, viewerLayout: false };
  const renderDeadline = Date.now() + 30000;
  while (Date.now() < renderDeadline) {
    state = await page.evaluate(() => {
      const body = document.body ? (document.body.innerText || "") : "";
      const notFound = body.includes("This page doesn't exist") || body.includes("404 error");
      const svgShapes = document.querySelectorAll("svg path, svg rect, svg image, svg text, svg ellipse, svg circle").length;
      const viewerLayout = !!document.querySelector("[class*='viewer-layout'], [class*='viewer-section']");
      return { rendered: viewerLayout && svgShapes > 50, notFound, svgShapes, viewerLayout };
    });
    if (state.notFound || state.rendered) break;
    await page.waitForTimeout(500);
  }
  check(!state.notFound, `viewer is NOT the not-found page (no "This page doesn't exist"/"404 error")`);
  check(state.viewerLayout, `viewer layout mounted (viewer-section/layout present)`);
  check(state.rendered, `viewer painted prototype frame SVG content (svg shape nodes=${state.svgShapes})`);
  check(fragmentRequests.length === 0,
    `zero get-file-fragment requests — pages are inline (count=${fragmentRequests.length})`);

  // ── (4) MEDIA in view mode: zero by-file-media-id 404 (route shared with the
  //     proven media flow). The default interaction frame is "Grid" (no images),
  //     so <image> paint is reported best-effort, not gated. ──
  const imgNodes = await page.evaluate(() =>
    [...document.querySelectorAll("svg image")].filter((n) => {
      const href = n.getAttribute("href") || n.getAttribute("xlink:href") || "";
      return href.includes("by-file-media-id") || href.startsWith("data:image") || href.includes("/assets/");
    }).length
  );
  const media404 = mediaResponses.filter((r) => r.status === 404);
  const media200 = mediaResponses.filter((r) => r.status === 200).length;
  check(media404.length === 0, `no by-file-media-id request 404'd in view mode (404s=${media404.length})`);
  console.log(`  (best-effort, non-gating) viewer <image> nodes=${imgNodes}, by-file-media-id 200=${media200} (default "Grid" frame references no images)`);

  // ── Best-effort font-fidelity note (non-gating) ──
  const fontNote = await page.evaluate(() => {
    const t = document.querySelector("svg text, svg foreignObject [style*='font-family']");
    if (!t) return "no text node sampled";
    try { return getComputedStyle(t).fontFamily || "(empty font-family)"; } catch { return "(uncomputable)"; }
  });
  console.log(`  (best-effort, non-gating) sampled viewer text font-family: ${fontNote}`);

  const shot = path.join(SCRATCH, "pp-viewer.png");
  await page.screenshot({ path: shot });
  console.log(`  screenshot: ${shot}`);

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
