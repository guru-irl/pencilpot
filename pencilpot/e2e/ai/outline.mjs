// outline() proof: the AI's "where's what" index. Boot the runtime, checkout,
// and assert outline() returns every page with boards/text/instances and the
// file's components (incl. a freshly promoted one) — all WITHOUT reading files.
//
// SKIP (exit 0) if the design is absent. Run: node pencilpot/e2e/ai/outline.mjs
import { FID, designPresent, copyDesign, spawnRuntime, loadWorkingCopy, kill, makeChecks } from "./_boot.mjs";

if (!designPresent()) { console.log("SKIP: canonical design absent — outline"); process.exit(0); }

const { check, passed } = makeChecks();
let srv;
try {
  const dir = copyDesign("outline");
  const r = await spawnRuntime(dir);
  srv = r.proc;
  const wc = await new (await loadWorkingCopy(r.base))(FID, "local").checkout();

  const o = wc.outline();
  check(Array.isArray(o.pages) && o.pages.length > 0, `outline lists pages (${o.pages.length})`);
  const withBoards = o.pages.find((p) => p.counts.boards > 0);
  check(!!withBoards, `a page reports boards (${withBoards?.name})`);
  check(withBoards.boards.every((b) => b.id && b.name && Number.isFinite(b.width)),
        `boards carry id+name+geometry (e.g. ${withBoards.boards[0]?.name})`);
  const withText = o.pages.find((p) => p.counts.texts > 0);
  check(!!withText && withText.texts.some((t) => typeof t.text === "string" && t.text.length > 0),
        `text shapes carry locatable snippets (e.g. "${withText?.texts?.[0]?.text}")`);
  check(withText.texts.every((t) => t.frameId), `each text knows its board (frameId)`);

  // Components branch: promote a fresh board and confirm it surfaces with its location.
  const b = wc.addBoard({ x: 0, y: 0, width: 100, height: 60, name: "ProbeCard" });
  wc.closeBoard();
  wc.createComponent(b, { name: "ProbeCard" });
  const o2 = wc.outline();
  const c = o2.components.find((c) => c.name === "ProbeCard");
  check(!!c, `outline lists components (${o2.components.length}) incl. the new one`);
  check(!!(c && c.mainPage && c.mainShape), `component carries its main-instance location (page+shape)`);
  check(c && "variantId" in c && "variant" in c, `component exposes variant fields (variantId/variant)`);

  console.log(passed() ? "\nALL CHECKS PASS" : "\nSOME CHECKS FAILED");
} finally { kill(srv); }
process.exit(passed() ? 0 : 1);
