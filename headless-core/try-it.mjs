// Phase 0 hands-on demo: add a board to the penpot-hl file HEADLESSLY (no browser, no plugin).
// Usage:  node try-it.mjs [name] [x] [y] [width] [height]
//   e.g.  node try-it.mjs "Hello" 80 80 400 300
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { buildAddBoardBody } from "./target/headless/penpot.js";

const BASE = process.env.PENPOT_HL_BASE ?? "http://localhost:9101";
const env = JSON.parse(readFileSync(new URL("../infra/penpot-hl/test-env.json", import.meta.url)));

const [name = "Headless Demo", x = "60", y = "60", width = "360", height = "240"] = process.argv.slice(2);

async function rpc(name, body, { transit } = {}) {
  const res = await fetch(`${BASE}/api/rpc/command/${name}`, {
    method: "POST",
    headers: {
      "Content-Type": transit ? "application/transit+json" : "application/json",
      Accept: "application/json",
      Authorization: `Token ${env.token}`,
    },
    body: transit ?? JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${name} -> HTTP ${res.status}: ${text.slice(0, 500)}`);
  return text ? JSON.parse(text) : undefined;
}

// 1. read current document state (revn/vern/features/pageId)
const file = await rpc("get-file", { id: env.fileId });
const pageId = file.data.pages[0];

// 2. build a geometry-complete board change with Penpot's OWN engine, encoded as transit
const body = buildAddBoardBody(JSON.stringify({
  fileId: env.fileId, sessionId: randomUUID(),
  revn: file.revn, vern: file.vern, features: file.features,
  pageId, x: +x, y: +y, width: +width, height: +height, name,
}));

// 3. persist headlessly via update-file
const res = await rpc("update-file", null, { transit: body });

console.log(`✅ Added board "${name}" (${x},${y} ${width}x${height}) — revn ${file.revn} -> ${res.revn + 1}`);
console.log(`   Open the file at ${BASE} (login hl@penpot.local / penpot1234) — if it's already open, the board appears live.`);
