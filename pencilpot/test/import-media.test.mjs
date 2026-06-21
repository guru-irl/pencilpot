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
// The storage-object id the binary used to be (wrongly) keyed by.
const STORAGE_ID = "5839e54f-040f-4ca6-8989-890baa6f875d";

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
  } finally {
    if (cleanup) cleanup();
  }
});
