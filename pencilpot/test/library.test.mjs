import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSession } from "../../headless-core/target/headless/penpot.js";
import { writeDesign } from "../store/store.mjs";
import { initProject } from "../store/project.mjs";
import { getFileLibraries } from "../runtime/rpc.mjs";

test("getFileLibraries resolves a linked shared library from disk", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pp-lib-"));
  initProject(root);

  // Build a shared library with a component.
  const lib = createSession(JSON.stringify({ empty: true }));
  const lb = lib.addBoard(JSON.stringify({ x: 0, y: 0, width: 80, height: 40, name: "Button" }));
  lib.addRect(JSON.stringify({ x: 5, y: 5, width: 70, height: 30, parentId: lb }));
  lib.closeBoard();
  const compId = lib.createComponent(lb, JSON.stringify({ name: "Button" }));
  const libParts = JSON.parse(lib.serializeStore());
  const libId = JSON.parse(lib.getFileResponse()).meta.id;
  const libDir = path.join(root, "shared", "brand.penpot");
  writeDesign(libDir, libParts);

  // Build the design file that links the library.
  const design = createSession(JSON.stringify({ empty: true }));
  design.addBoard(JSON.stringify({ x: 0, y: 0, width: 100, height: 100, name: "Home" }));
  design.closeBoard();
  const dParts = JSON.parse(design.serializeStore());
  // Inject the library link into the manifest EDN.
  // The manifest always contains `:libraries []` when no libraries are set.
  dParts.manifest = dParts.manifest.replace(
    /:libraries\s+\[\]/,
    `:libraries [{:id #uuid "${libId}" :path "shared/brand.penpot"}]`
  );
  const designDir = path.join(root, "home.penpot");
  writeDesign(designDir, dParts);

  const libs = getFileLibraries(designDir, root);

  // libs should be an array; find the entry for libId
  assert.ok(Array.isArray(libs), "getFileLibraries returns an array");
  const found = libs.find((l) => String(l.id) === String(libId));
  assert.ok(found, "linked library resolved by id");
  // The library entry should carry the component id or name
  assert.ok(
    JSON.stringify(found).includes(String(compId)) ||
      JSON.stringify(found).toLowerCase().includes("button"),
    "library carries its component (compId or name Button present)"
  );
});

test("getFileLibraries returns empty array for a design with no libraries", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pp-lib-"));
  initProject(root);
  const design = createSession(JSON.stringify({ empty: true }));
  design.addBoard(JSON.stringify({ x: 0, y: 0, width: 100, height: 100, name: "A" }));
  design.closeBoard();
  const designDir = path.join(root, "nolib.penpot");
  writeDesign(designDir, JSON.parse(design.serializeStore()));
  const libs = getFileLibraries(designDir, root);
  assert.ok(Array.isArray(libs), "returns array");
  assert.equal(libs.length, 0, "empty array when no libraries linked");
});
