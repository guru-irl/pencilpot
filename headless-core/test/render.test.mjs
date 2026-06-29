// renderShape — browser-free SVG render of a single shape/board via
// app.main.render/frame-imposter mounted through react-dom/server. No browser,
// no canvas, synchronous. Asserted on a fresh session + a fromStore-hydrated one.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createSession } from "../target/headless/penpot.js";

function boardWithRect() {
  const s = createSession(JSON.stringify({ empty: true, name: "Render" }));
  const b = s.addBoard(JSON.stringify({ x: 0, y: 0, width: 200, height: 120, name: "F" }));
  s.addRect(JSON.stringify({ x: 20, y: 20, width: 80, height: 60, name: "r", fills: [{ "fill-color": "#22aa55", "fill-opacity": 1 }] }));
  s.closeBoard();
  return { s, b };
}

test("renderShape returns a self-contained SVG for a board", () => {
  const { s, b } = boardWithRect();
  const svg = s.renderShape(b);
  assert.equal(typeof svg, "string");
  assert.ok(svg.startsWith("<svg"), `starts with <svg: ${svg.slice(0, 40)}`);
  assert.match(svg, /viewBox="0 0 200 120"/, "viewBox matches the board bounds");
  assert.match(svg, /width="200"/, "width attr matches");
  assert.ok(svg.includes("22aa55") || /<rect/.test(svg), "child rect rendered into the SVG");
  assert.ok(svg.length > 200, `non-trivial output (got ${svg.length})`);
});

test("renderShape returns '' for an unknown id (never empty SVG on a no-op)", () => {
  const { s } = boardWithRect();
  assert.equal(s.renderShape("00000000-0000-0000-0000-000000000099"), "");
});

test("renderShape works on a fromStore-hydrated session", () => {
  const { s, b } = boardWithRect();
  const parts = JSON.parse(s.serializeStore());
  const s2 = createSession(JSON.stringify({ fromStore: parts }));
  const svg = s2.renderShape(b);
  assert.ok(svg.startsWith("<svg"), "hydrated session renders SVG");
  assert.match(svg, /viewBox="0 0 200 120"/, "hydrated viewBox matches");
});

test("renderShape SVG rasterizes to a real PNG via rsvg-convert (no browser)", () => {
  const has = spawnSync("rsvg-convert", ["--version"]).status === 0;
  if (!has) return; // host lacks rsvg-convert: skip (SVG path already covered)
  const { s, b } = boardWithRect();
  const svgP = path.join(os.tmpdir(), `rt-${Date.now()}.svg`);
  const pngP = svgP.replace(".svg", ".png");
  fs.writeFileSync(svgP, s.renderShape(b));
  assert.equal(spawnSync("rsvg-convert", ["-z", "2", "-f", "png", svgP, "-o", pngP]).status, 0);
  const buf = fs.readFileSync(pngP);
  assert.ok(buf.length > 100 && buf[0] === 0x89 && buf[1] === 0x50, "PNG magic bytes present"); // 400x240 @2x
  fs.unlinkSync(svgP); fs.unlinkSync(pngP);
});
