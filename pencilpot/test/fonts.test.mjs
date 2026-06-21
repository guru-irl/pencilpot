/**
 * Parts B + C TDD: custom font support + Google fonts CSS2 proxy
 *
 * Tests:
 *  B1. addFont writes the binary into fonts/ and updates fonts.json
 *  B2. readFonts returns empty list for fresh project
 *  B3. addFont twice accumulates both variants
 *  B4. runtime get-font-variants returns variants in Penpot transit shape
 *  B5. GET /assets/by-id/<id> serves the font binary with a font content-type
 *  C1. legacyToCSS2 correctly translates Roboto:400,700italic -> CSS2 query
 *  C2. /internal/gfonts/css returns text/css with @font-face (requires internet)
 *  C3. /internal/gfonts/css rewrites gstatic.com URLs to /internal/gfonts/font
 *  C4. /internal/gfonts/font/* proxies a gstatic font byte stream
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const ROOT = path.resolve(import.meta.dirname, "../..");
const PENCILPOT = path.resolve(import.meta.dirname, "..");
const SERVER_MJS = path.join(PENCILPOT, "runtime/server.mjs");

// ── helpers ──────────────────────────────────────────────────────────────────

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pp-fonts-"));
}

function findSystemFont() {
  const candidates = [
    "/usr/share/fonts/carlito/Carlito-Regular.ttf",
    "/usr/share/fonts/carlito/Carlito-Bold.ttf",
  ];
  for (const f of candidates) {
    if (fs.existsSync(f)) return f;
  }
  const dirs = ["/usr/share/fonts", "/usr/local/share/fonts", `${os.homedir()}/.fonts`];
  for (const d of dirs) {
    if (!fs.existsSync(d)) continue;
    // Recursive scan with a simple loop
    const found = findFontFile(d);
    if (found) return found;
  }
  return null;
}

function findFontFile(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
  for (const e of entries) {
    if (e.isDirectory()) {
      const r = findFontFile(path.join(dir, e.name));
      if (r) return r;
    } else if (e.name.endsWith(".ttf") || e.name.endsWith(".woff2")) {
      return path.join(dir, e.name);
    }
  }
  return null;
}

// Create a minimal project structure (no engine needed for font store tests)
function makeProject(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const manifest = { name: "test", designs: [], default: null, version: 1 };
  fs.writeFileSync(path.join(dir, "test.pencil"), JSON.stringify(manifest));
  fs.mkdirSync(path.join(dir, "designs"), { recursive: true });
  return dir;
}

async function waitForUrl(url, timeoutMs = 15000, intervalMs = 200) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 1000);
      const res = await fetch(url, { signal: ctrl.signal });
      clearTimeout(t);
      if (res.status < 500) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

// ── TEST 1: addFont writes file + fonts.json ──────────────────────────────────

test("addFont copies font file into fonts/ and appends to fonts.json", async (t) => {
  const systemFont = findSystemFont();
  if (!systemFont) return t.skip("no system .ttf font found");

  const dir = makeProject(tmp());

  const { addFont } = await import("../store/fonts.mjs");
  const variant = await addFont(dir, {
    file: systemFont,
    family: "TestCarlito",
    weight: 400,
    style: "normal",
  });

  // 1. fonts.json written
  const fontsJson = path.join(dir, "fonts", "fonts.json");
  assert.ok(fs.existsSync(fontsJson), "fonts.json created");

  // 2. variants array has one entry
  const data = JSON.parse(fs.readFileSync(fontsJson, "utf8"));
  assert.equal(data.variants.length, 1, "one variant in fonts.json");

  // 3. entry has required shape
  const v = data.variants[0];
  assert.ok(v.id, "variant has id");
  assert.equal(v.family, "TestCarlito", "family matches");
  assert.equal(v.weight, 400, "weight matches");
  assert.equal(v.style, "normal", "style matches");
  assert.ok(v.file, "variant has file name");
  assert.ok(v.format, "variant has format");

  // 4. actual font file copied into fonts/
  const fontFilePath = path.join(dir, "fonts", v.file);
  assert.ok(fs.existsSync(fontFilePath), `font file exists at fonts/${v.file}`);
  const srcSize = fs.statSync(systemFont).size;
  const dstSize = fs.statSync(fontFilePath).size;
  assert.equal(dstSize, srcSize, "font file has same size as source");

  // 5. returned variant matches stored variant
  assert.equal(variant.id, v.id, "returned variant id matches stored");
  assert.equal(variant.family, v.family, "returned variant family matches stored");
});

// ── TEST 2: readFonts returns empty list for fresh project ────────────────────

test("readFonts returns empty variants for a project with no fonts", async () => {
  const dir = makeProject(tmp());
  const { readFonts } = await import("../store/fonts.mjs");
  const variants = readFonts(dir);
  assert.deepEqual(variants, [], "empty variants for fresh project");
});

// ── TEST 3: addFont twice adds both variants ──────────────────────────────────

test("addFont twice accumulates both variants in fonts.json", async (t) => {
  const systemFont = findSystemFont();
  if (!systemFont) return t.skip("no system .ttf font found");

  const dir = makeProject(tmp());
  const { addFont, readFonts } = await import("../store/fonts.mjs");

  await addFont(dir, { file: systemFont, family: "Fam", weight: 400, style: "normal" });
  await addFont(dir, { file: systemFont, family: "Fam", weight: 700, style: "normal" });

  const variants = readFonts(dir);
  assert.equal(variants.length, 2, "two variants after two addFont calls");
});

// ── TEST 4: runtime get-font-variants returns variants in transit shape ────────

test("runtime get-font-variants returns added fonts in Penpot transit shape", async (t) => {
  const systemFont = findSystemFont();
  if (!systemFont) return t.skip("no system .ttf font found");

  // We only test handleRpc directly (no server process) to keep this fast + reliable.
  // Seed: project + one font
  const dir = makeProject(tmp());
  const { addFont } = await import("../store/fonts.mjs");
  await addFont(dir, { file: systemFont, family: "Carlito", weight: 400, style: "normal" });

  const { handleRpc } = await import("../runtime/rpc.mjs");

  // Create a minimal fake req/res
  let responseBody = "";
  let responseStatus = 0;
  let responseHeaders = {};
  const res = {
    writeHead(status, headers) { responseStatus = status; responseHeaders = headers; },
    end(body) { responseBody = body; },
  };

  const req = {
    url: "/api/rpc/command/get-font-variants?team-id=00000000-0000-0000-0000-000000000000",
    method: "GET",
    headers: { accept: "application/transit+json" },
  };

  const cfg = { design: null, project: dir };
  await handleRpc(req, res, cfg);

  assert.equal(responseStatus, 200, "status 200");
  assert.match(responseHeaders["content-type"] ?? "", /transit/, "transit content-type");

  // Parse transit response: it's a JSON array of transit-encoded variant maps.
  const arr = JSON.parse(responseBody);
  assert.ok(Array.isArray(arr), "response is an array");
  assert.equal(arr.length, 1, "one variant returned");

  // Each element is a transit map: ["^ ", "~:key", val, ...]
  const v = arr[0];
  assert.equal(v[0], "^ ", "transit map marker");
  // Required keys in the transit map: ~:font-family, ~:font-weight, ~:font-style,
  // ~:woff1-file-id (or woff2/ttf/otf depending on format), ~:id, ~:font-id
  const keys = v.filter((_, i) => i > 0 && i % 2 === 1);
  assert.ok(keys.includes("~:font-family"), "has font-family");
  assert.ok(keys.includes("~:font-weight"), "has font-weight");
  assert.ok(keys.includes("~:font-style"), "has font-style");
  // At least one of the file-id keys must be present
  const fileIdKeys = ["~:woff2-file-id", "~:woff1-file-id", "~:ttf-file-id", "~:otf-file-id"];
  const hasFileId = fileIdKeys.some((k) => keys.includes(k));
  assert.ok(hasFileId, `has at least one *-file-id key: found keys=${keys.join(",")}`);
});

// Regression (font double-prefix bug): the frontend's data/fonts.cljs `adapt-font-id`
// ALWAYS prepends "custom-" to the :font-id it receives. So get-font-variants must
// serve the RAW id (no leading "custom-"); serving an already-prefixed id yields a
// doubled "custom-custom-" registry key, and text edits then bake that broken id
// into every leaf so the font no longer resolves on reload.
test("get-font-variants strips a leading custom- so the frontend re-prefixes to a single custom-<id>", async (t) => {
  const systemFont = findSystemFont();
  if (!systemFont) return t.skip("no system .ttf font found");

  const dir = makeProject(tmp());
  const { addFont } = await import("../store/fonts.mjs");
  // Register a font whose stable fontId already carries the "custom-" prefix
  // (this is exactly the shape imported .penpot designs produce).
  await addFont(dir, { file: systemFont, family: "Carlito", weight: 400, style: "normal", fontId: "custom-carlito" });

  const { handleRpc } = await import("../runtime/rpc.mjs");
  let responseBody = "";
  const res = { writeHead() {}, end(body) { responseBody = body; } };
  const req = {
    url: "/api/rpc/command/get-font-variants?team-id=00000000-0000-0000-0000-000000000000",
    method: "GET",
    headers: { accept: "application/transit+json" },
  };
  await handleRpc(req, res, { design: null, project: dir });

  const v = JSON.parse(responseBody)[0];
  const idx = v.indexOf("~:font-id");
  assert.ok(idx > 0, "served variant carries ~:font-id");
  const servedFontId = v[idx + 1];
  assert.equal(servedFontId, "carlito", "leading custom- is stripped from the served font-id");
  assert.ok(!/^custom-/.test(servedFontId), "served font-id must not start with custom-");
});

// ── TEST 5: GET /assets/by-id/<id> serves font binary ────────────────────────

test("GET /assets/by-id/<variantId> serves the font binary with a font content-type", async (t) => {
  const systemFont = findSystemFont();
  if (!systemFont) return t.skip("no system .ttf font found");

  const dir = makeProject(tmp());
  const { addFont } = await import("../store/fonts.mjs");
  const variant = await addFont(dir, { file: systemFont, family: "Carlito", weight: 400, style: "normal" });

  // We also need a valid design dir so the server can start without crashing on
  // get-file. Create a minimal one with the headless engine.
  const { initProject, addDesign } = await import("../store/project.mjs");
  const { writeDesign } = await import("../store/store.mjs");
  const { createSession } = await import("../../headless-core/target/headless/penpot.js");
  const ddir = addDesign(dir, "home");
  const s = createSession(JSON.stringify({ empty: true }));
  writeDesign(ddir, JSON.parse(s.serializeStore()));

  // Pick a free port
  const { createServer } = await import("node:net");
  const port = await new Promise((resolve) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });

  // Spawn the runtime
  const pencilFile = path.join(dir, "test.pencil");
  const child = spawn(process.execPath, [SERVER_MJS], {
    env: {
      ...process.env,
      PENCILPOT_PROJECT: pencilFile,
      PENCILPOT_PORT: String(port),
    },
    stdio: "pipe",
  });
  child.stderr.on("data", (d) => {});
  child.stdout.on("data", (d) => {});

  try {
    const ready = await waitForUrl(`http://localhost:${port}/`, 15000);
    if (!ready) {
      t.diagnostic("Runtime did not start within 15 s");
      t.skip("runtime not ready");
      return;
    }

    const url = `http://localhost:${port}/assets/by-id/${variant.id}`;
    const res = await fetch(url);

    assert.equal(res.status, 200, `GET ${url} → 200`);

    const ct = res.headers.get("content-type") ?? "";
    const fontTypes = ["font/ttf", "font/woff2", "font/woff", "font/otf", "application/font", "application/octet-stream"];
    const isFont = fontTypes.some((t) => ct.includes(t));
    assert.ok(isFont, `content-type is a font type, got: ${ct}`);

    // Verify it's the right data
    const body = await res.arrayBuffer();
    const srcSize = fs.statSync(systemFont).size;
    assert.equal(body.byteLength, srcSize, "response body size matches source font");
  } finally {
    child.kill("SIGTERM");
    await new Promise((r) => child.on("exit", r));
  }
});

// ── TEST C1: legacyToCSS2 translation ────────────────────────────────────────

test("legacyToCSS2 translates Roboto:400,700,700italic to CSS2 ital,wght tuples", async () => {
  const { legacyToCSS2 } = await import("../runtime/gfonts.mjs");

  // "Roboto:400,700,700italic" → Roboto:ital,wght@0,400;0,700;1,700
  // (ital axis alphabetically before wght; upright=0, italic=1; sorted tuples)
  const result = legacyToCSS2("Roboto", ["400", "700", "700italic"]);
  // The result must be a valid CSS2 family spec: Family:ital,wght@...
  assert.match(result, /^Roboto:ital,wght@/, "starts with Roboto:ital,wght@");
  // Must include the upright 400
  assert.match(result, /0,400/, "includes 0,400 (upright 400)");
  // Must include the italic 700
  assert.match(result, /1,700/, "includes 1,700 (italic 700)");
  // Must include the upright 700
  assert.match(result, /0,700/, "includes 0,700 (upright 700)");
  // Tuples must be sorted: 0,400 before 0,700 before 1,700
  const tupleStr = result.split("@")[1];
  const tuples = tupleStr.split(";");
  assert.ok(tuples.length >= 3, `at least 3 tuples: ${result}`);
  // All tuples in ascending order
  for (let i = 0; i < tuples.length - 1; i++) {
    const a = tuples[i].split(",").map(Number);
    const b = tuples[i + 1].split(",").map(Number);
    assert.ok(
      a[0] < b[0] || (a[0] === b[0] && a[1] <= b[1]),
      `tuples sorted ascending: ${tuples[i]} <= ${tuples[i + 1]}`
    );
  }
});

test("legacyToCSS2 translates Roboto:400,700italic (2 ids) to 2 tuples", async () => {
  const { legacyToCSS2 } = await import("../runtime/gfonts.mjs");

  // "400" → upright 400; "700italic" → italic 700 — exactly 2 tuples
  const result = legacyToCSS2("Roboto", ["400", "700italic"]);
  assert.match(result, /^Roboto:ital,wght@/, "starts with Roboto:ital,wght@");
  assert.match(result, /0,400/, "includes 0,400 (upright 400)");
  assert.match(result, /1,700/, "includes 1,700 (italic 700)");
  const tupleStr = result.split("@")[1];
  const tuples = tupleStr.split(";");
  assert.equal(tuples.length, 2, `exactly 2 tuples: ${result}`);
  // Sorted: 0,400 before 1,700
  assert.equal(tuples[0], "0,400");
  assert.equal(tuples[1], "1,700");
});

test("legacyToCSS2 handles 'regular' -> 400 upright", async () => {
  const { legacyToCSS2 } = await import("../runtime/gfonts.mjs");
  const result = legacyToCSS2("Inter", ["regular"]);
  assert.match(result, /^Inter:ital,wght@0,400$/, `got: ${result}`);
});

test("legacyToCSS2 handles 'italic' alone -> 400 italic", async () => {
  const { legacyToCSS2 } = await import("../runtime/gfonts.mjs");
  const result = legacyToCSS2("Lato", ["italic"]);
  assert.match(result, /^Lato:ital,wght@1,400$/, `got: ${result}`);
});

// ── TEST C2+C3: /internal/gfonts/css route ───────────────────────────────────

test("/internal/gfonts/css returns text/css with @font-face and rewritten urls (requires internet)", async (t) => {
  // Check internet connectivity first
  let online = false;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 4000);
    const r = await fetch("https://fonts.googleapis.com/css2?family=Roboto:ital,wght@0,400&display=block", {
      signal: ctrl.signal,
      headers: { "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36" },
    });
    clearTimeout(timer);
    online = r.ok;
  } catch {}

  if (!online) return t.skip("fonts.googleapis.com not reachable — skipping gfonts proxy test");

  // Spawn the runtime server (no project needed for gfonts route)
  const { createServer } = await import("node:net");
  const port = await new Promise((resolve) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });

  const child = spawn(process.execPath, [SERVER_MJS], {
    env: { ...process.env, PENCILPOT_PORT: String(port) },
    stdio: "pipe",
  });
  child.stderr.on("data", () => {});
  child.stdout.on("data", () => {});

  try {
    const ready = await waitForUrl(`http://localhost:${port}/`, 15000);
    if (!ready) return t.skip("runtime not ready");

    // Request the gfonts CSS for Roboto:400 (legacy format)
    const url = `http://localhost:${port}/internal/gfonts/css?family=Roboto:400&display=block`;
    const res = await fetch(url);

    assert.equal(res.status, 200, `GET ${url} -> 200`);
    const ct = res.headers.get("content-type") ?? "";
    assert.match(ct, /text\/css/, `content-type is text/css, got: ${ct}`);

    const css = await res.text();
    assert.match(css, /@font-face/, "CSS contains @font-face");

    // gstatic URLs must be rewritten to /internal/gfonts/font
    assert.ok(!css.includes("fonts.gstatic.com"), "gstatic URLs are rewritten away");
    assert.match(css, /\/internal\/gfonts\/font/, "URLs rewritten to /internal/gfonts/font");
  } finally {
    child.kill("SIGTERM");
    await new Promise((r) => child.on("exit", r));
  }
});

// ── TEST C4: /internal/gfonts/font/* proxies font bytes ──────────────────────

test("/internal/gfonts/font/* proxies gstatic font bytes (requires internet)", async (t) => {
  let online = false;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 4000);
    const r = await fetch("https://fonts.googleapis.com/css2?family=Roboto:ital,wght@0,400&display=block", {
      signal: ctrl.signal,
      headers: { "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36" },
    });
    clearTimeout(timer);
    online = r.ok;
  } catch {}
  if (!online) return t.skip("fonts.googleapis.com not reachable — skipping gfonts proxy test");

  // Get an actual gstatic URL from the CSS2 API so we have a real path to proxy.
  const cssRes = await fetch("https://fonts.googleapis.com/css2?family=Roboto:ital,wght@0,400&display=block", {
    headers: { "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" },
  });
  const css = await cssRes.text();
  // Extract one gstatic path: fonts.gstatic.com/s/<path>
  const m = css.match(/https:\/\/fonts\.gstatic\.com\/s\/([^)'"]+\.woff2)/);
  if (!m) return t.skip("Could not extract a gstatic woff2 URL from CSS2 response");
  const gstaticPath = m[1]; // e.g. "roboto/v51/KFO....woff2"

  const { createServer } = await import("node:net");
  const port = await new Promise((resolve) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });

  const child = spawn(process.execPath, [SERVER_MJS], {
    env: { ...process.env, PENCILPOT_PORT: String(port) },
    stdio: "pipe",
  });
  child.stderr.on("data", () => {});
  child.stdout.on("data", () => {});

  try {
    const ready = await waitForUrl(`http://localhost:${port}/`, 15000);
    if (!ready) return t.skip("runtime not ready");

    const url = `http://localhost:${port}/internal/gfonts/font/${gstaticPath}`;
    const res = await fetch(url);

    assert.equal(res.status, 200, `GET ${url} -> 200`);
    const fontCt = res.headers.get("content-type") ?? "";
    assert.match(fontCt, /font\/woff2|application\/font|octet-stream/, `font content-type, got: ${fontCt}`);

    const buf = await res.arrayBuffer();
    assert.ok(buf.byteLength > 1000, `font bytes > 1000 bytes, got ${buf.byteLength}`);
  } finally {
    child.kill("SIGTERM");
    await new Promise((r) => child.on("exit", r));
  }
});

// ── Stage 2: variable fonts ──────────────────────────────────────────────────

const VF_FIXTURE = "/mnt/data/src/DefaultLauncher/fonts/_variable/GoogleSansFlex.ttf";

test("addVariableFont round-trips axes + instances via readFonts", async (t) => {
  if (!fs.existsSync(VF_FIXTURE)) return t.skip(`fixture missing: ${VF_FIXTURE}`);

  const dir = makeProject(tmp());
  const { addVariableFont, readFonts } = await import("../store/fonts.mjs");
  const { readFvar } = await import("../store/fvar.mjs");

  const { axes, instances } = readFvar(fs.readFileSync(VF_FIXTURE));
  const descriptor = addVariableFont(dir, {
    file: VF_FIXTURE,
    family: "Google Sans Flex",
    axes,
    instances,
  });

  // Returned descriptor carries the variable family shape: a full weight ramp
  // (100–900) sharing one VF file, under a loadable custom-<slug> font-id.
  assert.equal(descriptor.variable, true, "descriptor.variable is true");
  assert.equal(descriptor.fontId, "custom-google-sans-flex", "fontId defaults to custom-<slug>");
  assert.equal(descriptor.variants.length, 9, "9-weight ramp registered");
  assert.deepEqual(
    descriptor.variants.map((v) => v.weight),
    [100, 200, 300, 400, 500, 600, 700, 800, 900],
    "weights 100..900"
  );
  // Every variant shares the one VF file and the custom- font-id.
  for (const v of descriptor.variants) {
    assert.equal(v.fontId, "custom-google-sans-flex", "variant fontId is custom-<slug>");
    assert.equal(v.file, descriptor.file, "all variants share one VF file");
    assert.equal(v.id, `custom-google-sans-flex-w${v.weight}`, "variant id = <fontId>-w<weight>");
    assert.equal(v.variable, true, "variant.variable true");
    assert.ok(v.axes.length > 0, "axes present");
    assert.ok(v.instances.length > 0, "instances present");
  }

  // Font file copied exactly once
  assert.ok(fs.existsSync(path.join(dir, "fonts", descriptor.file)), "font file copied");

  // readFonts returns the whole ramp with variable keys preserved
  const fonts = readFonts(dir);
  assert.equal(fonts.length, 9, "nine ramp variants");
  for (const v of fonts) {
    assert.equal(v.variable, true, "readFonts preserves variable");
    assert.deepEqual(v.axes, axes, "readFonts preserves axes");
    assert.deepEqual(v.instances, instances, "readFonts preserves instances");
  }

  // Idempotent re-add: ramp stays at 9 (no duplicates)
  addVariableFont(dir, { file: VF_FIXTURE, family: "Google Sans Flex", axes, instances });
  assert.equal(readFonts(dir).length, 9, "re-add stays at nine variants");
});

test("addVariableFont omits instances key when none are supplied", async (t) => {
  if (!fs.existsSync(VF_FIXTURE)) return t.skip(`fixture missing: ${VF_FIXTURE}`);
  const dir = makeProject(tmp());
  const { addVariableFont } = await import("../store/fonts.mjs");
  const { readFvar } = await import("../store/fvar.mjs");
  const { axes } = readFvar(fs.readFileSync(VF_FIXTURE));
  const descriptor = addVariableFont(dir, { file: VF_FIXTURE, family: "VF NoInst", axes, instances: [] });
  assert.ok(!("instances" in descriptor), "no instances key on descriptor when empty");
  for (const v of descriptor.variants) {
    assert.ok(!("instances" in v), "no instances key on variant when empty");
  }
});

test("encodeTransitFontVariants emits ~:variable/~:axes/~:instances for variable variants", async () => {
  const { encodeTransitFontVariants } = await import("../runtime/rpc.mjs");
  const variants = [{
    id: "vf-demo", fontId: "vf-demo", family: "Demo VF", weight: 400, style: "normal",
    format: "ttf", variable: true,
    axes: [
      { tag: "wght", min: 100, default: 400, max: 900, name: "Weight" },
      { tag: "wdth", min: 75, default: 100, max: 125, name: "Width" },
    ],
    instances: [
      { name: "Regular", coords: { wght: 400, wdth: 100 } },
      { name: "Bold", coords: { wght: 700, wdth: 100 } },
    ],
  }];
  const arr = JSON.parse(encodeTransitFontVariants(variants));
  const map = arr[0];
  const keys = map.filter((_, i) => i > 0 && i % 2 === 1);
  assert.ok(keys.includes("~:variable"), "has ~:variable");
  assert.ok(keys.includes("~:axes"), "has ~:axes");
  assert.ok(keys.includes("~:instances"), "has ~:instances");

  // ~:variable value is true
  const variableIdx = map.indexOf("~:variable");
  assert.equal(map[variableIdx + 1], true, "~:variable === true");

  // ~:axes is a list of transit maps with tag/min/max/default/name
  const axesVal = map[map.indexOf("~:axes") + 1];
  assert.equal(axesVal.length, 2, "two axes encoded");
  const ax0 = axesVal[0];
  assert.equal(ax0[0], "^ ", "axis is a transit map");
  const axKeys = ax0.filter((_, i) => i > 0 && i % 2 === 1);
  for (const k of ["~:tag", "~:min", "~:max", "~:default", "~:name"]) {
    assert.ok(axKeys.includes(k), `axis has ${k}`);
  }

  // ~:instances → maps with ~:name + ~:coords (coords is a transit map)
  const instVal = map[map.indexOf("~:instances") + 1];
  assert.equal(instVal.length, 2, "two instances encoded");
  const inst0 = instVal[0];
  assert.equal(inst0[inst0.indexOf("~:name") + 1], "Regular", "instance name");
  const coords = inst0[inst0.indexOf("~:coords") + 1];
  assert.equal(coords[0], "^ ", "coords is a transit map");
  assert.equal(coords[coords.indexOf("~:wght") + 1], 400, "coord wght=400");
});

test("encodeTransitFontVariants omits variable keys for static variants (byte-identical)", async () => {
  const { encodeTransitFontVariants } = await import("../runtime/rpc.mjs");
  const variants = [{
    id: "demo-400-normal", fontId: "demo-400-normal", family: "Demo",
    weight: 400, style: "normal", format: "ttf",
  }];
  const arr = JSON.parse(encodeTransitFontVariants(variants));
  const keys = arr[0].filter((_, i) => i > 0 && i % 2 === 1);
  assert.ok(!keys.includes("~:variable"), "no ~:variable for static");
  assert.ok(!keys.includes("~:axes"), "no ~:axes for static");
  assert.ok(!keys.includes("~:instances"), "no ~:instances for static");

  // Exact expected static encoding (locks the byte-identical contract).
  const expected = JSON.stringify([[
    "^ ",
    "~:id", "demo-400-normal",
    "~:font-id", "demo-400-normal",
    "~:font-family", "Demo",
    "~:font-weight", 400,
    "~:font-style", "normal",
    "~:woff2-file-id", "demo-400-normal",
    "~:woff1-file-id", "demo-400-normal",
    "~:ttf-file-id", "demo-400-normal",
    "~:otf-file-id", "demo-400-normal",
  ]]);
  assert.equal(JSON.stringify(arr), expected, "static encoding unchanged");
});

// ── Stage 2: buildCSS2URL unit cases ─────────────────────────────────────────

test("buildCSS2URL static: single weight", async () => {
  const { buildCSS2URL } = await import("../runtime/gfonts.mjs");
  const url = buildCSS2URL("Roboto", {});
  assert.equal(url, "https://fonts.googleapis.com/css2?family=Roboto%3Awght%40400");
});

test("buildCSS2URL static: comma weight list", async () => {
  const { buildCSS2URL } = await import("../runtime/gfonts.mjs");
  const url = buildCSS2URL("Roboto", { weights: "400,700" });
  assert.equal(decodeURIComponent(url), "https://fonts.googleapis.com/css2?family=Roboto:wght@400;700");
});

test("buildCSS2URL static: range weights expand to 100-step list", async () => {
  const { buildCSS2URL } = await import("../runtime/gfonts.mjs");
  const url = buildCSS2URL("Inter", { weights: "100..400" });
  assert.equal(decodeURIComponent(url), "https://fonts.googleapis.com/css2?family=Inter:wght@100;200;300;400");
});

test("buildCSS2URL variable: default wght range when no axes given", async () => {
  const { buildCSS2URL } = await import("../runtime/gfonts.mjs");
  const url = buildCSS2URL("Roboto Flex", { variable: true });
  assert.equal(decodeURIComponent(url), "https://fonts.googleapis.com/css2?family=Roboto Flex:wght@100..900");
});

test("buildCSS2URL variable: axes sorted registered-then-custom alpha", async () => {
  const { buildCSS2URL } = await import("../runtime/gfonts.mjs");
  // custom GRAD (uppercase) must sort after registered wght/wdth (lowercase)
  const url = buildCSS2URL("Roboto Flex", { variable: true, axes: "GRAD,wght,wdth" });
  const spec = decodeURIComponent(url).split("family=")[1];
  // tag list before '@'
  const tagList = spec.split("@")[0].split(":")[1];
  assert.equal(tagList, "wdth,wght,GRAD", `tag order: ${tagList}`);
});
