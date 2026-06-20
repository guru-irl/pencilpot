// VF render harness — STABLE SVG renderer (no wasm).
//
// This is the integration gate for the two variable-font fixes:
//   (1) `font-variation-settings` emitted in SVG text styles (styles.cljs)
//   (2) a single variable `@font-face` for `:variable` custom fonts (fonts.cljs)
//
// Where vf-render.mjs proves the WASM renderer honours axes, this proves the
// DEFAULT (SVG/DOM) renderer does too — i.e. opening the workspace WITHOUT
// `&wasm=true`. In SVG mode the viewport is real SVG/HTML DOM (no `<canvas>`
// driving it), the page goes idle, and ordinary element screenshots work.
//
// Method: seed TWO copies of the vftest design whose VF text differs ONLY in
// `:font-variation-settings` — variant A `{"wdth" 25}`, variant B `{"wdth" 151}`
// (the width axis extremes). The stored shape geometry is identical between the
// two copies (seed only rewrites the variation map), so the on-screen framing of
// the heading is identical; only the rendered glyphs differ IF the SVG renderer
// applies the width axis. We screenshot the SAME clip rect for both and compare.
//
//   PASS  = RMSE(A,B) > 1.0 (0..255 scale)  AND  canvas count 0  AND  VF fetched
//
// If axes still don't render the two screenshots are byte-identical (RMSE ~0)
// and this FAILs honestly — do not fudge a pass.
//
// Run: node e2e/vf/vf-render-svg.mjs   (boots the runtime + Chromium itself)

import { chromium } from "../../node_modules/playwright/index.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { seed } from "./seed.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME = path.resolve(HERE, "../../runtime/server.mjs");
const SRC = "/mnt/data/src/DefaultLauncher";
const TEAM_ID = "0398e5fc-95c9-80d6-8008-29071f0fdaed";
const FID = "67e207c3-ec3b-80d7-8008-252de1d3a44e";
// The "LAUNCHER" variable-font heading shape (Google Sans Flex). Same shape the
// UI-edit harness drives; in SVG mode its wrapper is `#shape-<uuid>`.
const VF_SHAPE_ID = "a0b0c325-382e-80da-8008-2388fc7353bb";
const VF_ASSET_HINT = "custom-google-sans-flex"; // /assets/by-id/custom-google-sans-flex-wNNN
const VF_PAGE = "a0b0c325-382e-80da-8008-238861a34c9c.edn";

// Strip the stored `:position-data` from the VF heading shape so the workspace
// regenerates it from the content tree (which carries `:font-variation-settings`).
// The shipped value is a bare rect with no font fields, so without this the
// stable SVG renderer paints static/blank glyphs and never picks up the axes.
function stripHeadingPositionData(designDir) {
  const pagePath = path.join(designDir, "pages", VF_PAGE);
  let edn = fs.readFileSync(pagePath, "utf8");
  const before = edn;
  // From the heading shape's :id to its own (next) :position-data, set it nil.
  edn = edn.replace(
    new RegExp(`(:id #uuid "${VF_SHAPE_ID}"[\\s\\S]*?):position-data \\[[^\\]]*\\]`),
    "$1:position-data nil");
  if (edn === before) throw new Error("strip: heading :position-data not found to nil-out");
  fs.writeFileSync(pagePath, edn);
}

const CHROME_ARGS = [
  "--use-gl=angle",
  "--use-angle=swiftshader",
  "--enable-unsafe-swiftshader",
  "--ignore-gpu-blocklist",
];

function loud(msg) { process.stderr.write(msg + "\n"); }

function waitForServer(url, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = async () => {
      try { const r = await fetch(url); if (r.ok || r.status === 200) return resolve(); } catch {}
      if (Date.now() > deadline) return reject(new Error("server did not come up"));
      setTimeout(tick, 250);
    };
    tick();
  });
}

// RMSE on a 0..255 scale between two equal-sized PNGs via ImageMagick.
// `magick compare -metric RMSE` prints "<abs> (<normalized 0..1>)"; we scale the
// normalized value to 0..255 so the threshold matches the brief's reference
// (an isolated browser spike of width extremes measured ~105 on this scale).
function rmse255(a, b) {
  try {
    execFileSync("magick", ["compare", "-metric", "RMSE", a, b, "null:"], { stdio: "pipe" });
    return 0; // identical -> exits 0
  } catch (e) {
    const m = String(e.stderr || "").match(/\(([\d.]+)\)/);
    return m ? parseFloat(m[1]) * 255 : NaN;
  }
}

// Boot a pencilpot runtime against `projectRoot`, open the workspace in SVG mode
// (NO &wasm=true), select+frame the VF heading, and return a live page + diags.
//
// We capture a FIXED viewport region (between the side panels) rather than the
// element's box: the SVG <g> wrapper reports a 0x0 box in Chromium and the
// heading must be framed identically for A and B. Selecting the shape from the
// layers panel and zoom-to-selection (Shift+2) gives deterministic framing
// because the two seeded copies share identical stored geometry — only the
// `:font-variation-settings` differ.
const VIEWPORT_CLIP = { x: 330, y: 95, width: 748, height: 790 };

async function boot(projectRoot, port) {
  const env = { ...process.env, PENCILPOT_PROJECT: projectRoot, PENCILPOT_PORT: String(port) };
  const srv = spawn(process.execPath, [RUNTIME], { env, stdio: ["ignore", "ignore", "ignore"] });
  const fontAssets = [];
  const consoleErrors = [];
  try {
    await waitForServer(`http://localhost:${port}/`, 25000);
    const browser = await chromium.launch({ headless: true, args: CHROME_ARGS });
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    page.on("request", (r) => { if (r.url().includes(VF_ASSET_HINT)) fontAssets.push(r.url()); });
    page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
    page.on("pageerror", (e) => consoleErrors.push(String(e)));

    // SVG renderer is the default for the local profile; NO &wasm=true.
    const url = `http://localhost:${port}/#/workspace?team-id=${TEAM_ID}&file-id=${FID}`;
    await page.goto(url, { waitUntil: "domcontentloaded" });

    // Wait for the file to load (the shape wrapper is attached even while its
    // board is off-screen / thumbnailed).
    await page.waitForSelector(`#shape-${VF_SHAPE_ID}`, { state: "attached", timeout: 30000 });
    await page.waitForTimeout(800);

    // Select the VF heading via its layer-row (expand boards until present),
    // mirroring ui-axis.mjs, then zoom-to-selection for deterministic framing.
    const row = page.locator(`#${VF_SHAPE_ID}`);
    for (let i = 0; i < 10 && (await row.count()) === 0; i++) {
      const toggles = page.locator('[data-testid="toggle-content"]');
      const n = await toggles.count();
      for (let j = 0; j < n; j++) { try { await toggles.nth(j).click({ timeout: 400 }); } catch {} }
      await page.waitForTimeout(250);
    }
    if ((await row.count()) === 0) throw new Error("VF heading layer-row not found");
    await row.first().click();
    await page.waitForTimeout(400);
    await page.keyboard.press("Shift+2"); // zoom-to-selection
    await page.waitForTimeout(1500);
    await page.evaluate(() => document.fonts.ready);
    // position-data regeneration is async (overlay measurement -> update-position-data
    // -> re-render), and only THEN does the variable @font-face binary get fetched.
    // Poll up to ~12s for the VF asset to appear in network before settling.
    {
      const deadline = Date.now() + 12000;
      while (fontAssets.length === 0 && Date.now() < deadline) {
        await page.waitForTimeout(300);
      }
    }
    await page.keyboard.press("Escape"); // drop selection so handles aren't shot
    await page.waitForTimeout(1500); // settle (page is idle in SVG mode)

    const canvasCount = await page.locator("canvas").count();
    // Whether the variable @font-face actually finished loading in the browser.
    const vfFaceLoaded = await page.evaluate(() =>
      [...document.fonts].some((f) => f.family === "Google Sans Flex" && f.status === "loaded"));
    return { srv, browser, page, fontAssets, consoleErrors, canvasCount, vfFaceLoaded };
  } catch (e) {
    try { process.kill(srv.pid); } catch {}
    throw e;
  }
}

async function shotShape(page, out) {
  await page.screenshot({ path: out, clip: VIEWPORT_CLIP });
}

async function main() {
  if (!fs.existsSync(SRC)) { loud(`SKIP: ${SRC} missing`); process.exit(0); }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vf-render-svg-"));
  const dirA = path.join(tmp, "A"), dirB = path.join(tmp, "B");
  const shotA = path.join(tmp, "wdth25.png"), shotB = path.join(tmp, "wdth151.png");

  // Two copies differing ONLY in the width axis. Strip the heading's stored
  // :position-data in each so the workspace regenerates it (carrying the axes).
  const seededA = seed(dirA, { wdth: 25 });
  const seededB = seed(dirB, { wdth: 151 });
  stripHeadingPositionData(seededA.designDir);
  stripHeadingPositionData(seededB.designDir);

  let ok = true;
  const allErrors = [];

  // --- Variant A (width 25). ---
  const a = await boot(dirA, 14010);
  try {
    await shotShape(a.page, shotA);
  } finally {
    allErrors.push(...a.consoleErrors);
    await a.browser.close().catch(() => {});
    try { process.kill(a.srv.pid); } catch {}
  }
  const canvasA = a.canvasCount;
  const vfFetchedA = a.fontAssets.length > 0;

  // --- Variant B (width 151): identical framing -> same fixed clip. ---
  const b = await boot(dirB, 14011);
  try {
    await shotShape(b.page, shotB);
  } finally {
    allErrors.push(...b.consoleErrors);
    await b.browser.close().catch(() => {});
    try { process.kill(b.srv.pid); } catch {}
  }
  const canvasB = b.canvasCount;
  const vfFetchedB = b.fontAssets.length > 0;

  const diff = rmse255(shotA, shotB);
  const canvasCount = Math.max(canvasA, canvasB);
  const vfFetched = vfFetchedA && vfFetchedB;

  loud(`clip rect            : ${JSON.stringify(VIEWPORT_CLIP)}`);
  loud(`canvas count (A,B)   : ${canvasA}, ${canvasB}  -> ${canvasCount}`);
  loud(`VF asset fetched(A,B): ${vfFetchedA}, ${vfFetchedB}  -> ${vfFetched}`);
  loud(`VF face loaded (A,B) : ${a.vfFaceLoaded}, ${b.vfFaceLoaded}`);
  loud(`RMSE(wdth25, wdth151): ${diff}  (0..255 scale; threshold > 1.0)`);
  if (allErrors.length) loud(`console errors: ${allErrors.length} -> ${allErrors.slice(0, 3).join(" | ")}`);

  if (!(diff > 1.0)) { loud(`FAIL: width axis produced no visible SVG render difference (RMSE ${diff})`); ok = false; }
  if (canvasCount !== 0) { loud(`FAIL: expected SVG mode (canvas count 0) but found ${canvasCount}`); ok = false; }
  if (!vfFetched) { loud(`FAIL: variable-font binary (${VF_ASSET_HINT}) was not fetched in SVG mode`); ok = false; }

  // Keep artifacts on failure for inspection; clean up on success.
  if (ok) {
    fs.rmSync(tmp, { recursive: true, force: true });
    loud(`PASS  RMSE=${diff} canvas=${canvasCount} vfFetched=${vfFetched}`);
    process.exit(0);
  }
  loud(`FAIL  RMSE=${diff} canvas=${canvasCount} vfFetched=${vfFetched}  (artifacts: ${tmp})`);
  process.exit(1);
}

main().catch((e) => { loud("ERROR: " + e.stack); process.exit(1); });
