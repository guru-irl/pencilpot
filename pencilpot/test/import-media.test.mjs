import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { importPenpot } from "../runtime/import-binfile.mjs";

// The canonical source design used to seed pencilpot projects.  Importing it is
// the realistic end-to-end exercise of the media pipeline.
const ORIGINAL_PENPOT = "/home/guru/Downloads/Default Design System.penpot";

// A fill-referenced file-media-object id (what `:fill-image {:id …}` resolves to)
// and its descriptor metadata, taken from
//   files/<fid>/media/8bff608e-9e53-81dd-8008-28c8626dd48f.json
const FILE_MEDIA_ID = "8bff608e-9e53-81dd-8008-28c8626dd48f";
// The other fill-referenced file-media-object id in the same design.
const FILE_MEDIA_ID_C3BF = "8bff608e-9e53-81dd-8008-28c85d54c3bf";
// The storage-object id the binary used to be (wrongly) keyed by.
const STORAGE_ID = "5839e54f-040f-4ca6-8989-890baa6f875d";

const IMAGE_EXTS = new Set(["jpg", "jpeg", "png", "gif", "webp"]);

// Read the first bytes of a file (for magic-byte sniffing).
function firstBytes(p, n = 8) {
  const fd = fs.openSync(p, "r");
  try {
    const b = Buffer.alloc(n);
    fs.readSync(fd, b, 0, n, 0);
    return b;
  } finally {
    fs.closeSync(fd);
  }
}

// Return "jpeg"/"png" if buf begins with real image magic bytes, else null.
function imageMagic(buf) {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpeg";
  if (buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "png";
  return null;
}

test("import keys media by file-media-id, carrying descriptor metadata", async (t) => {
  if (!fs.existsSync(ORIGINAL_PENPOT)) {
    t.skip(`original .penpot not present at ${ORIGINAL_PENPOT}`);
    return;
  }

  const { mediaFiles, cleanup } = await importPenpot(ORIGINAL_PENPOT);
  try {
    // The fill-referenced file-media-id must be present as a media entry.
    const entry = mediaFiles.find((m) => m.id === FILE_MEDIA_ID);
    assert.ok(
      entry,
      `expected a mediaFiles entry keyed by file-media-id ${FILE_MEDIA_ID}; ` +
        `got ids: ${mediaFiles.map((m) => m.id).join(", ")}`,
    );

    // …and it must carry the descriptor metadata used to write the sidecar.
    assert.equal(entry.width, 500, "width from descriptor");
    assert.equal(entry.height, 500, "height from descriptor");
    assert.equal(entry.mtype, "image/jpeg", "mtype from descriptor");
    assert.equal(entry.name, "Currents", "name from descriptor");

    // The bare storage-object id must NOT leak through as a media key.
    const leaked = mediaFiles.find((m) => m.id === STORAGE_ID);
    assert.ok(
      !leaked,
      `storage-object id ${STORAGE_ID} must not be a media key (media is keyed by file-media-id)`,
    );

    // …and the resolved entry must point at a REAL image binary — not the
    // storage object's JSON metadata twin (objects/<id>.json).  A .penpot stores
    // each storage object as a PAIR (<id>.jpg AND <id>.json); if the importer keys
    // its storage map by stem, the .json twin clobbers the image and the descriptor
    // join resolves to JSON text.  Metadata assertions alone (above) do NOT catch
    // that — these magic-byte checks do.
    assert.ok(
      IMAGE_EXTS.has(entry.ext),
      `entry.ext must be an image extension, got "${entry.ext}" (json => clobbered by storage-metadata twin)`,
    );
    const magic = imageMagic(firstBytes(entry.srcPath));
    assert.ok(
      magic,
      `entry.srcPath must be a real image binary; got ext="${entry.ext}" first bytes=` +
        `${firstBytes(entry.srcPath).toString("hex")}`,
    );
    assert.equal(magic, "jpeg", "the d48f image is a JPEG");

    // Defense in depth: BOTH fill-referenced image ids resolve to real binaries.
    for (const id of [FILE_MEDIA_ID, FILE_MEDIA_ID_C3BF]) {
      const e = mediaFiles.find((m) => m.id === id);
      assert.ok(e, `media entry for ${id} present`);
      assert.ok(IMAGE_EXTS.has(e.ext), `${id}: ext must be an image extension, got "${e.ext}"`);
      assert.ok(
        imageMagic(firstBytes(e.srcPath)),
        `${id}: srcPath must be a real image binary, got ext="${e.ext}"`,
      );
    }
  } finally {
    if (cleanup) cleanup();
  }
});
