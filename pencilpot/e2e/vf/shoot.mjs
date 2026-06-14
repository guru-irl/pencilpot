// VF bug harness — boot the pencilpot runtime against a seeded project, load
// the workspace in real (swiftshader) Chromium, zoom to the VF text, and
// screenshot the canvas.
//
// Usage:
//   node shoot.mjs <projectRoot> <fileId> <outPng> [--no-zoom] [--cold]
//
// --cold : do NOT interact before screenshotting (proves boot-time render).
//          Without it we press shift+1 (zoom-to-fit) to frame the big heading.
//
// Returns exit 0 on success. Prints diagnostics to stderr.

import { chromium } from "../../node_modules/playwright/index.mjs";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME = path.resolve(HERE, "../../runtime/server.mjs");
const TEAM_ID = "0398e5fc-95c9-80d6-8008-29071f0fdaed";

const CHROME_ARGS = [
  "--use-gl=angle",
  "--use-angle=swiftshader",
  "--enable-unsafe-swiftshader",
  "--ignore-gpu-blocklist",
];

function waitForServer(url, timeoutMs = 20000) {
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

export async function shoot({ projectRoot, fileId, out, cold = false, port }) {
  port = port ?? (10000 + Math.floor(Math.random() * 40000));
  const env = {
    ...process.env,
    PENCILPOT_PROJECT: projectRoot,
    PENCILPOT_PORT: String(port),
  };
  const srv = spawn(process.execPath, [RUNTIME], {
    env,
    stdio: ["ignore", "inherit", "inherit"],
    detached: false,
  });

  try {
    await waitForServer(`http://localhost:${port}/`, 25000);

    const browser = await chromium.launch({ headless: true, args: CHROME_ARGS });
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

    const consoleErrors = [];
    page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
    page.on("pageerror", (e) => consoleErrors.push(String(e)));

    // Track custom-font binary fetches into the WASM store (Bug 2 evidence).
    const fontAssets = [];
    page.on("request", (r) => {
      const u = r.url();
      if (u.includes("/assets/by-id/")) fontAssets.push(u.split("/assets/by-id/")[1]);
    });

    // `wasm=true` forces the render-wasm renderer (the SVG renderer is the
    // default for the synthetic local profile). This is what the real user
    // sees when they have the wasm renderer enabled.
    const url = `http://localhost:${port}/#/workspace?team-id=${TEAM_ID}&file-id=${fileId}&wasm=true`;
    await page.goto(url, { waitUntil: "domcontentloaded" });

    // Wait for the wasm canvas to mount + paint.
    await page.waitForSelector("canvas", { timeout: 30000 });
    await page.waitForTimeout(6000);

    if (!cold) {
      // Zoom to fit so the big VF heading is framed regardless of pan.
      await page.keyboard.press("Shift+1");
      await page.waitForTimeout(2500);
    }

    // Capture the canvas pixels directly via toDataURL. The wasm context is
    // created with preserveDrawingBuffer:true so this reads the last painted
    // frame. Using Playwright's page/element screenshot hangs because the wasm
    // render loop keeps the page "unstable" forever.
    const dataUrl = await page.evaluate(() => {
      const c = document.querySelector("canvas");
      if (!c) return null;
      return c.toDataURL("image/png");
    });
    if (!dataUrl) throw new Error("no canvas / could not read pixels");
    const b64 = dataUrl.replace(/^data:image\/png;base64,/, "");
    fs.writeFileSync(out, Buffer.from(b64, "base64"));

    await browser.close();
    return { consoleErrors, port, fontAssets };
  } finally {
    try { process.kill(srv.pid); } catch {}
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [projectRoot, fileId, out] = process.argv.slice(2);
  const cold = process.argv.includes("--cold");
  shoot({ projectRoot, fileId, out, cold })
    .then(({ consoleErrors }) => {
      process.stderr.write(`shot -> ${out}; console errors: ${consoleErrors.length}\n`);
      process.exit(0);
    })
    .catch((e) => { process.stderr.write(`SHOOT FAILED: ${e.stack}\n`); process.exit(1); });
}
