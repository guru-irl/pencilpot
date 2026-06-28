// AI-dev live proof — the SDK "full control" verbs through the REAL runtime:
// edit/move/resize/delete/group existing shapes + all-type tokens + binding,
// then commit -> POST /pencilpot/save -> assert it persisted to the on-disk EDN.
//
// SKIP (exit 0) if the canonical design is absent. Run: node pencilpot/e2e/ai/sdk-edit.mjs
import {
  FID, designPresent, copyDesign, spawnRuntime, loadWorkingCopy,
  kill, makeChecks, save, status, readPageEdns,
} from "./_boot.mjs";
import fs from "node:fs";
import path from "node:path";

if (!designPresent()) {
  console.log("SKIP: canonical design absent — cannot run sdk-edit live proof");
  process.exit(0);
}

const { check, passed } = makeChecks();
let srv, dir;
try {
  dir = copyDesign("ai-sdk-edit");
  const r = await spawnRuntime(dir);
  srv = r.proc;
  const WorkingCopy = await loadWorkingCopy(r.base);
  const wc = await new WorkingCopy(FID, "local").checkout();

  // append a known scaffold we can edit deterministically
  const board = wc.addBoard({ x: 9000, y: 9000, width: 500, height: 400, name: "EDIT-AUDIT" });
  const r1 = wc.addRect({ x: 10, y: 10, width: 60, height: 60, name: "r1" });
  const r2 = wc.addRect({ x: 100, y: 10, width: 60, height: 60, name: "r2" });
  const r3 = wc.addRect({ x: 200, y: 10, width: 60, height: 60, name: "r3-doomed" });
  wc.closeBoard();

  // EDIT existing shapes
  wc.updateShape(r1, { name: "edited-r1", opacity: 0.4, fills: [{ "fill-color": "#22aa55", "fill-opacity": 1 }] });
  wc.moveShape(r2, { x: 9300, y: 9200 });
  wc.resizeShape(r1, { width: 140 });
  wc.deleteShape(r3);
  const grp = wc.groupShapes([r1, r2], { name: "AUDIT-GROUP" });
  wc.rotateShape(grp, { angle: 30 });

  // tokens of a non-color type + binding (+ literal resolution onto the fill)
  wc.addToken({ set: "audit", name: "audit.brand", type: "color", value: "#abcdef" });
  wc.addToken({ set: "audit", name: "audit.gap", type: "spacing", value: "12" });
  wc.applyToken(r1, { token: "audit.brand", attributes: ["fill"] });

  // variants: promote a fresh component into a variant set, then add a sibling
  const vb = wc.addBoard({ x: 9700, y: 9000, width: 120, height: 80, name: "V-AUDIT" });
  wc.addRect({ x: 10, y: 10, width: 40, height: 40, name: "vr" });
  wc.closeBoard();
  const vcomp = wc.createComponent(vb, { name: "VComp" });
  const vcontainer = wc.makeVariant(vb, { name: "VSet" });
  wc.addVariant(vb);

  check(wc.newValidationErrors().length === 0, `edits introduce no new validation errors: ${JSON.stringify(wc.newValidationErrors())}`);

  const scene = JSON.parse(wc.session.objects());
  check(scene[grp] && scene[grp].type === "group", "group created in the live scene");
  check(typeof scene[grp].rotation === "number" && scene[grp].rotation !== 0, "group rotated in the live scene");
  check(scene[r1].name === "edited-r1" && scene[r1]["parent-id"] === grp, "r1 edited + grouped");
  check(scene[r1].fills && scene[r1].fills[0]["fill-color"] === "#abcdef", "literal color token resolved onto r1 fill");
  check(!scene[r3], "r3 deleted from the live scene");
  check(scene[vcontainer] && scene[vcontainer]["is-variant-container"] === true, "variant container created");

  await wc.commit();
  await save(r.base);
  check((await status(r.base)).dirty === false, "committed + saved (dirty=false)");

  // cold-read the on-disk EDN: edits durable
  const pages = readPageEdns(dir);
  check(pages.includes("AUDIT-GROUP"), "group persisted to page EDN");
  check(pages.includes("edited-r1"), "renamed shape persisted to page EDN");
  check(pages.includes("is-variant-container"), "variant set persisted to page EDN");
  check(!pages.includes("r3-doomed"), "deleted shape absent from page EDN");

  // token persists to the design manifest (TokensLib lives there). Find manifest.edn
  // whether the layout is a bare design dir or a project with designs/<name>/.
  const manifestPaths = [];
  (function walk(d, depth) {
    if (depth > 3) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isFile() && e.name === "manifest.edn") manifestPaths.push(p);
      else if (e.isDirectory() && e.name !== "pages" && e.name !== "components") walk(p, depth + 1);
    }
  })(dir, 0);
  const manifest = manifestPaths.map((p) => fs.readFileSync(p, "utf8")).join("\n");
  check(/audit\.brand/.test(manifest) || /audit\.brand/.test(pages), "token persisted (manifest/EDN)");

  console.log(passed() ? "\nALL CHECKS PASS" : "\nSOME CHECKS FAILED");
  process.exitCode = passed() ? 0 : 1;
} catch (e) {
  console.log("FAIL: harness error");
  console.error(e?.stack || String(e));
  process.exitCode = 1;
} finally {
  if (srv) kill(srv);
}
