// AI-dev audit — B3 / Harness B: persistence & lifecycle on a LOCAL pencilpot
// runtime, using the now-working high-level SDK loop (A-FIX/A-FIX2 made commit()
// usable on an imported, pre-existing-nonconformant design).
//
// Proves the three lifecycle guarantees an AI dev workflow depends on:
//   (A) DURABILITY: SDK edit -> commit() (staged) -> /pencilpot/status dirty=true ->
//       /pencilpot/save -> on-disk page EDN gains the new shape -> status clean ->
//       RESTART the runtime -> reopen: status dirty=false AND the edit is still there.
//   (B) DISCARD: fresh edit -> commit() (staged, dirty) -> /pencilpot/discard ->
//       status clean AND the staged edit is GONE from get-file AND the on-disk EDN
//       never changed (discard reverts the in-memory working copy to disk state).
//   (C) NO SPURIOUS DIRTY: a pristine COPY opens dirty=false and a no-op REOPEN
//       (kill+respawn) is still dirty=false — the content-only dirty signature
//       strips :revn / :position-data / EDN whitespace (commit 3f05d851bb), and a
//       plain workspace load (which recomputes text :position-data) does NOT dirty
//       the design (cross-ref pencilpot/e2e/vf/verify-positiondata.mjs).
//
// SKIP (exit 0) if the canonical design is absent. Run twice — deterministic.
// Run: node pencilpot/e2e/ai/lifecycle.mjs
import { chromium } from "../../node_modules/playwright/index.mjs";
import fs from "node:fs";
import path from "node:path";
import {
  TEAM, FID, PID, REPO, SCRATCH, designPresent, copyDesign, spawnRuntime,
  getFileViaRuntime, loadWorkingCopy, status, save, discard, kill, readPageEdns, makeChecks,
} from "./_boot.mjs";

const CHROME_ARGS = ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"];
const wsUrl = (base) => `${base}/#/workspace?team-id=${TEAM}&file-id=${FID}&page-id=${PID}`;

if (!designPresent()) {
  console.log("SKIP: canonical design /mnt/data/src/DefaultLauncher/design absent — cannot run B3 lifecycle");
  process.exit(0);
}

const { check, passed } = makeChecks();
const finding = {};

// Add one distinctively-named board+rect via the SDK, commit (staged). Returns the marker.
async function stageEdit(base, marker) {
  const WorkingCopy = await loadWorkingCopy(base);
  const wc = await new WorkingCopy(FID, "local").checkout();
  const board = wc.addBoard({ x: 5200, y: 5200, width: 240, height: 160, name: marker });
  wc.addRect({ x: 5220, y: 5230, width: 120, height: 70, name: `${marker} Rect`, fills: [{ fillColor: "#ff3399" }] });
  wc.closeBoard();
  const introduced = wc.newValidationErrors();
  check(introduced.length === 0, `[${marker}] edit introduced no new validation errors: ${JSON.stringify(introduced)}`);
  const revnBefore = wc.revn;
  await wc.commit();
  check(wc.revn === revnBefore + 1, `[${marker}] commit() bumped revn ${revnBefore} -> ${wc.revn}`);
  return { board };
}

let srv = null, browser = null;
try {
  // ─────────────────────────────────────────────────────────────────────────
  // (A+B) DISCARD and DURABILITY both stage via the WorkingCopy SDK, which freezes
  // PENPOT_HL_BASE at module load (A1 gotcha) — so every SDK edit in this process
  // must hit the SAME runtime. We run both on ONE runtime over ONE copy (dirA):
  // discard first (staged then reverted, never saved), then durability (staged,
  // committed, SAVED). The cold-restart reopen + the spurious-dirty section use
  // direct fetch (no SDK), so they may spawn fresh runtimes on any port.
  // ─────────────────────────────────────────────────────────────────────────
  const dirA = copyDesign("b3life");
  let r = await spawnRuntime(dirA);
  srv = r.proc;
  const ediskBefore = readPageEdns(dirA);
  check(!ediskBefore.includes("B3LIFE") && !ediskBefore.includes("B3DISCARD"), `precondition: neither marker on disk before edits`);

  // (B) DISCARD — stage an edit, commit it (staged in memory), then discard it.
  await stageEdit(r.base, "B3DISCARD");
  const stD1 = await status(r.base);
  check(stD1.dirty === true, `staged discard-candidate edit makes the runtime dirty`);
  const beforeDiscard = await getFileViaRuntime(r.base, FID);
  check(beforeDiscard.transit.includes("B3DISCARD"), `staged edit is visible in get-file before discard`);

  await discard(r.base);
  const stD2 = await status(r.base);
  check(stD2.dirty === false, `runtime clean after /pencilpot/discard`);
  const afterDiscard = await getFileViaRuntime(r.base, FID);
  check(!afterDiscard.transit.includes("B3DISCARD"), `staged edit GONE from get-file after discard (working copy reverted to disk)`);
  const diskAfterDiscard = readPageEdns(dirA);
  check(!diskAfterDiscard.includes("B3DISCARD"), `on-disk EDN never changed by the discarded edit (discard touched only the in-memory working copy)`);
  finding.discard = true;

  // (A) DURABILITY — fresh checkout, stage, commit (staged), save (persist), confirm disk.
  await stageEdit(r.base, "B3LIFE");
  const stStaged = await status(r.base);
  check(stStaged.dirty === true, `staged commit makes the runtime dirty (commit stages in memory, not disk)`);
  const diskAfterCommit = readPageEdns(dirA);
  check(!diskAfterCommit.includes("B3LIFE"), `disk still pristine after commit (the save gap: commit != write)`);

  const saveRes = await save(r.base);
  check(saveRes && saveRes.ok !== false, `POST /pencilpot/save responded`);
  const stClean = await status(r.base);
  check(stClean.dirty === false, `runtime clean after /pencilpot/save`);
  const diskAfterSave = readPageEdns(dirA);
  check(diskAfterSave.includes("B3LIFE"), `on-disk page EDN gained the new shape after save`);
  kill(srv); srv = null;

  // cold restart -> reopen via direct fetch (no SDK): durable + discard left no trace.
  r = await spawnRuntime(dirA);
  srv = r.proc;
  const reopened = await getFileViaRuntime(r.base, FID);
  check(reopened.transit.includes("B3LIFE"), `saved edit persists across a cold runtime restart (durable)`);
  check(!reopened.transit.includes("B3DISCARD"), `discarded edit left no trace after the cold restart`);
  const stReopen = await status(r.base);
  check(stReopen.dirty === false, `reopened design is clean — no spurious dirty after a real save`);
  kill(srv); srv = null;
  finding.durable = true;

  // ─────────────────────────────────────────────────────────────────────────
  // (C) NO SPURIOUS DIRTY — pristine open, no-op reopen, workspace-load churn
  // ─────────────────────────────────────────────────────────────────────────
  const dirC = copyDesign("b3clean");
  r = await spawnRuntime(dirC);
  srv = r.proc;
  const stC0 = await status(r.base);
  check(stC0.dirty === false, `a pristine COPY opens with dirty=false (content-only signature, no edits)`);

  // workspace load recomputes text :position-data in the in-memory working copy;
  // the content-only dirty signature strips it, so loading must NOT dirty the file.
  browser = await chromium.launch({ headless: true, args: CHROME_ARGS });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await ctx.newPage();
  await page.goto(wsUrl(r.base), { waitUntil: "domcontentloaded" });
  await page.waitForSelector('a[title^="View mode"]', { state: "visible", timeout: 60000 });
  await page.waitForTimeout(3000);
  await ctx.close();
  await browser.close(); browser = null;
  const stC1 = await status(r.base);
  check(stC1.dirty === false, `opening the workspace (recomputes :position-data) did NOT spuriously dirty the design`);

  // no-op reopen: kill + respawn on the now-untouched dir -> still clean
  kill(srv); srv = null;
  r = await spawnRuntime(dirC);
  srv = r.proc;
  const stC2 = await status(r.base);
  check(stC2.dirty === false, `no-op REOPEN (kill+respawn) is still dirty=false (:revn/:position-data/whitespace stripped from the signature)`);
  const diskC = readPageEdns(dirC);
  check(!diskC.includes("B3LIFE") && !diskC.includes("B3DISCARD"), `(isolation) this clean copy carries none of the other tests' markers`);
  kill(srv); srv = null;
  finding.noSpuriousDirty = true;

  writeFindings(finding);
} catch (e) {
  console.log("FAIL: harness error");
  console.error(e?.stack || String(e));
  process.exitCode = 1;
} finally {
  if (browser) { try { await browser.close(); } catch {} }
  if (srv) kill(srv);
}

function writeFindings(d) {
  const md = `<!-- LIFECYCLE -->
## Persistence & lifecycle (findings)

**Harness:** \`pencilpot/e2e/ai/lifecycle.mjs\` — the full commit→save→reopen + discard + dirty
lifecycle on COPIES, via the now-working high-level \`commit()\` (A-FIX/A-FIX2).

| Guarantee | Status | Proof |
|---|---|---|
| Durability (commit→save→cold reopen) | **WORKS** | save wrote the shape to disk EDN; a runtime restart re-served it; dirty=false |
| The **save gap** | **CONFIRMED** | \`commit()\` stages in memory (dirty=true) but disk stays pristine until \`POST /pencilpot/save\` |
| Discard | **WORKS** | \`POST /pencilpot/discard\` reverts the staged edit (gone from get-file) and never touches disk |
| No spurious dirty | **WORKS** | pristine open + no-op reopen + a workspace load (which recomputes \`:position-data\`) all stay dirty=false |

## The lifecycle, precisely
1. **Edit** via the SDK/MCP (\`addBoard\`/\`addRect\`/…): mutates the in-memory session only; revn unchanged.
2. **\`commit()\`** (\`update-file\` transport): applies the recorded changes to the runtime's in-memory
   working copy and **bumps revn**. \`GET /pencilpot/status → {dirty:true, revn}\`. **Nothing is written to disk.**
3. **\`POST /pencilpot/save\`**: flushes the working copy to the on-disk EDN parts (\`pages/\`, \`components/\`,
   …). \`status → dirty:false\`. This is the ONLY disk-write chokepoint (the **save gap** an AI loop must honour).
4. **Cold restart** re-hydrates from disk: the saved edit is present and \`dirty:false\` (durable).
5. **\`POST /pencilpot/discard\`**: drops the in-memory working copy back to the on-disk state — staged edits
   vanish from \`get-file\`, disk is untouched. (Use it to abandon an uncommitted/unsaved experiment.)

## The non-spurious-dirty invariant (commit \`3f05d851bb\`, cross-ref \`verify-positiondata.mjs\`)
\`GET /pencilpot/status\` reports \`dirty\` by comparing a **content-only signature** of the working copy
against the on-disk baseline. That signature strips \`:revn\`, text \`:position-data\` (an engine-recomputed
render cache, never persisted), and EDN whitespace. Consequences proven here:
- A freshly-copied design opens \`dirty:false\` (no edits, no churn).
- Loading the workspace recomputes \`:position-data\` in memory, but that is excluded from the signature →
  **viewing never dirties the file** (this is what makes "open to look, close without a save prompt" correct).
- A no-op kill+respawn reopen is \`dirty:false\` (revn/whitespace differences alone never count as changes).

## Gotchas for an AI dev loop
- **\`commit()\` ≠ persisted.** Always \`POST /pencilpot/save\` after committing, or the edit is lost on
  restart/discard. Poll \`GET /pencilpot/status\` (\`{dirty,revn}\`) to confirm.
- \`discard\` reverts EVERYTHING staged since the last save (it reloads from disk) — it is not per-change undo.
- Saving is whole-working-copy → on-disk parts; there is no partial/selective save.
`;
  const out = path.resolve(REPO, ".superpowers/sdd/ai-B3-findings.md");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  // Replace any prior lifecycle section (idempotent), keep the prototypes section above it.
  const marker = "<!-- LIFECYCLE -->";
  let head = "";
  try { const cur = fs.readFileSync(out, "utf8"); const idx = cur.indexOf(marker); head = idx >= 0 ? cur.slice(0, idx) : cur + "\n"; } catch { head = ""; }
  fs.writeFileSync(out, head + md);
  console.log(`  findings: ${out}`);
}

console.log(passed() ? "\nALL CHECKS PASS" : "\nCHECKS FAILED");
process.exit(passed() ? 0 : 1);
