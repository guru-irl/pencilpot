// VF bug harness — seed a temp .pencil project from DefaultLauncher and mutate
// the variable-font text node's :font-variation-settings to a chosen value.
//
// We copy the real DefaultLauncher design (a known-valid file already using the
// VF "Google Sans Flex" at font-id custom-custom-google-sans-flex) into a temp
// project, then rewrite the single text node "LAUNCHER" so its wdth/opsz/etc.
// axes are set to the requested extreme. Rendering that file at two extremes
// must produce visibly different glyphs IF the axes are honoured by the wasm
// renderer.
//
// Usage: node seed.mjs <destProjectRoot> <axisJson>
//   axisJson e.g. '{"wdth":151,"opsz":144,"GRAD":0,"ROND":0,"slnt":0}'
// Prints the fileId (page workspace target) on stdout.

import fs from "node:fs";
import path from "node:path";

// The VF-axis fixture lives in pencilpot-vftest: a copy of the design system
// whose "LAUNCHER" heading is set to the VARIABLE font (custom-custom-google-sans-flex)
// so axis edits are observable. (The canonical design system at
// /mnt/data/src/DefaultLauncher/design uses the STATIC width families and is not
// the right fixture for axis testing.)
const SRC = "/mnt/data/src/pencilpot-vftest";
const SRC_DESIGN = path.join(SRC, "designs/default-design-system");
const VF_PAGE = "a0b0c325-382e-80da-8008-238861a34c9c.edn";
const TARGET_TEXT = "LAUNCHER"; // the auto-width VF heading we mutate

function cpDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const s = path.join(from, e.name);
    const d = path.join(to, e.name);
    if (e.isDirectory()) cpDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

// Render an EDN map literal for {"tag" value ...} (string keys, numeric vals).
function ednAxisMap(axes) {
  const body = Object.entries(axes)
    .map(([k, v]) => `\n                      ${JSON.stringify(k)} ${v}`)
    .join("");
  return `{${body}}`;
}

export function seed(destRoot, axes) {
  fs.rmSync(destRoot, { recursive: true, force: true });
  fs.mkdirSync(destRoot, { recursive: true });

  // Copy fonts/ (the VF registration + ttf files) and the design.
  cpDir(path.join(SRC, "fonts"), path.join(destRoot, "fonts"));
  const designDir = path.join(destRoot, "designs/default-design-system");
  cpDir(SRC_DESIGN, designDir);

  // Write the .pencil manifest.
  const pencil = {
    name: "vf-proof",
    designs: [{ name: "default-design-system", path: "designs/default-design-system" }],
    default: "default-design-system",
    version: 1,
  };
  const pencilPath = path.join(destRoot, "vf-proof.pencil");
  fs.writeFileSync(pencilPath, JSON.stringify(pencil, null, 2));

  // Mutate the VF text node: replace EVERY :font-variation-settings block on the
  // VF page with the requested axes. There are exactly two (leaf + paragraph)
  // for the LAUNCHER node; replacing all is fine since this page only has the
  // one VF text we care about with variation settings present.
  const pagePath = path.join(designDir, "pages", VF_PAGE);
  let edn = fs.readFileSync(pagePath, "utf8");
  const newMap = ednAxisMap(axes);
  // Match `:font-variation-settings {  ... }` (multi-line). The value map ends
  // at the first standalone `}` that closes it. Original maps contain only
  // "TAG" number pairs, no nested braces, so a non-greedy match to `}` is safe.
  const before = edn;
  edn = edn.replace(/:font-variation-settings\s*\{[^{}]*\}/g, `:font-variation-settings ${newMap}`);
  if (edn === before) throw new Error("seed: no :font-variation-settings block found to mutate");
  fs.writeFileSync(pagePath, edn);

  // Read fileId from manifest.
  const manifest = fs.readFileSync(path.join(designDir, "manifest.edn"), "utf8");
  const id = manifest.match(/:id\s+#uuid\s+"([^"]+)"/)[1];
  return { pencilPath, designDir, fileId: id };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const destRoot = process.argv[2];
  const axes = JSON.parse(process.argv[3]);
  const { fileId } = seed(destRoot, axes);
  process.stdout.write(fileId);
}
