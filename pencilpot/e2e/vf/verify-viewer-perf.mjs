// e2e/perf: prove the headless-engine cold-start (~8.5-9.4s) no longer lands on
// the user's first request.  Boots the runtime on a COPY of the canonical
// DefaultLauncher design, waits for boot AND the boot-time engine warmup, then
// times get-view-only-bundle (prototype view) + get-file and asserts both are
// fast (no cold createSession on the user path).  SKIP (exit 0) if the canonical
// design is absent.  Run standalone: `node e2e/vf/verify-viewer-perf.mjs`.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PENCILPOT = path.resolve(HERE, "../..");
const CANONICAL = "/mnt/data/src/DefaultLauncher/design";
const FID = "67e207c3-ec3b-80d7-8008-252de1d3a44e";
const FAST_MS = 1500;   // generous warm ceiling (warm ~300ms; cold ~8.5-9.4s)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("  PASS", m); } else { fail++; console.log("  FAIL", m); } };

async function timeReq(base, method, query) {
  const t0 = performance.now();
  const r = await fetch(`${base}/api/main/methods/${method}?${query}`, {
    headers: { accept: "application/transit+json" },
  });
  const body = await r.text();
  return { ms: performance.now() - t0, status: r.status, bytes: body.length };
}

async function runOnce(iteration) {
  console.log(`\n── iteration ${iteration} ──`);
  const scratch = path.join(PENCILPOT, ".scratch");
  fs.mkdirSync(scratch, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(scratch, "perf-e2e-"));
  fs.cpSync(CANONICAL, path.join(tmp, "design"), { recursive: true });
  const port = 4900 + iteration;

  const srv = spawn(process.execPath, ["runtime/server.mjs"], {
    cwd: PENCILPOT,
    env: { ...process.env, PENCILPOT_DESIGN: path.join(tmp, "design"), PENCILPOT_PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let booted = false, warmed = false, warmMs = null;
  srv.stdout.on("data", (d) => {
    const s = String(d);
    if (s.includes("pencilpot runtime on http")) booted = true;
    const m = s.match(/engine warmed in (\d+)ms/);
    if (m) { warmed = true; warmMs = Number(m[1]); }
  });
  srv.stderr.on("data", (d) => process.stderr.write("[srv] " + d));

  try {
    for (let i = 0; i < 100 && !booted; i++) await sleep(100);
    ok(booted, "server booted");
    if (!booted) return;
    // Wait for the boot-time engine warmup to complete (so the first user request
    // is NOT the one that pays the cold cost).  Cold warmup can take ~10s.
    for (let i = 0; i < 200 && !warmed; i++) await sleep(100);
    ok(warmed, `boot warmup completed${warmMs != null ? ` (engine warmed in ${warmMs}ms)` : ""}`);

    const base = `http://localhost:${port}`;
    const bundle = await timeReq(base, "get-view-only-bundle", `file-id=${FID}`);
    console.log(`  get-view-only-bundle: ${bundle.ms.toFixed(0)}ms status=${bundle.status} bytes=${bundle.bytes}`);
    ok(bundle.status === 200, "get-view-only-bundle 200");
    ok(bundle.bytes > 1000, "get-view-only-bundle returned a real bundle");
    ok(bundle.ms < FAST_MS, `get-view-only-bundle fast (<${FAST_MS}ms) — no cold createSession on user path`);

    const gf = await timeReq(base, "get-file", `id=${FID}`);
    console.log(`  get-file: ${gf.ms.toFixed(0)}ms status=${gf.status} bytes=${gf.bytes}`);
    ok(gf.status === 200, "get-file 200");
    ok(gf.ms < FAST_MS, `get-file fast (<${FAST_MS}ms) after warmup`);
  } finally {
    srv.kill();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

(async () => {
  if (!fs.existsSync(CANONICAL)) {
    console.log("SKIP: canonical design absent at", CANONICAL);
    process.exit(0);
  }
  await runOnce(1);
  await runOnce(2);
  console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
