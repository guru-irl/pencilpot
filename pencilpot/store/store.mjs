import fs from "node:fs";
import path from "node:path";
import { stripPositionData } from "./edn.mjs";

// parts = { manifest: edn-str, pages: {id: edn}, components: {id: edn}, media: [id…] }
export function writeDesign(dir, parts) {
  fs.mkdirSync(path.join(dir, "pages"), { recursive: true });
  fs.mkdirSync(path.join(dir, "components"), { recursive: true });
  fs.mkdirSync(path.join(dir, "media"), { recursive: true });
  fs.writeFileSync(path.join(dir, "manifest.edn"), parts.manifest);
  for (const [id, edn] of Object.entries(parts.pages)) fs.writeFileSync(path.join(dir, "pages", `${id}.edn`), stripPositionData(edn));
  for (const [id, edn] of Object.entries(parts.components)) fs.writeFileSync(path.join(dir, "components", `${id}.edn`), stripPositionData(edn));
  prune(path.join(dir, "pages"), new Set(Object.keys(parts.pages).map((i) => `${i}.edn`)));
  prune(path.join(dir, "components"), new Set(Object.keys(parts.components).map((i) => `${i}.edn`)));
}

function prune(d, keep) {
  if (!fs.existsSync(d)) return;
  for (const f of fs.readdirSync(d)) if (f.endsWith(".edn") && !keep.has(f)) fs.rmSync(path.join(d, f));
}

export function readDesign(dir) {
  return {
    manifest: fs.readFileSync(path.join(dir, "manifest.edn"), "utf8"),
    pages: readEdnDir(path.join(dir, "pages")),
    components: readEdnDir(path.join(dir, "components")),
    media: [],
  };
}

function readEdnDir(d) {
  const out = {};
  if (!fs.existsSync(d)) return out;
  for (const f of fs.readdirSync(d).filter((x) => x.endsWith(".edn"))) out[f.replace(/\.edn$/, "")] = fs.readFileSync(path.join(d, f), "utf8");
  return out;
}
