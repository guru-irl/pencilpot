/**
 * Stage 2 fonts — fvar parser tests.
 *
 * Parses a real variable font (Google Sans Flex) and asserts the discovered
 * axes + named instances. Skips gracefully if the fixture is missing.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const FIXTURE = "/mnt/data/src/DefaultLauncher/fonts/_variable/GoogleSansFlex.ttf";

test("readFvar parses axes + named instances from GoogleSansFlex.ttf", async (t) => {
  if (!fs.existsSync(FIXTURE)) return t.skip(`fixture missing: ${FIXTURE}`);

  const { readFvar } = await import("../store/fvar.mjs");
  const buf = fs.readFileSync(FIXTURE);
  const { axes, instances } = readFvar(buf);

  // Axes present
  assert.ok(Array.isArray(axes) && axes.length > 0, "has axes");
  const byTag = Object.fromEntries(axes.map((a) => [a.tag, a]));

  for (const tag of ["wght", "wdth", "opsz", "slnt", "GRAD", "ROND"]) {
    assert.ok(byTag[tag], `axis ${tag} present`);
    const a = byTag[tag];
    assert.ok(
      a.min <= a.default && a.default <= a.max,
      `${tag}: min<=default<=max (${a.min} <= ${a.default} <= ${a.max})`
    );
    assert.ok(typeof a.name === "string", `${tag} has a name`);
  }

  // At least one named instance with coords
  assert.ok(Array.isArray(instances), "instances is an array");
  assert.ok(instances.length >= 1, "at least one named instance");
  const first = instances[0];
  assert.ok(typeof first.name === "string", "instance has a name");
  assert.ok(first.coords && Object.keys(first.coords).length > 0, "instance has coords");
  // coords keys must be axis tags
  for (const tag of Object.keys(first.coords)) {
    assert.ok(byTag[tag], `coord tag ${tag} matches an axis`);
  }
});

test("readFvar throws a clear error on a non-variable font buffer", async () => {
  const { readFvar } = await import("../store/fvar.mjs");
  // Minimal SFNT header with zero tables → no fvar.
  const buf = Buffer.alloc(12);
  buf.writeUInt32BE(0x00010000, 0); // sfntVersion
  buf.writeUInt16BE(0, 4);          // numTables = 0
  assert.throws(() => readFvar(buf), /fvar/);
});

test("readFontFamilyName returns a family name for GoogleSansFlex.ttf", async (t) => {
  if (!fs.existsSync(FIXTURE)) return t.skip(`fixture missing: ${FIXTURE}`);
  const { readFontFamilyName } = await import("../store/fvar.mjs");
  const name = readFontFamilyName(fs.readFileSync(FIXTURE));
  assert.ok(name && typeof name === "string" && name.length > 0, `got family name: ${name}`);
});
