// AI-dev audit — commit-imported: the baseline-diff commit gate (A-FIX2) lets the
// high-level SDK/MCP `commit()` SUCCEED on an IMPORTED design that carries
// PRE-EXISTING strict-schema nonconformities (the canonical DefaultLauncher has a
// real tokens-lib instance + variable-font :font-variation-settings that render
// fine but trip the whole-file validator). Before A-FIX2, commit() was blocked on
// such designs; now the gate snapshots the pre-edit validation at checkout and
// blocks only on errors the EDIT introduces.
//
//   checkout (baseline may be non-empty) -> add a clean board+rect -> commit()
//   SUCCEEDS (pre-existing issues excluded) -> staged in the runtime (dirty) ->
//   /pencilpot/save -> on-disk EDN has the shapes -> cold reopen clean.
//
// Boots runtime/server.mjs over a throwaway COPY of DefaultLauncher (never the
// canonical design). SKIPs (exit 0) if the canonical design is absent.
// Run: node pencilpot/e2e/ai/commit-imported.mjs
import {
  FID, SCRATCH, designPresent, copyDesign, spawnRuntime, getFileViaRuntime,
  loadWorkingCopy, status, save, kill, readPageEdns, makeChecks,
} from "./_boot.mjs";
import fs from "node:fs";

const { check, passed } = makeChecks();

if (!designPresent()) {
  console.log("SKIP: canonical DefaultLauncher design absent — cannot run commit-imported e2e");
  process.exit(0);
}

fs.mkdirSync(SCRATCH, { recursive: true });
const dir = copyDesign("commit-imported");

let srv = null;
try {
  const r = await spawnRuntime(dir);
  srv = r.proc;
  const base = r.base;

  const WorkingCopy = await loadWorkingCopy(base);
  const wc = await new WorkingCopy(FID, "local").checkout();
  check(typeof wc.revn === "number", `checkout ok (revn=${wc.revn})`);

  // (1) The imported design's PRE-EDIT baseline — DefaultLauncher is expected to
  //     carry pre-existing strict-schema nonconformities (tokens-lib + VF). This is
  //     exactly what used to block commit(); the gate now records it as baseline.
  const baseline = wc.baselineErrs ?? [];
  check(Array.isArray(baseline),
    `checkout snapshotted a validation baseline (${baseline.length} pre-existing issue(s): ${JSON.stringify(baseline)})`);
  check(baseline.length >= 1,
    `the imported DefaultLauncher HAS pre-existing whole-file issues — the case A-FIX2 targets (baseline=${baseline.length})`);

  // (2) Add a clean board+rect. These introduce no NEW validation errors.
  const board = wc.addBoard({ x: 700, y: 700, width: 260, height: 160, name: "IMP Board" });
  const rect = wc.addRect({ x: 720, y: 720, width: 100, height: 60, parentId: board, name: "IMP Rect", fills: [{ fillColor: "#8844ff" }] });
  wc.closeBoard();
  const introduced = wc.newValidationErrors();
  check(introduced.length === 0,
    `the clean edit introduced NO new validation errors (introduced=${JSON.stringify(introduced)})`);
  check(wc.pendingChanges().length >= 2, `pending changes recorded (${wc.pendingChanges().length})`);

  // (3) THE A-FIX2 WIN: commit() succeeds despite the non-empty baseline.
  const revnBefore = wc.revn;
  const res = await wc.commit();
  check(!!res, `commit() RESOLVED on the imported design (was blocked pre-A-FIX2 by pre-existing issues)`);
  check(wc.revn === revnBefore + 1, `commit bumped revn ${revnBefore} -> ${wc.revn}`);

  // (4) staged in the runtime working copy; get-file reflects the board, dirty.
  const after = await getFileViaRuntime(base, FID);
  check(after.transit.includes("IMP Board"), `committed board visible in the runtime get-file`);
  const st1 = await status(base);
  check(st1.dirty === true, `runtime is dirty after commit (staged, not yet on disk)`);

  // (5) explicit save -> on-disk EDN gains the shapes.
  await save(base);
  const st2 = await status(base);
  check(st2.dirty === false, `runtime clean after /pencilpot/save`);
  const edn = readPageEdns(dir);
  check(edn.includes("IMP Board") && edn.includes("IMP Rect"), `on-disk page EDN contains the committed shapes`);

  // (6) cold reopen: shapes persist, design reopens clean (no spurious dirty).
  kill(srv); srv = null;
  const r2 = await spawnRuntime(dir);
  srv = r2.proc;
  const reopened = await getFileViaRuntime(r2.base, FID);
  check(reopened.transit.includes("IMP Board"), `shapes persist across a cold runtime restart`);
  const st3 = await status(r2.base);
  check(st3.dirty === false, `reopened imported design is clean (no spurious dirty)`);

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
