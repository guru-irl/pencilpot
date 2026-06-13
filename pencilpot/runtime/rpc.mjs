// Real RPC handlers: get-file/update-file from on-disk EDN store + synthetic
// boot stubs for all other SPA endpoints.
import path from "node:path";
import { createSession } from "../../headless-core/target/headless/penpot.js";
import { readDesign, writeDesign } from "../store/index.mjs";
import { readFonts } from "../store/fonts.mjs";
import { resolveProjectRoot, resolveProject } from "../store/project.mjs";
import { readBody } from "./proxy.mjs";
import { stub, isStub, buildUpdateFileResponse } from "./stubs.mjs";
import { noteSelfWrite } from "./live.mjs";

/** Extract the RPC command name from a URL like /api/main/methods/get-file?... */
const cmd = (url) => url.split("?")[0].split("/").filter(Boolean).pop();

/** Extract a query-param value from a URL string. */
const qp = (url, key) => new URL("http://h" + url).searchParams.get(key);

/** Hydrate a session from the on-disk store at `dir`. */
function sessionFor(dir) {
  return createSession(JSON.stringify({ fromStore: readDesign(dir) }));
}

/**
 * Extract a value from a transit-JSON map array by keyword name.
 * Transit maps are encoded as ["^ ", "~:key1", val1, "~:key2", val2, ...].
 * This is a lightweight raw extraction — values are NOT fully transit-decoded.
 */
function transitGet(transitStr, keyword) {
  const arr = JSON.parse(transitStr);
  if (!Array.isArray(arr) || arr[0] !== "^ ") return undefined;
  const needle = `~:${keyword}`;
  for (let i = 1; i < arr.length - 1; i += 2) {
    if (arr[i] === needle) return arr[i + 1];
  }
  return undefined;
}

/**
 * Hydrate -> applyFn(session) -> bump revn -> serialize -> write.
 * Returns { revn } so callers can embed it in the response.
 *
 * Calls noteSelfWrite() immediately AFTER the disk write so the live-update
 * watcher adopts the just-written content as its baseline — the fs events this
 * write generates then resolve to an unchanged signature and never reload.
 */
function persistChanges(dir, applyFn) {
  const s = sessionFor(dir);
  applyFn(s);
  const revn = s.bumpRevn();
  writeDesign(dir, JSON.parse(s.serializeStore()));
  noteSelfWrite();                             // ← adopt new content as baseline
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
  const result = JSON.parse(sessionFor(dir).getFileResponse());
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
  const manifest = readDesign(designDir).manifest;
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
function encodeTransitFontVariants(variants) {
  const arr = variants.map(({ id, fontId, family, weight, style, format }) => {
    // Penpot's custom-font @font-face builds its URL from :woff1-file-id (see
    // fonts.cljs generate-custom-font-variant-css).  We only ever have one file
    // per variant, served by /assets/by-id/<id> with the correct content-type, so
    // point ALL the *-file-id slots at the same id — whichever the loader reads,
    // the URL resolves to the real file (the browser sniffs the actual format).
    const woff2 = id, woff1 = id, ttf = id, otf = id;
    return [
      "^ ",
      "~:id",           id,
      "~:font-id",      fontId ?? id,
      "~:font-family",  family,
      "~:font-weight",  weight,
      "~:font-style",   style,
      "~:woff2-file-id", woff2,
      "~:woff1-file-id", woff1,
      "~:ttf-file-id",   ttf,
      "~:otf-file-id",   otf,
    ];
  });
  return JSON.stringify(arr);
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
      const libRefs = parseLibrariesFromManifest(readDesign(cfg.design).manifest);
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
    // Response shape matches pencilpot/spike/recordings/055-update-file.body:
    // transit+json: ["^ ","~:revn", N, "~:lagged", []]
    res.writeHead(200, { "content-type": "application/transit+json" });
    res.end(buildUpdateFileResponse(revn));
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
