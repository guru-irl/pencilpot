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
 * @returns {Promise<{parts: object, mediaFiles: {id: string, srcPath: string, ext: string, width: number, height: number, mtype: string, name: string, thumbnailSrcPath?: string, thumbnailExt?: string}[]}>}
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
        _descriptors: [],  // full media descriptors: { fileMediaId, mediaId, thumbnailId, width, height, mtype, name }
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
      // AND retain the full descriptor so media can be keyed by the file-media-id
      // (`mid`) it is referenced by, carrying width/height/mtype/name metadata.
      try {
        const desc = JSON.parse(readText(absPath));
        if (desc.mediaId) {
          fileSlot._primaryIds.push(desc.mediaId);
        }
        if (desc.thumbnailId) {
          fileSlot._thumbnailIds.push(desc.thumbnailId);
        }
        fileSlot._descriptors.push({
          fileMediaId: mid,
          mediaId: desc.mediaId ?? null,
          thumbnailId: desc.thumbnailId ?? null,
          width: desc.width ?? null,
          height: desc.height ?? null,
          mtype: desc.mtype ?? null,
          name: desc.name ?? null,
        });
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
 * @returns {{ parts: object, mediaFiles: {id: string, srcPath: string, ext: string, width: number, height: number, mtype: string, name: string, thumbnailSrcPath?: string, thumbnailExt?: string}[] }}
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

    // Media descriptors link a file-media-object-id (what `:fill-image {:id …}`
    // references) to storage-object ids (the actual binaries: `mediaId` primary,
    // `thumbnailId` optional).  The engine + canvas resolve images BY FILE-MEDIA-ID
    // (GET /assets/by-file-media-id/<id>), so media must be keyed by the
    // file-media-id on disk — not by the storage-object id the binary is named with.
    const descriptors = Object.values(grouped.files).flatMap((f) => f._descriptors || []);

    // Build storage-object-id → { srcPath, ext } once by globbing objects/<id>.<ext>.
    const objectsDir = path.join(tmpDir, "objects");
    const hasObjectsDir = fs.existsSync(objectsDir);
    const storageById = new Map();
    if (hasObjectsDir) {
      for (const entry of fs.readdirSync(objectsDir)) {
        const dotIdx = entry.lastIndexOf(".");
        if (dotIdx === -1) continue;
        const sid = entry.slice(0, dotIdx);
        const ext = entry.slice(dotIdx + 1);
        // A .penpot stores each storage object as a PAIR: the image binary
        // (objects/<id>.jpg|png|…) AND a metadata twin (objects/<id>.json).
        // Both share the same id stem, so without this guard the .json twin
        // clobbers the real image in the map and the descriptor join below
        // resolves to JSON text instead of pixels.  Media binaries are always
        // images — never a bare .json — so skipping json storage objects is safe.
        if (ext === "json") continue;
        storageById.set(sid, { srcPath: path.join(objectsDir, entry), ext });
      }
    }

    // Resolve each descriptor to a media entry keyed by its file-media-id,
    // carrying metadata and (when present) the thumbnail binary.
    const resolvedMedia = [];
    for (const d of descriptors) {
      const primary = d.mediaId ? storageById.get(d.mediaId) : null;
      if (!primary) {
        // Primary binary genuinely absent from the zip — warn and skip.
        console.warn(`  warning: primary media object ${d.mediaId} not found in zip (skipping)`);
        continue;
      }
      const entry = {
        id: d.fileMediaId,
        srcPath: primary.srcPath,
        ext: primary.ext,
        width: d.width,
        height: d.height,
        mtype: d.mtype,
        name: d.name,
      };
      const thumb = d.thumbnailId ? storageById.get(d.thumbnailId) : null;
      if (thumb) {
        // Thumbnail binary present — carry it so the caller can write
        // <file-media-id>.thumbnail.<ext>.  Missing thumbnails are a silent skip.
        entry.thumbnailSrcPath = thumb.srcPath;
        entry.thumbnailExt = thumb.ext;
      }
      resolvedMedia.push(entry);
    }

    // If no media descriptors at all, fall back to all binaries found,
    // keyed by their own id (non-descriptor imports must not regress).
    const effectiveMedia = descriptors.length > 0 ? resolvedMedia : mediaFiles;

    // Copy resolved media to a stable temp location BEFORE cleaning up tmpDir,
    // so that the caller can still copy from srcPath after this function returns.
    const stableDir = fs.mkdtempSync(path.join(os.tmpdir(), "pencilpot-media-"));
    const stableMedia = [];
    for (const mf of effectiveMedia) {
      const dest = path.join(stableDir, `${mf.id}.${mf.ext}`);
      fs.copyFileSync(mf.srcPath, dest);
      const out = {
        id: mf.id,
        srcPath: dest,
        ext: mf.ext,
        width: mf.width ?? null,
        height: mf.height ?? null,
        mtype: mf.mtype ?? null,
        name: mf.name ?? null,
        _stableDir: stableDir,
      };
      if (mf.thumbnailSrcPath) {
        const thumbDest = path.join(stableDir, `${mf.id}.thumbnail.${mf.thumbnailExt}`);
        fs.copyFileSync(mf.thumbnailSrcPath, thumbDest);
        out.thumbnailSrcPath = thumbDest;
        out.thumbnailExt = mf.thumbnailExt;
      }
      stableMedia.push(out);
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
