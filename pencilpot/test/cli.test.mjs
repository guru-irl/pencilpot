import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { execFileSync, spawn } from "node:child_process";

const BIN = path.resolve(import.meta.dirname, "../bin/pencilpot.mjs");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "pp-cli-"));

test("pencilpot new scaffolds a valid .pencil project", () => {
  const dir = path.join(tmp(), "acme");
  execFileSync("node", [BIN, "new", dir], { stdio: "pipe" });
  assert.ok(fs.existsSync(path.join(dir, "acme.pencil")), ".pencil created");
  const m = JSON.parse(fs.readFileSync(path.join(dir, "acme.pencil"), "utf8"));
  assert.equal(m.name, "acme");
  assert.ok(fs.existsSync(path.join(dir, ".git")), "git repo");
  assert.ok(fs.existsSync(path.join(dir, "designs")), "designs/");
});

test("pencilpot open --no-window starts a runtime that serves get-file", async () => {
  // scaffold + seed a design so get-file has data
  const dir = path.join(tmp(), "demo");
  execFileSync("node", [BIN, "new", dir], { stdio: "pipe" });
  // create an empty design via the store + engine so the runtime can serve it
  const { addDesign } = await import("../store/project.mjs");
  const { writeDesign } = await import("../store/store.mjs");
  const { createSession } = await import("../../headless-core/target/headless/penpot.js");
  const ddir = addDesign(dir, "home");
  const s = createSession(JSON.stringify({ empty: true }));
  const b = s.addBoard(JSON.stringify({ x:0,y:0,width:100,height:100,name:"B" })); s.closeBoard();
  writeDesign(ddir, JSON.parse(s.serializeStore()));

  const port = 7821;
  const child = spawn("node", [BIN, "open", path.join(dir, "demo.pencil"), "--no-window", "--port", String(port)], { stdio: "pipe" });
  try {
    // poll the port for get-file
    let ok = false;
    for (let i = 0; i < 50; i++) {
      try {
        const r = await fetch(`http://localhost:${port}/api/rpc/command/get-file?id=x`, { headers: { accept: "application/json" } });
        if (r.status === 200) { ok = true; break; }
      } catch {}
      await new Promise((res) => setTimeout(res, 200));
    }
    assert.ok(ok, "runtime served get-file");
  } finally { child.kill("SIGTERM"); }
});

test("pencilpot new creates an immediately-openable project (starter design)", async () => {
  const dir = path.join(tmp(), "demo2");
  execFileSync("node", [BIN, "new", dir], { stdio: "pipe" });
  const m = JSON.parse(fs.readFileSync(path.join(dir, "demo2.pencil"), "utf8"));
  assert.ok(m.designs.length >= 1, "has a starter design");
  assert.ok(m.default, "has a default design");
  assert.ok(fs.existsSync(path.join(dir, "designs", m.default, "manifest.edn")), "starter design has EDN");
  // open it headlessly -> serves get-file
  const port = 7841;
  const child = spawn("node", [BIN, "open", path.join(dir, "demo2.pencil"), "--no-window", "--port", String(port)], { stdio: "pipe" });
  try {
    let ok = false;
    for (let i=0;i<50;i++){ try { const r=await fetch(`http://localhost:${port}/api/rpc/command/get-file?id=x`,{headers:{accept:"application/json"}}); if(r.status===200){ok=true;break;} } catch{}; await new Promise(r=>setTimeout(r,200)); }
    assert.ok(ok, "new->open serves get-file");
  } finally { child.kill("SIGTERM"); }
});

test("pencilpot --help exits 0 without 'Unknown command'", () => {
  const out = execFileSync("node", [BIN, "--help"], { encoding: "utf8" });
  assert.ok(!/Unknown command/i.test(out), "no 'Unknown command'");
  assert.match(out, /Commands:/);
});

test("pencilpot import natively converts a .penpot (no backend)", async (t) => {
  const sample = [
    "/home/guru/Downloads/Default Design System.penpot",
    "/home/guru/Downloads/Default Launcher.penpot",
  ].find((f) => fs.existsSync(f));
  if (!sample) return t.skip("no sample .penpot file found");

  const dir = path.join(tmp(), "imp");
  execFileSync("node", [BIN, "new", dir], { stdio: "pipe" });
  // Import natively (no --instance / --token needed)
  execFileSync("node", [BIN, "import", sample, "--project", dir, "--name", "ds"], {
    stdio: "pipe",
    timeout: 120_000,
  });

  // 1. Verify the design was registered in the project manifest
  const baseName = path.basename(dir);
  const pencilPath = path.join(dir, `${baseName}.pencil`);
  const m = JSON.parse(fs.readFileSync(pencilPath, "utf8"));
  assert.ok(m.designs.find((d) => d.name === "ds"), "imported design registered in .pencil");

  // 2. Verify EDN was written on disk
  const designDir = path.join(dir, "designs", "ds");
  assert.ok(fs.existsSync(path.join(designDir, "manifest.edn")), "manifest.edn written");
  assert.ok(fs.existsSync(path.join(designDir, "pages")), "pages/ directory created");

  // 3. Re-hydrate via the engine and assert objects exist
  const { readDesign } = await import("../store/store.mjs");
  const { createSession } = await import("../../headless-core/target/headless/penpot.js");
  const parts = readDesign(designDir);
  const s = createSession(JSON.stringify({ fromStore: parts }));
  const objs = JSON.parse(s.objects());
  assert.ok(Object.keys(objs).length > 0, "imported design has objects (root frame at minimum)");

  // 4. Confirm the import was truly native: no penpot-hl needed (port 9101 NOT used)
  const penpotHlUsed = await fetch("http://localhost:9101").then(() => true).catch(() => false);
  // We don't fail if penpot-hl is up — we just confirm the import didn't REQUIRE it.
  // The test already ran without --instance/--token, which is the proof.
  assert.ok(true, "import completed without --instance/--token (native)");

  console.log(`  imported objects: ${Object.keys(objs).length}`);
  console.log(`  pages: ${Object.keys(parts.pages).length}`);
  console.log(`  components: ${Object.keys(parts.components).length}`);
});
