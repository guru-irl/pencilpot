import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, "..", "runtime", "server.mjs");

const BOUNDARY = "----pencilpotUploadBoundary";

// minimal but spec-valid PNG with a known size
function makePng(w, h) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write("IHDR", 4, "ascii");
  ihdr.writeUInt32BE(w, 8);
  ihdr.writeUInt32BE(h, 12);
  ihdr[16] = 8; ihdr[17] = 6;
  const iend = Buffer.from([0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);
  return Buffer.concat([sig, ihdr, iend]);
}

function buildMultipart(fileBytes, { name = "Cover", filename = "cover.png", ctype = "image/png" } = {}) {
  const chunks = [
    Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="file-id"\r\n\r\n11111111-1111-1111-1111-111111111111\r\n`),
    Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="name"\r\n\r\n${name}\r\n`),
    Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="is-local"\r\n\r\ntrue\r\n`),
    Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="content"; filename="${filename}"\r\nContent-Type: ${ctype}\r\n\r\n`),
    fileBytes,
    Buffer.from(`\r\n--${BOUNDARY}--\r\n`),
  ];
  return Buffer.concat(chunks);
}

// Decode a flat penpot transit map array ["^ ","~:k",v,...] into a JS object,
// stripping the ~: key prefix and ~u uuid value prefix.
function decodeTransitMap(text) {
  const arr = JSON.parse(text);
  assert.ok(Array.isArray(arr) && arr[0] === "^ ", "transit map array form");
  const out = {};
  for (let i = 1; i < arr.length - 1; i += 2) {
    const key = String(arr[i]).replace(/^~:/, "");
    let val = arr[i + 1];
    if (typeof val === "string" && val.startsWith("~u")) val = val.slice(2);
    out[key] = val;
  }
  return out;
}

function makeDesignDir() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pp-upload-"));
  const design = path.join(root, "home");
  fs.mkdirSync(path.join(design, "pages"), { recursive: true });
  fs.mkdirSync(path.join(design, "components"), { recursive: true });
  fs.mkdirSync(path.join(design, "media"), { recursive: true });
  fs.writeFileSync(path.join(design, "manifest.edn"),
    `{:id #uuid "11111111-1111-1111-1111-111111111111" :name "Home"}`);
  return { root, design };
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

let fixture, proc, base, stderr = "";

function bootServer(designDir, port) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [SERVER], {
      env: { ...process.env, PENCILPOT_PORT: String(port), PENCILPOT_DESIGN: designDir },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    const onData = (d) => {
      out += d.toString();
      if (out.includes("pencilpot runtime on http://localhost:")) {
        p.stdout.off("data", onData);
        resolve(p);
      }
    };
    p.stdout.on("data", onData);
    p.stderr.on("data", (d) => { const s = d.toString(); out += s; stderr += s; });
    p.on("exit", (code) => reject(new Error(`server exited early (code ${code}):\n${out}`)));
    setTimeout(() => reject(new Error(`server did not boot:\n${out}`)), 15000);
  });
}

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

test("upload-file-media-object: writes the blob to /media and returns a real media-object (transit)", async () => {
  const png = makePng(7, 11);
  const res = await fetch(`${base}/api/main/methods/upload-file-media-object`, {
    method: "POST",
    headers: { "content-type": `multipart/form-data; boundary=${BOUNDARY}`, accept: "application/transit+json" },
    body: buildMultipart(png),
  });
  assert.equal(res.status, 200);
  const obj = decodeTransitMap(await res.text());

  assert.match(obj.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, "id is a uuid");
  assert.equal(obj.width, 7, "probed width");
  assert.equal(obj.height, 11, "probed height");
  assert.equal(obj.mtype, "image/png", "mtype");
  assert.equal(obj.name, "Cover", "name from the multipart field");

  // blob written under the new file-media-id
  const onDisk = path.join(fixture.design, "media", `${obj.id}.png`);
  assert.ok(fs.existsSync(onDisk), "binary written to <design>/media/<id>.png");
  assert.ok(fs.readFileSync(onDisk).equals(png), "on-disk bytes equal the uploaded blob");
  // sidecar written
  const sidecar = JSON.parse(fs.readFileSync(path.join(fixture.design, "media", `${obj.id}.json`), "utf8"));
  assert.deepEqual(sidecar, { width: 7, height: 11, mtype: "image/png", name: "Cover" });

  // and the Task-2 route serves it end-to-end
  const get = await fetch(`${base}/assets/by-file-media-id/${obj.id}`);
  assert.equal(get.status, 200, "uploaded media is immediately servable");
  const served = Buffer.from(await get.arrayBuffer());
  assert.ok(served.equals(png), "served bytes equal the uploaded blob");

  // the unhandled-RPC warning must NOT fire for this command
  assert.ok(!stderr.includes("unhandled RPC upload-file-media-object"),
    "no unhandled-RPC warning for upload-file-media-object");
});

test("upload-file-media-object: JSON accept yields a parseable media-object", async () => {
  const png = makePng(3, 4);
  const res = await fetch(`${base}/api/main/methods/upload-file-media-object`, {
    method: "POST",
    headers: { "content-type": `multipart/form-data; boundary=${BOUNDARY}`, accept: "application/json" },
    body: buildMultipart(png, { name: "Plain" }),
  });
  assert.equal(res.status, 200);
  const obj = JSON.parse(await res.text());
  assert.ok(obj.id && obj.width === 3 && obj.height === 4 && obj.mtype === "image/png");
  assert.equal(obj.name, "Plain");
});

test("clone-file-media-object: copies an existing media object to a new id", async () => {
  // seed an object via upload first
  const png = makePng(5, 6);
  const up = await fetch(`${base}/api/main/methods/upload-file-media-object`, {
    method: "POST",
    headers: { "content-type": `multipart/form-data; boundary=${BOUNDARY}`, accept: "application/json" },
    body: buildMultipart(png, { name: "Src" }),
  });
  const src = JSON.parse(await up.text());

  const res = await fetch(`${base}/api/main/methods/clone-file-media-object`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(["^ ", "~:is-local", true, "~:file-id", "11111111-1111-1111-1111-111111111111", "~:id", `~u${src.id}`]),
  });
  assert.equal(res.status, 200);
  const clone = JSON.parse(await res.text());
  assert.notEqual(clone.id, src.id, "clone gets a fresh id");
  assert.equal(clone.width, 5);
  assert.equal(clone.height, 6);
  assert.ok(fs.existsSync(path.join(fixture.design, "media", `${clone.id}.png`)), "clone binary written");

  const get = await fetch(`${base}/assets/by-file-media-id/${clone.id}`);
  assert.equal(get.status, 200);
  assert.ok(Buffer.from(await get.arrayBuffer()).equals(png), "clone serves the same bytes");
});
