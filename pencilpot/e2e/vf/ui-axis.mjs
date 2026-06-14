// VF UI-edit regression harness — drives the REAL workspace UI and asserts that
// changing a variable-font axis in the options panel actually re-renders the
// glyphs on the canvas.
//
// THE BUG this guards against:
//   Changing a *non-metric* variable-font axis (GRAD / ROND / opsz / slnt) via
//   the "Variable axes" inputs updated the design data but did NOT repaint the
//   canvas. The selection-mode edit path (`update-attrs` -> `resize-wasm-text`)
//   pushes the new content into WASM but only repaints as a side effect of a
//   geometry resize. Non-metric axes don't change the text box, so the resize
//   was an identity transform and no frame was rendered. (A *metric* axis like
//   width, or the weight dropdown, incidentally resized the auto-width box and
//   so DID repaint — which is why they appeared to "work".)
//
// Prior harnesses (vf-render.mjs) set :font-variation-settings in the design EDN
// and re-rendered, so they exercised the wasm render path but NOT the UI edit ->
// live re-render path, and missed this bug entirely. This harness types into the
// real axis input and commits, then diffs the canvas before/after.
//
// Usage: node ui-axis.mjs <projectRoot> <fileId> <outDir>

import { chromium } from "../../node_modules/playwright/index.mjs";
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME = path.resolve(HERE, "../../runtime/server.mjs");
const TEAM_ID = "0398e5fc-95c9-80d6-8008-29071f0fdaed";

// The variable-font ("Google Sans Flex") text shape in the DefaultLauncher page.
const VF_SHAPE_ID = "a0b0c325-382e-80da-8008-2388fc7353bb";

const CHROME_ARGS = [
  "--use-gl=angle",
  "--use-angle=swiftshader",
  "--enable-unsafe-swiftshader",
  "--ignore-gpu-blocklist",
];

function waitForServer(url, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = async () => {
      try {
        const r = await fetch(url);
        if (r.ok || r.status === 200) return resolve();
      } catch {}
      if (Date.now() > deadline) return reject(new Error("server did not come up"));
      setTimeout(tick, 250);
    };
    tick();
  });
}

// RMSE in [0,1] between two pngs via ImageMagick.
function rmse(a, b) {
  try {
    execFileSync("magick", ["compare", "-metric", "RMSE", a, b, "null:"], { stdio: "pipe" });
    return 0;
  } catch (e) {
    const m = String(e.stderr || "").match(/\(([\d.]+)\)/);
    return m ? parseFloat(m[1]) : NaN;
  }
}

async function shotCanvas(page, out) {
  const dataUrl = await page.evaluate(() => {
    const c = document.querySelector("canvas");
    return c ? c.toDataURL("image/png") : null;
  });
  if (!dataUrl) throw new Error("no canvas / could not read pixels");
  fs.writeFileSync(out, Buffer.from(dataUrl.replace(/^data:image\/png;base64,/, ""), "base64"));
}

async function setAxis(page, ariaLabel, value, ms = 2500) {
  const input = page.locator(`input[aria-label="${ariaLabel}"]`).first();
  if ((await input.count()) === 0) throw new Error(`axis input "${ariaLabel}" not found`);
  await input.scrollIntoViewIfNeeded();
  await input.click();
  await input.fill("");
  await input.type(String(value));
  await input.press("Enter");
  await page.waitForTimeout(ms);
}

export async function run({ projectRoot, fileId, outDir, port }) {
  fs.mkdirSync(outDir, { recursive: true });
  port = port ?? (10000 + Math.floor(Math.random() * 40000));
  const env = { ...process.env, PENCILPOT_PROJECT: projectRoot, PENCILPOT_PORT: String(port) };
  const srv = spawn(process.execPath, [RUNTIME], { env, stdio: ["ignore", "inherit", "inherit"] });

  const result = { consoleErrors: [], shots: {} };
  try {
    await waitForServer(`http://localhost:${port}/`, 25000);
    const browser = await chromium.launch({ headless: true, args: CHROME_ARGS });
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    page.on("console", (m) => { if (m.type() === "error") result.consoleErrors.push(m.text()); });
    page.on("pageerror", (e) => result.consoleErrors.push(String(e)));

    const url = `http://localhost:${port}/#/workspace?team-id=${TEAM_ID}&file-id=${fileId}&wasm=true`;
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("canvas", { timeout: 30000 });
    await page.waitForTimeout(6000);

    // Select the VF text shape via its layer-row (real UI click). Expand boards
    // until the row is present.
    const row = page.locator(`#${VF_SHAPE_ID}`);
    for (let i = 0; i < 8 && (await row.count()) === 0; i++) {
      const toggles = page.locator('[data-testid="toggle-content"]');
      const n = await toggles.count();
      for (let j = 0; j < n; j++) { try { await toggles.nth(j).click({ timeout: 500 }); } catch {} }
      await page.waitForTimeout(300);
    }
    if ((await row.count()) === 0) throw new Error("VF layer-row not found");
    await row.first().click();
    await page.waitForTimeout(500);

    // Zoom to selection so the heading fills the canvas (stable framing).
    await page.keyboard.press("Shift+2");
    await page.waitForTimeout(2500);

    const p = (f) => path.join(outDir, f);
    await shotCanvas(page, p("01-before.png"));

    // --- THE BUG: change a NON-METRIC axis (GRAD). Must repaint the glyphs. ---
    // GRAD 3 -> 100 makes the strokes much heavier without changing the box.
    // This is exactly the case that did NOT repaint before the fix (identity
    // resize -> no render requested).
    await setAxis(page, "Grade", 100);
    await shotCanvas(page, p("02-after-grad.png"));

    // --- A second NON-METRIC axis (Optical Size) must also repaint. ---
    await setAxis(page, "Optical Size", 144);
    await shotCanvas(page, p("03-after-opsz.png"));

    // --- Regression: a METRIC axis (Width) must still repaint. This path is
    // shared with the font-weight dropdown (both change the auto-width box and
    // repaint via the resize modifier), so it doubles as the weight regression. ---
    await setAxis(page, "Width", 151);
    await shotCanvas(page, p("04-after-width.png"));

    await browser.close();

    result.shots = {
      gradDiff: rmse(p("01-before.png"), p("02-after-grad.png")),
      opszDiff: rmse(p("02-after-grad.png"), p("03-after-opsz.png")),
      widthDiff: rmse(p("03-after-opsz.png"), p("04-after-width.png")),
    };
    return result;
  } finally {
    try { process.kill(srv.pid); } catch {}
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [projectRoot, fileId, outDir] = process.argv.slice(2);
  run({ projectRoot, fileId, outDir })
    .then((r) => {
      const { gradDiff, opszDiff, widthDiff } = r.shots;
      process.stderr.write(`GRAD (non-metric) axis canvas RMSE = ${gradDiff}\n`);
      process.stderr.write(`OPSZ (non-metric) axis canvas RMSE = ${opszDiff}\n`);
      process.stderr.write(`WIDTH (metric)    axis canvas RMSE = ${widthDiff}\n`);
      let ok = true;
      // A non-metric axis edit must visibly change glyphs. 0.02 is well above
      // swiftshader noise; observed ~0.05-0.17 when working, ~0 when broken.
      if (!(gradDiff > 0.02)) { process.stderr.write(`FAIL: GRAD axis did not repaint (RMSE ${gradDiff})\n`); ok = false; }
      if (!(opszDiff > 0.02)) { process.stderr.write(`FAIL: OPSZ axis did not repaint (RMSE ${opszDiff})\n`); ok = false; }
      if (!(widthDiff > 0.02)) { process.stderr.write(`FAIL: WIDTH axis regressed (RMSE ${widthDiff})\n`); ok = false; }
      if (r.consoleErrors.length)
        process.stderr.write(`WARN: ${r.consoleErrors.length} console error(s)\n`);
      if (ok) { process.stderr.write("PASS: variable-font axis edits repaint via the real UI\n"); process.exit(0); }
      process.exit(1);
    })
    .catch((e) => { process.stderr.write(`UI RUN FAILED: ${e.stack}\n`); process.exit(1); });
}
