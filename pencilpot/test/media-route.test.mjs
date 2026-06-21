import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { resolveMediaAsset } from "../runtime/media.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));        // pencilpot/test
const SERVER = path.join(HERE, "..", "runtime", "server.mjs");    // pencilpot/runtime/server.mjs

// ── fixture ids ──────────────────────────────────────────────────────────────
const ID_FULL  = "8bff608e-9e53-81dd-8008-28c85d54c3bf"; // full image only
const ID_THUMB = "8bff608e-9e53-81dd-8008-28c8626dd48f"; // full image + thumbnail
const ID_NONE  = "00000000-0000-0000-0000-000000000000"; // not on disk

const FULL_BYTES   = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const FULL2_BYTES  = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 8, 7]);
const THUMB_BYTES  = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 4, 5, 6]);

// ── build a minimal but real design dir with media fixtures ──────────────────
function makeDesignDir() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pp-media-"));
  const design = path.join(root, "home");
  fs.mkdirSync(path.join(design, "pages"), { recursive: true });
  fs.mkdirSync(path.join(design, "components"), { recursive: true });
  const media = path.join(design, "media");
  fs.mkdirSync(media, { recursive: true });

  fs.writeFileSync(path.join(design, "manifest.edn"),
    `{:id #uuid "11111111-1111-1111-1111-111111111111" :name "Home"}`);

  // id1: full image + sidecar
  fs.writeFileSync(path.join(media, `${ID_FULL}.png`), FULL_BYTES);
  fs.writeFileSync(path.join(media, `${ID_FULL}.json`),
    JSON.stringify({ width: 2, height: 2, mtype: "image/png", name: "full" }));

  // id2: full image + thumbnail + sidecar
  fs.writeFileSync(path.join(media, `${ID_THUMB}.png`), FULL2_BYTES);
  fs.writeFileSync(path.join(media, `${ID_THUMB}.thumbnail.png`), THUMB_BYTES);
  fs.writeFileSync(path.join(media, `${ID_THUMB}.json`),
    JSON.stringify({ width: 4, height: 4, mtype: "image/png", name: "thumbed" }));

  return { root, design, media };
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function bootServer(designDir, port) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [SERVER], {
      env: {
        ...process.env,
        PENCILPOT_PORT: String(port),
        PENCILPOT_DESIGN: designDir, // legacy mode: absolute existing design dir
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    const onData = (d) => {
      out += d.toString();
      if (out.includes("pencilpot runtime on http://localhost:")) {
        proc.stdout.off("data", onData);
        resolve(proc);
      }
    };
    proc.stdout.on("data", onData);
    proc.stderr.on("data", (d) => { out += d.toString(); });
    proc.on("exit", (code) => reject(new Error(`server exited early (code ${code}):\n${out}`)));
    setTimeout(() => reject(new Error(`server did not boot in time:\n${out}`)), 15000);
  });
}

// ── server-boot HTTP suite ───────────────────────────────────────────────────
let fixture, proc, base;

before(async () => {
  fixture = makeDesignDir();
  const port = await freePort();
  proc = await bootServer(fixture.design, port);
  base = `http://127.0.0.1:${port}`;
});

after(() => {
  if (proc && !proc.killed) proc.kill("SIGKILL");
  if (fixture) fs.rmSync(fixture.root, { recursive: true, force: true });
});

test("GET /assets/by-file-media-id/<id> → 200, image content-type, exact bytes", async () => {
  const res = await fetch(`${base}/assets/by-file-media-id/${ID_FULL}`);
  assert.equal(res.status, 200, "full image resolves");
  assert.match(res.headers.get("content-type") ?? "", /image\/png/, "content-type image/png");
  const body = Buffer.from(await res.arrayBuffer());
  assert.ok(body.equals(FULL_BYTES), "served bytes equal the on-disk file");
});

test("GET /assets/by-file-media-id/<id>/thumbnail → serves the thumbnail when present", async () => {
  const res = await fetch(`${base}/assets/by-file-media-id/${ID_THUMB}/thumbnail`);
  assert.equal(res.status, 200, "thumbnail resolves");
  const body = Buffer.from(await res.arrayBuffer());
  assert.ok(body.equals(THUMB_BYTES), "served the thumbnail bytes, not the full image");
});

test("GET /assets/by-file-media-id/<id>/thumbnail → falls back to full image when no thumbnail", async () => {
  const res = await fetch(`${base}/assets/by-file-media-id/${ID_FULL}/thumbnail`);
  assert.equal(res.status, 200, "thumbnail request falls back to full");
  const body = Buffer.from(await res.arrayBuffer());
  assert.ok(body.equals(FULL_BYTES), "fell back to the full image bytes");
});

test("GET /assets/by-file-media-id/<unknown> → 404 (no SPA fall-through)", async () => {
  const res = await fetch(`${base}/assets/by-file-media-id/${ID_NONE}`);
  assert.equal(res.status, 404, "unknown id is 404");
});

test("GET /assets/by-file-media-id/<traversal> → not 200 (path-traversal guarded)", async () => {
  const res = await fetch(`${base}/assets/by-file-media-id/..%2f..%2fmanifest.edn`);
  assert.notEqual(res.status, 200, "path traversal must not resolve a file");
});

// ── pure resolver unit suite (no server) ─────────────────────────────────────
test("resolveMediaAsset: resolves full image with content-type", () => {
  const f = makeDesignDir();
  try {
    const r = resolveMediaAsset(f.design, ID_FULL);
    assert.ok(r, "resolves");
    assert.equal(path.basename(r.filePath), `${ID_FULL}.png`);
    assert.match(r.contentType, /image\/png/);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test("resolveMediaAsset: thumbnail present → returns thumbnail; absent → falls back to full", () => {
  const f = makeDesignDir();
  try {
    const t = resolveMediaAsset(f.design, ID_THUMB, { thumbnail: true });
    assert.equal(path.basename(t.filePath), `${ID_THUMB}.thumbnail.png`, "uses thumbnail file");
    const fb = resolveMediaAsset(f.design, ID_FULL, { thumbnail: true });
    assert.equal(path.basename(fb.filePath), `${ID_FULL}.png`, "falls back to full image");
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test("resolveMediaAsset: unknown id → null", () => {
  const f = makeDesignDir();
  try {
    assert.equal(resolveMediaAsset(f.design, ID_NONE), null);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test("resolveMediaAsset: unsafe ids (traversal / separators) → null", () => {
  const f = makeDesignDir();
  try {
    for (const bad of ["../manifest", "..", "a/b", "a\\b", "..%2f", ""]) {
      assert.equal(resolveMediaAsset(f.design, bad), null, `unsafe id rejected: ${JSON.stringify(bad)}`);
    }
    assert.equal(resolveMediaAsset(null, ID_FULL), null, "no design dir → null");
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});
