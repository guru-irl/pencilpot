// Real RPC handlers: get-file/update-file from on-disk EDN store + synthetic
// boot stubs for all other SPA endpoints.
import { createSession } from "../../headless-core/target/headless/penpot.js";
import { readDesign, writeDesign } from "../store/index.mjs";
import { readBody } from "./proxy.mjs";
import { stub, isStub, buildUpdateFileResponse } from "./stubs.mjs";

/** Extract the RPC command name from a URL like /api/main/methods/get-file?... */
const cmd = (url) => url.split("?")[0].split("/").filter(Boolean).pop();

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
 */
function persistChanges(dir, applyFn) {
  const s = sessionFor(dir);
  applyFn(s);
  const revn = s.bumpRevn();
  writeDesign(dir, JSON.parse(s.serializeStore()));
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

// ---------------------------------------------------------------------------
// HTTP router — called by server.mjs for every /api/* request
// ---------------------------------------------------------------------------

export async function handleRpc(req, res, cfg) {
  const command = cmd(req.url);
  const accept = req.headers["accept"] || "";
  const wantTransit = accept.includes("transit");

  if (command === "get-file") {
    const { meta, transit } = getFile(cfg.design);
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
    // Task 7 fills this with real library data; for now stub empty list.
    res.writeHead(200, { "content-type": "application/transit+json" });
    res.end("[]");
    return;
  }

  // Drain request body for non-GET/HEAD requests so the socket stays clean.
  if (!["GET", "HEAD"].includes(req.method)) await readBody(req);

  // Synthetic boot stubs (recordings replayed verbatim).
  if (isStub(command)) {
    stub(command, res);
    return;
  }

  res.writeHead(404);
  res.end(`no stub: ${command}`);
}
