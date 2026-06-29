// Realtime live-sync proof (no browser): an AI/SDK commit must push a `changes`
// SSE frame to /pencilpot/live carrying the edit, so the open SPA can apply it
// live via handle-file-change. We open the SSE stream, do an SDK move+commit
// (JSON accept = the AI path), and assert the frame arrives with our shape id.
//
// SKIP (exit 0) if the canonical design is absent. Run: node pencilpot/e2e/ai/realtime.mjs
import { FID, designPresent, copyDesign, spawnRuntime, loadWorkingCopy, kill, makeChecks } from "./_boot.mjs";
import http from "node:http";

if (!designPresent()) { console.log("SKIP: canonical design absent — realtime proof"); process.exit(0); }

const { check, passed } = makeChecks();
let srv, sseReq;
const frames = [];
try {
  const dir = copyDesign("ai-realtime");
  const r = await spawnRuntime(dir);
  srv = r.proc;

  // 1) Open the SSE live channel and collect `changes` frames.
  const base = new URL(r.base);
  await new Promise((resolve) => {
    sseReq = http.get({ hostname: base.hostname, port: base.port, path: "/pencilpot/live",
                        headers: { accept: "text/event-stream" } }, (res) => {
      let buf = "";
      res.setEncoding("utf8");
      res.on("data", (c) => {
        buf += c;
        let i;
        while ((i = buf.indexOf("\n\n")) !== -1) {
          const raw = buf.slice(0, i); buf = buf.slice(i + 2);
          const ev = (raw.match(/^event: (.*)$/m) || [])[1];
          const data = (raw.match(/^data: (.*)$/m) || [])[1];
          if (ev === "changes") frames.push(data);
        }
      });
      resolve();
    });
    sseReq.on("error", resolve);
  });
  await new Promise((r) => setTimeout(r, 300)); // let the stream establish

  // 2) AI edit: move an existing shape, then commit (JSON accept => AI path).
  const WorkingCopy = await loadWorkingCopy(r.base);
  const wc = await new WorkingCopy(FID, "local").checkout();
  const objs = JSON.parse(wc.session.objects());
  const target = Object.values(objs).find((o) => o.type === "rect" || o.type === "circle");
  check(!!target, "found a shape to move");
  wc.moveShape(target.id, { x: (target.x ?? 0) + 25, y: (target.y ?? 0) + 25 });
  await wc.commit();

  // 3) Wait for the SSE frame to land.
  for (let i = 0; i < 40 && frames.length === 0; i++) await new Promise((r) => setTimeout(r, 50));
  check(frames.length >= 1, `received a 'changes' SSE frame (${frames.length})`);
  if (frames.length) {
    const payload = JSON.parse(frames[0]);
    check(typeof payload.revn === "number" && typeof payload.body === "string", "frame has revn + transit body");
    check(payload.body.includes(target.id), "frame body references the moved shape id");
    check(payload.body.includes("mod-obj") || payload.body.includes(":changes") || payload.body.includes("~:changes"),
          "frame body carries the change ops");
  }
  console.log(passed() ? "\nALL CHECKS PASS" : "\nSOME CHECKS FAILED");
} finally { try { sseReq?.destroy(); } catch {} kill(srv); }
process.exit(passed() ? 0 : 1);
