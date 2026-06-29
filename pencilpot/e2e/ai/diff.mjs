// Diff integration proof: capture a baseline of the engine's objects, make edits
// (move a shape, add a rect), then diff baseline vs current — the realistic shape
// of `pencilpot diff` (AI sees what changed). Uses the SDK over a booted runtime.
//
// SKIP (exit 0) if the design is absent. Run: node pencilpot/e2e/ai/diff.mjs
import { FID, designPresent, copyDesign, spawnRuntime, loadWorkingCopy, kill, makeChecks } from "./_boot.mjs";
import { diffObjects, formatDiff } from "../../store/diff.mjs";

if (!designPresent()) { console.log("SKIP: canonical design absent — diff"); process.exit(0); }

const { check, passed } = makeChecks();
let srv;
try {
  const dir = copyDesign("diff");
  const r = await spawnRuntime(dir);
  srv = r.proc;
  const wc = await new (await loadWorkingCopy(r.base))(FID, "local").checkout();

  const ROOT = "00000000-0000-0000-0000-000000000000";
  const baseline = JSON.parse(wc.session.objects());
  const target = Object.values(baseline).find((o) => (o.type === "rect" || o.type === "circle") && o["frame-id"] && o["frame-id"] !== ROOT);
  check(!!target, `baseline captured (${Object.keys(baseline).length} objects), target ${target?.id?.slice(0,8)}`);

  // Simulate the user's edits.
  wc.moveShape(target.id, { x: (target.x ?? 0) + 30, y: (target.y ?? 0) + 40 });
  const board = Object.values(baseline).find((o) => o.type === "frame" && o["frame-id"] === ROOT);
  const newId = wc.addRect(board.id, { x: 12, y: 12, width: 40, height: 40, name: "DiffProbe" });

  const current = JSON.parse(wc.session.objects());
  const d = diffObjects(baseline, current);

  check(d.modified.some((m) => m.id === target.id && (m.keys.includes("x") || m.keys.includes("y"))),
        `diff lists the moved shape with x/y change`);
  check(d.added.some((a) => String(a.id) === String(newId) || a.name === "DiffProbe"),
        `diff lists the added rect (${d.added.length} added)`);
  check(d.summary.changed >= 2, `summary counts changes (${JSON.stringify(d.summary)})`);
  check(/~ .*x|y/.test(formatDiff(d)) && /\+ rect/.test(formatDiff(d)), "formatDiff renders ~ and + lines");
  console.log("\n--- sample diff ---\n" + formatDiff(d).split("\n").slice(0, 6).join("\n"));
  console.log(passed() ? "\nALL CHECKS PASS" : "\nSOME CHECKS FAILED");
} finally { kill(srv); }
process.exit(passed() ? 0 : 1);
