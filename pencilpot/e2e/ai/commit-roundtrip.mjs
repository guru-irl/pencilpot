// AI-dev audit — commit-roundtrip: the high-level MCP/SDK `commit()` path now
// works against a LOCAL pencilpot runtime (was Finding #2: blocked because
// validate() rejected hydrated plain-map shapes via schema:shape's [:fn shape?]).
//
// Self-contained: scaffolds a FRESH `pencilpot new` project (a clean empty
// starter — no imported tokens-lib / variable-font data), boots the runtime over
// it, and drives the full loop the AI uses:
//   checkout -> validate([]) -> script(add board+rect) -> validate([]) ->
//   commit() (revn bump) -> /pencilpot/save -> on-disk EDN has the shapes ->
//   restart runtime -> reopen clean, shapes still present.
//
// Run: node pencilpot/e2e/ai/commit-roundtrip.mjs   (no canonical design needed)
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  REPO, SCRATCH, spawnRuntime, getFileViaRuntime, loadWorkingCopy,
  status, save, kill, readPageEdns, makeChecks,
} from "./_boot.mjs";

const { check, passed } = makeChecks();
const CLI = path.resolve(REPO, "pencilpot/bin/pencilpot.mjs");

function pencilNew(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [CLI, "new", dir], { stdio: ["ignore", "inherit", "inherit"] });
    p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`pencilpot new exited ${code}`))));
  });
}

const projDir = path.join(SCRATCH, "ai-commit-proj");
const designDir = path.join(projDir, "designs", "main");

let srv = null;
try {
  fs.mkdirSync(SCRATCH, { recursive: true });
  await pencilNew(projDir);
  check(fs.existsSync(path.join(designDir, "manifest.edn")), "fresh starter design scaffolded");

  const r = await spawnRuntime(designDir);
  srv = r.proc;
  const base = r.base;

  // file-id from the runtime's get-file meta (authoritative)
  const { meta } = await getFileViaRuntime(base, undefined);
  // get-file with no id serves the main design; but checkout needs the id:
  const fid = meta?.id;
  check(!!fid, `runtime get-file meta carries the file id (${fid})`);

  const WorkingCopy = await loadWorkingCopy(base);
  const wc = await new WorkingCopy(fid, "local").checkout();
  check(true, `checkout ok (revn=${wc.revn})`);

  // (1) THE FIX: a fresh hydrated design validates clean (was ["invalid file data"])
  const v0 = wc.validate();
  check(Array.isArray(v0) && v0.length === 0, `fresh hydrated design validates clean: ${JSON.stringify(v0)}`);

  // (2) add shapes via the engine, still valid
  const board = wc.addBoard({ x: 40, y: 40, width: 320, height: 200, name: "AI Board" });
  const rect = wc.addRect({ x: 60, y: 60, width: 120, height: 80, name: "AI Rect", fills: [{ fillColor: "#3366ff" }] });
  wc.closeBoard();
  const v1 = wc.validate();
  check(Array.isArray(v1) && v1.length === 0, `after add board+rect validates clean: ${JSON.stringify(v1)}`);
  check(wc.pendingChanges().length >= 2, `pending changes recorded (${wc.pendingChanges().length})`);

  // (3) THE PREVIOUSLY-BLOCKED PATH: high-level commit() now succeeds
  const revnBefore = wc.revn;
  const res = await wc.commit();
  check(!!res, `commit() resolved without throwing (was blocked by the validate gate)`);
  check(wc.revn === revnBefore + 1, `commit bumped revn ${revnBefore} -> ${wc.revn}`);

  // (4) commit staged into the runtime working copy; get-file reflects the board
  const after = await getFileViaRuntime(base, fid);
  check(after.transit.includes("AI Board"), `committed board visible in runtime get-file`);
  const st1 = await status(base);
  check(st1.dirty === true, `runtime is dirty after commit (staged, not yet saved)`);

  // (5) explicit save -> on-disk EDN has the new shapes
  await save(base);
  const st2 = await status(base);
  check(st2.dirty === false, `runtime clean after /pencilpot/save`);
  const edn = readPageEdns(designDir);
  check(edn.includes("AI Board") && edn.includes("AI Rect"), `on-disk page EDN contains the committed shapes`);

  // (6) cold reopen: restart runtime over the saved design, shapes persist, clean
  kill(srv); srv = null;
  const r2 = await spawnRuntime(designDir);
  srv = r2.proc;
  const reopened = await getFileViaRuntime(r2.base, fid);
  check(reopened.transit.includes("AI Board"), `shapes persist across a cold runtime restart`);
  const st3 = await status(r2.base);
  check(st3.dirty === false, `reopened design is clean (no spurious dirty)`);

  console.log(`  ids: board=${board} rect=${rect}`);
} catch (e) {
  console.log("FAIL: harness error");
  console.error(e?.stack || String(e));
  process.exitCode = 1;
} finally {
  if (srv) kill(srv);
}

console.log(passed() ? "\nALL CHECKS PASS" : "\nCHECKS FAILED");
process.exit(passed() ? 0 : 1);
