// pencilpot media resolution — maps a file-media-object id to its on-disk binary.
//
// Media is stored keyed by file-media-id (the id a shape's :fill-image references):
//   <design>/media/<id>.<ext>            full image
//   <design>/media/<id>.thumbnail.<ext>  optional thumbnail
//   <design>/media/<id>.json             sidecar { width, height, mtype, name }
//
// The runtime serves these at /assets/by-file-media-id/<id> (+ /thumbnail), which
// is exactly the URL the canvas requests (frontend config.cljs resolve-file-media).

import fs from "node:fs";
import path from "node:path";

// Content-type by file extension (used to label the bytes we actually serve).
const EXT_CONTENT_TYPES = {
  png:  "image/png",
  jpg:  "image/jpeg",
  jpeg: "image/jpeg",
  gif:  "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  bmp:  "image/bmp",
  svg:  "image/svg+xml",
};

// Reject ids that could escape the media dir or smuggle separators.
function isUnsafeId(id) {
  return !id
    || id.includes("/")
    || id.includes("\\")
    || id.includes("..")
    || id.includes("\0");
}

function sidecarMtype(mediaDir, id) {
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(mediaDir, `${id}.json`), "utf8"));
    return typeof meta.mtype === "string" && meta.mtype ? meta.mtype : null;
  } catch {
    return null;
  }
}

/**
 * Resolve a media id to a servable file.
 *
 * @param {string|null} designDir  the open design dir (CONFIG.design)
 * @param {string} id              the file-media-object id (uuid)
 * @param {{thumbnail?: boolean}} [opts]
 * @returns {{filePath: string, contentType: string} | null}
 *
 * For thumbnail requests, serves `<id>.thumbnail.<ext>` when present, otherwise
 * falls back to the full `<id>.<ext>` (penpot tolerates a full-size thumbnail).
 * Unknown id or no matching file → null (caller should 404).
 */
export function resolveMediaAsset(designDir, id, { thumbnail = false } = {}) {
  if (!designDir || isUnsafeId(id)) return null;
  const mediaDir = path.join(designDir, "media");

  let entries;
  try {
    entries = fs.readdirSync(mediaDir);
  } catch {
    return null; // no media dir
  }

  const fullPrefix  = `${id}.`;
  const thumbPrefix = `${id}.thumbnail.`;

  // The full image is `<id>.<ext>` but NOT the `.thumbnail.` variant or the `.json` sidecar.
  const isFull  = (e) => e.startsWith(fullPrefix) && !e.startsWith(thumbPrefix) && !e.endsWith(".json");
  const isThumb = (e) => e.startsWith(thumbPrefix) && !e.endsWith(".json");

  let fileName = null;
  if (thumbnail) fileName = entries.find(isThumb);
  if (!fileName) fileName = entries.find(isFull); // full, or thumbnail-fallback
  if (!fileName) return null;

  // Content-type from the actual served file's extension first (so a thumbnail
  // whose format differs from the full image is still labelled correctly); fall
  // back to the sidecar mtype, then octet-stream.
  const ext = fileName.slice(fileName.lastIndexOf(".") + 1).toLowerCase();
  const contentType = EXT_CONTENT_TYPES[ext]
    ?? sidecarMtype(mediaDir, id)
    ?? "application/octet-stream";

  return { filePath: path.join(mediaDir, fileName), contentType };
}
