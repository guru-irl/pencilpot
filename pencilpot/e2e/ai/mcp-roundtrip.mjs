// A1 — MCP transport proof (the integration spine of the AI-dev capability audit).
//
// Proves the REAL `penpot-headless` MCP server (headless-core/mcp/server.mjs, spoken
// over genuine stdio JSON-RPC via the MCP SDK client) drives a LOCAL pencilpot design
// by pointing PENPOT_HL_BASE at the running pencilpot runtime. Boots the runtime over a
// COPY of DefaultLauncher/design (never the canonical design).
//
// What this harness establishes (and the two findings it pins down):
//
//   PHASE A — real MCP stdio round-trip:
//     checkout(FID)  -> reads the local design through the runtime (objects>0, revn)
//     scene()        -> object map
//     script(...)    -> addBoard + nested addRect + closeBoard (engine UUIDs, pending>=2)
//     status()       -> pending change count
//     validate()     -> RUNS, but currently reports ["invalid file data"] (FINDING #2)
//     commit()       -> currently GATED: the MCP commit tool refuses while validate is
//                       non-empty. The runtime's get-file transit hydrates into :data
//                       that fails common.files.validate/check-file-data — this also
//                       reproduces on a fresh empty `pencilpot new` starter, so it gates
//                       EVERY commit. The underlying transport is NOT the problem.
//
//   PHASE B — update-file transport + save lifecycle (validate gate bypassed):
//     checkout -> edit -> commitBody -> POST /api/rpc/command/update-file (HTTP 200,
//     revn bumps) -> edit VISIBLE in a direct get-file -> runtime status DIRTY (staged,
//     not on disk: the SAVE GAP) -> POST /pencilpot/save -> on-disk page EDN now carries
//     the edit -> status clean. This proves the real integration spine end to end.
//
// FINDING #1 (fixed in this change): headless-core/sdk/rpc.mjs getFile read
//   meta.data.pages[0] for an UNUSED pageId; the pencilpot runtime returns `data` as a
//   raw transit blob (no decoded .pages), so checkout threw. Guarded with optional
//   chaining (safe for real backends: same value; pencilpot: undefined).
//
// MCP path: REAL stdio round-trip via @modelcontextprotocol/sdk StdioClientTransport
// (already a headless-core dependency — no new deps).
//
// SKIPs (exit 0) if /mnt/data/src/DefaultLauncher/design is absent.
// Run: node pencilpot/e2e/ai/mcp-roundtrip.mjs
import { randomUUID } from "node:crypto";
import {
  designPresent, copyDesign, spawnRuntime, kill, status, save,
  getFileViaRuntime, readPageEdns, loadMcpClient, loadWorkingCopy, makeChecks,
  MCP_SERVER, FID,
} from "./_boot.mjs";

if (!designPresent()) {
  console.log("SKIP: /mnt/data/src/DefaultLauncher/design not present — cannot run MCP transport proof");
  process.exit(0);
}

const { check, passed } = makeChecks();
const callJson = (resp) => {
  const t = resp?.content?.find((c) => c.type === "text")?.text ?? "";
  try { return JSON.parse(t); } catch { return { _raw: t }; }
};

let runtime = null, client = null, transport = null;
try {
  const dir = copyDesign("mcp");
  runtime = await spawnRuntime(dir);
  console.log(`runtime up: ${runtime.base} (design copy ${dir})`);

  // ════ PHASE A — real MCP stdio round-trip ════
  const { Client, StdioClientTransport } = await loadMcpClient();
  transport = new StdioClientTransport({
    command: process.execPath,
    args: [MCP_SERVER],
    env: { ...process.env, PENPOT_HL_BASE: runtime.base, PENPOT_TOKEN: "local" },
    stderr: "inherit",
  });
  client = new Client({ name: "a1-harness", version: "0.0.1" }, { capabilities: {} });
  await client.connect(transport);

  const tools = (await client.listTools()).tools.map((t) => t.name);
  check(["checkout", "script", "scene", "validate", "status", "commit", "discard"].every((n) => tools.includes(n)),
    `MCP advertises the headless tools (${tools.join(",")})`);

  const co = callJson(await client.callTool({ name: "checkout", arguments: { fileId: FID } }));
  check(co.checkedOut === FID && typeof co.revn === "number" && co.objects > 0,
    `[MCP] checkout drove the local runtime (objects=${co.objects}, revn=${co.revn})`);

  const scn = callJson(await client.callTool({ name: "scene", arguments: {} }));
  check(scn && typeof scn === "object" && Object.keys(scn).length > 0,
    `[MCP] scene returned the object map (${Object.keys(scn || {}).length} objects)`);

  const code = `
    const board = wc.addBoard({ x: 100, y: 100, width: 240, height: 160, name: "A1 MCP Board" });
    const rect  = wc.addRect({ x: 120, y: 120, width: 100, height: 60, parentId: board, name: "A1 MCP Rect", fills: [{ fillColor: "#ff3366" }] });
    wc.closeBoard();
    return { board, rect, pending: wc.pendingChanges().length };
  `;
  const sc = callJson(await client.callTool({ name: "script", arguments: { code } }));
  const boardId = sc?.result?.board, rectId = sc?.result?.rect;
  check(!sc.error && typeof boardId === "string" && typeof rectId === "string",
    `[MCP] script added board+rect (board=${boardId}, rect=${rectId}, err=${sc.error || "none"})`);
  check((sc.pending ?? sc?.result?.pending) >= 2,
    `[MCP] script recorded pending changes (pending=${sc.pending ?? sc?.result?.pending})`);

  const st = callJson(await client.callTool({ name: "status", arguments: {} }));
  check(st.pending >= 2, `[MCP] status shows pending changes (pending=${st.pending})`);

  const val = callJson(await client.callTool({ name: "validate", arguments: {} }));
  check(Array.isArray(val), `[MCP] validate runs and returns an array (issues=${Array.isArray(val) ? val.length : "n/a"})`);

  // FINDING #2: commit is gated by validate; runtime-hydrated :data fails check-file-data.
  const cm = callJson(await client.callTool({ name: "commit", arguments: {} }));
  check(cm.error && Array.isArray(cm.errs) && cm.errs.join(" ").includes("invalid file data"),
    `[MCP] commit is GATED by validate on runtime-hydrated data (FINDING #2: errs=${JSON.stringify(cm.errs)})`);

  await client.close(); client = null;

  // ════ PHASE B — update-file transport + save lifecycle (gate bypassed) ════
  // Drive the SAME real engine + transport the MCP commit uses, minus the validate
  // gate, to prove the integration spine and the explicit-save lifecycle end to end.
  const WorkingCopy = await loadWorkingCopy(runtime.base);
  const wc = await new WorkingCopy(FID, "local").checkout();
  const b = wc.addBoard({ x: 400, y: 400, width: 200, height: 120, name: "A1 TX Board" });
  wc.addRect({ x: 420, y: 420, width: 80, height: 40, parentId: b, name: "A1 TX Rect", fills: [{ fillColor: "#33ff66" }] });
  wc.closeBoard();
  check(wc.pendingChanges().length >= 2, `[TX] SDK recorded pending changes (${wc.pendingChanges().length})`);

  const diskBefore = readPageEdns(dir);
  check(!diskBefore.includes("A1 TX Board"), `[TX] precondition: on-disk EDN has no "A1 TX Board"`);

  const body = wc.session.commitBody(JSON.stringify({ sessionId: randomUUID(), revn: wc.revn, vern: wc.vern }));
  const upd = await fetch(`${runtime.base}/api/rpc/command/update-file`, {
    method: "POST",
    headers: { "Content-Type": "application/transit+json", Accept: "application/json" },
    body,
  });
  const updText = await upd.text();
  check(upd.status === 200 && /258|~:revn/.test(updText),
    `[TX] update-file transport works (HTTP ${upd.status}, ${updText.slice(0, 40)})`);

  const gf = await getFileViaRuntime(runtime.base, FID);
  check(gf.transit.includes("A1 TX Board"),
    `[TX] edit visible in a direct runtime get-file after update-file`);

  const stagedStatus = await status(runtime.base);
  check(stagedStatus.dirty === true && stagedStatus.revn === 258,
    `[TX] commit STAGED only — status dirty, revn bumped (SAVE GAP: dirty=${stagedStatus.dirty}, revn=${stagedStatus.revn})`);
  check(!readPageEdns(dir).includes("A1 TX Board"), `[TX] disk still unchanged before save (proves the gap)`);

  const saved = await save(runtime.base);
  check(readPageEdns(dir).includes("A1 TX Board"),
    `[TX] POST /pencilpot/save persisted the edit to on-disk EDN (revn=${saved.revn})`);
  const cleanStatus = await status(runtime.base);
  check(cleanStatus.dirty === false, `[TX] status returns to clean after save (dirty=${cleanStatus.dirty})`);

} catch (e) {
  console.log("FAIL: harness error");
  console.error(e?.stack || String(e));
  check(false, `harness threw: ${e?.message || e}`);
} finally {
  try { if (client) await client.close(); } catch {}
  kill(runtime?.proc);
}

const ok = passed();
console.log(ok ? "\nALL CHECKS PASS" : "\nCHECKS FAILED");
process.exit(ok ? 0 : 1);
