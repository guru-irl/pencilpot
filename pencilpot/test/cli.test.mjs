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
