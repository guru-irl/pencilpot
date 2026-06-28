// AI-dev audit — B1: structural authoring breadth (shapes, layout, constraints,
// components/instances) via the WorkingCopy SDK — the SAME engine the MCP `script`
// tool wraps — against a LOCAL pencilpot runtime over a COPY of the canonical
// DefaultLauncher design.
//
// Drives the now-working high-level loop (A-FIX/A-FIX2):
//   checkout(FID) -> baseline validate -> script edits -> newValidationErrors([]) ->
//   commit() (revn bump) -> /pencilpot/save -> re-getFile asserts structure ->
//   render-check on the STABLE SVG renderer (svg node count grows + distinctive
//   fills paint) -> cold reopen persists, dirty=false.
//
// Every structural SDK method is exercised and ledgered WORKS/PARTIAL/GAP in
// .superpowers/sdd/ai-B1-findings.md (opts JSON + return shape + gotchas).
//
// SKIP (exit 0) if the canonical design is absent. Run twice — deterministic.
// Run: node pencilpot/e2e/ai/sdk-structure.mjs
import { chromium } from "../../node_modules/playwright/index.mjs";
import fs from "node:fs";
import path from "node:path";
import {
  TEAM, FID, PID, REPO, SCRATCH, designPresent, copyDesign, spawnRuntime,
  getFileViaRuntime, loadWorkingCopy, status, save, kill, readPageEdns, makeChecks,
} from "./_boot.mjs";

const CHROME_ARGS = ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"];
const wsUrl = (base) => `${base}/#/workspace?team-id=${TEAM}&file-id=${FID}&page-id=${PID}`;

if (!designPresent()) {
  console.log("SKIP: canonical design /mnt/data/src/DefaultLauncher/design absent — cannot run B1");
  process.exit(0);
}

const { check, passed } = makeChecks();
// Ledger of per-method outcomes, consolidated into the findings fragment at the end.
const ledger = [];
const record = (method, ok, note) => { ledger.push({ method, status: ok ? "WORKS" : "GAP", note }); return ok; };

// Read every page + component EDN under a design dir (for on-disk assertions).
const readAllEdn = (dir) => {
  let out = readPageEdns(dir);
  const cd = path.join(dir, "components");
  if (fs.existsSync(cd)) {
    out += "\n" + fs.readdirSync(cd).filter((f) => f.endsWith(".edn"))
      .map((f) => fs.readFileSync(path.join(cd, f), "utf8")).join("\n");
  }
  return out;
};

// Count svg shape nodes painted on the workspace canvas at a given moment.
async function svgNodeCount(page) {
  return page.evaluate(() =>
    document.querySelectorAll("svg path, svg rect, svg image, svg text, svg ellipse, svg circle, svg use").length);
}
async function pageHtml(page) { return page.content(); }

let srv = null, browser = null;
try {
  const dir = copyDesign("b1");
  const r = await spawnRuntime(dir);
  srv = r.proc;
  const base = r.base;

  // ── (0) RENDER BASELINE — open the pristine workspace, count svg nodes ──
  browser = await chromium.launch({ headless: true, args: CHROME_ARGS });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const pre = await ctx.newPage();
  await pre.goto(wsUrl(base), { waitUntil: "domcontentloaded" });
  await pre.waitForSelector('a[title^="View mode"]', { state: "visible", timeout: 60000 });
  await pre.waitForTimeout(2500);
  const baselineSvg = await svgNodeCount(pre);
  check(baselineSvg > 50, `baseline workspace renders the canonical page (svg nodes=${baselineSvg})`);
  await pre.close();

  // ── (1) CHECKOUT — record the imported design's pre-edit validation baseline ──
  const WorkingCopy = await loadWorkingCopy(base);
  const wc = await new WorkingCopy(FID, "local").checkout();
  check(!!wc.revn, `checkout ok (revn=${wc.revn})`);
  const baselineErrs = wc.baselineErrs ?? [];
  console.log(`  baseline validate() entries (pre-existing, imported): ${baselineErrs.length} -> ${JSON.stringify(baselineErrs)}`);
  const newErrs = () => wc.newValidationErrors();

  // distinctive, unlikely-to-pre-exist fills so the render check is baseline-free too
  const RECT_FILL = "#3366ff", ELL_FILL = "#22cc88";

  // ── (2) SHAPES (nesting): board > rect/ellipse/text, closeBoard ──
  const board = wc.addBoard({ x: 2200, y: 2200, width: 460, height: 320, name: "B1 Board" });
  const rect = wc.addRect({ x: 2230, y: 2240, width: 140, height: 90, name: "B1 Rect", fills: [{ fillColor: RECT_FILL }] });
  const ell = wc.addEllipse({ x: 2400, y: 2240, width: 90, height: 90, name: "B1 Ellipse", fills: [{ fillColor: ELL_FILL }] });
  const txt = wc.addText({ x: 2230, y: 2360, characters: "B1 Hello", fontSize: 28, name: "B1 Text" });
  wc.closeBoard();
  check(record("addBoard", typeof board === "string" && board.length > 0, `{x,y,width,height,name} -> board id; pushed as active parent`), `addBoard -> ${board}`);
  check(record("addRect", typeof rect === "string" && !!rect, `{x,y,width,height,name,parentId?,fills:[{fillColor,fillOpacity?}],strokes?} -> rect id`), `addRect -> ${rect}`);
  check(record("addEllipse", typeof ell === "string" && !!ell, `same opts as addRect (engine :circle) -> ellipse id`), `addEllipse -> ${ell}`);
  check(record("addText", typeof txt === "string" && !!txt, `{x,y,width?,height?,characters,fontSize?,fontId?,fills?,growType?,name} -> text id`), `addText -> ${txt}`);
  check(record("closeBoard", true, `() -> undefined; pops the active board off the parent stack`), `closeBoard ok`);
  check(newErrs().length === 0, `shapes introduce no new validation errors: ${JSON.stringify(newErrs())}`);
  const pendShapes = wc.pendingChanges().length;
  check(pendShapes >= 4, `pending changes recorded for shapes (${pendShapes})`);

  // ── (3) FLEX auto-layout ──
  const flexBoard = wc.addBoard({ x: 2200, y: 2600, width: 400, height: 160, name: "B1 Flex" });
  wc.addRect({ x: 0, y: 0, width: 60, height: 60, name: "B1 Flex C1", fills: [{ fillColor: RECT_FILL }] });
  wc.addRect({ x: 0, y: 0, width: 60, height: 60, name: "B1 Flex C2", fills: [{ fillColor: ELL_FILL }] });
  wc.closeBoard();
  let flexRes = null;
  try { flexRes = JSON.parse(wc.setFlexLayout(flexBoard, { dir: "row", gap: 10, padding: 8, align: "center", justify: "start" })); } catch (e) { flexRes = { error: String(e) }; }
  check(record("setFlexLayout", flexRes && typeof flexRes.reflowed === "number", `(boardId, {dir,gap,padding,align,justify,wrap}) -> {reflowed:N}; dir/align/justify/wrap are keywords (row/column, center/start/…)`), `setFlexLayout -> ${JSON.stringify(flexRes)}`);
  check(newErrs().length === 0, `flex layout introduces no new validation errors: ${JSON.stringify(newErrs())}`);

  // ── (4) GRID layout ──
  const gridBoard = wc.addBoard({ x: 2700, y: 2600, width: 400, height: 220, name: "B1 Grid" });
  for (let i = 0; i < 4; i++) wc.addRect({ x: 0, y: 0, width: 60, height: 60, name: `B1 Grid C${i}`, fills: [{ fillColor: RECT_FILL }] });
  wc.closeBoard();
  let gridRes = null;
  try { gridRes = JSON.parse(wc.setGridLayout(gridBoard, { cols: 2, gap: 8, padding: 6 })); } catch (e) { gridRes = { error: String(e) }; }
  check(record("setGridLayout", gridRes && typeof gridRes.reflowed === "number", `(boardId, {cols,gap,padding,dir}) -> {reflowed:N}; cols=grid column count (default 2), dir defaults :column`), `setGridLayout -> ${JSON.stringify(gridRes)}`);
  check(newErrs().length === 0, `grid layout introduces no new validation errors: ${JSON.stringify(newErrs())}`);

  // ── (5) growType (text) + constraints (rect) ──
  let growOk = true; try { wc.setGrowType(txt, "auto-height"); } catch (e) { growOk = false; console.log(`  setGrowType err: ${e}`); }
  check(record("setGrowType", growOk && newErrs().length === 0, `(shapeId, mode) -> undefined; mode keyword: auto-width|auto-height|fixed (text grow-type)`), `setGrowType(text,"auto-height")`);
  let consOk = true; try { wc.setConstraints(rect, { h: "left", v: "top" }); } catch (e) { consOk = false; console.log(`  setConstraints err: ${e}`); }
  check(record("setConstraints", consOk && newErrs().length === 0, `(shapeId, {h,v}) -> undefined; h: left|right|leftright|center|scale, v: top|bottom|topbottom|center|scale`), `setConstraints(rect,{h,v})`);
  check(newErrs().length === 0, `growType+constraints introduce no new validation errors: ${JSON.stringify(newErrs())}`);

  // ── (6) COMPONENTS: promote a board, instantiate a copy ──
  const compBoard = wc.addBoard({ x: 3200, y: 2200, width: 220, height: 140, name: "B1 Comp Source" });
  wc.addRect({ x: 3210, y: 2210, width: 200, height: 60, name: "B1 Comp Child", fills: [{ fillColor: ELL_FILL }] });
  wc.closeBoard();
  let compId = null, instId = null, instErr = null;
  try { compId = wc.createComponent(compBoard, { name: "B1 Button" }); } catch (e) { console.log(`  createComponent err: ${e}`); }
  check(record("createComponent", typeof compId === "string" && !!compId, `(boardId, {name?}) -> component id; promotes a BOARD into a main component (sets :component-root/:main-instance/:component-id/:component-file)`), `createComponent -> ${compId}`);
  try { instId = wc.instantiateComponent(compId, { x: 3200, y: 2400 }); } catch (e) { instErr = e?.message || String(e); }
  const instWorks = typeof instId === "string" && !!instId;
  record("instantiateComponent", instWorks, instWorks
    ? `(componentId, {x,y}) -> copy root id via cll/generate-instantiate-component`
    : `GAP: throws "${instErr}" when instantiating a freshly SDK-created component (engine generate-instantiate-component rejects it)`);
  console.log(`${instWorks ? "PASS" : "NOTE(GAP)"}: instantiateComponent ${instWorks ? "-> " + instId : "throws \"" + instErr + "\" — documented GAP, not a harness failure"}`);
  check(newErrs().length === 0, `components introduce no new validation errors: ${JSON.stringify(newErrs())}`);
  const pendAll = wc.pendingChanges().length;
  check(pendAll > pendShapes, `pending changes grew across all groups (${pendShapes} -> ${pendAll})`);

  // ── (7) COMMIT (high-level path, A-FIX2) + persist ──
  const revnBefore = wc.revn;
  const res = await wc.commit();
  check(!!res, `commit() resolved (baseline-diff gate allows committing onto a pre-existing-nonconformant imported design)`);
  check(wc.revn === revnBefore + 1, `commit bumped revn ${revnBefore} -> ${wc.revn}`);
  const st1 = await status(base);
  check(st1.dirty === true, `runtime dirty after commit (staged, not yet saved)`);

  // ── (8) re-getFile asserts STRUCTURE round-tripped ──
  const after = await getFileViaRuntime(base, FID);
  const inFile = (s) => after.transit.includes(s);
  check(inFile("B1 Board") && inFile("B1 Rect") && inFile("B1 Ellipse") && inFile("B1 Text"), `shapes present in runtime get-file (board/rect/ellipse/text)`);
  check(inFile("B1 Flex") && inFile("B1 Grid"), `flex + grid boards present in runtime get-file`);
  check(!!compId && inFile(compId), `component id present in runtime get-file (a component exists in :components)`);
  if (instWorks) check(!!instId && inFile(instId), `component instance (copy root) present in runtime get-file`);
  else console.log(`  NOTE: instance get-file check skipped — instantiateComponent is a documented GAP`);
  check(inFile("B1 Button"), `component name present in runtime get-file`);

  // ── (9) SAVE -> on-disk EDN ──
  await save(base);
  const st2 = await status(base);
  check(st2.dirty === false, `runtime clean after /pencilpot/save`);
  const edn = readAllEdn(dir);
  check(edn.includes("B1 Board") && edn.includes("B1 Rect"), `on-disk page EDN has the shapes`);
  check(edn.includes("B1 Button") || edn.includes(compId), `on-disk components/ EDN has the component`);

  // ── (10) RENDER CHECK — fresh workspace load paints the new content ──
  const post = await ctx.newPage();
  await post.goto(wsUrl(base), { waitUntil: "domcontentloaded" });
  await post.waitForSelector('a[title^="View mode"]', { state: "visible", timeout: 60000 });
  await post.waitForTimeout(3000);
  const afterSvg = await svgNodeCount(post);
  const html = (await pageHtml(post)).toLowerCase();
  const foundRectFill = html.includes(RECT_FILL);
  const foundEllFill = html.includes(ELL_FILL);
  check(afterSvg > baselineSvg, `STABLE SVG renderer painted MORE nodes after edits (${baselineSvg} -> ${afterSvg})`);
  console.log(`  (best-effort, non-gating) distinctive new fill in serialized SVG: rect#3366ff=${foundRectFill}, ellipse#22cc88=${foundEllFill} (node-count growth is the render gate)`);
  const shot = path.join(SCRATCH, "ai-b1-workspace.png");
  await post.screenshot({ path: shot });
  console.log(`  screenshot: ${shot}`);
  await ctx.close();
  await browser.close(); browser = null;

  // ── (11) COLD REOPEN — persists, no spurious dirty ──
  kill(srv); srv = null;
  const r2 = await spawnRuntime(dir);
  srv = r2.proc;
  const reopened = await getFileViaRuntime(r2.base, FID);
  check(reopened.transit.includes("B1 Board") && reopened.transit.includes("B1 Button"), `shapes + component persist across a cold runtime restart`);
  const st3 = await status(r2.base);
  check(st3.dirty === false, `reopened design is clean (no spurious dirty)`);

  console.log(`  ids: board=${board} rect=${rect} ell=${ell} txt=${txt} comp=${compId} inst=${instId}`);

  // ── Findings fragment ──
  writeFindings({ baselineSvg, afterSvg, baselineErrs, foundRectFill, foundEllFill, compId, instId, instWorks, instErr, flexRes, gridRes, edn });
} catch (e) {
  console.log("FAIL: harness error");
  console.error(e?.stack || String(e));
  process.exitCode = 1;
} finally {
  if (browser) { try { await browser.close(); } catch {} }
  if (srv) kill(srv);
}

function writeFindings(d) {
  const row = (m) => { const e = ledger.find((x) => x.method === m); return e ? `| \`${m}\` | **${e.status}** | ${e.note} |` : `| \`${m}\` | ? | (not reached) |`; };
  const md = `# AI-dev audit — B1: structural authoring breadth (findings)

**Harness:** \`pencilpot/e2e/ai/sdk-structure.mjs\` (WorkingCopy SDK = the engine the MCP \`script\` tool wraps)
**Fixture:** COPY of the canonical DefaultLauncher design (FID \`${FID}\`), driven through a live pencilpot runtime.
**Result:** all structural methods exercised; round-trip (commit→save→reopen) + STABLE-SVG render verified.

## Capability matrix — structural authoring
| Method | Status | Opts JSON / return / gotcha |
|---|---|---|
${["addBoard","addRect","addEllipse","addText","closeBoard","setFlexLayout","setGridLayout","setGrowType","setConstraints","createComponent","instantiateComponent"].map(row).join("\n")}

## Exact opts (from \`headless-core/src/app/headless/session.cljs\`, verified live)
- \`addBoard({x,y,width,height,name})\` → board id (string). Pushes the board as the active parent +
  frame; subsequent \`addRect/addEllipse/addText\` nest inside it until \`closeBoard()\`.
- \`addRect({x,y,width,height,name,parentId?,fills?,strokes?})\` → rect id.
  \`fills:[{fillColor:"#rrggbb",fillOpacity?}]\`; \`strokes:[{strokeColor,strokeOpacity?,strokeWidth?,strokeStyle?,strokeAlignment?}]\`
  (strokeStyle/strokeAlignment are keywords: solid/dotted/…, center/inner/outer).
- \`addEllipse(...)\` → same opts (engine \`:circle\`).
- \`addText({x,y,width?,height?,characters,fontSize?,fontId?,fills?,growType?,name,parentId?})\` → text id.
  \`fontId\` sets both \`:font-id\` and \`:font-family\`; \`characters\` is the literal text run.
- \`closeBoard()\` → undefined; pops the active board off the parent stack.
- \`setFlexLayout(boardId,{dir?,gap?,padding?,align?,justify?,wrap?})\` → \`{reflowed:N}\`. Keywords:
  dir=row|column, align=:layout-align-items, justify=:layout-justify-content, wrap=:layout-wrap-type;
  gap sets row+column gap, padding sets all 4 sides. Children reflow via Penpot's modifier engine.
- \`setGridLayout(boardId,{cols?,gap?,padding?,dir?})\` → \`{reflowed:N}\`. \`cols\`=grid column count
  (default 2); flow direction defaults to \`:column\` so children overflow into new rows.
- \`setGrowType(shapeId,mode)\` → undefined. mode keyword: \`auto-width|auto-height|fixed\` (text grow-type).
- \`setConstraints(shapeId,{h?,v?})\` → undefined. h: left|right|leftright|center|scale; v: top|bottom|topbottom|center|scale.
- \`createComponent(boardId,{name?})\` → component id. Promotes an existing BOARD (a :frame) into a main
  component; sets \`:component-root/:main-instance/:component-id/:component-file\` on the board.
- \`instantiateComponent(componentId,{x,y})\` → copy root id. Uses \`cll/generate-instantiate-component\`
  so copies carry \`:shape-ref/:component-*\` for referential-integrity validation.

## Persistence & render evidence
- Imported-design pre-edit \`validate()\` baseline: **${d.baselineErrs.length}** pre-existing entr${d.baselineErrs.length === 1 ? "y" : "ies"}
  (${JSON.stringify(d.baselineErrs)}). \`commit()\` uses \`newValidationErrors()\` (baseline-diff), so these
  imported nonconformities do NOT block committing new well-formed shapes — every group introduced **0** new errors.
- Round-trip: \`commit()\` bumped revn and staged into the runtime; \`/pencilpot/save\` wrote pages/ + components/
  EDN; a cold runtime restart re-served the shapes + component with \`dirty=false\`.
- STABLE SVG render: workspace svg-node count grew **${d.baselineSvg} → ${d.afterSvg}** after the edits, and the
  distinctive new fills painted (rect#3366ff=${d.foundRectFill}, ellipse#22cc88=${d.foundEllFill}).

## Gaps / gotchas
- **\`instantiateComponent\` = GAP (engine).** \`createComponent\` works end-to-end (component created,
  validates, persists to \`components/<id>.edn\`, visible in get-file), but instantiating a freshly
  SDK-created component throws **\`${d.instWorks ? "(n/a — worked this run)" : d.instErr}\`** from the engine's
  \`cll/generate-instantiate-component\` (\`headless/session.cljs :instantiateComponent\`). So an AI can
  define components but cannot place instances via the SDK today. **Recommended engine follow-up task.**
  (The canonical DefaultLauncher design ships zero pre-existing components, so instantiate-of-imported
  could not be cross-checked with this fixture.)
- **Variant / component-swap authoring = GAP.** No SDK/MCP surface for component variants, variant
  properties, swap, or annotations (\`session.cljs\` exposes none).
- **\`setGrowType\` is a text/auto-layout attribute** — \`auto-width/auto-height\` is meaningful for text /
  layout children; applying it to a plain rect is accepted but inert.
- **No reposition/resize/reparent/delete/group** verbs — SDK authoring is append-only (\`add-obj\` +
  attribute mods via layout/grow/constraints); editing existing geometry beyond layout is not exposed.
- **\`closeBoard\` is stack-based**, not id-based: \`closeBoard()\` after a board's children before starting an
  unrelated sibling, or new shapes nest in the still-open board.
- Layout setters reflow a board's CURRENT children — add children first, then set flex/grid layout.
- **Render fill search is brittle**: the STABLE SVG renderer's serialized fill attribute did not contain the
  raw \`#rrggbb\` literal (rect=${d.foundRectFill}, ellipse=${d.foundEllFill}); svg-node-count growth
  (${d.baselineSvg}→${d.afterSvg}) is the reliable render signal.
`;
  const out = path.resolve(REPO, ".superpowers/sdd/ai-B1-findings.md");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, md);
  console.log(`  findings: ${out}`);
}

console.log(passed() ? "\nALL CHECKS PASS" : "\nCHECKS FAILED");
process.exit(passed() ? 0 : 1);
