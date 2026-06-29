// High-fidelity SVG → PNG rasterizer for shapes that contain TEXT.
//
// Why this exists: `renderShape` emits the Penpot SVG browser-free, but text
// shapes that lack browser-computed `:position-data` (always true under headless
// SSR) render as `<foreignObject>` HTML (see render.cljs frame-imposter is-render?).
// librsvg/ImageMagick IGNORE foreignObject, so the fast `renderShapePng` path is
// text-less by design. A real browser engine renders foreignObject + honors
// `@font-face`, so for pixel-accurate text we rasterize through the Chromium that
// Playwright already ships. This module dynamically imports Playwright ONLY when
// called, so the SDK keeps a browser-free default and no load-time dependency.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// Resolve Playwright from wherever it is installed in this repo (it is a
// pencilpot-layer dependency, not a headless-core one). Try the normal module
// resolution first, then the known pencilpot location.
async function loadChromium() {
  const candidates = [
    "playwright",
    path.resolve(HERE, "../../pencilpot/node_modules/playwright/index.mjs"),
    path.resolve(HERE, "../../node_modules/playwright/index.mjs"),
  ];
  for (const c of candidates) {
    try { const m = await import(c); if (m?.chromium) return m.chromium; } catch { /* try next */ }
  }
  throw new Error("hifi-raster: Playwright/Chromium not available (install playwright to enable fidelity:\"high\")");
}

const FONT_MIME = { ttf: "font/ttf", otf: "font/otf", woff: "font/woff", woff1: "font/woff", woff2: "font/woff2" };

/** Build an `@font-face` stylesheet from a pencilpot fonts/ store so Chromium
 *  can resolve the design's custom families (matched by family+weight+style). */
export function buildFontFaceCss(fontsDir) {
  if (!fontsDir) return "";
  const jsonPath = path.join(fontsDir, "fonts.json");
  if (!fs.existsSync(jsonPath)) return "";
  let variants = [];
  try { variants = JSON.parse(fs.readFileSync(jsonPath, "utf8")).variants || []; } catch { return ""; }
  const faces = [];
  for (const v of variants) {
    const file = v.file && path.join(fontsDir, v.file);
    if (!file || !fs.existsSync(file)) continue;
    const fmt = (v.format || path.extname(file).slice(1) || "ttf").toLowerCase();
    const b64 = fs.readFileSync(file).toString("base64");
    const weight = v.weight ?? 400;
    const style = v.style || "normal";
    faces.push(
      `@font-face{font-family:"${v.family}";font-weight:${weight};font-style:${style};` +
      `font-display:block;src:url(data:${FONT_MIME[fmt] || "font/ttf"};base64,${b64});}`,
    );
  }
  return faces.join("\n");
}

/**
 * Rasterize a Penpot SVG string (which may contain foreignObject text) to a PNG.
 * @param {{svg:string, out?:string, scale?:number, fontsDir?:string, id?:string}} opts
 * @returns {Promise<string>} the written PNG path
 */
export async function rasterizeSvg({ svg, out, scale = 2, fontsDir, id = "shape" }) {
  if (!svg || !svg.startsWith("<svg")) throw new Error("rasterizeSvg: input is not an <svg>");
  const png = out || path.join(os.tmpdir(), `pencilpot-${id}-${Date.now()}.png`);
  const fontCss = buildFontFaceCss(fontsDir);
  // The svg already carries px width/height (design units * zoom). We render at
  // deviceScaleFactor=scale for crisp output and screenshot just the svg box.
  const html =
    `<!doctype html><html><head><meta charset="utf-8">` +
    `<style>html,body{margin:0;padding:0;background:transparent}` +
    `svg{display:block}\n${fontCss}</style></head>` +
    `<body>${svg}</body></html>`;

  const chromium = await loadChromium();
  const browser = await chromium.launch({
    headless: true,
    args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist", "--force-color-profile=srgb"],
  });
  try {
    const page = await browser.newPage({ deviceScaleFactor: scale, viewport: { width: 64, height: 64 } });
    await page.setContent(html, { waitUntil: "load" });
    // Wait for embedded fonts to finish loading so glyphs are shaped before shot.
    await page.evaluate(() => (document.fonts && document.fonts.ready) ? document.fonts.ready : null).catch(() => {});
    await page.waitForTimeout(150);
    const el = await page.$("svg");
    if (!el) throw new Error("rasterizeSvg: no <svg> rendered in page");
    await el.screenshot({ path: png, omitBackground: true });
    return png;
  } finally {
    await browser.close().catch(() => {});
  }
}
