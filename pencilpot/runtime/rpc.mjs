// Real RPC handlers: get-file/update-file from on-disk EDN store + synthetic
// boot stubs for all other SPA endpoints.
import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { createSession } from "../../headless-core/target/headless/penpot.js";
import { getStore, stage, status } from "./worktree.mjs";
import { readFonts } from "../store/fonts.mjs";
import { resolveProjectRoot, resolveProject } from "../store/project.mjs";
import { readBody } from "./proxy.mjs";
import { stub, isStub, buildUpdateFileResponse } from "./stubs.mjs";
import { broadcastStatus } from "./live.mjs";
import { parseMultipart } from "./multipart.mjs";
import { imageSize } from "./image-size.mjs";
import { resolveMediaAsset } from "./media.mjs";

/** Extract the RPC command name from a URL like /api/main/methods/get-file?... */
const cmd = (url) => url.split("?")[0].split("/").filter(Boolean).pop();

/** Extract a query-param value from a URL string. */
const qp = (url, key) => new URL("http://h" + url).searchParams.get(key);

/** Hydrate a session from the working copy (in-memory for the open design,
 *  on-disk for any other dir). */
function sessionFor(dir) {
  return createSession(JSON.stringify({ fromStore: getStore(dir) }));
}

// ── Read-session cache ──────────────────────────────────────────────────────
// The FIRST createSession() in a server process pays a one-time ~8.5-9.4s engine
// warmup (CLJS JIT/init); every createSession after that is ~300ms.  Read-only
// endpoints (get-file, get-view-only-bundle) re-hydrate a session on every call,
// so without caching each repeated read pays ~300ms and the very first one pays
// the full cold cost.  We cache ONE hydrated session for the OPEN design, keyed
// on the working-copy object IDENTITY (NOT (dir,revn)):
//
//   - getStore(openDir) returns the stable in-memory `_store` reference; that
//     reference is replaced EXACTLY when content changes — stage() (edit) and
//     discard() (revert) both assign a fresh `_store`, while save() and plain
//     reads keep the same reference.  So identity-keying invalidates precisely
//     on content change and — crucially — also on discard, which reverts content
//     WITHOUT bumping revn: a naive (dir,revn) key would serve a STALE post-edit
//     session after a discard.  Identity keying is strictly safer than (dir,revn).
//   - For any NON-open dir (linked libraries) getStore returns a fresh readDesign
//     object every call, so those never cache (always fresh) and never evict the
//     open-design session.
//
// SAFETY: reads never mutate the session (getFileResponse / getViewerBundle are
// pure reads) and createSession / those getters are synchronous, so a cached
// session shared across concurrent reads at the same content is safe.  WRITES
// (persistChanges) keep using a fresh sessionFor() — after their stage() the
// `_store` ref changes, auto-invalidating this cache (read-after-write is fresh).
let _readSession = { store: null, session: null };
function readSessionFor(dir) {
  // Only the open design is cached; libraries / other dirs always read fresh.
  if (status().design !== dir) return sessionFor(dir);
  const store = getStore(dir);
  if (_readSession.store === store) return _readSession.session;
  const session = createSession(JSON.stringify({ fromStore: store }));
  _readSession = { store, session };
  return session;
}

/** Warm the headless engine OFF the request path (called at server boot).
 *  Builds + caches the open design's read session so the user's first get-file /
 *  get-view-only-bundle is ~300ms instead of the ~8.5-9.4s cold createSession.
 *  Best-effort: a failure is swallowed (the engine just warms on first real use).
 *  NOTE: createSession is synchronous, so this blocks the event loop for the
 *  one-time warmup duration; callers should defer it (setImmediate) so listen()
 *  + the banner happen first and the initial static-asset burst is served. */
export function warmEngine(dir) {
  if (!dir) return;
  const t0 = Date.now();
  try {
    readSessionFor(dir);
    console.log(`[pencilpot] engine warmed in ${Date.now() - t0}ms`);
  } catch (e) {
    console.warn(`[pencilpot] engine warmup skipped: ${e?.message ?? e}`);
  }
}

/** Test-only: expose the cached read-session resolver so tests can assert
 *  cache-hit (identity) and write-invalidation behavior. */
export { readSessionFor as __readSessionFor };

/**
 * Extract a value from a transit-JSON map array by keyword name.
 * Transit maps are encoded as ["^ ", "~:key1", val1, "~:key2", val2, ...].
 * This is a lightweight raw extraction — values are NOT fully transit-decoded.
 */
function transitGet(transitStr, keyword) {
  const parsed = JSON.parse(transitStr);
  const needle = `~:${keyword}`;
  // Transit map literal form: ["^ ", "~:k1", v1, "~:k2", v2, ...]
  if (Array.isArray(parsed)) {
    if (parsed[0] !== "^ ") return undefined;
    for (let i = 1; i < parsed.length - 1; i += 2) {
      if (parsed[i] === needle) return parsed[i + 1];
    }
    return undefined;
  }
  // Transit object form: {"~:k1": v1, "~:k2": v2}  (how rp/cmd! encodes a small
  // params map over the wire, e.g. {"~:id":"~u..","~:name":"New"}).
  if (parsed && typeof parsed === "object") {
    return Object.prototype.hasOwnProperty.call(parsed, needle) ? parsed[needle] : undefined;
  }
  return undefined;
}

/**
 * Hydrate -> applyFn(session) -> bump revn -> serialize -> STAGE in memory.
 * Returns { revn } so callers can embed it in the response.
 *
 * Manual-save model: changes are staged into the in-memory working copy and the
 * design is marked dirty (a `status` SSE event notifies the SPA).  Nothing is
 * written to disk until an explicit Save (see server.mjs /pencilpot/save).
 */
function persistChanges(dir, applyFn) {
  const s = sessionFor(dir);
  applyFn(s);
  const revn = s.bumpRevn();
  stage(dir, JSON.parse(s.serializeStore()), revn);   // ← in memory, not disk
  broadcastStatus(status().dirty, revn);              // ← reflect ACTUAL dirty state
  return { revn };
}

// ---------------------------------------------------------------------------
// Public helpers (also used directly by integration tests)
// ---------------------------------------------------------------------------

/**
 * Load the store and return { meta, transit }.
 * `meta` is augmented with a `data` field (the raw transit-encoded data object)
 * so callers can assert `meta.data` is set and so the SPA's get-file consumer
 * sees the file data in the expected position.
 */
export function getFile(dir) {
  const result = JSON.parse(readSessionFor(dir).getFileResponse());
  // Attach the transit-encoded :data blob to meta so consumers see meta.data.
  // transitGet does a raw JSON-level extraction (no full transit decode needed
  // here — the value is passed back into createSession via fromTransit).
  if (!result.meta.data) {
    result.meta.data = transitGet(result.transit, "data");
  }
  return result;
}

/** Apply a transit-encoded update-file request body and persist. Returns { revn }. */
export function updateFile(dir, transitBody) {
  return persistChanges(dir, (s) => s.applyTransitUpdate(transitBody));
}

/** Apply a JSON array of change maps and persist. Returns { revn }. Test-only path. */
export function updateFileJson(dir, changesJson) {
  return persistChanges(dir, (s) => s.applyChanges(changesJson));
}

/**
 * Parse the `:libraries` vector from a manifest EDN string.
 * Returns an array of { id: "<uuid-string>", path: "<rel-path>" }.
 * The manifest always serializes as:
 *   :libraries [{:id #uuid "…" :path "…"} …]
 */
function parseLibrariesFromManifest(manifestEdn) {
  const outer = manifestEdn.match(/:libraries\s*\[([^\]]*)\]/s);
  if (!outer) return [];
  const inner = outer[1].trim();
  if (!inner) return [];
  const entries = [];
  const re = /\{:id\s+#uuid\s+"([^"]+)"\s+:path\s+"([^"]+)"\}/g;
  let m;
  while ((m = re.exec(inner)) !== null) {
    entries.push({ id: m[1], path: m[2] });
  }
  return entries;
}

/**
 * Resolve the linked shared libraries for a design file.
 *
 * Reads `:libraries` from the design's manifest, loads each linked
 * `shared/*.penpot` from `projectRoot` via the headless engine, and
 * returns an array of library metadata objects:
 *   [ { id, name, revn, vern, features, data, components } ]
 *
 * The returned objects carry the full `data` field (transit-decoded)
 * so callers (tests or the HTTP handler) can assert component presence.
 * The HTTP `get-file-libraries` handler encodes only the metadata subset
 * needed by the SPA; `get-file?id=<libId>` serves the full transit payload.
 */
export function getFileLibraries(designDir, projectRoot) {
  const manifest = getStore(designDir).manifest;
  const refs = parseLibrariesFromManifest(manifest);
  return refs.map(({ id, path: libPath }) => {
    const libDir = path.join(projectRoot, libPath);
    const { meta } = getFile(libDir);
    // Ensure id matches the manifest reference (getFile reads from the store,
    // so meta.id is authoritative; use the manifest ref as a fallback label).
    return { ...meta, id: meta.id ?? id };
  });
}

/**
 * Encode a list of library metadata objects as a transit+json array suitable
 * for the `get-file-libraries` HTTP response.
 *
 * Penpot transit+json encodes maps as ["^ ", "~:key", value, ...].
 * The SPA only reads :id and :synced-at from this response; it then fetches
 * the full file data via get-file?id=<libId>.  We include :name / :revn so
 * the workspace sidebar shows correct names without an extra round-trip.
 *
 * Timestamps: the SPA calls `check-libraries-synchronization` and shows a
 * "library out of sync" banner when :modified-at > :synced-at.  We set both
 * to the same ISO timestamp so the banner is suppressed.
 */
function encodeTransitLibraryList(libs) {
  const now = new Date().toISOString();
  const arr = libs.map(({ id, name, revn, vern, features }) =>
    [
      "^ ",
      "~:id", id,
      "~:name", name ?? "Library",
      "~:revn", revn ?? 0,
      "~:vern", vern ?? 0,
      "~:features", features ?? [],
      "~:is-shared", true,
      "~:modified-at", now,
      "~:synced-at", now,
    ]
  );
  return JSON.stringify(arr);
}

// ---------------------------------------------------------------------------
// Font variants: transit encoding for get-font-variants
// ---------------------------------------------------------------------------

/**
 * Encode a list of project font variants (from readFonts) as transit+json.
 *
 * Penpot frontend `prepare-font-variant` reads from each item:
 *   :font-style, :font-weight, :font-family,
 *   :woff1-file-id, :woff2-file-id, :ttf-file-id, :otf-file-id
 *   (plus :id and :font-id for the font registry key)
 *
 * We map our variant's format field to the appropriate *-file-id key, setting
 * the others to null so the frontend skips them.  The variant id is used as
 * the file-id so the asset route /assets/by-id/<id> resolves it directly.
 */
export function encodeTransitFontVariants(variants) {
  const arr = variants.map((v) => {
    const { id, fontId, family, weight, style, variable, axes, instances } = v;
    // Penpot's frontend (data/fonts.cljs `adapt-font-id`) ALWAYS prepends
    // "custom-" to the :font-id it receives from get-font-variants, building the
    // font-registry key the workspace edits with. So we must serve the RAW id
    // here (matching the real Penpot backend, which stores un-prefixed ids):
    // serving an already-"custom-"-prefixed id yields a doubled "custom-custom-"
    // registry key, and any text edit then bakes that broken id into every leaf
    // (font no longer resolves -> falls back on reload).
    const rawFontId = String(fontId ?? id).replace(/^custom-/, "");
    // Penpot's custom-font @font-face builds its URL from :woff1-file-id (see
    // fonts.cljs generate-custom-font-variant-css).  We only ever have one file
    // per variant, served by /assets/by-id/<id> with the correct content-type, so
    // point ALL the *-file-id slots at the same id — whichever the loader reads,
    // the URL resolves to the real file (the browser sniffs the actual format).
    const woff2 = id, woff1 = id, ttf = id, otf = id;
    const map = [
      "^ ",
      "~:id",           id,
      "~:font-id",      rawFontId,
      "~:font-family",  family,
      "~:font-weight",  weight,
      "~:font-style",   style,
      "~:woff2-file-id", woff2,
      "~:woff1-file-id", woff1,
      "~:ttf-file-id",   ttf,
      "~:otf-file-id",   otf,
    ];

    // Variable fonts: append axis + instance metadata after the file-id slots.
    // Static variants are byte-identical to the pre-Stage-2 output (no new keys).
    if (variable) {
      map.push("~:variable", true);
      const axesEnc = (axes ?? []).map((a) => [
        "^ ",
        "~:tag",     a.tag,
        "~:min",     a.min,
        "~:max",     a.max,
        "~:default", a.default,
        "~:name",    a.name ?? a.tag,
      ]);
      map.push("~:axes", axesEnc);

      if (Array.isArray(instances) && instances.length > 0) {
        const instEnc = instances.map((inst) => {
          const coordMap = ["^ "];
          for (const [tag, val] of Object.entries(inst.coords ?? {})) {
            coordMap.push(`~:${tag}`, val);
          }
          return ["^ ", "~:name", inst.name ?? "", "~:coords", coordMap];
        });
        map.push("~:instances", instEnc);
      }
    }

    return map;
  });
  return JSON.stringify(arr);
}

/**
 * Plain-object twin of encodeTransitFontVariants for the view-only bundle's
 * :fonts. The headless engine js->clj-keywordizes these maps, so the hyphenated
 * string keys here become the same :font-id / :font-family / :woff1-file-id / …
 * keys the SPA's df/fonts-fetched + generate-custom-font-variant-css read. This
 * is deliberately the SAME logical field set encodeTransitFontVariants hand-
 * encodes for get-font-variants (kept in sync) — minus the transit tags, since
 * the engine encodes the whole bundle (fonts included) in one transit pass.
 */
export function fontVariantsForBundle(variants) {
  return variants.map((v) => {
    const { id, fontId, family, weight, style, variable, axes, instances } = v;
    // Serve the RAW (un-"custom-"-prefixed) font-id — fonts.cljs adapt-font-id
    // always prepends "custom-"; a pre-prefixed id yields "custom-custom-".
    const rawFontId = String(fontId ?? id).replace(/^custom-/, "");
    // One file per variant, served by /assets/by-id/<id>; point every *-file-id
    // slot at the same id (the browser sniffs the real format).
    const map = {
      "id": id,
      "font-id": rawFontId,
      "font-family": family,
      "font-weight": weight,
      "font-style": style,
      "woff2-file-id": id,
      "woff1-file-id": id,
      "ttf-file-id": id,
      "otf-file-id": id,
    };
    if (variable) {
      map["variable"] = true;
      map["axes"] = (axes ?? []).map((a) => ({
        "tag": a.tag, "min": a.min, "max": a.max,
        "default": a.default, "name": a.name ?? a.tag,
      }));
      if (Array.isArray(instances) && instances.length > 0) {
        map["instances"] = instances.map((inst) => ({
          "name": inst.name ?? "",
          "coords": { ...(inst.coords ?? {}) },
        }));
      }
    }
    return map;
  });
}

// ---------------------------------------------------------------------------
// Media objects: local /media writes for upload / create-from-url / clone
// ---------------------------------------------------------------------------

// file-media-object content-type → on-disk extension (mirrors media.mjs).
const MTYPE_EXT = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/avif": "avif",
  "image/bmp": "bmp",
  "image/svg+xml": "svg",
};

function extFor(mtype, filename) {
  if (mtype && MTYPE_EXT[mtype]) return MTYPE_EXT[mtype];
  if (filename && filename.includes(".")) return filename.slice(filename.lastIndexOf(".") + 1).toLowerCase();
  return "bin";
}

/**
 * Encode a media-object as a penpot transit+json map.  The :id is encoded as a
 * transit uuid (`~u…`) so the SPA's transit reader hands the workspace a real
 * UUID (the value it bakes into the shape's :fill-image :id).
 */
function encodeTransitMediaObject(o) {
  return JSON.stringify([
    "^ ",
    "~:id", `~u${o.id}`,
    "~:name", o.name,
    "~:width", o.width,
    "~:height", o.height,
    "~:mtype", o.mtype,
    "~:is-local", o["is-local"],
    "~:created-at", o["created-at"],
    "~:modified-at", o["modified-at"],
  ]);
}

/**
 * Write an image blob to `<design>/media/<new-id>.<ext>` + a `<new-id>.json`
 * sidecar ({width,height,mtype,name}) and return the media-object map.
 * Dimensions are probed from the bytes; the multipart-declared mtype is the
 * fallback when the probe can't read the format.
 */
function writeMediaObject(designDir, { bytes, mtype, name, filename, isLocal = true }) {
  if (!designDir) throw new Error("upload: no design configured");
  const probe = imageSize(bytes);
  const finalMtype = probe?.mtype || mtype || "application/octet-stream";
  const width = probe?.width ?? 0;
  const height = probe?.height ?? 0;
  const id = randomUUID();
  const ext = extFor(finalMtype, filename);
  const objName = name || filename || "image";

  const mediaDir = path.join(designDir, "media");
  fs.mkdirSync(mediaDir, { recursive: true });
  fs.writeFileSync(path.join(mediaDir, `${id}.${ext}`), bytes);
  fs.writeFileSync(path.join(mediaDir, `${id}.json`),
    JSON.stringify({ width, height, mtype: finalMtype, name: objName }));

  const now = new Date().toISOString();
  return { id, name: objName, width, height, mtype: finalMtype, "is-local": isLocal !== false, "created-at": now, "modified-at": now };
}

/** Strip a transit uuid prefix (`~u`) if present. */
const unTransitUuid = (v) => (typeof v === "string" ? v.replace(/^~u/, "") : v);

/** Clone an on-disk media object (`<src>.<ext>` + sidecar + optional thumbnail) under a new id. */
function cloneMediaObject(designDir, srcId) {
  if (!designDir) throw new Error("clone: no design configured");
  const asset = resolveMediaAsset(designDir, srcId);
  if (!asset) throw new Error(`clone: source media ${srcId} not found`);
  const mediaDir = path.join(designDir, "media");
  const ext = asset.filePath.slice(asset.filePath.lastIndexOf(".") + 1).toLowerCase();
  const newId = randomUUID();

  fs.copyFileSync(asset.filePath, path.join(mediaDir, `${newId}.${ext}`));

  let meta = { width: 0, height: 0, mtype: asset.contentType, name: "image" };
  try { meta = { ...meta, ...JSON.parse(fs.readFileSync(path.join(mediaDir, `${srcId}.json`), "utf8")) }; } catch { /* no sidecar */ }
  fs.writeFileSync(path.join(mediaDir, `${newId}.json`), JSON.stringify(meta));

  const thumb = resolveMediaAsset(designDir, srcId, { thumbnail: true });
  if (thumb && thumb.filePath !== asset.filePath) {
    const tExt = thumb.filePath.slice(thumb.filePath.lastIndexOf(".") + 1).toLowerCase();
    fs.copyFileSync(thumb.filePath, path.join(mediaDir, `${newId}.thumbnail.${tExt}`));
  }

  const now = new Date().toISOString();
  return { id: newId, name: meta.name, width: meta.width, height: meta.height, mtype: meta.mtype, "is-local": true, "created-at": now, "modified-at": now };
}

// ---------------------------------------------------------------------------
// HTTP router — called by server.mjs for every /api/* request
// ---------------------------------------------------------------------------

export async function handleRpc(req, res, cfg) {
  const command = cmd(req.url);
  const accept = req.headers["accept"] || "";
  const wantTransit = accept.includes("transit");

  if (command === "get-file") {
    // The SPA calls get-file?id=<fileId> both for the main design and for each
    // linked library.  Resolve which file to serve:
    //   1. No ?id or ?id matches the design file → serve the main design.
    //   2. ?id matches a linked library → serve that library from shared/.
    const reqId = qp(req.url, "id");
    let serveDir = cfg.design;
    if (reqId && cfg.design) {
      const projectRoot = cfg.project ?? resolveProjectRoot(cfg.design);
      const libRefs = parseLibrariesFromManifest(getStore(cfg.design).manifest);
      const ref = libRefs.find(({ id }) => id === reqId);
      if (ref) serveDir = path.join(projectRoot, ref.path);
    }
    const { meta, transit } = getFile(serveDir);
    res.writeHead(200, {
      "content-type": wantTransit ? "application/transit+json" : "application/json",
      "x-pencilpot-source": "disk",
    });
    res.end(wantTransit ? transit : JSON.stringify(meta));
    return;
  }

  if (command === "update-file") {
    const body = (await readBody(req)).toString("utf8");
    const { revn } = updateFile(cfg.design, body);
    // The SPA calls update-file as transit (Accept: transit+json) and expects the
    // transit response (["^ ","~:revn", N, "~:lagged", []], matching
    // pencilpot/spike/recordings/055-update-file.body).  The headless SDK/MCP
    // commit() path sends Accept: application/json and expects {"revn": N} (the
    // real backend's JSON shape) — honour Accept so wc.commit() reads revn correctly.
    if (wantTransit) {
      res.writeHead(200, { "content-type": "application/transit+json" });
      res.end(buildUpdateFileResponse(revn));
    } else {
      // Match the REAL backend's JSON contract: it returns the PRE-increment
      // (original) revn (files_update.clj: "preserve the original revn for the
      // response"), and the SDK's wc.commit() computes the new revn as res.revn+1.
      // persistChanges returns the POST-increment revn, so hand back revn-1 here.
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ revn: revn - 1, lagged: [] }));
    }
    return;
  }

  if (command === "get-file-libraries") {
    // Return transit-encoded list of linked library metadata.
    // If no design is configured, return empty (safe fallback).
    if (!cfg.design) {
      res.writeHead(200, { "content-type": "application/transit+json", "x-pencilpot-source": "disk" });
      res.end("[]");
      return;
    }
    const projectRoot = cfg.project ?? resolveProjectRoot(cfg.design);
    const libs = getFileLibraries(cfg.design, projectRoot);
    res.writeHead(200, {
      "content-type": "application/transit+json",
      "x-pencilpot-source": "disk",
    });
    res.end(encodeTransitLibraryList(libs));
    return;
  }

  if (command === "get-font-variants") {
    // Serve custom font variants from the project's fonts/ directory.
    // team-id in the request is ignored (pencilpot has no multi-team concept).
    // Empty project → valid empty list (safe fallback; does not break SPA boot).
    const projectRoot = cfg.project ?? (cfg.design ? resolveProjectRoot(cfg.design) : null);
    const variants = projectRoot ? readFonts(projectRoot) : [];
    res.writeHead(200, {
      "content-type": "application/transit+json",
      "x-pencilpot-source": "disk",
    });
    res.end(encodeTransitFontVariants(variants));
    return;
  }

  if (command === "rename-file") {
    // The SPA's dw/rename-file optimistically updates UI state then calls
    // (rp/cmd! :rename-file {:id :name}).  Persist the new name into the
    // working-copy manifest's top-level :name and mark the design dirty so the
    // rename is written to disk on the next explicit Save.
    const body = (await readBody(req)).toString("utf8");
    // Name may arrive transit-encoded ("~:name","New") or as JSON (:name "New").
    // Prefer transitGet for the transit case: it JSON.parses and decodes the
    // value in full, so names containing `"` or `\` are not truncated by a
    // hand-rolled quote-delimited regex.  Fall back to the plain JSON/EDN
    // `:name "..."` encoding when the body is not a transit map.
    let newName = null;
    try {
      newName = transitGet(body, "name");
    } catch {
      // Body is not valid JSON (e.g. plain EDN) — fall through to the regex.
    }
    if (newName == null) {
      const m = body.match(/:name\s+"([^"]*)"/);
      newName = m ? m[1] : null;
    }
    const store = cfg.design ? getStore(cfg.design) : null;
    if (newName != null && store) {
      // manifest.edn serializes keywords alphabetically, so the FIRST
      // `:name "..."` is the design's file name (library refs serialize as
      // {:id :path} with no nested :name before it).  Anchor to that first
      // occurrence; JSON.stringify escapes quotes/backslashes in the new name.
      // Use a FUNCTION replacer so `$`-sequences in the name (e.g. `$&`, `$1`,
      // `` $` ``) are written literally and never interpreted as replacement
      // patterns by String.prototype.replace.
      store.manifest = store.manifest.replace(
        /(:name\s+)"(?:[^"\\]|\\.)*"/,
        (_m, p1) => p1 + JSON.stringify(newName),
      );
      stage(cfg.design, store, status().revn);
      broadcastStatus(status().dirty, status().revn);
    }
    res.writeHead(200, { "content-type": "application/transit+json" });
    return res.end('["^ "]');
  }

  // --- Media objects: write the uploaded/fetched/cloned blob into <design>/media
  //     and return a real media-object so "add/replace image" works (and the
  //     `unhandled RPC upload-file-media-object` warning stops firing).
  if (command === "upload-file-media-object") {
    const body = await readBody(req);
    const { fields, file } = parseMultipart(body, req.headers["content-type"]);
    if (!file) throw new Error("upload-file-media-object: no file part in multipart body");
    const obj = writeMediaObject(cfg.design, {
      bytes: file.bytes, mtype: file.mtype, name: fields["name"], filename: file.filename,
      isLocal: fields["is-local"] !== "false",
    });
    res.writeHead(200, { "content-type": wantTransit ? "application/transit+json" : "application/json" });
    res.end(wantTransit ? encodeTransitMediaObject(obj) : JSON.stringify(obj));
    return;
  }

  if (command === "create-file-media-object-from-url") {
    const bodyStr = (await readBody(req)).toString("utf8");
    const url = transitGet(bodyStr, "url");
    const name = transitGet(bodyStr, "name");
    if (!url) throw new Error("create-file-media-object-from-url: missing url");
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`create-file-media-object-from-url: fetch ${url} → HTTP ${resp.status}`);
    const bytes = Buffer.from(await resp.arrayBuffer());
    const obj = writeMediaObject(cfg.design, {
      bytes, mtype: resp.headers.get("content-type") || undefined,
      name, filename: url.split("/").pop(),
    });
    res.writeHead(200, { "content-type": wantTransit ? "application/transit+json" : "application/json" });
    res.end(wantTransit ? encodeTransitMediaObject(obj) : JSON.stringify(obj));
    return;
  }

  if (command === "clone-file-media-object") {
    const bodyStr = (await readBody(req)).toString("utf8");
    const srcId = unTransitUuid(transitGet(bodyStr, "id"));
    if (!srcId) throw new Error("clone-file-media-object: missing id");
    const obj = cloneMediaObject(cfg.design, srcId);
    res.writeHead(200, { "content-type": wantTransit ? "application/transit+json" : "application/json" });
    res.end(wantTransit ? encodeTransitMediaObject(obj) : JSON.stringify(obj));
    return;
  }

  // --- Prototype view mode: the viewer's fetch-bundle (data/viewer) calls
  //     :get-view-only-bundle to load the file.  Without a real bundle it hits
  //     the benign `200 {}` stub below -> nil :file/page -> the viewer raises
  //     :not-found and renders the "doesn't exist" 404 screen.
  //     Build the bundle in the headless engine (ONE transit doc so the file
  //     :data cache refs stay coherent) and inject the team fonts so custom /
  //     variable fonts render in view mode.
  if (command === "get-view-only-bundle") {
    const dir = cfg.design;
    // Custom font variants (best-effort: a project-less design still yields a
    // valid bundle with an empty :fonts).
    let fonts = [];
    try {
      const projectRoot = cfg.project ?? (dir ? resolveProjectRoot(dir) : null);
      if (projectRoot) fonts = fontVariantsForBundle(readFonts(projectRoot));
    } catch {
      // No fonts.json / unreadable fonts dir — the bundle is still valid.
    }
    // projectName: the design's file name from the manifest (viewer only shows it).
    let projectName = "Local";
    try {
      const m = dir && getStore(dir).manifest.match(/:name\s+"((?:[^"\\]|\\.)*)"/);
      if (m) projectName = JSON.parse(`"${m[1]}"`);
    } catch {
      // Keep the default name.
    }
    // teamId mirrors server.mjs TEAM_ID; projectId is a stable synthetic uuid
    // (pencilpot has no multi-project team concept — the viewer only needs a uuid).
    const teamId = "0398e5fc-95c9-80d6-8008-29071f0fdaed";
    const projectId = "0398e5fc-95c9-80d6-8008-29071f0fdaf0";
    const { transit } = JSON.parse(
      readSessionFor(dir).getViewerBundle(
        JSON.stringify({ teamId, projectId, projectName, fonts }),
      ),
    );
    res.writeHead(200, {
      "content-type": "application/transit+json",
      "x-pencilpot-source": "disk",
    });
    res.end(transit);
    return;
  }

  // Drain request body for non-GET/HEAD requests so the socket stays clean.
  if (!["GET", "HEAD"].includes(req.method)) await readBody(req);

  // Synthetic boot stubs (recordings replayed verbatim).
  if (isStub(command)) {
    stub(command, res);
    return;
  }

  // Pencilpot is a backendless IDE — unknown SaaS RPCs (update-profile-props,
  // audit, prefs, set-workspace-visited, etc.) must NEVER return 4xx.
  // A 404 causes Penpot's repo layer to raise :unable-to-process-repository-response
  // and crash the whole workspace with an internal-error screen.
  // Return a benign 200 with an empty transit map so fire-and-forget writes no-op.
  console.warn(`[pencilpot] unhandled RPC ${command} -> 200 {}`);
  const wantTransitFallback = (req.headers["accept"] || "").includes("transit");
  if (wantTransitFallback) {
    res.writeHead(200, { "content-type": "application/transit+json" });
    res.end('["^ "]');
  } else {
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  }
}
