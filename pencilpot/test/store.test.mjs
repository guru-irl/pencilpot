import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { writeDesign, readDesign } from "../store/store.mjs";
import { createSession } from "../../headless-core/target/headless/penpot.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "pp-"));
function seed() {
  const s = createSession(JSON.stringify({ empty: true }));
  const b = s.addBoard(JSON.stringify({ x: 0, y: 0, width: 100, height: 100, name: "B" }));
  const r = s.addRect(JSON.stringify({ x: 10, y: 10, width: 20, height: 20, parentId: b }));
  s.closeBoard();
  return { s, b, r };
}
function snapshot(dir) {
  const out = {}; (function walk(d){ for (const e of fs.readdirSync(d,{withFileTypes:true})){ const p=path.join(d,e.name); e.isDirectory()?walk(p):(out[path.relative(dir,p)]=fs.readFileSync(p,"utf8")); } })(dir); return out;
}

test("writeDesign explodes into manifest/pages/components; readDesign restores losslessly", () => {
  const { s, b } = seed();
  const dir = path.join(tmp(), "home.penpot");
  writeDesign(dir, JSON.parse(s.serializeStore()));
  assert.ok(fs.existsSync(path.join(dir, "manifest.edn")));
  assert.ok(fs.readdirSync(path.join(dir, "pages")).length >= 1);
  const s2 = createSession(JSON.stringify({ fromStore: readDesign(dir) }));
  assert.deepEqual(JSON.parse(s2.objects()), JSON.parse(s.objects()), "objects round-trip through disk");
  // STRONG fidelity: re-serializing the disk-loaded session is byte-identical (nothing dropped/reordered)
  assert.equal(s2.serializeStore(), s.serializeStore(), "full re-serialize identical through disk");
});

test("editing one shape rewrites exactly one page file (minimal diff)", () => {
  const { s, r } = seed();
  const dir = path.join(tmp(), "home.penpot");
  writeDesign(dir, JSON.parse(s.serializeStore()));
  const before = snapshot(dir);
  s.setShapePosition ? s.setShapePosition(JSON.stringify({ id: r, x: 99 })) // if such a helper exists
    : s.applyChanges(JSON.stringify([{ type: "mod-obj", id: r, operations: [{ type: "set", attr: "x", val: 99 }] }]));
  writeDesign(dir, JSON.parse(s.serializeStore()));
  const after = snapshot(dir);
  const changedPages = Object.keys(after).filter((f) => f.startsWith("pages/") && after[f] !== before[f]);
  assert.equal(changedPages.length, 1, "exactly one page .edn changed");
});

test("writeDesign strips :position-data from disk but not from the caller's parts", () => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pp-st-")), "home.penpot");
  const parts = {
    manifest: "{:name \"d\"}",
    pages: { p1: '{:id 1 :position-data [#penpot/rect "1,2,3"] :name "t"}' },
    components: { c1: '{:cid 2 :position-data [{:a [1 2]}] :k 3}' },
    media: [],
  };
  writeDesign(dir, parts);

  const onDisk = readDesign(dir);
  assert.ok(!onDisk.pages.p1.includes(":position-data"), "page pd removed on disk");
  assert.ok(!onDisk.components.c1.includes(":position-data"), "component pd removed on disk");
  assert.ok(onDisk.pages.p1.includes(':name "t"'), "real content preserved");

  // Caller's object is untouched (in-memory working copy keeps pd).
  assert.ok(parts.pages.p1.includes(":position-data"), "caller parts not mutated");
});

import { initProject, addDesign, resolveProjectRoot, listDesigns } from "../store/project.mjs";

test("initProject creates a git repo + shared/; resolveProjectRoot walks up from a nested design dir; addDesign + listDesigns work", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pp-proj-"));
  initProject(root, "myproj");
  assert.ok(fs.existsSync(path.join(root, ".git")), "git initialized");
  assert.ok(fs.existsSync(path.join(root, "shared")), "shared/ created");
  assert.ok(fs.existsSync(path.join(root, "designs")), "designs/ created");
  addDesign(root, "home");
  const design = path.join(root, "designs", "home");
  // resolveProjectRoot still works (walks up to nearest dir with .git or shared/)
  assert.equal(resolveProjectRoot(design), root, "resolves root from the design dir");
  assert.equal(resolveProjectRoot(path.join(design, "pages")), root, "resolves root from a nested path (pages/ not yet created, dirname used)");
  assert.deepEqual(listDesigns(root).map((d) => d.name), ["home"], "listDesigns returns [{name,dir}]");
});
