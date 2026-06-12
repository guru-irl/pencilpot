// Replay captured /api responses by command name (verbatim bytes).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "recordings");

// All-zeros UUID = anonymous profile; we never want to replay this.
const ANON_UUID = "00000000-0000-0000-0000-000000000000";

function isAnonymousProfile(command, body) {
  if (command !== "get-profile") return false;
  // Transit+json: the id field follows "~u" prefix
  return body.includes(ANON_UUID);
}

// Map command-name -> { status, contentType, body:Buffer }.
// Files are sorted so highest-seq number wins (last capture wins),
// and anonymous get-profile captures are skipped.
function load() {
  const map = new Map();
  if (!fs.existsSync(DIR)) return map;
  const files = fs.readdirSync(DIR).filter((x) => x.endsWith(".json")).sort();
  for (const f of files) {
    const meta = JSON.parse(fs.readFileSync(path.join(DIR, f), "utf8"));
    const bodyPath = path.join(DIR, f.replace(/\.json$/, ".body"));
    const body = fs.readFileSync(bodyPath);

    // Skip anonymous profile responses; they redirect the SPA to /auth/login.
    if (isAnonymousProfile(meta.command, body.toString("utf8"))) continue;

    // Serve 401 get-enabled-flags as empty 200; a 401 causes the SPA to bounce.
    if (meta.command === "get-enabled-flags" && meta.status === 401) {
      map.set(meta.command, {
        status: 200,
        contentType: "application/transit+json",
        body: Buffer.from("[]"),
      });
      continue;
    }

    map.set(meta.command, { status: meta.status, contentType: meta.contentType, body });
  }
  return map;
}

const FIXTURES = load();

export function replayFixture(command, res) {
  const fx = FIXTURES.get(command);
  if (!fx) { res.writeHead(404); res.end(`no fixture for ${command}`); return false; }
  res.writeHead(fx.status, { "content-type": fx.contentType });
  res.end(fx.body);
  return true;
}

export function hasFixture(command) { return FIXTURES.has(command); }
