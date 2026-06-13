/**
 * Native .penpot → .pencil converter.
 *
 * Unpacks the ZIP, groups entries into the structure expected by the engine's
 * `importBinfileV3`, calls it, and returns the pencilpot store parts + media
 * file descriptors.
 *
 * No external Penpot backend, no network, no penpot-hl.
 *
 * @param {string} filePath  Absolute path to the .penpot ZIP file
 * @returns {Promise<{parts: object, mediaFiles: {id: string, srcPath: string, ext: string}[]}>}
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

// ---------------------------------------------------------------------------
// Unzip helpers
// ---------------------------------------------------------------------------

/**
 * Unzip `filePath` to a temp directory using the system `unzip` command.
 * Returns the temp directory path.
 */
function unzipToTemp(filePath) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pencilpot-import-"));
  execFileSync("unzip", ["-q", "-o", filePath, "-d", tmpDir], { stdio: "pipe" });
  return tmpDir;
}

/**
 * Walk the unzipped directory and collect all .json files with their paths
 * relative to tmpDir, plus all non-.json non-folder binary entries
 * (the media objects under objects/).
 */
function collectEntries(tmpDir) {
  const jsonEntries = {};   // relPath → absolute path
  const binaryEntries = {}; // relPath → absolute path

  function walk(dir, base) {
    for (const entry of fs.readdirSync(dir)) {
      const abs = path.join(dir, entry);
      const rel = base ? `${base}/${entry}` : entry;
      const stat = fs.statSync(abs);
      if (stat.isDirectory()) {
        walk(abs, rel);
      } else if (entry.endsWith(".json")) {
        jsonEntries[rel] = abs;
      } else {
        // Binary (images, etc.)
        binaryEntries[rel] = abs;
      }
    }
  }

  walk(tmpDir, "");
  return { jsonEntries, binaryEntries };
}

// ---------------------------------------------------------------------------
// Group entries into the structure expected by importBinfileV3
// ---------------------------------------------------------------------------

/**
 * Given the flat maps of {relPath → absPath}, group them into:
 * {
 *   manifest: "<text>",
 *   files: {
 *     "<file-id>": {
 *       file: "<text>",
 *       pages: { "<pid>": { page: "<text>", shapes: { "<sid>": "<text>" } } },
 *       colors: { "<id>": "<text>" },
 *       typographies: { "<id>": "<text>" },
 *       components: { "<id>": "<text>" },
 *       tokensLib: "<text>" | null,
 *       mediaIds: ["<uuid>", ...]
 *     }
 *   }
 * }
 *
 * and a separate list of media file descriptors:
 * [{ id, srcPath, ext }]
 */
function groupEntries(jsonEntries, binaryEntries) {
  const result = {
    manifest: null,
    files: {},
  };

  const mediaFiles = []; // { id, srcPath, ext }

  // Helper: ensure file-level slot exists
  function ensureFile(fileId) {
    if (!result.files[fileId]) {
      result.files[fileId] = {
        file: null,
        pages: {},
        colors: {},
        typographies: {},
        components: {},
        tokensLib: null,
        mediaIds: [],
        _primaryIds: [],   // storage-object ids that are primary media (must exist)
        _thumbnailIds: [], // storage-object ids that are thumbnails (may be absent)
      };
    }
    return result.files[fileId];
  }

  // Helper: ensure page slot exists
  function ensurePage(fileSlot, pageId) {
    if (!fileSlot.pages[pageId]) {
      fileSlot.pages[pageId] = { page: null, shapes: {} };
    }
    return fileSlot.pages[pageId];
  }

  function readText(absPath) {
    return fs.readFileSync(absPath, "utf8");
  }

  // Manifest
  if (jsonEntries["manifest.json"]) {
    result.manifest = readText(jsonEntries["manifest.json"]);
  }

  // Patterns to match:
  //   files/<fid>.json                                  → file meta
  //   files/<fid>/pages/<pid>.json                      → page meta
  //   files/<fid>/pages/<pid>/<sid>.json                → shape
  //   files/<fid>/colors/<cid>.json                     → color
  //   files/<fid>/typographies/<tid>.json               → typography
  //   files/<fid>/components/<cid>.json                 → component
  //   files/<fid>/tokens.json                           → tokens-lib
  //   files/<fid>/media/<mid>.json                      → media meta (json descriptor)
  //   objects/<oid>.<ext>                               → binary media object

  const PAT_FILE      = /^files\/([^/]+)\.json$/;
  const PAT_PAGE      = /^files\/([^/]+)\/pages\/([^/]+)\.json$/;
  const PAT_SHAPE     = /^files\/([^/]+)\/pages\/([^/]+)\/([^/]+)\.json$/;
  const PAT_COLOR     = /^files\/([^/]+)\/colors\/([^/]+)\.json$/;
  const PAT_TYPO      = /^files\/([^/]+)\/typographies\/([^/]+)\.json$/;
  const PAT_COMPONENT = /^files\/([^/]+)\/components\/([^/]+)\.json$/;
  const PAT_TOKENS    = /^files\/([^/]+)\/tokens\.json$/;
  const PAT_MEDIA     = /^files\/([^/]+)\/media\/([^/]+)\.json$/;

  for (const [rel, absPath] of Object.entries(jsonEntries)) {
    if (rel === "manifest.json") continue;

    let m;

    if ((m = rel.match(PAT_SHAPE))) {
      const [, fid, pid, sid] = m;
      const fileSlot = ensureFile(fid);
      const pageSlot = ensurePage(fileSlot, pid);
      pageSlot.shapes[sid] = readText(absPath);
      continue;
    }

    if ((m = rel.match(PAT_PAGE))) {
      const [, fid, pid] = m;
      const fileSlot = ensureFile(fid);
      const pageSlot = ensurePage(fileSlot, pid);
      pageSlot.page = readText(absPath);
      continue;
    }

    if ((m = rel.match(PAT_COLOR))) {
      const [, fid, cid] = m;
      ensureFile(fid).colors[cid] = readText(absPath);
      continue;
    }

    if ((m = rel.match(PAT_TYPO))) {
      const [, fid, tid] = m;
      ensureFile(fid).typographies[tid] = readText(absPath);
      continue;
    }

    if ((m = rel.match(PAT_COMPONENT))) {
      const [, fid, cid] = m;
      ensureFile(fid).components[cid] = readText(absPath);
      continue;
    }

    if ((m = rel.match(PAT_TOKENS))) {
      const [, fid] = m;
      ensureFile(fid).tokensLib = readText(absPath);
      continue;
    }

    if ((m = rel.match(PAT_MEDIA))) {
      const [, fid, mid] = m;
      const fileSlot = ensureFile(fid);
      if (!fileSlot.mediaIds.includes(mid)) {
        fileSlot.mediaIds.push(mid);
      }
      // Track the storage-object ids (mediaId = primary, thumbnailId = optional)
      try {
        const desc = JSON.parse(readText(absPath));
        if (desc.mediaId) {
          fileSlot._primaryIds.push(desc.mediaId);
        }
        if (desc.thumbnailId) {
          fileSlot._thumbnailIds.push(desc.thumbnailId);
        }
      } catch {}
      continue;
    }

    if ((m = rel.match(PAT_FILE))) {
      const [, fid] = m;
      ensureFile(fid).file = readText(absPath);
      continue;
    }
  }

  // Binary objects (media files: objects/<id>.<ext>)
  const PAT_BINARY = /^objects\/([^/]+)\.([^.]+)$/;
  for (const [rel, absPath] of Object.entries(binaryEntries)) {
    const m = rel.match(PAT_BINARY);
    if (m) {
      mediaFiles.push({ id: m[1], srcPath: absPath, ext: m[2] });
    }
  }

  return { grouped: result, mediaFiles };
}

// ---------------------------------------------------------------------------
// Sort pages by their :index field (from the page JSON)
// ---------------------------------------------------------------------------

/**
 * The pages in `file.pages` may arrive in any order.
 * Sort them by their `:index` field (present in the page.json).
 * Returns a new `file.pages` object with pages ordered correctly.
 */
function sortPagesByIndex(pages) {
  // Each page entry has a `page` text we can parse to get `index`
  const pageList = Object.entries(pages).map(([pid, slot]) => {
    let index = 0;
    try {
      const parsed = JSON.parse(slot.page || "{}");
      index = parsed.index ?? 0;
    } catch {}
    return { pid, slot, index };
  });
  pageList.sort((a, b) => a.index - b.index);
  // Rebuild ordered object (JS objects preserve insertion order)
  const ordered = {};
  for (const { pid, slot } of pageList) {
    ordered[pid] = slot;
  }
  return ordered;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Natively convert a .penpot file into pencilpot store parts.
 *
 * @param {string} filePath Absolute path to the .penpot ZIP
 * @returns {{ parts: object, mediaFiles: {id: string, srcPath: string, ext: string}[] }}
 */
export async function importPenpot(filePath) {
  // 1. Unzip to a temp dir
  const tmpDir = unzipToTemp(filePath);

  try {
    // 2. Collect and group entries
    const { jsonEntries, binaryEntries } = collectEntries(tmpDir);
    const { grouped, mediaFiles } = groupEntries(jsonEntries, binaryEntries);

    if (!grouped.manifest) {
      throw new Error("importPenpot: manifest.json not found in .penpot file");
    }

    // 3. Sort pages by index within each file
    for (const fileEntry of Object.values(grouped.files)) {
      fileEntry.pages = sortPagesByIndex(fileEntry.pages);
    }

    // 4. Call the engine to decode + assemble + serialize
    const { importBinfileV3 } = await import("../../headless-core/target/headless/penpot.js");
    const resultJson = importBinfileV3(JSON.stringify(grouped));
    const result = JSON.parse(resultJson);

    // Build the set of storage-object IDs referenced by media descriptors
    // (media descriptors link file-media-object-id → storage-object mediaId/thumbnailId)
    // Separate primary mediaIds from thumbnailIds so we can warn only on missing primaries.
    const primaryMediaIds = new Set(
      Object.values(grouped.files).flatMap((f) => f._primaryIds || [])
    );
    const thumbnailIds = new Set(
      Object.values(grouped.files).flatMap((f) => f._thumbnailIds || [])
    );
    const allReferencedIds = new Set([...primaryMediaIds, ...thumbnailIds]);

    // For each referenced id, GLOB objects/<id>.* in the temp dir to find the
    // actual file (which may be .png, .jpg, or any extension).  Skip thumbnail
    // ids that weren't exported (silently); warn only for missing primary mediaIds.
    const resolvedMedia = [];
    const objectsDir = path.join(tmpDir, "objects");
    const hasObjectsDir = fs.existsSync(objectsDir);

    for (const id of allReferencedIds) {
      let found = false;
      if (hasObjectsDir) {
        for (const entry of fs.readdirSync(objectsDir)) {
          // entry format: <id>.<ext>  (no dots in the id part)
          const dotIdx = entry.lastIndexOf(".");
          if (dotIdx === -1) continue;
          const entryId = entry.slice(0, dotIdx);
          const entryExt = entry.slice(dotIdx + 1);
          if (entryId === id) {
            resolvedMedia.push({ id, srcPath: path.join(objectsDir, entry), ext: entryExt });
            found = true;
            break;
          }
        }
      }
      if (!found && primaryMediaIds.has(id)) {
        // Only warn for primary media that genuinely has no binary in the zip.
        console.warn(`  warning: primary media object ${id} not found in zip (skipping)`);
      }
      // Missing thumbnails → silent skip (do nothing).
    }

    // If no media descriptors at all, fall back to all binaries found.
    const effectiveMedia = allReferencedIds.size > 0 ? resolvedMedia : mediaFiles;

    // Copy resolved media to a stable temp location BEFORE cleaning up tmpDir,
    // so that the caller can still copy from srcPath after this function returns.
    const stableDir = fs.mkdtempSync(path.join(os.tmpdir(), "pencilpot-media-"));
    const stableMedia = [];
    for (const mf of effectiveMedia) {
      const dest = path.join(stableDir, `${mf.id}.${mf.ext}`);
      fs.copyFileSync(mf.srcPath, dest);
      stableMedia.push({ id: mf.id, srcPath: dest, ext: mf.ext, _stableDir: stableDir });
    }

    return {
      parts: result.parts,
      mediaFiles: stableMedia,
      // Caller MUST call cleanup() after consuming mediaFiles to remove stableDir.
      cleanup: () => { try { fs.rmSync(stableDir, { recursive: true, force: true }); } catch {} },
    };
  } finally {
    // Clean up the original extraction temp dir (not the stable media dir)
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}
