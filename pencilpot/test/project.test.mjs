import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { initProject, readProject, resolveProject, addDesign, listDesigns, setDefault } from "../store/project.mjs";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "pp-proj-"));

test("initProject scaffolds a .pencil project; readProject + resolveProject + addDesign work", () => {
  const root = tmp();
  initProject(root, "acme");
  assert.ok(fs.existsSync(path.join(root, "acme.pencil")), ".pencil manifest");
  assert.ok(fs.existsSync(path.join(root, "designs")), "designs/");
  assert.ok(fs.existsSync(path.join(root, "shared")), "shared/");
  assert.ok(fs.existsSync(path.join(root, ".git")), "git repo");
  const m = JSON.parse(fs.readFileSync(path.join(root, "acme.pencil"), "utf8"));
  assert.equal(m.name, "acme");

  addDesign(root, "home");
  assert.ok(fs.existsSync(path.join(root, "designs", "home")), "design dir created");
  const proj = readProject(path.join(root, "acme.pencil"));
  assert.equal(proj.name, "acme");
  assert.ok(proj.designs.find((d) => d.name === "home"), "home in designs");
  assert.equal(proj.default, "home", "first design becomes default");

  // resolve from a nested path inside the project
  assert.equal(resolveProject(path.join(root, "designs", "home")).root, root);
  assert.equal(resolveProject(path.join(root, "acme.pencil")).root, root);
  assert.deepEqual(listDesigns(root).map((d) => d.name), ["home"]);
});

test("setDefault changes the project's default design", () => {
  const root = tmp();
  initProject(root, "proj");
  addDesign(root, "alpha");
  addDesign(root, "beta");
  const pencilPath = path.join(root, "proj.pencil");
  const before = JSON.parse(fs.readFileSync(pencilPath, "utf8"));
  assert.equal(before.default, "alpha", "first design is default initially");

  setDefault(root, "beta");
  const after = JSON.parse(fs.readFileSync(pencilPath, "utf8"));
  assert.equal(after.default, "beta", "default changed to beta");
});

test("setDefault throws if the design does not exist", () => {
  const root = tmp();
  initProject(root, "proj");
  addDesign(root, "alpha");
  assert.throws(() => setDefault(root, "nonexistent"), /not found/i, "throws on missing design");
});
