#!/usr/bin/env node
// One-command tiered test runner for the Penpot Headless SDK.
//
// Tiers:
//   unit         — no network (session, facade, script). Always runs.
//   integration  — LIVE against penpot-hl :9101 (workingcopy.roundtrip, roundtrip).
//   e2e          — MCP server + CLI (mcp-server, cli), also LIVE.
//
// Preflight:
//   1. Ensure the build artifact target/headless/penpot.js exists; else build.
//   2. Probe http://localhost:9101 AND presence of infra/penpot-hl/test-env.json
//      -> LIVE_AVAILABLE. Live tiers run only when available (default mode), else
//      they are LOUDLY skipped and NOT counted as passed.
//
// Flags:
//   --unit   unit tier only
//   --live   require live; FAIL preflight if :9101 is down (don't skip)
//   default  auto (unit always; live tiers if available, else skipped+warned)

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const BASE = process.env.PENPOT_HL_BASE ?? "http://localhost:9101";
const ARTIFACT = path.join(root, "target/headless/penpot.js");
const ENV_FILE = path.resolve(root, "../infra/penpot-hl/test-env.json");

const TIERS = [
  { name: "unit", live: false, files: [
    "test/session.test.mjs",
    "test/facade.test.mjs",
    "test/script.test.mjs",
  ] },
  { name: "integration", live: true, files: [
    "test/workingcopy.roundtrip.test.mjs",
    "test/roundtrip.test.mjs",
  ] },
  { name: "e2e", live: true, files: [
    "test/mcp-server.test.mjs",
    "test/cli.test.mjs",
  ] },
];

const args = process.argv.slice(2);
const UNIT_ONLY = args.includes("--unit");
const REQUIRE_LIVE = args.includes("--live");

const C = {
  reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m",
  red: "\x1b[31m", green: "\x1b[32m", yellow: "\x1b[33m", cyan: "\x1b[36m",
};
const color = (c, s) => `${C[c]}${s}${C.reset}`;

function ensureBuild() {
  if (existsSync(ARTIFACT)) return;
  console.log(color("cyan", "• build artifact missing — running `npm run build`…"));
  const r = spawnSync("npm", ["run", "build"], { cwd: root, stdio: "inherit" });
  if (r.status !== 0 || !existsSync(ARTIFACT)) {
    console.error(color("red", "✖ build failed — cannot run tests"));
    process.exit(1);
  }
}

async function probeLive() {
  if (!existsSync(ENV_FILE)) return { ok: false, reason: "infra/penpot-hl/test-env.json missing" };
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 3000);
    const res = await fetch(BASE, { signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok && res.status >= 500) return { ok: false, reason: `:9101 returned HTTP ${res.status}` };
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: `:9101 not reachable (${String(e.message || e).split("\n")[0]})` };
  }
}

// Run one tier's files under `node --test`, parse the TAP summary lines.
function runTier(tier) {
  const t0 = Date.now();
  // --test-concurrency=1 serializes file execution. Live tiers share one
  // penpot-hl file; running their files in parallel races on object counts.
  const r = spawnSync(process.execPath, ["--test", "--test-concurrency=1", ...tier.files], {
    cwd: root, encoding: "utf8", env: { ...process.env, PENPOT_HL_BASE: BASE },
  });
  const out = (r.stdout || "") + (r.stderr || "");
  process.stdout.write(out);
  const num = (re) => { const m = out.match(re); return m ? Number(m[1]) : 0; };
  return {
    tests: num(/^# tests (\d+)$/m),
    pass: num(/^# pass (\d+)$/m),
    fail: num(/^# fail (\d+)$/m),
    skipped: num(/^# skipped (\d+)$/m),
    exit: r.status ?? 1,
    ms: Date.now() - t0,
  };
}

function loudSkip(reason) {
  const line = "═".repeat(72);
  console.log(color("yellow", `\n${line}`));
  console.log(color("yellow", color("bold", "  ⚠  SKIPPED integration/e2e tiers")));
  console.log(color("yellow", `     reason: ${reason}`));
  console.log(color("yellow", "     penpot-hl :9101 not reachable — run `penpot start`"));
  console.log(color("yellow", "     (or `npm run test:live` to FAIL instead of skip)"));
  console.log(color("yellow", `${line}\n`));
}

async function main() {
  ensureBuild();

  let liveAvailable = false;
  let liveReason = "";
  if (!UNIT_ONLY) {
    const probe = await probeLive();
    liveAvailable = probe.ok;
    liveReason = probe.reason || "";
    if (REQUIRE_LIVE && !liveAvailable) {
      console.error(color("red", `\n✖ --live requested but live env unavailable: ${liveReason}`));
      process.exit(1);
    }
  }

  const wall0 = Date.now();
  const results = []; // {name, status: ran|skipped, stats?}
  let skipWarned = false;

  for (const tier of TIERS) {
    if (UNIT_ONLY && tier.live) continue;
    if (tier.live && !liveAvailable) {
      if (!skipWarned) { loudSkip(liveReason); skipWarned = true; }
      results.push({ name: tier.name, status: "skipped", files: tier.files.length });
      continue;
    }
    console.log(color("cyan", color("bold", `\n▶ tier: ${tier.name}`)));
    const stats = runTier(tier);
    results.push({ name: tier.name, status: "ran", stats });
  }

  const wallMs = Date.now() - wall0;

  // SUMMARY
  const line = "─".repeat(64);
  console.log(color("bold", `\n${line}`));
  console.log(color("bold", "  TEST SUMMARY"));
  console.log(line);
  console.log(color("dim", `  ${"tier".padEnd(14)}${"tests".padStart(7)}${"pass".padStart(7)}${"fail".padStart(7)}${"skip".padStart(9)}`));
  let anyFail = false;
  let anySkipped = false;
  for (const res of results) {
    if (res.status === "skipped") {
      anySkipped = true;
      console.log(color("yellow", `  ${res.name.padEnd(14)}${"-".padStart(7)}${"-".padStart(7)}${"-".padStart(7)}${"SKIPPED".padStart(9)}`));
    } else {
      const s = res.stats;
      if (s.fail > 0 || s.exit !== 0) anyFail = true;
      const rowColor = (s.fail > 0 || s.exit !== 0) ? "red" : "green";
      console.log(color(rowColor, `  ${res.name.padEnd(14)}${String(s.tests).padStart(7)}${String(s.pass).padStart(7)}${String(s.fail).padStart(7)}${String(s.skipped).padStart(9)}`));
    }
  }
  console.log(line);
  console.log(`  wall-time: ${(wallMs / 1000).toFixed(2)}s`);
  if (anySkipped) {
    console.log(color("yellow", color("bold", "  ⚠  LIVE TIERS SKIPPED — this run is NOT a full green. Bring up penpot-hl :9101.")));
  }
  console.log(color("bold", line));

  if (anyFail) {
    console.log(color("red", color("bold", "\n✖ FAIL — one or more tests failed.\n")));
    process.exit(1);
  }
  console.log(color("green", color("bold", `\n✔ ${anySkipped ? "ran tiers passed (live tiers skipped)" : "all tiers passed"}\n`)));
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
