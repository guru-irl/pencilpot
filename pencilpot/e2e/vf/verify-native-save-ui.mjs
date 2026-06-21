// T9 integration verification for the native-save-UI + injection-teardown work.
// Boots the pencilpot runtime against a throwaway design copy, loads the
// workspace with the freshly-built frontend, and asserts runtime behavior.
//
// Usage: node verify-native-save-ui.mjs <projectRoot> <fileId> <pageId>
import { chromium } from "../../node_modules/playwright/index.mjs";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME = path.resolve(HERE, "../../runtime/server.mjs");
const TEAM_ID = "0398e5fc-95c9-80d6-8008-29071f0fdaed";
const CHROME_ARGS = ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"];

const [projectRoot, fileId, pageId] = process.argv.slice(2);
const port = 20000 + Math.floor(Math.random() * 40000);
const manifestPath = path.join(projectRoot, "designs", "home", "manifest.edn");

const results = [];
const ok = (name, pass, detail = "") => { results.push({ name, pass, detail }); console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`); };

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

const srv = spawn(process.execPath, [RUNTIME], {
  env: { ...process.env, PENCILPOT_PROJECT: projectRoot, PENCILPOT_PORT: String(port) },
  stdio: ["ignore", "inherit", "inherit"],
});

try {
  await waitForServer(`http://localhost:${port}/`, 25000);

  // ── 1. Served config.js: only the 3 native globals, no injected script ──
  const cfg = await (await fetch(`http://localhost:${port}/js/config.js`)).text();
  const hasThree = /penpotPublicURI/.test(cfg) && /penpotFlags/.test(cfg) && /pencilpotFile/.test(cfg);
  const noInject = !/liveUpdateScript|pencilpotBuild|pencilpot-save-badge|createElement/.test(cfg);
  ok("config.js has 3 native globals", hasThree, cfg.slice(0, 120).replace(/\n/g, " "));
  ok("config.js carries NO injected save-script", noInject);

  const browser = await chromium.launch({ headless: true, args: CHROME_ARGS });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const consoleErrors = [];
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
  page.on("pageerror", (e) => consoleErrors.push(String(e)));

  // SVG renderer (no wasm=true) — pencilpot's preferred path.
  const url = `http://localhost:${port}/#/workspace?team-id=${TEAM_ID}&file-id=${fileId}&page-id=${pageId}`;
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(9000); // let the SPA boot + native client start

  // ── 2. Boots cleanly with the rebuilt bundle (new namespace/init OK) ──
  const fatal = consoleErrors.filter((e) => /pencilpot|start-client|TypeError|is not a function|Uncaught/i.test(e));
  ok("workspace boots without pencilpot-related console errors", fatal.length === 0, fatal.slice(0, 2).join(" | "));

  // ── 3. Injection gone at runtime (old injected DOM ids absent) ──
  const injectionDom = await page.evaluate(() => ({
    badge: !!document.getElementById("pencilpot-save-badge"),
    banner: !!document.getElementById("pencilpot-live-banner"),
    oldFlag: !!window.__pencilpotLiveStarted,
    buildGlobal: typeof window.pencilpotBuild !== "undefined",
    fileGlobal: !!window.pencilpotFile,
    titleDot: /[●…]/.test(document.title),
  }));
  ok("no injected save-badge in DOM", !injectionDom.badge);
  ok("no injected live-banner in DOM", !injectionDom.banner);
  ok("no old __pencilpotLiveStarted flag", !injectionDom.oldFlag);
  ok("no pencilpotBuild global", !injectionDom.buildGlobal);
  ok("pencilpotFile global present (native UI enabled)", injectionDom.fileGlobal);
  ok("tab title has NO ● / … dot (status moved to header)", !injectionDom.titleDot);

  // ── 4. Native header save-status text present (one of the three labels) ──
  const statusText = await page.evaluate(() => {
    const txt = document.body.innerText || "";
    return ["Saved", "Unsaved changes", "Saving…"].find((s) => txt.includes(s)) || null;
  });
  ok("native header shows a save-status label", statusText !== null, statusText || "none found");

  // ── 5. Clean open is not spuriously dirty (issue 1 / T1) ──
  // Give it a moment of idle; status should settle to Saved, not Unsaved.
  await page.waitForTimeout(2500);
  const dirtyOnIdle = await page.evaluate(() => (document.body.innerText || "").includes("Unsaved changes"));
  ok("clean idle open is NOT spuriously 'Unsaved changes' (T1)", !dirtyOnIdle, dirtyOnIdle ? "shows Unsaved on idle" : "");

  // ── 6. File menu has pencilpot Save + Rename items (by explicit id) ──
  // Open the main menu (hamburger) then the File submenu, then look for ids.
  let menuSave = false, menuRename = false;
  try {
    await page.locator('[aria-label="Main menu"]').first().click({ timeout: 4000 });
    await page.waitForTimeout(500);
    await page.locator('[data-testid="file"]').first().click({ timeout: 3000 });
    await page.waitForTimeout(600);
    menuSave = (await page.locator("#file-menu-pencilpot-save").count()) > 0;
    menuRename = (await page.locator("#file-menu-pencilpot-rename").count()) > 0;
  } catch (e) { /* menu nav best-effort */ }
  ok("File menu exposes pencilpot Save item", menuSave);
  ok("File menu exposes pencilpot Rename item", menuRename);

  // close any open menu
  await page.keyboard.press("Escape").catch(() => {});
  await page.waitForTimeout(300);

  // ── 7. End-to-end rename persistence (T2+T3+T4): rename via header dbl-click ──
  const nameBefore = fs.readFileSync(manifestPath, "utf8").match(/:name\s+"([^"]*)"/)?.[1];
  const NEW_NAME = "Pencilpot Verify " + Date.now() % 100000;
  let renamePersisted = false, renameErr = "";
  try {
    // double-click the file-name title (reliable [title=...] selector) to edit
    await page.locator(`[title="${nameBefore || "Headless Test File"}"]`).first().dblclick({ timeout: 5000 });
    await page.waitForTimeout(500);
    const input = page.locator('input[class*="file-name-input"]').first();
    await input.waitFor({ state: "visible", timeout: 4000 });
    await input.fill(NEW_NAME);
    await input.press("Enter");
    await page.waitForTimeout(1200);
    // explicit save to flush working copy to disk
    await fetch(`http://localhost:${port}/pencilpot/save`, { method: "POST" });
    await page.waitForTimeout(800);
    const nameAfter = fs.readFileSync(manifestPath, "utf8").match(/:name\s+"([^"]*)"/)?.[1];
    renamePersisted = nameAfter === NEW_NAME;
    renameErr = `before="${nameBefore}" after="${nameAfter}" expected="${NEW_NAME}"`;
  } catch (e) { renameErr = String(e).slice(0, 160); }
  ok("rename persists to manifest after save (T2+T3+T4)", renamePersisted, renameErr);

  await browser.close();
  ok("total console errors", true, `${consoleErrors.length} (non-fatal counted separately)`);
} catch (e) {
  ok("harness ran", false, String(e.stack || e).slice(0, 400));
} finally {
  try { process.kill(srv.pid); } catch {}
}

const failed = results.filter((r) => !r.pass);
console.log(`\n=== ${results.length - failed.length}/${results.length} checks passed ===`);
process.exit(failed.length ? 1 : 0);
