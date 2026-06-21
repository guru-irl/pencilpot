import { test } from "node:test";
import assert from "node:assert/strict";
import { imageSize } from "../runtime/image-size.mjs";

// ── fixture builders (minimal but spec-valid headers) ────────────────────────

function makePng(w, h) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);            // chunk length
  ihdr.write("IHDR", 4, "ascii");
  ihdr.writeUInt32BE(w, 8);             // width
  ihdr.writeUInt32BE(h, 12);            // height
  ihdr[16] = 8;                         // bit depth
  ihdr[17] = 6;                         // colour type (RGBA)
  const iend = Buffer.from([0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);
  return Buffer.concat([sig, ihdr, iend]);
}

function makeJpeg(w, h) {
  const soi = Buffer.from([0xff, 0xd8]);
  // A non-SOF segment (APP0) first, to prove the parser walks past it by length.
  const app0 = Buffer.alloc(2 + 2 + 4);
  app0[0] = 0xff; app0[1] = 0xe0;
  app0.writeUInt16BE(2 + 4, 2);         // segment length (excludes marker)
  // SOF0
  const sof = Buffer.alloc(2 + 2 + 1 + 2 + 2 + 1 + 9);
  let o = 0;
  sof[o++] = 0xff; sof[o++] = 0xc0;
  sof.writeUInt16BE(2 + 1 + 2 + 2 + 1 + 9, o); o += 2;  // length = 17
  sof[o++] = 8;                          // precision
  sof.writeUInt16BE(h, o); o += 2;       // height
  sof.writeUInt16BE(w, o); o += 2;       // width
  sof[o++] = 3;                          // components
  const eoi = Buffer.from([0xff, 0xd9]);
  return Buffer.concat([soi, app0, sof, eoi]);
}

function makeGif(w, h) {
  const buf = Buffer.alloc(13);
  buf.write("GIF89a", 0, "ascii");
  buf.writeUInt16LE(w, 6);
  buf.writeUInt16LE(h, 8);
  return buf;
}

// ── tests ────────────────────────────────────────────────────────────────────

test("PNG → width/height/mtype", () => {
  assert.deepEqual(imageSize(makePng(2, 3)), { width: 2, height: 3, mtype: "image/png" });
  assert.deepEqual(imageSize(makePng(640, 480)), { width: 640, height: 480, mtype: "image/png" });
});

test("JPEG → walks past APP0 to SOF0 for width/height/mtype", () => {
  assert.deepEqual(imageSize(makeJpeg(500, 500)), { width: 500, height: 500, mtype: "image/jpeg" });
  assert.deepEqual(imageSize(makeJpeg(120, 90)), { width: 120, height: 90, mtype: "image/jpeg" });
});

test("GIF → logical-screen width/height/mtype", () => {
  assert.deepEqual(imageSize(makeGif(16, 32)), { width: 16, height: 32, mtype: "image/gif" });
});

test("unknown / too-short buffers → null", () => {
  assert.equal(imageSize(Buffer.from([0x00, 0x01, 0x02, 0x03])), null);
  assert.equal(imageSize(Buffer.from("not an image at all")), null);
  assert.equal(imageSize(Buffer.alloc(2)), null);
  assert.equal(imageSize("nope"), null);
});
