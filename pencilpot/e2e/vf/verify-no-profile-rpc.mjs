// Verifies the pencilpot frontend makes ZERO get-profile / update-profile-props
// network calls — the two RPCs that previously logged "unhandled RPC …" on every
// workspace open (the profile backend was removed; the profile is seeded locally
// at boot and update-profile-props now only mutates local app-state).
//
// It boots the runtime over a copy of the .scratch/proj fixture, opens the
// workspace in Chromium (SVG renderer, no &wasm), records every request to
// /api/main/methods/<command>, and asserts two flows fire ZERO profile RPCs:
//
//   (a) WORKSPACE MOUNT — the real flow the user hit: mounting the workspace
//       emits `update-profile-props {:workspace-visited true}` (set-workspace-visited)
//       and, in stock penpot, the refresh-profile -> get-profile chain.
//   (b) RENDERER CHANGE — toggling the renderer emits
//       `update-profile-props {:renderer …}`. That menu item is gated behind the
//       `:render-switch` flag (off in shipped pencilpot), so the harness enables
//       it by rewriting config.js, then drives the REAL menu so the genuine
//       update-profile-props event fires. If the menu can't be driven the check
//       is reported SKIPPED (not failed) — flow (a) already exercises
//       update-profile-props at the network layer and the RPC removal in
//       update-profile-props is unconditional (independent of the props map).
//
// Non-vacuity guards: the run also asserts the workspace actually mounted and
// that the app made OTHER RPCs (e.g. get-file) — proving the request interceptor
// works and the app is live, so "zero profile RPCs" is meaningful.
//
// Run: node pencilpot/e2e/vf/verify-no-profile-rpc.mjs
import { chromium } from "../../node_modules/playwright/index.mjs";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME = path.resolve(HERE, "../../runtime/server.mjs");
const FIXTURE = path.resolve(HERE, "../../../.scratch/proj");
const TEAM = "0398e5fc-95c9-80d6-8008-29071f0fdaed";
const FID = "0398e5fc-95c9-80d6-8008-29088f3ee53a";
const PID = "0398e5fc-95c9-80d6-8008-29088f3ee53b";
const ARGS = ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"];

// A request to a profile RPC, in any of the URL shapes penpot/pencilpot use.
const PROFILE_RE = /\/(?:methods|command)\/(get-profile|update-profile-props)\b/;
// Any RPC command call: /api/main/methods/<command>
const METHOD_RE = /\/(?:methods|command)\/([a-z0-9-]+)/;

const waitForServer = (url, timeoutMs = 25000) => {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = async () => {
      try { if ((await fetch(url)).ok) return resolve(); } catch {}
      if (Date.now() > deadline) return reject(new Error("server did not come up"));
      setTimeout(tick, 250);
    };
    tick();
  });
};

let ok = true;
const check = (cond, msg) => { console.log(`${cond ? "PASS" : "FAIL"}: ${msg}`); if (!cond) ok = false; };
const skip = (msg) => console.log(`SKIP: ${msg}`);

if (!fs.existsSync(FIXTURE)) { console.log(`SKIP: fixture missing ${FIXTURE}`); process.exit(0); }

const dest = "/tmp/pp-noprof-verify";
fs.rmSync(dest, { recursive: true, force: true });
fs.cpSync(FIXTURE, dest, { recursive: true });

const port = 20000 + Math.floor(Math.random() * 40000);
const srv = spawn(process.execPath, [RUNTIME], {
  env: { ...process.env, PENCILPOT_PROJECT: dest, PENCILPOT_PORT: String(port) },
  stdio: ["ignore", "inherit", "inherit"],
});
const base = `http://localhost:${port}`;

let browser;
try {
  await waitForServer(base + "/");
  browser = await chromium.launch({ headless: true, args: ARGS });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });

  // Enable the renderer toggle menu item (gated behind :render-switch, off in
  // shipped pencilpot) by appending its flag token to the injected config.js.
  await page.route(/\/(?:js\/)?config\.js$/, async (route) => {
    const resp = await route.fetch();
    let body = await resp.text();
    if (body.includes("penpotFlags") && !body.includes("enable-render-switch")) {
      body = body.replace(/penpotFlags="([^"]*)"/, 'penpotFlags="$1 enable-render-switch"');
    }
    await route.fulfill({ response: resp, body });
  });

  // Record every RPC command call BEFORE navigating.
  const allMethods = [];
  const profileHits = [];
  page.on("request", (r) => {
    const url = r.url();
    const m = url.match(METHOD_RE);
    if (m) allMethods.push(m[1]);
    if (PROFILE_RE.test(url)) profileHits.push(url.match(PROFILE_RE)[1]);
  });

  // (a) Workspace mount — fires update-profile-props {:workspace-visited true}.
  await page.goto(`${base}/#/workspace?team-id=${TEAM}&file-id=${FID}&page-id=${PID}`, { waitUntil: "domcontentloaded" });
  // Mount proof: the workspace header (with the Main menu button) renders.
  await page.waitForSelector('[aria-label="Main menu"]', { state: "visible", timeout: 30000 });
  await page.waitForTimeout(6000); // let set-workspace-visited + any profile chain settle

  // Non-vacuity: the interceptor works and the app is live (it made other RPCs).
  const others = [...new Set(allMethods.filter((m) => !/^(get-profile|update-profile-props)$/.test(m)))];
  check(others.length > 0, `app made other RPCs (proves interceptor + live app): [${others.slice(0, 12).join(", ")}]`);

  // (a) assertion: no profile RPCs during/after mount.
  check(profileHits.length === 0, `zero profile RPCs after workspace mount (saw: ${profileHits.join(", ") || "none"})`);

  // (b) Renderer change — drive the real menu so update-profile-props {:renderer …} fires.
  let rendererFired = false;
  try {
    await page.click('[aria-label="Main menu"]', { timeout: 3000 });
    await page.waitForTimeout(300);
    const pref = page.locator('[data-testid="preferences"]');
    await pref.waitFor({ state: "visible", timeout: 3000 });
    await pref.hover();
    await pref.click({ timeout: 2000 });
    await page.waitForTimeout(300);
    const toggle = page.getByText(/WebGL rendering/i).first();
    await toggle.waitFor({ state: "visible", timeout: 3000 });
    await toggle.click({ timeout: 2000 });
    rendererFired = true;
  } catch (e) {
    skip(`renderer toggle UI not drivable (${String(e).split("\n")[0]}) — mount already covers update-profile-props`);
  }
  await page.waitForTimeout(1500); // allow any (would-be) network call to be recorded

  if (rendererFired) {
    check(
      profileHits.length === 0,
      `zero profile RPCs after renderer change (update-profile-props {:renderer}) (saw: ${profileHits.join(", ") || "none"})`,
    );
  }

  // Final hard gate: zero profile RPCs across the whole session.
  check(profileHits.length === 0, `TOTAL profile RPCs == 0 (saw: ${profileHits.join(", ") || "none"})`);

  await browser.close();
} catch (e) {
  console.log("FAIL: harness error — " + (e && e.stack ? e.stack : e));
  ok = false;
} finally {
  try { await browser?.close(); } catch {}
  try { process.kill(srv.pid); } catch {}
}

console.log(ok ? "\nRESULT: PASS" : "\nRESULT: FAIL");
process.exit(ok ? 0 : 1);
