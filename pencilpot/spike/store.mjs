// Spike store: a file lives as <id>.transit (file-data transit) + <id>.meta.json.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "store");
fs.mkdirSync(DIR, { recursive: true });

export function writeFile(id, transit, meta) {
  fs.writeFileSync(path.join(DIR, `${id}.transit`), transit);
  fs.writeFileSync(path.join(DIR, `${id}.meta.json`), JSON.stringify(meta, null, 2));
}
export function readFile(id) {
  const tp = path.join(DIR, `${id}.transit`);
  if (!fs.existsSync(tp)) return null;
  return {
    transit: fs.readFileSync(tp, "utf8"),
    meta: JSON.parse(fs.readFileSync(path.join(DIR, `${id}.meta.json`), "utf8")),
  };
}
