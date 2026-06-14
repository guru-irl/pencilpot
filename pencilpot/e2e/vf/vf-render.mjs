// VF render regression harness — proves the two variable-font bugs stay fixed.
//
// Bug 1 (axes don't render): rendering the SAME VF text at two extreme axis
//   values must produce visibly DIFFERENT glyphs. Before the fix the renders
//   were byte-identical (RMSE 0) because the span resolved to the default font
//   (normalize-font-id fell back to uuid/zero for slug-based custom font-ids),
//   so Skia's set_font_arguments had no variable typeface to apply axes to.
//
// Bug 2 (custom font not loaded on boot): on a fresh load the custom VF binary
//   must be FETCHED into the WASM font store. Before the fix font-id->asset-id
//   compared a UUID object against the registry's font-id STRING and never
//   matched, so the VF (and every other custom font) was never fetched — the
//   text rendered with a fallback until an interaction re-resolved it.
//
// Run: node vf-render.mjs   (boots the runtime + swiftshader Chromium itself)
// Requires: the frontend bundle + render-wasm built; DefaultLauncher fonts.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { seed } from "./seed.mjs";
import { shoot } from "./shoot.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = "/mnt/data/src/DefaultLauncher";
const FID = "67e207c3-ec3b-80d7-8008-252de1d3a44e";

// LAUNCHER heading crop window (deterministic under zoom-to-fit).
const CROP = "250x60+265+240";

function loud(msg) { process.stderr.write(msg + "\n"); }

function crop(png) {
  const out = png.replace(/\.png$/, ".crop.png");
  execFileSync("magick", [png, "-crop", CROP, "+repage", out]);
  return out;
}

// RMSE in [0,1] between two pngs via ImageMagick `compare`.
function rmse(a, b) {
  try {
    execFileSync("magick", ["compare", "-metric", "RMSE", a, b, "null:"], { stdio: "pipe" });
    return 0; // identical → compare exits 0 with "0 (0)"
  } catch (e) {
    // compare exits non-zero when images differ; the metric is on stderr.
    const m = String(e.stderr || "").match(/\(([\d.]+)\)/);
    return m ? parseFloat(m[1]) : NaN;
  }
}

async function main() {
  if (!fs.existsSync(SRC)) { loud(`SKIP: ${SRC} missing`); process.exit(0); }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vf-render-"));
  const dirA = path.join(tmp, "A"), dirB = path.join(tmp, "B");
  const shotA = path.join(tmp, "wdth25.png"), shotB = path.join(tmp, "wdth151.png");

  // Two extreme width axis values on the same VF text.
  seed(dirA, { wdth: 25, opsz: 6, GRAD: 0, ROND: 0, slnt: 0, wght: 400 });
  seed(dirB, { wdth: 151, opsz: 144, GRAD: 0, ROND: 0, slnt: 0, wght: 400 });

  const rA = await shoot({ projectRoot: dirA, fileId: FID, out: shotA });
  const rB = await shoot({ projectRoot: dirB, fileId: FID, out: shotB });

  const diff = rmse(crop(shotA), crop(shotB));
  loud(`Bug 1 — axes render: LAUNCHER crop RMSE(wdth25, wdth151) = ${diff}`);

  // Bug 2 — the custom VF binary must be fetched into the WASM store on load.
  const vfFetched = [...rA.fontAssets, ...rB.fontAssets].some((a) =>
    a.startsWith("custom-google-sans-flex")
  );
  loud(`Bug 2 — VF loaded on boot: custom VF asset fetched = ${vfFetched} ` +
    `(assets: ${[...new Set([...rA.fontAssets, ...rB.fontAssets])].length})`);

  const errs = [...rA.consoleErrors, ...rB.consoleErrors];
  let ok = true;

  // Axes MUST visibly change the glyphs. 0.05 is far above noise; observed ~0.24.
  if (!(diff > 0.05)) {
    loud(`FAIL Bug 1: axis change produced no visible render difference (RMSE ${diff})`);
    ok = false;
  }
  if (!vfFetched) {
    loud("FAIL Bug 2: custom VF binary was never fetched into the WASM store on boot");
    ok = false;
  }
  if (errs.length) {
    loud(`WARN: ${errs.length} console error(s): ${errs.slice(0, 3).join(" | ")}`);
  }

  fs.rmSync(tmp, { recursive: true, force: true });
  if (ok) { loud("PASS: variable-font axes render (Bug 1 fixed)"); process.exit(0); }
  process.exit(1);
}

main().catch((e) => { loud("ERROR: " + e.stack); process.exit(1); });
