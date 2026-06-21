// Verifies position-data is a session cache: text still renders, viewing a page
// never dirties, Save writes zero :position-data to disk, AND text still repaints
// on a COLD reopen of a design whose on-disk page has zero :position-data.
//
// Boots runtime/server.mjs on a throwaway copy of .scratch/proj (whose `home`
// page already has 27 :position-data entries), opens the workspace in Chromium
// (SVG renderer, no &wasm), and asserts:
//   (1) text renders          — at least one painted svg <text> node
//   (2) viewing did not dirty  — GET /pencilpot/status -> dirty === false
//   (3) save strips disk EDN   — POST /pencilpot/save -> on-disk page has ZERO :position-data
//   (4) cold reopen repaints   — kill the runtime (drop the in-memory working copy
//                                that still holds recomputed position-data), spawn a
//                                FRESH runtime on the now-stripped dir, reopen, and
//                                assert text still paints — proving the frontend
//                                recomputes position-data from zero (the
//                                viewport_texts_html nil->recompute path).
//   (5) clean exit 0 on all-pass
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

function waitForExit(child, timeoutMs = 5000) {
  if (!child || child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(resolve, timeoutMs);
    child.once("exit", () => { clearTimeout(t); resolve(); });
  });
}

const dest = "/tmp/pp-pd-verify";
fs.rmSync(dest, { recursive: true, force: true });
fs.cpSync(path.resolve(HERE, "../../../.scratch/proj"), dest, { recursive: true });
const pageEdn = () => {
  const d = path.join(dest, "designs/home/pages");
  return fs.readFileSync(path.join(d, fs.readdirSync(d)[0]), "utf8");
};

const randomPort = () => 20000 + Math.floor(Math.random() * 40000);
function spawnServer(port) {
  const env = { ...process.env, PENCILPOT_PROJECT: dest, PENCILPOT_PORT: String(port) };
  return spawn(process.execPath, [RUNTIME], { env, stdio: ["ignore", "inherit", "inherit"] });
}
const wsUrl = (base) => `${base}/#/workspace?team-id=${TEAM}&file-id=${FID}&page-id=${PID}`;

let ok = true;
const check = (c, m) => { console.log(`${c ? "PASS" : "FAIL"}: ${m}`); if (!c) ok = false; };

let srv1 = null, srv2 = null, browser1 = null, browser2 = null;
try {
  // ── FIRST runtime: warm render, no-dirty-on-view, save-strip ──────────────
  const port1 = randomPort();
  srv1 = spawnServer(port1);
  const base1 = `http://localhost:${port1}`;
  await waitForServer(base1 + "/");
  browser1 = await chromium.launch({ headless: true, args: CHROME_ARGS });
  const page1 = await browser1.newPage({ viewport: { width: 1600, height: 1000 } });
  await page1.goto(wsUrl(base1), { waitUntil: "domcontentloaded" });
  // Wait for the SVG render pipeline to paint text (swiftshader headless is slow).
  try { await page1.waitForSelector("svg text", { state: "attached", timeout: 30000 }); } catch {}
  await page1.waitForTimeout(2000);

  // (1) text renders: at least one painted SVG <text> (the svg/text path keeps
  //     position-data in-memory so glyph runs paint).
  const textNodes = await page1.locator("svg text").count();
  check(textNodes > 0, `text renders on canvas (svg <text> count=${textNodes})`);

  // (2) viewing the page did NOT dirty (dirty signature ignores position-data).
  const dirty = (await (await fetch(base1 + "/pencilpot/status")).json()).dirty;
  check(dirty === false, `viewing a page did not dirty (dirty=${dirty})`);

  // (3) on-disk page has :position-data BEFORE save; save() must strip it.
  check(pageEdn().includes(":position-data"), "precondition: on-disk page has :position-data before save");
  await fetch(base1 + "/pencilpot/save", { method: "POST" });
  await page1.waitForTimeout(750);
  check(!pageEdn().includes(":position-data"), "Save wrote ZERO :position-data to disk");

  // ── Tear down FIRST runtime so its in-memory working copy (which still holds
  //    recomputed position-data) is gone.  After this, the only state left is the
  //    stripped on-disk EDN. ───────────────────────────────────────────────────
  await browser1.close(); browser1 = null;
  try { process.kill(srv1.pid); } catch {}
  await waitForExit(srv1);
  srv1 = null;

  // Precondition for the cold render: the on-disk page has ZERO :position-data,
  // so any text the second runtime paints CANNOT have come from disk.
  check(!pageEdn().includes(":position-data"),
    "precondition: on-disk page has ZERO :position-data after first-runtime teardown");

  // ── SECOND runtime: COLD reopen on the stripped dir ("closed & reopened
  //    pencilpot").  The runtime reads stripped disk fresh and serves it; the
  //    frontend must recompute position-data from text nodes + fonts to paint. ──
  const port2 = randomPort();
  srv2 = spawnServer(port2);
  const base2 = `http://localhost:${port2}`;
  await waitForServer(base2 + "/");
  browser2 = await chromium.launch({ headless: true, args: CHROME_ARGS });
  const page2 = await browser2.newPage({ viewport: { width: 1600, height: 1000 } });
  await page2.goto(wsUrl(base2), { waitUntil: "domcontentloaded" });
  // Generous timeout: cold swiftshader start + recompute-from-zero.
  try { await page2.waitForSelector("svg text", { state: "attached", timeout: 45000 }); } catch {}
  await page2.waitForTimeout(2500);

  // (4) cold reopen repaints: text painted from recompute, not from disk.
  const coldTextNodes = await page2.locator("svg text").count();
  check(coldTextNodes > 0,
    `cold reopen: text repaints from stripped (zero position-data) disk (svg <text> count=${coldTextNodes})`);

  // (5) cold reopen must NOT spuriously dirty.  The on-disk page carries the
  //     blank-line residue left when Save stripped :position-data; the SPA's
  //     no-op open update-file re-serializes it cleanly (and bumps :revn).  A
  //     content-only dirty signature must treat that as identical — opening a
  //     design with no user edits must stay clean.
  await page2.waitForTimeout(1500);
  const coldDirty = (await (await fetch(base2 + "/pencilpot/status")).json()).dirty;
  check(coldDirty === false, `cold reopen did not spuriously dirty (dirty=${coldDirty})`);

  await browser2.close(); browser2 = null;
} catch (e) {
  console.log("FAIL: harness error");
  console.error(e?.stack || String(e));
  ok = false;
} finally {
  for (const b of [browser1, browser2]) { if (b) { try { await b.close(); } catch {} } }
  for (const s of [srv1, srv2]) { if (s) { try { process.kill(s.pid); } catch {} } }
}

console.log(ok ? "\nALL CHECKS PASS" : "\nCHECKS FAILED");
process.exit(ok ? 0 : 1);
