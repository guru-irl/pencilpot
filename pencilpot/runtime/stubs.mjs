// Synthetic HTTP responses for workspace/SaaS endpoints the SPA still calls
// after the auth/dashboard layer was stripped in Phase 2.
// Replays verbatim bodies from pencilpot/runtime/stub-data/ (copied from
// Phase 0 recordings). get-enabled-flags returns empty [].
// Pruned stubs (Phase 2): get-profile, get-projects, get-team-recent-files,
// get-file-libraries (shadowed by the real rpc.mjs handler).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const STUB_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "stub-data");

// Load all stubbed commands into memory at import time.
function load() {
  const map = new Map();
  if (!fs.existsSync(STUB_DIR)) return map;
  for (const f of fs.readdirSync(STUB_DIR)) {
    if (!f.endsWith(".meta.json")) continue;
    const cmd = f.replace(/\.meta\.json$/, "");
    const meta = JSON.parse(fs.readFileSync(path.join(STUB_DIR, f), "utf8"));
    const body = fs.readFileSync(path.join(STUB_DIR, `${cmd}.body`));
    map.set(cmd, { status: meta.status, contentType: meta.contentType, body });
  }
  return map;
}

const STUBS = load();

/** Returns true if we have a stub for this command. */
export function isStub(command) {
  return STUBS.has(command);
}

/**
 * Write a stubbed response for the given command.
 * Returns true on success, false if no stub is registered.
 */
export function stub(command, res) {
  const s = STUBS.get(command);
  if (!s) return false;
  res.writeHead(s.status, { "content-type": s.contentType });
  res.end(s.body);
  return true;
}

/**
 * Build and return the transit+json body for an update-file response.
 * Shape: ["^ ","~:revn", N, "~:lagged", []]
 * (Matches the structure of pencilpot/spike/recordings/055-update-file.body)
 */
export function buildUpdateFileResponse(revn) {
  return JSON.stringify(["^ ", "~:revn", revn, "~:lagged", []]);
}
