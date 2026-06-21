#!/usr/bin/env node
// One-command tiered test runner for Pencilpot (Phases 1–3).
//
// Tiers:
//   unit         — no network/browser. engine build required.
//                  headless-core/test/store.test.mjs
//                  pencilpot/test/store.test.mjs
//                  pencilpot/test/project.test.mjs
//                  pencilpot/test/live.test.mjs
//   integration  — engine build, no browser/live needed.
//                  pencilpot/test/rpc.test.mjs
//                  pencilpot/test/library.test.mjs
//                  pencilpot/test/cli.test.mjs
//                  pencilpot/test/fonts.test.mjs
//                  pencilpot/test/terminal.test.mjs  (PTY <-> WS bridge)
//   desktop      — smoke: bash pencilpot/scripts/verify-desktop.sh
//                  Runs only when `pencilpot` is on PATH AND
//                  ~/.local/share/applications/pencilpot.desktop exists.
//                  LOUDLY skipped (not failed) when not installed.
//   e2e          — Playwright + penpot-hl :9101. Seeds a project, starts the runtime.
//                  pencilpot/e2e/boot.spec.mjs + edit.spec.mjs + library.spec.mjs
//                  + terminal.spec.mjs (integrated terminal dock; headless-safe)
//
// Preflight:
//   1. Ensure headless-core/target/headless/penpot.js exists; else build.
//   2. Probe http://localhost:9101 AND infra/penpot-hl/test-env.json → LIVE.
//      e2e runs only when LIVE. If not LIVE, e2e is LOUDLY skipped (not failed).
//
// Flags:
//   --unit   run unit + integration only (never desktop smoke or e2e)
//   --live   require penpot-hl :9101; FAIL preflight if down
//   (none)   auto: unit+integration+desktop always; e2e if live, else skip+warn

import { spawnSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";

// Resolve all paths from this script's location so it works from any cwd.
const HERE = path.dirname(fileURLToPath(import.meta.url));       // pencilpot/
const ROOT = path.resolve(HERE, "..");                           // repo root
const HC   = path.join(ROOT, "headless-core");                   // headless-core/
const ARTIFACT  = path.join(HC, "target/headless/penpot.js");
const ENV_FILE  = path.join(ROOT, "infra/penpot-hl/test-env.json");
const BUNDLE    = path.join(ROOT, "frontend/resources/public/index.html");
const HL_BASE   = process.env.PENPOT_HL_BASE ?? "http://localhost:9101";
const RT_PORT   = process.env.PENCILPOT_PORT ?? "7777";
const RT_BASE   = `http://localhost:${RT_PORT}`;
const SCRATCH      = path.join(HERE, ".scratch", "proj");
const PENCIL_FILE  = path.join(SCRATCH, "demo.pencil");
const DESIGN_DIR   = path.join(SCRATCH, "designs", "home");

const args = process.argv.slice(2);
const UNIT_ONLY    = args.includes("--unit");
const REQUIRE_LIVE = args.includes("--live");

// ── colours ──────────────────────────────────────────────────────────────────
const C = {
  reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m",
  red: "\x1b[31m", green: "\x1b[32m", yellow: "\x1b[33m", cyan: "\x1b[36m",
};
const col = (c, s) => `${C[c]}${s}${C.reset}`;

// ── preflight: engine build ───────────────────────────────────────────────────
function ensureBuild() {
  if (existsSync(ARTIFACT)) return;
  console.log(col("cyan", "• engine artifact missing — running `npm run build` in headless-core…"));
  const r = spawnSync("npm", ["run", "build"], { cwd: HC, stdio: "inherit" });
  if (r.status !== 0 || !existsSync(ARTIFACT)) {
    console.error(col("red", "✖ build failed — cannot run tests"));
    process.exit(1);
  }
}

// ── preflight: probe penpot-hl ───────────────────────────────────────────────
async function probeLive() {
  if (!existsSync(ENV_FILE)) return { ok: false, reason: "infra/penpot-hl/test-env.json missing" };
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 3000);
    const res = await fetch(HL_BASE, { signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok && res.status >= 500) return { ok: false, reason: `:9101 returned HTTP ${res.status}` };
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: `:9101 not reachable (${String(e.message || e).split("\n")[0]})` };
  }
}

// ── run node --test tier ─────────────────────────────────────────────────────
function runNodeTier(files) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, ["--test", "--test-concurrency=1", ...files], {
    cwd: ROOT, encoding: "utf8",
    env: { ...process.env, PENPOT_HL_BASE: HL_BASE },
  });
  const out = (r.stdout || "") + (r.stderr || "");
  process.stdout.write(out);
  const num = (re) => { const m = out.match(re); return m ? Number(m[1]) : 0; };
  return {
    tests: num(/^# tests (\d+)$/m),
    pass:  num(/^# pass (\d+)$/m),
    fail:  num(/^# fail (\d+)$/m),
    skip:  num(/^# skipped (\d+)$/m),
    exit:  r.status ?? 1,
    ms:    Date.now() - t0,
  };
}

// ── poll until a URL answers or timeout ──────────────────────────────────────
async function waitForUrl(url, timeoutMs = 20_000, intervalMs = 300) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 1500);
      const res = await fetch(url, { signal: ctrl.signal });
      clearTimeout(t);
      if (res.ok || res.status < 500) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

// ── e2e: seed + start runtime server + playwright + teardown ─────────────────
async function runE2eTier() {
  const t0 = Date.now();

  // 1. Seed the project from penpot-hl.
  console.log(col("cyan", "  seeding project from penpot-hl…"));
  const seed = spawnSync(
    process.execPath, ["scripts/seed-from-hl.mjs"],
    { cwd: HERE, stdio: "inherit", env: { ...process.env } }
  );
  if (seed.status !== 0) {
    console.error(col("red", "✖ seed-from-hl.mjs failed"));
    return { tests: 0, pass: 0, fail: 1, skip: 0, exit: 1, ms: Date.now() - t0 };
  }

  // 2. Start the runtime server.
  console.log(col("cyan", `  starting runtime server on ${RT_BASE}…`));
  let serverProc = null;
  try {
    serverProc = spawn(
      process.execPath, [path.join(HERE, "runtime/server.mjs")],
      {
        cwd: HERE,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          PENCILPOT_PORT:    RT_PORT,
          PENCILPOT_PROJECT: PENCIL_FILE,
        },
      }
    );
    serverProc.stdout.on("data", (d) => process.stdout.write(d));
    serverProc.stderr.on("data", (d) => process.stderr.write(d));
    serverProc.on("error", (e) => console.error(col("red", `server error: ${e}`)));

    // 3. Wait for server readiness.
    const ready = await waitForUrl(RT_BASE, 20_000);
    if (!ready) {
      console.error(col("red", `✖ runtime server did not become ready at ${RT_BASE} within 20 s`));
      serverProc.kill("SIGTERM");
      return { tests: 0, pass: 0, fail: 1, skip: 0, exit: 1, ms: Date.now() - t0 };
    }
    console.log(col("green", `  runtime ready at ${RT_BASE}`));

    // 4. Run Playwright.
    const pw = spawnSync(
      "npx", ["playwright", "test"],
      {
        cwd: HERE,
        encoding: "utf8",
        env: { ...process.env, PENCILPOT_PORT: RT_PORT },
        stdio: "pipe",
      }
    );
    const out = (pw.stdout || "") + (pw.stderr || "");
    process.stdout.write(out);

    // Parse playwright summary: "N passed", "N failed", "N skipped"
    const num = (re) => { const m = out.match(re); return m ? Number(m[1]) : 0; };
    const passed  = num(/(\d+)\s+passed/);
    const failed  = num(/(\d+)\s+failed/);
    const skipped = num(/(\d+)\s+skipped/);
    const total   = passed + failed + skipped || num(/(\d+)\s+test/);
    return {
      tests: total,
      pass:  passed,
      fail:  failed,
      skip:  skipped,
      exit:  pw.status ?? 1,
      ms:    Date.now() - t0,
    };
  } finally {
    // 5. Always kill the server.
    if (serverProc && !serverProc.killed) {
      serverProc.kill("SIGTERM");
      // Give it a moment to exit cleanly.
      await new Promise((r) => setTimeout(r, 500));
      if (!serverProc.killed) serverProc.kill("SIGKILL");
    }
  }
}

// ── LOUD skip block (penpot-hl not live) ─────────────────────────────────────
function loudSkipE2e(reason) {
  const line = "═".repeat(72);
  console.log(col("yellow", `\n${line}`));
  console.log(col("yellow", col("bold", "  ⚠  SKIPPED e2e tier")));
  console.log(col("yellow", `     reason: ${reason}`));
  console.log(col("yellow", "     penpot-hl :9101 not reachable — run `penpot start`"));
  console.log(col("yellow", "     (or `npm run test:e2e` / `node run-tests.mjs --live` to FAIL instead)"));
  console.log(col("yellow", `${line}\n`));
}

// ── desktop: detect installation + run smoke ─────────────────────────────────
function desktopInstalled() {
  const onPath = spawnSync("command", ["-v", "pencilpot"], { shell: true });
  const hasDesktop = existsSync(path.join(os.homedir(), ".local", "share", "applications", "pencilpot.desktop"));
  return onPath.status === 0 && hasDesktop;
}

function runDesktopSmoke() {
  const t0 = Date.now();
  const script = path.join(HERE, "scripts", "verify-desktop.sh");
  const r = spawnSync("bash", [script], { stdio: "inherit" });
  return { exit: r.status ?? 1, ms: Date.now() - t0 };
}

function loudSkipDesktop() {
  const line = "═".repeat(72);
  console.log(col("yellow", `\n${line}`));
  console.log(col("yellow", col("bold", "  ⚠  SKIPPED desktop smoke")));
  console.log(col("yellow", "     Desktop integration not installed — run `pencilpot install-desktop`"));
  console.log(col("yellow", "     (or ensure ~/.local/share/applications/pencilpot.desktop exists)"));
  console.log(col("yellow", `${line}\n`));
}

// ── LOUD skip block (frontend bundle not built) ───────────────────────────────
function loudSkipE2eBundle() {
  const line = "═".repeat(72);
  console.log(col("yellow", `\n${line}`));
  console.log(col("yellow", col("bold", "  ⚠  SKIPPED e2e — frontend bundle not built")));
  console.log(col("yellow", `     Missing: frontend/resources/public/index.html`));
  console.log(col("yellow", "     Build it first — see docs/pencilpot/architecture/02-frontend-build.md"));
  console.log(col("yellow", `${line}\n`));
}

// ── main ──────────────────────────────────────────────────────────────────────
async function main() {
  ensureBuild();

  // Probe live availability (unless --unit suppresses e2e entirely).
  let liveAvailable = false;
  let liveReason = "";
  if (!UNIT_ONLY) {
    const probe = await probeLive();
    liveAvailable = probe.ok;
    liveReason = probe.reason || "";
    if (REQUIRE_LIVE && !liveAvailable) {
      console.error(col("red", `\n✖ --live requested but penpot-hl unavailable: ${liveReason}`));
      process.exit(1);
    }
  }

  const wall0 = Date.now();
  const results = [];  // { name, status: "ran"|"skipped", stats? }

  // ── unit tier ───────────────────────────────────────────────────────────────
  {
    const files = [
      path.join(HC,   "test/store.test.mjs"),
      path.join(HERE, "test/store.test.mjs"),
      path.join(HERE, "test/project.test.mjs"),
      path.join(HERE, "test/live.test.mjs"),
    ];
    console.log(col("cyan", col("bold", "\n▶ tier: unit")));
    const stats = runNodeTier(files);
    results.push({ name: "unit", status: "ran", stats });
  }

  // ── integration tier ────────────────────────────────────────────────────────
  {
    const files = [
      path.join(HERE, "test/rpc.test.mjs"),
      path.join(HERE, "test/library.test.mjs"),
      path.join(HERE, "test/cli.test.mjs"),
      path.join(HERE, "test/fonts.test.mjs"),
      path.join(HERE, "test/import-media.test.mjs"),
      path.join(HERE, "test/media-route.test.mjs"),
      path.join(HERE, "test/terminal.test.mjs"),
    ];
    console.log(col("cyan", col("bold", "\n▶ tier: integration")));
    const stats = runNodeTier(files);
    results.push({ name: "integration", status: "ran", stats });
  }

  // ── desktop smoke tier ───────────────────────────────────────────────────────
  if (!UNIT_ONLY) {
    if (desktopInstalled()) {
      console.log(col("cyan", col("bold", "\n▶ tier: desktop smoke")));
      const { exit, ms } = runDesktopSmoke();
      // Report as pass/fail row (no node test counts — it's a script)
      const stats = { tests: 1, pass: exit === 0 ? 1 : 0, fail: exit === 0 ? 0 : 1, skip: 0, exit, ms };
      results.push({ name: "desktop", status: "ran", stats });
    } else {
      loudSkipDesktop();
      results.push({ name: "desktop", status: "skipped" });
    }
  }

  // ── e2e tier ─────────────────────────────────────────────────────────────────
  if (!UNIT_ONLY) {
    const bundleExists = existsSync(BUNDLE);
    if (!bundleExists) {
      loudSkipE2eBundle();
      results.push({ name: "e2e", status: "skipped" });
    } else if (!liveAvailable) {
      loudSkipE2e(liveReason);
      results.push({ name: "e2e", status: "skipped" });
    } else {
      console.log(col("cyan", col("bold", "\n▶ tier: e2e")));
      const stats = await runE2eTier();
      results.push({ name: "e2e", status: "ran", stats });
    }
  }

  const wallMs = Date.now() - wall0;

  // ── SUMMARY TABLE ─────────────────────────────────────────────────────────
  const line = "─".repeat(66);
  console.log(col("bold", `\n${line}`));
  console.log(col("bold", "  PENCILPOT TEST SUMMARY"));
  console.log(line);
  console.log(col("dim", `  ${"tier".padEnd(14)}${"tests".padStart(7)}${"pass".padStart(7)}${"fail".padStart(7)}${"skip".padStart(9)}${"time".padStart(9)}`));
  let anyFail = false;
  let anySkipped = false;
  for (const res of results) {
    if (res.status === "skipped") {
      anySkipped = true;
      console.log(col("yellow", `  ${res.name.padEnd(14)}${"-".padStart(7)}${"-".padStart(7)}${"-".padStart(7)}${"SKIPPED".padStart(9)}${"-".padStart(9)}`));
    } else {
      const s = res.stats;
      const bad = s.fail > 0 || s.exit !== 0;
      if (bad) anyFail = true;
      const rowCol = bad ? "red" : "green";
      const timeStr = `${(s.ms / 1000).toFixed(1)}s`;
      console.log(col(rowCol, `  ${res.name.padEnd(14)}${String(s.tests).padStart(7)}${String(s.pass).padStart(7)}${String(s.fail).padStart(7)}${String(s.skip).padStart(9)}${timeStr.padStart(9)}`));
    }
  }
  console.log(line);
  console.log(`  wall-time: ${(wallMs / 1000).toFixed(2)}s`);
  if (anySkipped) {
    const e2eSkipped  = results.some((r) => r.name === "e2e"     && r.status === "skipped");
    const deskSkipped = results.some((r) => r.name === "desktop" && r.status === "skipped");
    const bundleExists = existsSync(BUNDLE);
    if (deskSkipped) {
      console.log(col("yellow", col("bold", "  ⚠  desktop SKIPPED — run `pencilpot install-desktop` then re-run.")));
    }
    if (e2eSkipped) {
      if (!bundleExists) {
        console.log(col("yellow", col("bold", "  ⚠  e2e SKIPPED — build the frontend bundle (see docs/pencilpot/architecture/02-frontend-build.md).")));
      } else {
        console.log(col("yellow", col("bold", "  ⚠  e2e SKIPPED — not a full green. Bring up penpot-hl :9101.")));
      }
    }
  }
  console.log(col("bold", line));

  if (anyFail) {
    console.log(col("red", col("bold", "\n✖ FAIL — one or more tests failed.\n")));
    process.exit(1);
  }
  const skippedNames = results.filter((r) => r.status === "skipped").map((r) => r.name);
  const suffix = skippedNames.length ? ` (${skippedNames.join(", ")} skipped)` : "";
  console.log(col("green", col("bold", `\n✔ passed${suffix}\n`)));
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
