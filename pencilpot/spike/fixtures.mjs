// Replay captured /api responses by command name (verbatim bytes).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "recordings");

// Map command-name -> { status, contentType, body:Buffer }. Last write wins (latest capture).
function load() {
  const map = new Map();
  if (!fs.existsSync(DIR)) return map;
  for (const f of fs.readdirSync(DIR).filter((x) => x.endsWith(".json"))) {
    const meta = JSON.parse(fs.readFileSync(path.join(DIR, f), "utf8"));
    const body = fs.readFileSync(path.join(DIR, f.replace(/\.json$/, ".body")));
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
