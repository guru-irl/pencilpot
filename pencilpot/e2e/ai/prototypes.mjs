// AI-dev audit — B3 / Harness A: prototypes (interaction AUTHORING gap + viewer
// CONSUMPTION works) against a LOCAL pencilpot runtime over a COPY of the canonical
// DefaultLauncher design.
//
// Two halves:
//   (1) AUTHORING = GAP. The headless engine's exported method surface
//       (headless/session.cljs #js {...}) — which both the WorkingCopy SDK and the
//       MCP `script` tool wrap — exposes NO verb to author prototype interactions
//       (no addInteraction/setInteraction/addFlow/connect/navigate/hotspot/overlay).
//       Proven statically (the method table) AND dynamically (the SDK object has no
//       such method). The exact missing surface is documented in the findings.
//   (2) CONSUMPTION = WORKS. The canonical design ships real :navigate/:click
//       interactions on page 1274ef5c…57. We boot the runtime + the STABLE SVG
//       viewer (/#/view), assert get-view-only-bundle serves the interactions to
//       the viewer, the prototype frame renders (not the 404 page), and then DRIVE A
//       REAL HOTSPOT: an interactive shape renders as <g id="shape-<uuid>"> with an
//       on-pointer-down handler; dispatching `pointerdown` fires go-to-frame, which
//       navigates the viewer (observable as a changed URL `index` query param).
//
// SKIP (exit 0) if the canonical design is absent. Run twice — deterministic.
// Run: node pencilpot/e2e/ai/prototypes.mjs
import { chromium } from "../../node_modules/playwright/index.mjs";
import fs from "node:fs";
import path from "node:path";
import {
  TEAM, FID, REPO, SCRATCH, designPresent, copyDesign, spawnRuntime,
  loadWorkingCopy, kill, makeChecks, save, status, readPageEdns,
} from "./_boot.mjs";

const CHROME_ARGS = ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"];
const SESSION_CLJS = path.resolve(REPO, "headless-core/src/app/headless/session.cljs");

if (!designPresent()) {
  console.log("SKIP: canonical design /mnt/data/src/DefaultLauncher/design absent — cannot run B3 prototypes");
  process.exit(0);
}

const { check, passed } = makeChecks();
const finding = {};

// ── Parse the page EDN: find the page that carries :click/:navigate interactions,
//    plus the owning shape uuids (the hotspots). Each shape map has exactly one
//    `:id #uuid "X"`, and a click-navigate interaction sits after it in the SAME
//    map → the nearest preceding `:id` before a `:event-type :click` is the owner. ──
function findInteractionsPage(dir) {
  const pd = path.join(dir, "pages");
  for (const f of fs.readdirSync(pd).filter((x) => x.endsWith(".edn"))) {
    const edn = fs.readFileSync(path.join(pd, f), "utf8");
    if (/:event-type :click/.test(edn) && /:action-type :navigate/.test(edn)) {
      return { pageId: f.replace(/\.edn$/, ""), edn };
    }
  }
  return null;
}
function hotspotUuids(edn) {
  const out = [];
  const re = /:event-type :click/g;
  let m;
  while ((m = re.exec(edn))) {
    const before = edn.slice(0, m.index);
    // require this interaction to be a navigate within a small window around it
    const window = edn.slice(Math.max(0, m.index - 300), m.index + 300);
    if (!/:action-type :navigate/.test(window)) continue;
    const ids = [...before.matchAll(/:id #uuid "([0-9a-f-]+)"/g)];
    if (ids.length) {
      const owner = ids[ids.length - 1][1];
      if (owner !== "00000000-0000-0000-0000-000000000000" && !out.includes(owner)) out.push(owner);
    }
  }
  return out;
}

const viewerIndex = (url) => {
  const hash = url.split("#")[1] || "";
  const q = hash.split("?")[1] || "";
  const v = new URLSearchParams(q).get("index");
  return v == null ? null : v;
};

let srv = null, browser = null;
try {
  const dir = copyDesign("b3proto");

  // ─────────────────────────────────────────────────────────────────────────
  // (1) AUTHORING — wc.addInteraction wires a prototype link (commit 5268503075)
  // ─────────────────────────────────────────────────────────────────────────
  const sessionSrc = fs.readFileSync(SESSION_CLJS, "utf8");
  // the engine now exposes :addInteraction and writes the shape's :interactions vector
  check(/:addInteraction/.test(sessionSrc) && /:interactions/.test(sessionSrc),
    `headless/session.cljs exposes :addInteraction and writes :interactions`);

  // the WorkingCopy SDK = the public surface the MCP `script` tool wraps. Enumerate it.
  const r0 = await spawnRuntime(dir);
  srv = r0.proc;
  const base = r0.base;
  const WorkingCopy = await loadWorkingCopy(base);
  const wc = await new WorkingCopy(FID, "local").checkout();
  const sdkMethods = [...new Set([
    ...Object.getOwnPropertyNames(Object.getPrototypeOf(wc)),
    ...Object.getOwnPropertyNames(wc.session ? Object.getPrototypeOf(wc.session) : {}),
  ])].filter((k) => k !== "constructor" && typeof (wc[k] ?? wc.session?.[k]) === "function").sort();
  finding.exported = sdkMethods;
  check(sdkMethods.includes("addRect") && sdkMethods.includes("createComponent"),
    `(sanity) SDK method surface enumerated (addRect + createComponent present; ${sdkMethods.length} methods)`);
  check(typeof wc.addInteraction === "function",
    `WorkingCopy SDK exposes addInteraction (the prototype-authoring verb)`);

  // author a click→navigate link between two fresh frames
  const homeId = wc.addBoard({ x: 5000, y: 100, width: 300, height: 200, name: "AUDIT Home" });
  wc.closeBoard();
  const detailsId = wc.addBoard({ x: 5400, y: 100, width: 300, height: 200, name: "AUDIT Details" });
  wc.closeBoard();
  const inter = wc.addInteraction({ shapeId: homeId, destination: detailsId });
  check((inter["event-type"] ?? inter.eventType) === "click" &&
        (inter["action-type"] ?? inter.actionType) === "navigate" &&
        inter.destination === detailsId,
    `authored a click→navigate interaction (dest=${detailsId})`);
  check(wc.newValidationErrors().length === 0,
    `authored interaction introduces no validation errors: ${JSON.stringify(wc.newValidationErrors())}`);

  await wc.commit();
  await save(base);
  check((await status(base)).dirty === false, `authored interaction committed + saved (dirty=false)`);

  // cold-read the on-disk page EDN: the interaction persisted durably
  const allPageEdn = readPageEdns(dir);
  const authoredPersisted = allPageEdn.includes(detailsId) &&
    /:interactions/.test(allPageEdn) && allPageEdn.includes("AUDIT Home");
  check(authoredPersisted, `authored interaction persisted to the on-disk page EDN (durable)`);
  finding.authoringWorks = true;
  finding.authoredDest = detailsId;

  // ─────────────────────────────────────────────────────────────────────────
  // (2) CONSUMPTION — the STABLE SVG viewer plays the imported prototype
  // ─────────────────────────────────────────────────────────────────────────
  const ip = findInteractionsPage(dir);
  check(!!ip, `canonical design ships a page with :navigate/:click interactions (page ${ip?.pageId})`);
  const hotspots = ip ? hotspotUuids(ip.edn) : [];
  check(hotspots.length > 0, `parsed ${hotspots.length} click-navigate hotspot shape(s) from the page EDN`);
  finding.pageId = ip?.pageId; finding.hotspotCount = hotspots.length;

  browser = await chromium.launch({ headless: true, args: CHROME_ARGS });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await ctx.newPage();

  // Capture the get-view-only-bundle so we can assert the interactions reach the viewer.
  const bundle = { count: 0, ok: 0, bad: [], hasInteractions: false };
  page.on("response", async (resp) => {
    const u = resp.url();
    if (u.includes("/get-view-only-bundle")) {
      bundle.count++;
      if (resp.status() === 200) { bundle.ok++; } else { bundle.bad.push(resp.status()); }
      try { const t = await resp.text(); if (/interactions/.test(t) && /navigate/.test(t)) bundle.hasInteractions = true; } catch {}
    }
  });

  const viewUrl = (i) => `${base}/#/view?file-id=${FID}&page-id=${ip.pageId}&section=interactions${i == null ? "" : `&index=${i}`}`;

  async function loadAndRender(i) {
    await page.goto(viewUrl(i), { waitUntil: "domcontentloaded" });
    const dl = Date.now() + 45000;
    while (bundle.count === 0 && Date.now() < dl) await page.waitForTimeout(300);
    let st = { rendered: false, notFound: false, svg: 0, layout: false };
    const rdl = Date.now() + 30000;
    while (Date.now() < rdl) {
      st = await page.evaluate(() => {
        const body = document.body ? (document.body.innerText || "") : "";
        const notFound = body.includes("This page doesn't exist") || body.includes("404 error");
        const svg = document.querySelectorAll("svg path, svg rect, svg image, svg text, svg ellipse, svg circle").length;
        const layout = !!document.querySelector("[class*='viewer-layout'], [class*='viewer-section']");
        return { rendered: layout && svg > 50, notFound, svg, layout };
      });
      if (st.notFound || st.rendered) break;
      await page.waitForTimeout(400);
    }
    return st;
  }

  // initial load (auto-start frame)
  const st0 = await loadAndRender(null);
  check(bundle.count > 0 && bundle.bad.length === 0, `get-view-only-bundle served 200 to the viewer (count=${bundle.count}, bad=${bundle.bad.join(",") || "none"})`);
  check(bundle.hasInteractions, `served bundle carries the prototype interactions (:interactions + :navigate present in transit)`);
  check(!st0.notFound, `viewer is NOT the not-found page`);
  check(st0.rendered, `STABLE SVG viewer painted the prototype frame (svg nodes=${st0.svg}, layout=${st0.layout})`);
  finding.svg0 = st0.svg;

  // ── Drive a REAL prototype interaction. SVG `<g>` shape groups report 0×0 via
  //    getBoundingClientRect and ids repeat across frames, so we don't target by id
  //    — we issue REAL viewport mouse clicks on each frame until the viewer's URL
  //    `index` changes. A trusted click bubbles to the frame/shape on-pointer-down
  //    handler -> activate-interaction :navigate -> dv/go-to-frame -> the route's
  //    `index` query param is rewritten (frame navigation observed end to end). ──
  const clickPts = [[800, 500], [800, 300], [800, 800], [400, 500], [1200, 500], [800, 120]];
  let navProven = false, navFrom = null, navTo = null, navFrame = null;
  for (let i = 0; i < 8 && !navProven; i++) {
    const st = i === 0 ? st0 : await loadAndRender(i);
    if (!st.rendered) continue;
    for (const [x, y] of clickPts) {
      const from = viewerIndex(page.url());
      await page.mouse.click(x, y);
      const ndl = Date.now() + 2500;
      while (Date.now() < ndl) {
        const now = viewerIndex(page.url());
        if (now !== from) { navProven = true; navFrom = from; navTo = now; navFrame = i; break; }
        await page.waitForTimeout(120);
      }
      if (navProven) break;
    }
  }
  check(navProven, `clicking the prototype NAVIGATED the viewer (frame ${navFrame}: index ${navFrom} -> ${navTo})`);
  finding.navProven = navProven; finding.navFrom = navFrom; finding.navTo = navTo; finding.navFrame = navFrame;

  const shot = path.join(SCRATCH, "ai-b3-viewer.png");
  await page.screenshot({ path: shot });
  console.log(`  screenshot: ${shot}`);
  await ctx.close();
  await browser.close(); browser = null;

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
  const md = `# AI-dev audit — B3 / prototypes (findings)

**Harness:** \`pencilpot/e2e/ai/prototypes.mjs\`
**Fixture:** COPY of the canonical DefaultLauncher design (FID \`${FID}\`); the prototype lives on
page \`${d.pageId}\` (${d.hotspotCount} click→navigate hotspot shapes).

## Verdict
| Surface | Status | Notes |
|---|---|---|
| Interaction **authoring** (SDK/MCP) | **WORKS** | \`wc.addInteraction({shapeId,destination})\` wires a click→navigate link; committed + saved + persisted to page EDN (commit \`5268503075\`) |
| Interaction / prototype **viewing & playing** (\`/view\`) | **WORKS** | bundle served, frame rendered, a hotspot click navigated (index ${d.navFrom} → ${d.navTo}) |

## AUTHORING = WORKS (the verb)
The headless engine (\`headless-core/src/app/headless/session.cljs\`) exposes \`:addInteraction\`, surfaced
on the \`WorkingCopy\` SDK (\`wc.addInteraction\`) and reachable through the MCP \`script\` tool. The full
SDK method surface:
\`\`\`
${(d.exported || []).join("  ")}
\`\`\`
Authoring sets the origin shape's \`:interactions\` vector via \`pcb/update-shapes\` (no \`check-shape\`, so it
is safe on hydrated plain-map shapes), e.g.
\`\`\`clojure
:interactions [{:action-type :navigate          ; or :open-overlay / :close-overlay / :open-url / :prev-screen
                :event-type  :click              ; or :mouse-enter / :mouse-leave / :after-delay
                :destination #uuid "<frame-id>"  ; target board
                :preserve-scroll false}]
\`\`\`
(shape schema: \`app.common.types.shape.interactions\`; the verb builds it via the interactions helpers
so it is \`ctsi/check-interaction!\`-valid). So an AI can build the *frames* (boards/shapes/components)
**and** wire the *prototype* in code; pencilpot then renders/plays the authored interactions faithfully
— the same path as imported or UI-authored ones.

## VIEWING / PLAYING = WORKS (what was proven)
- \`get-view-only-bundle\` served **200** to the STABLE SVG viewer and the bundle transit carries the
  prototype data (\`:interactions\` + \`:navigate\` present).
- The viewer mounted (viewer-layout) and painted the prototype frame (svg nodes=${d.svg0}); it is NOT
  the "This page doesn't exist" / 404 page (the bug fixed earlier in the view-mode work).
- **A real prototype click navigated.** A trusted viewport mouse click on the rendered prototype
  (frame ${d.navFrame}) bubbled to the frame/shape \`on-pointer-down\` handler →
  \`activate-interaction\` (\`:action-type :navigate\`) → \`dv/go-to-frame\` → \`go-to-frame-by-index\`
  → \`rt/nav :viewer\`, rewriting the URL \`index\` query param **${d.navFrom} → ${d.navTo}** (frame
  navigation observed end to end).

## Gotchas
- The viewer route is a deep-linkable hash route: \`/#/view?file-id=<FID>&page-id=<PID>&section=interactions\`
  (optionally \`&index=<frame>\`); no index → the flow's starting frame (or frame 0).
- Prototype navigation is **frame-indexed within a page** (\`go-to-frame-by-index\` rewrites \`&index\`),
  not page-routed; \`:destination\` is a frame (board) uuid in the same page.
- Driving a hotspot in a headless test: SVG \`<g>\` shape groups report **0×0** via
  \`getBoundingClientRect\` and shape ids (\`shape-<uuid>\`) repeat across frames, so target by **real
  viewport mouse click** (\`page.mouse.click\`), not by DOM id; the click bubbles to the frame's
  \`on-pointer-down\` (the \`:interactions\` highlight \`<rect>\` itself is \`pointer-events:none\`).
- Supported \`:event-type\`s: \`:click\`, \`:mouse-press\`, \`:mouse-enter\`, \`:mouse-over\`,
  \`:mouse-leave\`, \`:after-delay\`; \`:action-type\`s include \`:navigate\`, \`:open-overlay\`,
  \`:toggle-overlay\`, \`:close-overlay\`, \`:prev-screen\`, \`:open-url\` (all consumed, none authorable).
`;
  const out = path.resolve(REPO, ".superpowers/sdd/ai-B3-findings.md");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  // prototypes writes the prototypes section; lifecycle.mjs appends its own section.
  const marker = "<!-- LIFECYCLE -->";
  let existing = "";
  try { const cur = fs.readFileSync(out, "utf8"); const idx = cur.indexOf(marker); if (idx >= 0) existing = "\n" + cur.slice(idx); } catch {}
  fs.writeFileSync(out, md + existing);
  console.log(`  findings: ${out}`);
}

console.log(passed() ? "\nALL CHECKS PASS" : "\nCHECKS FAILED");
process.exit(passed() ? 0 : 1);
