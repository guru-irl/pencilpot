// Verifies the image-media flow end-to-end on the STABLE SVG renderer:
//   (1) the runtime serves the canonical now-playing image at
//       /assets/by-file-media-id/<id> — HTTP 200, image/jpeg, JPEG magic bytes
//       (the data source the canvas fetches); an unknown id 404s.
//   (2) opening the now-playing page makes the canvas actually REQUEST that
//       media URL and get 200 (NOT 404) — the SVG <image> fill loads.
//   (3) programmatic "replace image": POST a generated PNG to
//       upload-file-media-object returns a NON-EMPTY media-object (uuid id,
//       width/height>0, mtype image/png), and the new id is immediately
//       servable at /assets/by-file-media-id/<new-id> (200 + the PNG bytes).
//
// This is the regression test for the media-flow fix (plan Task 6). It is
// NON-VACUOUS against the pre-fix runtime: before the fix the route did not
// exist (step 1/2 → 404) and upload-file-media-object was a no-op stub
// returning `{}` (step 3 → empty object, no servable id).
//
// Boots runtime/server.mjs (SVG renderer, no &wasm) against a throwaway COPY of
// the repaired DefaultLauncher project so the canonical design is never mutated.
// If the source project is absent, SKIPs (exit 0) with a clear message.
//
// Run: node pencilpot/e2e/vf/verify-media.mjs
import { chromium } from "../../node_modules/playwright/index.mjs";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME = path.resolve(HERE, "../../runtime/server.mjs");
const SRC = "/mnt/data/src/DefaultLauncher";          // canonical project root
const TEAM = "0398e5fc-95c9-80d6-8008-29071f0fdaed";  // synthetic team id (server.mjs TEAM_ID)
// A fill-referenced file-media-id present in the repaired design (real JPEG on disk).
const FULL_ID = "8bff608e-9e53-81dd-8008-28c8626dd48f";
const CHROME_ARGS = ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"];
const BOUNDARY = "----pencilpotMediaVerifyBoundary";

let ok = true;
const check = (c, m) => { console.log(`${c ? "PASS" : "FAIL"}: ${m}`); if (!c) ok = false; };

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
const randomPort = () => 20000 + Math.floor(Math.random() * 40000);

// A minimal, spec-valid PNG with a known size (for the replace round-trip).
function makePng(w, h) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0); ihdr.write("IHDR", 4, "ascii");
  ihdr.writeUInt32BE(w, 8); ihdr.writeUInt32BE(h, 12);
  ihdr[16] = 8; ihdr[17] = 6;
  const iend = Buffer.from([0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);
  return Buffer.concat([sig, ihdr, iend]);
}
function buildMultipart(fileBytes, { name = "Replacement", filename = "replace.png", ctype = "image/png" } = {}) {
  return Buffer.concat([
    Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="file-id"\r\n\r\n${randomUUID()}\r\n`),
    Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="name"\r\n\r\n${name}\r\n`),
    Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="is-local"\r\n\r\ntrue\r\n`),
    Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="content"; filename="${filename}"\r\nContent-Type: ${ctype}\r\n\r\n`),
    fileBytes,
    Buffer.from(`\r\n--${BOUNDARY}--\r\n`),
  ]);
}
// Decode a flat penpot transit map array ["^ ","~:k",v,...] into a JS object,
// stripping the ~: key prefix and ~u uuid value prefix (the production response form).
function decodeTransitMap(text) {
  const arr = JSON.parse(text);
  if (!Array.isArray(arr) || arr[0] !== "^ ") throw new Error("not a transit map array: " + text.slice(0, 80));
  const out = {};
  for (let i = 1; i < arr.length - 1; i += 2) {
    const key = String(arr[i]).replace(/^~:/, "");
    let val = arr[i + 1];
    if (typeof val === "string" && val.startsWith("~u")) val = val.slice(2);
    out[key] = val;
  }
  return out;
}

// ── Fixture: copy the repaired project to a throwaway dir (never touch canonical) ──
if (!fs.existsSync(SRC) || !fs.existsSync(path.join(SRC, "design"))) {
  console.log(`SKIP: source project ${SRC} (with design/) is absent — skipping media e2e (exit 0)`);
  process.exit(0);
}
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pp-media-verify-"));
const projRoot = path.join(tmpRoot, "proj");
fs.mkdirSync(projRoot, { recursive: true });
// Minimal .pencil manifest pointing at the copied design dir.
fs.writeFileSync(path.join(projRoot, "Verify.pencil"), JSON.stringify({
  name: "Verify", designs: [{ name: "d", path: "design" }], default: "d", version: 1,
}, null, 2));
fs.cpSync(path.join(SRC, "design"), path.join(projRoot, "design"), { recursive: true });
// Fonts best-effort (keeps the page from erroring on missing fonts; not required for media).
if (fs.existsSync(path.join(SRC, "fonts"))) {
  try { fs.cpSync(path.join(SRC, "fonts"), path.join(projRoot, "fonts"), { recursive: true }); } catch {}
}

const designDir = path.join(projRoot, "design");
// Derive the file id from the copied manifest.
const FID = (fs.readFileSync(path.join(designDir, "manifest.edn"), "utf8")
  .match(/:id\s+#uuid\s+"([^"]+)"/) || [])[1];
// Find the page that references the now-playing image fill.
const pagesDir = path.join(designDir, "pages");
let PID = null;
for (const f of fs.readdirSync(pagesDir)) {
  if (f.endsWith(".edn") && fs.readFileSync(path.join(pagesDir, f), "utf8").includes(FULL_ID)) {
    PID = f.replace(/\.edn$/, "");
    break;
  }
}

let srv = null, browser = null;
try {
  check(!!FID, `derived file-id from manifest (${FID})`);
  check(!!PID, `found now-playing page referencing ${FULL_ID} (page=${PID})`);

  const port = randomPort();
  const base = `http://localhost:${port}`;
  srv = spawn(process.execPath, [RUNTIME], {
    env: { ...process.env, PENCILPOT_PROJECT: projRoot, PENCILPOT_PORT: String(port) },
    stdio: ["ignore", "inherit", "inherit"],
  });
  await waitForServer(base + "/");

  // ── (1) Direct route check — the canvas's data source, no browser needed ──
  const direct = await fetch(`${base}/assets/by-file-media-id/${FULL_ID}`);
  const directBody = Buffer.from(await direct.arrayBuffer());
  check(direct.status === 200, `direct GET by-file-media-id/<id> -> 200 (got ${direct.status})`);
  check((direct.headers.get("content-type") || "").includes("image/jpeg"),
    `direct content-type is image/jpeg (got ${direct.headers.get("content-type")})`);
  check(directBody.length > 2 && directBody[0] === 0xFF && directBody[1] === 0xD8 && directBody[2] === 0xFF,
    `direct body starts with JPEG magic FF D8 FF (bytes=${directBody.slice(0, 3).toString("hex")})`);
  const unknown = await fetch(`${base}/assets/by-file-media-id/${randomUUID()}`);
  check(unknown.status === 404, `unknown media id -> 404 (got ${unknown.status})`);

  // ── (2) Browser render check — the canvas REQUESTS the media URL and gets 200 ──
  const mediaResponses = []; // {url, status}
  browser = await chromium.launch({ headless: true, args: CHROME_ARGS });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  page.on("response", (r) => {
    const u = r.url();
    if (u.includes("/assets/by-file-media-id/")) mediaResponses.push({ url: u, status: r.status() });
  });
  const wsUrl = `${base}/#/workspace?team-id=${TEAM}&file-id=${FID}&page-id=${PID}`;
  await page.goto(wsUrl, { waitUntil: "domcontentloaded" });

  // Wait (generously, swiftshader is slow) for at least one by-file-media-id response.
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline && mediaResponses.length === 0) {
    await page.waitForTimeout(500);
  }
  await page.waitForTimeout(1500); // let any in-flight media requests settle

  const got200 = mediaResponses.some((r) => r.status === 200);
  const got404 = mediaResponses.filter((r) => r.status === 404);
  console.log(`  media requests observed: ${JSON.stringify(mediaResponses.slice(0, 6))}`);
  check(mediaResponses.length > 0, `canvas requested /assets/by-file-media-id/ (count=${mediaResponses.length})`);
  check(got200, `at least one by-file-media-id request returned 200`);
  // Hard-fail on a 404 (the pre-fix failure mode); painting itself is best-effort below.
  check(got404.length === 0, `no by-file-media-id request 404'd (got ${got404.length})`);

  // Best-effort paint signal: an <image> fill node referencing the media URL.
  let imgNodes = 0;
  try {
    imgNodes = await page.evaluate(() =>
      [...document.querySelectorAll("image")].filter((n) => {
        const href = n.getAttribute("href") || n.getAttribute("xlink:href") || "";
        return href.includes("by-file-media-id") || href.startsWith("data:image");
      }).length);
  } catch {}
  console.log(`  (best-effort) painted <image> fill nodes: ${imgNodes}`);

  await browser.close(); browser = null;

  // ── (3) Replace-image round-trip — upload returns a real media-object, then serve it ──
  const png = makePng(9, 13);
  const up = await fetch(`${base}/api/main/methods/upload-file-media-object`, {
    method: "POST",
    headers: { "content-type": `multipart/form-data; boundary=${BOUNDARY}`, accept: "application/transit+json" },
    body: buildMultipart(png),
  });
  check(up.status === 200, `upload-file-media-object -> 200 (got ${up.status})`);
  let obj = {};
  try { obj = decodeTransitMap(await up.text()); } catch (e) { check(false, `upload response decodes (${e.message})`); }
  const isUuid = (s) => typeof s === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(s);
  check(isUuid(obj.id), `upload returned a uuid id (got ${obj.id})`);
  check(Number(obj.width) === 9 && Number(obj.height) === 13,
    `upload returned probed width/height (got ${obj.width}x${obj.height})`);
  check(obj.mtype === "image/png", `upload returned mtype image/png (got ${obj.mtype})`);

  const served = await fetch(`${base}/assets/by-file-media-id/${obj.id}`);
  const servedBody = Buffer.from(await served.arrayBuffer());
  check(served.status === 200, `new media id is servable -> 200 (got ${served.status})`);
  check(servedBody.equals(png), `served bytes equal the uploaded PNG (${servedBody.length}B)`);
} catch (e) {
  console.log("FAIL: harness error");
  console.error(e?.stack || String(e));
  ok = false;
} finally {
  if (browser) { try { await browser.close(); } catch {} }
  if (srv) { try { process.kill(srv.pid); } catch {} await waitForExit(srv); }
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
}

console.log(ok ? "\nALL CHECKS PASS" : "\nCHECKS FAILED");
process.exit(ok ? 0 : 1);
