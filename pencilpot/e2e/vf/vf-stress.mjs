// VF STRESS harness — STABLE SVG renderer. Drives the real "Variable axes" UI
// inputs many times and measures, per edit, whether the painted SVG <text>
// actually reflects the new axis value, and HOW LONG it takes.
//
// It separates two failure classes:
//   - ui-miss   : the numeric input itself didn't commit the requested value
//                 (harness/UI flakiness) — excluded from the render verdict.
//   - RENDER-LOST: the input DID commit the value but the painted <text> never
//                 caught up (the real bug) — the SVG repaint pipeline dropped it.
//
// The repaint pipeline is async + debounced:
//   axis commit -> content change -> hidden html measurement overlay re-render
//   -> tsp/calc-position-data (async DOM measure) -> update-position-data
//   (DEBOUNCED, global flag) -> commit-position-data -> svg_text re-render
//   -> <text style="font-variation-settings:...">. We read that final inline
//   style directly (no screenshot noise).
//
// Phases: (1) isolated single edits; (2) RACE HUNT — rapid v1->v2 pairs at
// delays scanning the debounce/commit window; the paint MUST converge to v2.
//
// Run: node e2e/vf/vf-stress.mjs [singleIters] [racePairs]

import { chromium } from "../../node_modules/playwright/index.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { seed } from "./seed.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME = path.resolve(HERE, "../../runtime/server.mjs");
const SRC = "/mnt/data/src/DefaultLauncher";
const TEAM_ID = "0398e5fc-95c9-80d6-8008-29071f0fdaed";
const VF_SHAPE_ID = "a0b0c325-382e-80da-8008-2388fc7353bb";
const VF_PAGE = "a0b0c325-382e-80da-8008-238861a34c9c.edn";
const CHROME_ARGS = ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"];
const SINGLE_ITERS = parseInt(process.argv[2] || "60", 10);
const RACE_PAIRS = parseInt(process.argv[3] || "40", 10);

function loud(m) { process.stderr.write(m + "\n"); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function stripHeadingPositionData(designDir) {
  const pagePath = path.join(designDir, "pages", VF_PAGE);
  let edn = fs.readFileSync(pagePath, "utf8");
  const before = edn;
  edn = edn.replace(new RegExp(`(:id #uuid "${VF_SHAPE_ID}"[\\s\\S]*?):position-data \\[[^\\]]*\\]`), "$1:position-data nil");
  if (edn === before) throw new Error("strip: heading :position-data not found");
  fs.writeFileSync(pagePath, edn);
}

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

// In-page: read the painted variation map from the live SVG <text> runs.
const READ_FVS = (shapeId) => {
  const texts = [...document.querySelectorAll(`#shape-${shapeId} text`)];
  const parse = (s) => { const m = {}; const re = /"(\w+)"\s+(-?[\d.]+)/g; let x; while ((x = re.exec(s || ""))) m[x[1]] = parseFloat(x[2]); return m; };
  return texts.map((t) => ({ fvs: parse(t.style.fontVariationSettings), weight: t.style.fontWeight }));
};

async function readAxisValue(page, tag) {
  const runs = await page.evaluate(READ_FVS, VF_SHAPE_ID);
  const vals = runs.map((r) => r.fvs[tag]).filter((v) => v !== undefined);
  return vals.length ? vals[vals.length - 1] : null;
}

// Reliable commit: select-all, type, Enter, verify the input holds the value
// (retry once). Returns the value the input actually holds.
async function setAxis(page, ariaLabel, value) {
  const input = page.locator(`input[aria-label="${ariaLabel}"]`).first();
  for (let attempt = 0; attempt < 2; attempt++) {
    await input.click({ clickCount: 3 });
    await input.pressSequentially(String(value), { delay: 5 });
    await input.press("Enter");
    let got; try { got = parseFloat(await input.inputValue()); } catch { got = NaN; }
    if (Math.round(got) === Math.round(value)) return got;
    await sleep(40);
  }
  try { return parseFloat(await input.inputValue()); } catch { return NaN; }
}

async function awaitPainted(page, tag, want, defaultVal, timeoutMs = 3000) {
  const atDefault = defaultVal !== undefined && Math.round(want) === Math.round(defaultVal);
  const t0 = Date.now();
  let immediate = null;
  for (let i = 0; ; i++) {
    const v = await readAxisValue(page, tag);
    if (i === 0) immediate = v;
    // Match if the painted value equals `want`, OR (when `want` is the axis
    // default) the override is correctly omitted (null) -> glyph renders at default.
    const match = (v !== null && Math.round(v) === Math.round(want)) || (v === null && atDefault);
    if (match) return { ok: true, latency: Date.now() - t0, immediate };
    if (Date.now() - t0 > timeoutMs) return { ok: false, latency: Date.now() - t0, immediate, last: v };
    await sleep(60);
  }
}

async function main() {
  if (!fs.existsSync(SRC)) { loud(`SKIP: ${SRC} missing`); process.exit(0); }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vf-stress-"));
  const dir = path.join(tmp, "S");
  const seeded = seed(dir, { wdth: 100, opsz: 40, GRAD: 0, slnt: 0 });
  stripHeadingPositionData(seeded.designDir);
  // Axis defaults (an override equal to its default is dropped from the map).
  const DEFAULTS = {};
  try {
    const fj = JSON.parse(fs.readFileSync(path.join(dir, "fonts/fonts.json"), "utf8"));
    const fv = (fj.variants || []).find((v) => v.axes && v.axes.length);
    for (const a of fv?.axes || []) DEFAULTS[a.tag] = a.default;
  } catch {}

  const port = 14077;
  const env = { ...process.env, PENCILPOT_PROJECT: dir, PENCILPOT_PORT: String(port) };
  const srv = spawn(process.execPath, [RUNTIME], { env, stdio: ["ignore", "ignore", "ignore"] });
  const consoleErrors = [];
  let browser;
  try {
    await waitForServer(`http://localhost:${port}/`);
    browser = await chromium.launch({ headless: true, args: CHROME_ARGS });
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
    page.on("pageerror", (e) => consoleErrors.push(String(e)));

    await page.goto(`http://localhost:${port}/#/workspace?team-id=${TEAM_ID}&file-id=${seeded.fileId}`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(`#shape-${VF_SHAPE_ID}`, { state: "attached", timeout: 30000 });
    await page.waitForTimeout(800);

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
    await page.keyboard.press("Shift+2");
    await page.waitForTimeout(1500);
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(2500);

    const runs0 = await page.evaluate(READ_FVS, VF_SHAPE_ID);
    loud(`painted <text> runs: ${runs0.length}; sample fvs=${JSON.stringify(runs0[0]?.fvs)}`);
    if (runs0.length === 0) throw new Error("no painted <text> runs found for shape");

    const axisInputs = await page.evaluate(() => {
      const header = [...document.querySelectorAll("span")].find((s) => s.textContent.trim() === "Variable axes");
      if (!header) return [];
      return [...header.parentElement.querySelectorAll("input")].map((inp) => ({
        ariaLabel: inp.getAttribute("aria-label"),
        min: parseFloat(inp.getAttribute("min")),
        max: parseFloat(inp.getAttribute("max")),
      })).filter((a) => a.ariaLabel && Number.isFinite(a.min) && Number.isFinite(a.max));
    });

    const axes = [];
    for (const ax of axisInputs) {
      const probe = Math.round((ax.min + ax.max) / 2) === 0 ? Math.round(ax.max) : Math.round((ax.min + ax.max) / 2);
      const before = (await page.evaluate(READ_FVS, VF_SHAPE_ID)).at(-1)?.fvs || {};
      await setAxis(page, ax.ariaLabel, probe);
      await sleep(1200);
      const after = (await page.evaluate(READ_FVS, VF_SHAPE_ID)).at(-1)?.fvs || {};
      let tag = null;
      for (const k of Object.keys(after)) if (after[k] !== before[k]) { tag = k; break; }
      if (tag) { axes.push({ ...ax, tag }); loud(`  calibrated "${ax.ariaLabel}" -> ${tag} [${ax.min}..${ax.max}]`); }
    }
    if (axes.length === 0) throw new Error("no axes calibrated");

    const rng = (() => { let s = 99173; return () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff; })();

    // ---- PHASE 1: isolated single edits (render verdict over INPUT-OK edits) ----
    let inputOk = 0, uiMiss = 0, renderLost = 0, immediate = 0, lat = [];
    const lostDetail = [];
    for (let i = 0; i < SINGLE_ITERS; i++) {
      const a = axes[Math.floor(rng() * axes.length)];
      let v = Math.round(a.min + rng() * (a.max - a.min));
      if (Math.round(v) === Math.round((await readAxisValue(page, a.tag)) ?? NaN)) v = v === a.max ? a.min : v + 1;
      const committed = await setAxis(page, a.ariaLabel, v);
      if (Math.round(committed) !== Math.round(v)) { uiMiss++; continue; } // not a render test
      inputOk++;
      const r = await awaitPainted(page, a.tag, v, DEFAULTS[a.tag], 3000);
      if (r.immediate !== null && Math.round(r.immediate) === Math.round(v)) immediate++;
      lat.push(r.latency);
      if (!r.ok) { renderLost++; lostDetail.push({ tag: a.tag, want: v, painted: r.last }); }
      if (i % 15 === 0) loud(`  [single ${i}/${SINGLE_ITERS}] ${a.tag}=${v} committed=${committed} -> ${r.ok ? "ok" : "RENDER-LOST"} ${r.latency}ms`);
    }

    // ---- PHASE 2: RACE HUNT — rapid v1->v2 pairs; paint MUST converge to v2 ----
    let raceTries = 0, raceStuck = 0; const raceDetail = [];
    for (let i = 0; i < RACE_PAIRS; i++) {
      const a = axes[i % axes.length];
      let v1 = Math.round(a.min + ((i * 37) % 100) / 100 * (a.max - a.min));
      let v2 = Math.round(a.min + ((i * 61) % 100) / 100 * (a.max - a.min));
      if (v2 === v1) v2 = v2 === a.max ? a.min : v2 + 1;
      const c1 = await setAxis(page, a.ariaLabel, v1);
      const delay = 25 + (i % 14) * 10; // 25..155ms — scans the 50ms debounce + commit window
      await sleep(delay);
      const c2 = await setAxis(page, a.ariaLabel, v2);
      if (Math.round(c1) !== Math.round(v1) || Math.round(c2) !== Math.round(v2)) continue; // input flake
      const r = await awaitPainted(page, a.tag, v2, DEFAULTS[a.tag], 4000);
      raceTries++;
      if (!r.ok) { raceStuck++; raceDetail.push({ tag: a.tag, want: v2, painted: r.last, delay }); }
      if (i % 10 === 0) loud(`  [race ${i}/${RACE_PAIRS}] ${a.tag} ${v1}->${v2} d=${delay}ms -> ${r.ok ? "ok" : `STUCK@${r.last}`}`);
    }

    // ---- PHASE 3: SCRUB — rapid arrow-key floods (mimics dragging/spinning a
    // value fast). Each Arrow commits, flooding update-position-data; the paint
    // MUST settle to the final input value. This is the closest repro of the
    // user's rapid interaction and the most likely to hit the commit race. ----
    let scrubTries = 0, scrubStuck = 0; const scrubDetail = [];
    for (let i = 0; i < RACE_PAIRS; i++) {
      const a = axes[i % axes.length];
      const start = Math.round(a.min + rng() * (a.max - a.min));
      const input = page.locator(`input[aria-label="${a.ariaLabel}"]`).first();
      await setAxis(page, a.ariaLabel, start);
      await input.click();
      const steps = 10 + Math.floor(rng() * 20);
      const dir2 = rng() < 0.5 ? "ArrowUp" : "ArrowDown";
      for (let k = 0; k < steps; k++) { await input.press(dir2); } // as fast as possible -> flood
      let finalV; try { finalV = parseFloat(await input.inputValue()); } catch { finalV = NaN; }
      if (!Number.isFinite(finalV)) continue;
      const r = await awaitPainted(page, a.tag, finalV, DEFAULTS[a.tag], 4000);
      scrubTries++;
      if (!r.ok) { scrubStuck++; scrubDetail.push({ tag: a.tag, want: finalV, dflt: DEFAULTS[a.tag], painted: r.last, steps }); }
      if (i % 10 === 0) loud(`  [scrub ${i}/${RACE_PAIRS}] ${a.tag} ${dir2}x${steps} -> final=${finalV} ${r.ok ? "ok" : `STUCK@${r.last}`}`);
    }

    // ---- Report ----
    lat.sort((a, b) => a - b);
    const p = (q) => lat.length ? lat[Math.min(lat.length - 1, Math.floor(q * lat.length))] : -1;
    loud("\n================ STRESS RESULTS ================");
    loud(`SINGLE: input-ok=${inputOk} (ui-miss excluded=${uiMiss})  render-lost=${renderLost}/${inputOk}  immediate=${immediate}/${inputOk}`);
    loud(`        latency p50=${p(0.5)}ms p90=${p(0.9)}ms p99=${p(0.99)}ms max=${lat.at(-1)}ms`);
    if (lostDetail.length) loud(`        RENDER-LOST: ${JSON.stringify(lostDetail.slice(0, 8))}`);
    loud(`RACE  : pairs=${raceTries}  stuck(paint != last value)=${raceStuck}/${raceTries}`);
    if (raceDetail.length) loud(`        STUCK: ${JSON.stringify(raceDetail.slice(0, 10))}`);
    loud(`SCRUB : floods=${scrubTries}  stuck(paint != final value)=${scrubStuck}/${scrubTries}`);
    if (scrubDetail.length) loud(`        STUCK: ${JSON.stringify(scrubDetail.slice(0, 10))}`);
    loud(`console errors: ${consoleErrors.length}`);
    const bug = renderLost + raceStuck + scrubStuck;
    loud(`\nVERDICT: ${bug === 0 ? "CLEAN" : "BUG REPRODUCED"}  (render-lost=${renderLost}, race-stuck=${raceStuck}, scrub-stuck=${scrubStuck})`);
    fs.rmSync(tmp, { recursive: true, force: true });
    process.exit(0);
  } catch (e) {
    loud("ERROR: " + e.stack);
    process.exit(1);
  } finally {
    try { await browser?.close(); } catch {}
    try { process.kill(srv.pid); } catch {}
  }
}

main();
