// Wave 3 — design tokens of ALL types (not just color) + token→shape binding.
//   addToken({set,name,type,value}), applyToken(id,{token,attributes}), unapplyToken.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createSession } from "../target/headless/penpot.js";

test("addToken creates tokens of many types; file validates", () => {
  const s = createSession(JSON.stringify({ empty: true, name: "Tokens" }));
  s.addToken(JSON.stringify({ set: "core", name: "color.brand", type: "color", value: "#ff0066" }));
  s.addToken(JSON.stringify({ set: "core", name: "space.md", type: "spacing", value: "16" }));
  s.addToken(JSON.stringify({ set: "core", name: "size.lg", type: "sizing", value: "240" }));
  s.addToken(JSON.stringify({ set: "core", name: "radius.sm", type: "border-radius", value: "4" }));
  s.addToken(JSON.stringify({ set: "core", name: "opacity.half", type: "opacity", value: "0.5" }));

  const toks = JSON.parse(s.tokens());
  assert.ok(toks.tokens.length >= 5, `created tokens (${toks.tokens.length})`);
  const names = toks.tokens.map((t) => t.name);
  for (const n of ["color.brand", "space.md", "size.lg", "radius.sm", "opacity.half"])
    assert.ok(names.includes(n), `token ${n} present`);
  assert.deepEqual(JSON.parse(s.validate()), [], "file validates with mixed-type tokens");
});

test("addToken rejects an invalid type (fail-fast)", () => {
  const s = createSession(JSON.stringify({ empty: true, name: "T2" }));
  assert.throws(() => s.addToken(JSON.stringify({ name: "bad", type: "teleport", value: "1" })),
    /invalid type/, "bad token type throws a clear error");
});

test("applyToken binds a token to a shape attribute; unapplyToken removes it", () => {
  const s = createSession(JSON.stringify({ empty: true, name: "Bind" }));
  s.addToken(JSON.stringify({ set: "core", name: "color.brand", type: "color", value: "#ff0066" }));
  s.addToken(JSON.stringify({ set: "core", name: "radius.sm", type: "border-radius", value: "8" }));
  const b = s.addBoard(JSON.stringify({ x: 0, y: 0, width: 200, height: 200, name: "F" }));
  const r = s.addRect(JSON.stringify({ x: 0, y: 0, width: 100, height: 60, name: "r" }));
  s.closeBoard();

  s.applyToken(r, JSON.stringify({ token: "color.brand", attributes: ["fill"] }));
  s.applyToken(r, JSON.stringify({ token: "radius.sm", attributes: ["r1", "r2", "r3", "r4"] }));
  let at = JSON.parse(s.objects())[r]["applied-tokens"];
  assert.equal(at.fill, "color.brand", "fill bound to the color token");
  assert.equal(at.r1, "radius.sm", "r1 bound to the radius token");
  assert.deepEqual(JSON.parse(s.validate()), [], "validates with applied tokens");

  s.unapplyToken(r, JSON.stringify({ attributes: ["fill"] }));
  at = JSON.parse(s.objects())[r]["applied-tokens"];
  assert.ok(!at.fill, "fill binding removed");
  assert.equal(at.r1, "radius.sm", "radius binding remains");
});

test("applyToken throws for an unknown token name", () => {
  const s = createSession(JSON.stringify({ empty: true, name: "B2" }));
  const b = s.addBoard(JSON.stringify({ x: 0, y: 0, width: 100, height: 100, name: "F" }));
  const r = s.addRect(JSON.stringify({ x: 0, y: 0, width: 50, height: 50, name: "r" }));
  s.closeBoard();
  assert.throws(() => s.applyToken(r, JSON.stringify({ token: "nope.missing", attributes: ["fill"] })),
    /no token named/, "unknown token name fails fast");
});

test("tokens + bindings persist on a fromStore-hydrated session + round-trip", () => {
  const s1 = createSession(JSON.stringify({ empty: true, name: "Hyd" }));
  s1.addToken(JSON.stringify({ set: "core", name: "color.brand", type: "color", value: "#0af" }));
  const b = s1.addBoard(JSON.stringify({ x: 0, y: 0, width: 200, height: 200, name: "F" }));
  const r = s1.addRect(JSON.stringify({ x: 0, y: 0, width: 80, height: 80, name: "r" }));
  s1.closeBoard();

  const s2 = createSession(JSON.stringify({ fromStore: JSON.parse(s1.serializeStore()) }));
  // add a non-color token AND bind it on the hydrated session (the realistic path)
  s2.addToken(JSON.stringify({ set: "core", name: "space.lg", type: "spacing", value: "24" }));
  s2.applyToken(r, JSON.stringify({ token: "color.brand", attributes: ["fill"] }));
  assert.deepEqual(JSON.parse(s2.validate()), [], "hydrated token edits validate");

  const s3 = createSession(JSON.stringify({ fromStore: JSON.parse(s2.serializeStore()) }));
  const names = JSON.parse(s3.tokens()).tokens.map((t) => t.name);
  assert.ok(names.includes("color.brand") && names.includes("space.lg"), "tokens persisted");
  assert.equal(JSON.parse(s3.objects())[r]["applied-tokens"].fill, "color.brand", "binding persisted");
});
