// Text-fidelity proof: the Typography board (all text, no shapes) must rasterize
// to a PNG with real glyphs. The fast rsvg path renders it blank (foreignObject);
// renderShapePngHiFi (Chromium) renders the text. We assert a non-trivial fraction
// of dark pixels AND that hi-fi has materially more ink than the fast path.
//
// SKIP (exit 0) if the design is absent. Run: node pencilpot/e2e/ai/render-text.mjs
import { FID, SRC_DESIGN, SCRATCH, designPresent, copyDesign, spawnRuntime, loadWorkingCopy, kill, makeChecks } from "./_boot.mjs";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

if (!designPresent()) { console.log("SKIP: canonical design absent — text fidelity"); process.exit(0); }

// Fraction of inked (non-white) pixels in a PNG, via ImageMagick.
function inkRatio(png) {
  const r = spawnSync("magick", [png, "-background", "white", "-alpha", "remove", "-alpha", "off",
    "-colorspace", "Gray", "-negate", "-threshold", "20%", "-format", "%[fx:mean]", "info:"], { encoding: "utf8" });
  return parseFloat((r.stdout || "0").trim()) || 0;
}

const { check, passed } = makeChecks();
let srv;
try {
  const fontsDir = path.resolve(SRC_DESIGN, "../fonts");
  check(fs.existsSync(path.join(fontsDir, "fonts.json")), `project fonts store present (${fontsDir})`);
  const dir = copyDesign("render-text");
  const r = await spawnRuntime(dir);
  srv = r.proc;
  const wc = await new (await loadWorkingCopy(r.base))(FID, "local").checkout();
  const objs = JSON.parse(wc.session.objects());
  const ROOT = "00000000-0000-0000-0000-000000000000";
  const boards = Object.values(objs).filter(o => o.type === "frame" && o["frame-id"] === ROOT);
  const typo = boards.find(b => /typography/i.test(b.name) && !/mono/i.test(b.name)) || boards[0];
  check(!!typo, `picked the Typography board (${typo?.name})`);

  // SVG now carries foreignObject text markup (A1).
  const svg = wc.renderShape(typo.id);
  check((svg.match(/<foreignObject/g) || []).length > 0, `SVG carries foreignObject text (${(svg.match(/<foreignObject/g)||[]).length})`);

  // Fast (rsvg) path — text-less by design.
  const fastPng = path.join(SCRATCH, "typo-fast.png");
  wc.renderShapePng(typo.id, { scale: 1, out: fastPng });
  const fast = inkRatio(fastPng);

  // Hi-fi (Chromium) path — text rendered.
  const hiPng = path.join(SCRATCH, "typo-hifi.png");
  await wc.renderShapePngHiFi(typo.id, { scale: 2, out: hiPng, fontsDir });
  check(fs.existsSync(hiPng) && fs.readFileSync(hiPng).slice(0, 8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a])), "hi-fi PNG written (PNG magic)");
  const hi = inkRatio(hiPng);

  check(hi > 0.01, `hi-fi has real text ink (${(hi*100).toFixed(2)}% > 1%)`);
  check(hi > fast + 0.005, `hi-fi shows MORE text than fast/rsvg (hi=${(hi*100).toFixed(2)}% vs fast=${(fast*100).toFixed(2)}%)`);
  console.log(passed() ? "\nALL CHECKS PASS" : "\nSOME CHECKS FAILED");
} finally { kill(srv); }
process.exit(passed() ? 0 : 1);
