// Realtime BROWSER proof — the real "work WITH the AI" test. Boot the runtime
// against a copy of the canonical design, load the workspace in Chromium, record
// a shape's on-screen rect, then drive an AI move via the SDK (separate client)
// and assert the shape MOVES live in the open SPA with NO page reload.
//
// SKIP (exit 0) if the design is absent. Run: node pencilpot/e2e/vf/realtime-browser.mjs
import { chromium } from "../../node_modules/playwright/index.mjs";
import { FID, TEAM, SCRATCH, designPresent, copyDesign, spawnRuntime, loadWorkingCopy, kill, makeChecks } from "../ai/_boot.mjs";
import fs from "node:fs";
import path from "node:path";

if (!designPresent()) { console.log("SKIP: canonical design absent — realtime browser proof"); process.exit(0); }

const CHROME_ARGS = ["--use-gl=angle","--use-angle=swiftshader","--enable-unsafe-swiftshader","--ignore-gpu-blocklist"];
const { check, passed } = makeChecks();
let srv, browser;
try {
  const dir = copyDesign("rt-browser");
  const r = await spawnRuntime(dir);
  srv = r.proc;

  // Pick a target shape (a rect/circle nested in a board) via the SDK objects map.
  const WorkingCopy = await loadWorkingCopy(r.base);
  const wc = await new WorkingCopy(FID, "local").checkout();
  const objs = JSON.parse(wc.session.objects());
  const ROOT = "00000000-0000-0000-0000-000000000000";
  const target = Object.values(objs).find(o => (o.type === "rect" || o.type === "circle") && o["frame-id"] && o["frame-id"] !== ROOT);
  check(!!target, `picked a target shape (${target?.type} ${target?.id?.slice(0,8)})`);
  const pageId = target["page-id"] || Object.values(objs).find(o => o["page-id"])?.["page-id"];

  // Load the workspace in a real browser.
  browser = await chromium.launch({ headless: true, args: CHROME_ARGS });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errs = [];
  page.on("console", m => { if (m.type() === "error") errs.push(m.text()); });
  page.on("pageerror", e => errs.push(String(e)));
  const url = `${r.base}/#/workspace?team-id=${TEAM}&file-id=${FID}${pageId ? `&page-id=${pageId}` : ""}`;
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(9000);                 // SPA boot + native SSE client start
  await page.keyboard.press("Shift+1");            // zoom-to-fit so shapes are in view
  await page.waitForTimeout(1500);

  // Sentinel to detect a page reload (would wipe this global).
  await page.evaluate(() => { window.__rtSentinel = String(Date.now()); });
  const sentinel = await page.evaluate(() => window.__rtSentinel);

  const sel = `#shape-${target.id}`;
  const rectBefore = await page.evaluate((s) => {
    const el = document.querySelector(s); if (!el) return null;
    const b = el.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height };
  }, sel);
  check(!!rectBefore, `target shape is in the DOM (${sel.slice(0,16)}…)`);
  await page.screenshot({ path: path.join(SCRATCH, "rt-before.png") });

  // AI EDIT (separate client): move the shape by a large delta + commit.
  const DX = 600, DY = 400;
  wc.moveShape(target.id, { x: (target.x ?? 0) + DX, y: (target.y ?? 0) + DY });
  await wc.commit();

  // Wait for the SSE 'changes' frame to apply in the SPA.
  let rectAfter = null;
  for (let i = 0; i < 50; i++) {
    await page.waitForTimeout(120);
    rectAfter = await page.evaluate((s) => {
      const el = document.querySelector(s); if (!el) return null;
      const b = el.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height };
    }, sel);
    if (rectBefore && rectAfter && (Math.abs(rectAfter.x - rectBefore.x) > 5 || Math.abs(rectAfter.y - rectBefore.y) > 5)) break;
  }
  await page.screenshot({ path: path.join(SCRATCH, "rt-after.png") });

  const stillThere = await page.evaluate(() => window.__rtSentinel);
  check(stillThere === sentinel, "NO page reload (sentinel survived) — live apply, not a refresh");
  check(!!(rectBefore && rectAfter), "shape rect readable before and after");
  if (rectBefore && rectAfter) {
    const dx = rectAfter.x - rectBefore.x, dy = rectAfter.y - rectBefore.y;
    check(Math.abs(dx) > 5 || Math.abs(dy) > 5, `shape MOVED live: dx=${dx.toFixed(0)} dy=${dy.toFixed(0)} px`);
    check(dx > 0 && dy > 0, `moved in the +x/+y direction of the edit (dx=${dx.toFixed(0)}, dy=${dy.toFixed(0)})`);
  }
  const fatal = errs.filter(e => !/favicon|fonts.googleapis|net::ERR/i.test(e));
  check(fatal.length === 0, `no fatal console errors (${fatal.length})`, fatal.slice(0,2).join(" | "));
  console.log(passed() ? "\nALL CHECKS PASS" : "\nSOME CHECKS FAILED");
} finally { try { await browser?.close(); } catch {} kill(srv); }
process.exit(passed() ? 0 : 1);
