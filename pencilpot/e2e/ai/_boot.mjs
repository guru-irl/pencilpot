// Shared boot/connect helpers for the pencilpot AI-dev capability audit (A-series).
//
// Every A-harness reuses these to: copy the canonical design to a throwaway COPY,
// boot the pencilpot runtime over it, talk to it the way the headless SDK/MCP do
// (POST /api/rpc/command/get-file as json-meta + transit), and drive the explicit
// save/discard/status lifecycle. NEVER mutates the canonical design — only COPIES
// under .scratch/.
//
// SKIP contract: if the canonical design is absent, designPresent() is false and a
// harness should print a SKIP line and exit 0.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(HERE, "../../.."); // /mnt/data/src/penpot
export const RUNTIME = path.resolve(REPO, "pencilpot/runtime/server.mjs");
export const MCP_SERVER = path.resolve(REPO, "headless-core/mcp/server.mjs");
export const SRC_DESIGN = "/mnt/data/src/DefaultLauncher/design";
export const SCRATCH = path.resolve(REPO, ".scratch");

// Canonical DefaultLauncher fixture identifiers.
export const TEAM = "0398e5fc-95c9-80d6-8008-29071f0fdaed";
export const FID = "67e207c3-ec3b-80d7-8008-252de1d3a44e";
export const PID = "a0b0c325-382e-80da-8008-238861a34c9c";

// The MCP SDK lives in headless-core/node_modules; load its ESM build by path so
// it resolves regardless of where the harness file sits in the tree. No new deps.
const SDK = path.join(REPO, "headless-core/node_modules/@modelcontextprotocol/sdk/dist/esm");
export async function loadMcpClient() {
  const { Client } = await import(path.join(SDK, "client/index.js"));
  const { StdioClientTransport } = await import(path.join(SDK, "client/stdio.js"));
  return { Client, StdioClientTransport };
}

// Load the WorkingCopy SDK bound to a given runtime base. GOTCHA: sdk/rpc.mjs
// freezes BASE = PENPOT_HL_BASE at MODULE LOAD, so the env var MUST be set before
// the SDK is imported (this is also why the MCP server only honours its `base`
// option when passed as a subprocess env var). We dynamic-import after setting it.
export async function loadWorkingCopy(base) {
  process.env.PENPOT_HL_BASE = base;
  const { WorkingCopy } = await import(path.join(REPO, "headless-core/sdk/working-copy.mjs"));
  return WorkingCopy;
}

export function designPresent() {
  return fs.existsSync(SRC_DESIGN);
}

/** rm+cp the canonical design to a throwaway COPY under .scratch/, return its path. */
export function copyDesign(name) {
  fs.mkdirSync(SCRATCH, { recursive: true });
  const dest = path.join(SCRATCH, `ai-${name}-design`);
  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(SRC_DESIGN, dest, { recursive: true });
  return dest;
}

export const randomPort = () => 20000 + Math.floor(Math.random() * 40000);

export function waitForHttp(url, timeoutMs = 45000) {
  // First engine warmup blocks the event loop ~8.5s at boot, so the first GET /
  // may not answer until it finishes — allow a generous timeout.
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = async () => {
      try { const r = await fetch(url); if (r.ok) return resolve(); } catch {}
      if (Date.now() > deadline) return reject(new Error(`server did not come up: ${url}`));
      setTimeout(tick, 250);
    };
    tick();
  });
}

/** Spawn runtime/server.mjs over a design dir (legacy PENCILPOT_DESIGN mode). */
export async function spawnRuntime(dir, port = randomPort()) {
  const env = { ...process.env, PENCILPOT_DESIGN: dir, PENCILPOT_PORT: String(port) };
  const proc = spawn(process.execPath, [RUNTIME], { env, stdio: ["ignore", "inherit", "inherit"] });
  const base = `http://localhost:${port}`;
  await waitForHttp(base + "/");
  return { proc, base, port, dir };
}

export function kill(proc) { try { if (proc) process.kill(proc.pid); } catch {} }

export async function status(base) {
  const r = await fetch(base + "/pencilpot/status");
  return await r.json();
}
export async function save(base) {
  const r = await fetch(base + "/pencilpot/save", { method: "POST" });
  return await r.json();
}
export async function discard(base) {
  const r = await fetch(base + "/pencilpot/discard", { method: "POST" });
  return await r.json();
}

/** get-file the way headless-core/sdk/rpc.mjs does: json meta + transit string. */
export async function getFileViaRuntime(base, fid = FID) {
  const post = (accept) => fetch(`${base}/api/rpc/command/get-file`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: accept },
    body: JSON.stringify({ id: fid }),
  }).then((r) => r.text());
  const metaText = await post("application/json");
  const transit = await post("application/transit+json");
  let meta = null;
  try { meta = JSON.parse(metaText); } catch {}
  return { meta, metaText, transit };
}

/** Concatenated text of every on-disk page EDN under <dir>/pages — for disk asserts. */
export function readPageEdns(dir) {
  const pd = path.join(dir, "pages");
  if (!fs.existsSync(pd)) return "";
  return fs.readdirSync(pd)
    .filter((f) => f.endsWith(".edn"))
    .map((f) => fs.readFileSync(path.join(pd, f), "utf8"))
    .join("\n");
}

/** Tiny check harness: tracks pass/fail, returns a checker + a live accessor. */
export function makeChecks() {
  let ok = true;
  const check = (c, m) => { console.log(`${c ? "PASS" : "FAIL"}: ${m}`); if (!c) ok = false; };
  const passed = () => ok;
  return { check, passed };
}
