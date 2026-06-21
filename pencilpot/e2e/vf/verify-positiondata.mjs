// Verifies position-data is a session cache: text still renders, viewing a page
// never dirties, and Save writes zero :position-data to disk.
//
// Boots runtime/server.mjs on a throwaway copy of .scratch/proj (whose `home`
// page already has 27 :position-data entries), opens the workspace in Chromium
// (SVG renderer, no &wasm), and asserts four invariants:
//   (1) text renders          — at least one painted svg <text> node
//   (2) viewing did not dirty  — GET /pencilpot/status -> dirty === false
//   (3) save strips disk EDN   — POST /pencilpot/save -> on-disk page has ZERO :position-data
//   (4) clean exit 0 on all-pass
//
// Run: node pencilpot/e2e/vf/verify-positiondata.mjs
import { chromium } from "../../node_modules/playwright/index.mjs";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME = path.resolve(HERE, "../../runtime/server.mjs");
const TEAM = "0398e5fc-95c9-80d6-8008-29071f0fdaed";
const FID  = "0398e5fc-95c9-80d6-8008-29088f3ee53a";
const PID  = "0398e5fc-95c9-80d6-8008-29088f3ee53b";
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

const dest = "/tmp/pp-pd-verify";
fs.rmSync(dest, { recursive: true, force: true });
fs.cpSync(path.resolve(HERE, "../../../.scratch/proj"), dest, { recursive: true });
const pageEdn = () => {
  const d = path.join(dest, "designs/home/pages");
  return fs.readFileSync(path.join(d, fs.readdirSync(d)[0]), "utf8");
};

const port = 20000 + Math.floor(Math.random() * 40000);
const env = { ...process.env, PENCILPOT_PROJECT: dest, PENCILPOT_PORT: String(port) };
const srv = spawn(process.execPath, [RUNTIME], { env, stdio: ["ignore", "inherit", "inherit"] });
const base = `http://localhost:${port}`;

let ok = true;
const check = (c, m) => { console.log(`${c ? "PASS" : "FAIL"}: ${m}`); if (!c) ok = false; };

try {
  await waitForServer(base + "/");
  const browser = await chromium.launch({ headless: true, args: CHROME_ARGS });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  await page.goto(`${base}/#/workspace?team-id=${TEAM}&file-id=${FID}&page-id=${PID}`, { waitUntil: "domcontentloaded" });
  // Wait for the SVG render pipeline to paint text (swiftshader headless is slow).
  try { await page.waitForSelector("svg text", { state: "attached", timeout: 30000 }); } catch {}
  await page.waitForTimeout(2000);

  // (1) text renders: at least one painted SVG <text> (the svg/text path keeps
  //     position-data in-memory so glyph runs paint).
  const textNodes = await page.locator("svg text").count();
  check(textNodes > 0, `text renders on canvas (svg <text> count=${textNodes})`);

  // (2) viewing the page did NOT dirty (dirty signature ignores position-data).
  const dirty = (await (await fetch(base + "/pencilpot/status")).json()).dirty;
  check(dirty === false, `viewing a page did not dirty (dirty=${dirty})`);

  // (3) on-disk page has :position-data BEFORE save; save() must strip it.
  check(pageEdn().includes(":position-data"), "precondition: on-disk page has :position-data before save");
  await fetch(base + "/pencilpot/save", { method: "POST" });
  await page.waitForTimeout(750);
  check(!pageEdn().includes(":position-data"), "Save wrote ZERO :position-data to disk");

  await browser.close();
} catch (e) {
  console.log("FAIL: harness error");
  console.error(e?.stack || String(e));
  ok = false;
} finally {
  try { process.kill(srv.pid); } catch {}
}

console.log(ok ? "\nALL CHECKS PASS" : "\nCHECKS FAILED");
process.exit(ok ? 0 : 1);
