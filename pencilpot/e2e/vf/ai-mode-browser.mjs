// AI-mode BROWSER proof: boot the runtime with --ai (PENCILPOT_AI=1), load the
// workspace in Chromium, and assert (1) the integrated terminal dock auto-opens
// (xterm mounts) and (2) selecting a shape is REPORTED to the runtime so an AI
// agent's viewport()/MCP `viewport` tool sees the user's current selection.
//
// SKIP (exit 0) if the design is absent. Run: node pencilpot/e2e/vf/ai-mode-browser.mjs
import { chromium } from "../../node_modules/playwright/index.mjs";
import { FID, TEAM, SCRATCH, designPresent, copyDesign, spawnRuntime, loadWorkingCopy, randomPort, kill, makeChecks } from "../ai/_boot.mjs";
import path from "node:path";

if (!designPresent()) { console.log("SKIP: canonical design absent — ai-mode browser proof"); process.exit(0); }

const CHROME_ARGS = ["--use-gl=angle","--use-angle=swiftshader","--enable-unsafe-swiftshader","--ignore-gpu-blocklist"];
const { check, passed } = makeChecks();
let srv, browser;
try {
  const dir = copyDesign("ai-mode");
  const port = randomPort();
  const r = await spawnRuntime(dir, port, { PENCILPOT_AI: "1" });   // <-- AI mode
  srv = r.proc;

  // Pick a top-level board (single-click selects the board deterministically;
  // nested shapes need a drill-in double-click).
  const WorkingCopy = await loadWorkingCopy(r.base);
  const wc = await new WorkingCopy(FID, "local").checkout();
  const objs = JSON.parse(wc.session.objects());
  const ROOT = "00000000-0000-0000-0000-000000000000";
  const board = Object.values(objs).find(o => o.type === "frame" && o["frame-id"] === ROOT);
  check(!!board, `picked a top-level board (${board?.name} ${board?.id?.slice(0,8)})`);
  const pageId = board["page-id"] || Object.values(objs).find(o => o["page-id"])?.["page-id"];

  // config.js advertises AI mode.
  const cfg = await (await fetch(`${r.base}/js/config.js`)).text();
  check(/pencilpotAi=true/.test(cfg), "config.js advertises pencilpotAi=true");

  browser = await chromium.launch({ headless: true, args: CHROME_ARGS });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errs = [];
  page.on("console", m => { if (m.type() === "error") errs.push(m.text()); });
  page.on("pageerror", e => errs.push(String(e)));
  const url = `${r.base}/#/workspace?team-id=${TEAM}&file-id=${FID}${pageId ? `&page-id=${pageId}` : ""}`;
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(9000);                 // SPA boot + native client start

  // (1) Terminal auto-opened: xterm mounts its own `.xterm` node when the dock renders.
  const xtermCount = await page.evaluate(() => document.querySelectorAll(".xterm").length);
  check(xtermCount > 0, `integrated terminal auto-opened in AI mode (.xterm nodes: ${xtermCount})`);
  await page.screenshot({ path: path.join(SCRATCH, "ai-mode.png") });

  // (2) Selection is reported to the runtime. Click a layer row in the left
  // sidebar (a plain DOM click — deterministic, no canvas hit-testing).
  const rowInfo = await page.evaluate(() => {
    const row = document.querySelector('[data-testid="layer-row"]');
    if (!row) return null;
    row.click();
    return { text: row.textContent.trim().slice(0, 60) };
  });
  check(!!rowInfo, `clicked a layer row (${rowInfo?.text || "—"})`);
  await page.waitForTimeout(700);

  // Read it back the way an AI agent would: WorkingCopy.viewport().
  let vp = null;
  for (let i = 0; i < 25; i++) {
    vp = await wc.viewport();
    if (vp && vp.selected && vp.selected.length > 0) break;
    await page.waitForTimeout(200);
  }
  check(!!(vp && vp.ts > 0), `runtime received a viewport report (ts=${vp?.ts || 0})`);
  check(!!(vp && vp.selected && vp.selected.length > 0 && vp.selected.every(id => objs[id])),
        `viewport().selected carries valid shape ids (${(vp?.selected || []).map(s=>s.slice(0,8)).join(",") || "—"})`);
  check(!!(vp && Array.isArray(vp.shapes) && vp.shapes.length === vp.selected.length
           && vp.shapes.every(s => s.id && s.type && objs[s.id] && objs[s.id].type === s.type)),
        `viewport().shapes carries id+name+type matching the engine`);
  check(!!(vp && vp.pageId), `viewport() reports the current page (${vp?.pageName || vp?.pageId || "—"})`);

  const fatal = errs.filter(e => !/favicon|fonts.googleapis|net::ERR/i.test(e));
  check(fatal.length === 0, `no fatal console errors (${fatal.length})`, fatal.slice(0,2).join(" | "));
  console.log(passed() ? "\nALL CHECKS PASS" : "\nSOME CHECKS FAILED");
} finally { try { await browser?.close(); } catch {} kill(srv); }
process.exit(passed() ? 0 : 1);
