# Pencilpot realtime — AI edits live in the open SPA (work WITH the AI)

Date: 2026-06-29. Branch: pencilpot. TDD, subagent-driven. Supersedes the realtime
section of `2026-06-29-pencilpot-render-fidelity-and-collab.md`.

## Goal
When the AI edits a design (MCP/SDK `commit` → `update-file`), the **already-open**
pencilpot SPA reflects the change LIVE — no reload, no losing UI state — so it feels
like the user is working *with* the AI. Native Penpot only; no injection.

## Why this is small (architecture already supports it)
- SPA has the canonical collab apply path: `app.main.data.workspace.notifications/handle-file-change`
  takes `{:file-id :changes :revn :vern}` and dispatches `dch/commit {:source :remote
  :redo-changes changes :save-undo? false}` → applies changes to live workspace state.
- Runtime already runs an SSE channel `GET /pencilpot/live` (`live.mjs`): events `status`
  (dirty indicator) and `reload` (external disk edit → reload dialog). The frontend
  consumer is `app.main.data.pencilpot/start-client!`.
- The collab WebSocket `/ws/notifications` is fully stubbed (no echo risk there).
- **Echo discriminator EXISTS**: in `rpc.mjs` update-file handler, `wantTransit` is true
  for SPA edits (`Accept: transit+json`) and false for AI/SDK/MCP edits (`Accept:
  application/json`). Broadcast ONLY on the JSON branch → the user's own SPA edits are
  never echoed back (they're already applied locally); only AI edits get pushed.

## Design (transport: reuse SSE; codec: transit)
The AI's `update-file` request body IS transit and already contains `:changes`, `:id`
(file-id), `:revn`. We forward it to SPA clients; the SPA decodes with its own transit
reader and feeds `handle-file-change`. No re-encoding, exact fidelity.

### Wave R1 — runtime broadcast (mjs only, NO rebuild)
1. `live.mjs`: add `broadcastChanges(transitBody, revn)`:
   `event: changes\ndata: ${JSON.stringify({ revn, body: transitBody })}\n\n` to every client.
   (transitBody is single-line JSON string; safe in SSE data.)
2. `rpc.mjs` update-file handler: capture the request `body`. In the **JSON branch only**
   (AI/MCP/SDK), call `broadcastChanges(body, revn)` AFTER `updateFile`. Transit branch
   (SPA) does nothing new. Export `broadcastChanges` from live.mjs; import in rpc.mjs.
3. TDD (pencilpot/test, node-only, NO browser): unit `live.test.mjs` — register a fake
   client, call `broadcastChanges('{"~:x":1}', 7)`, assert the client received a frame
   `event: changes` whose data JSON has `revn:7` and `body` round-trips. And: a transit
   update-file does NOT broadcast changes; a JSON update-file DOES (spy on clients).

### Wave R2 — frontend consumer (CLJS, needs frontend release rebuild)
1. `app.main.data.pencilpot`: require `[app.main.data.workspace.notifications :as dwn]`
   and the transit reader `[app.common.transit :as t]` (CONFIRMED — the SPA decodes rp
   responses with `t/decode-str`, repo.cljs:228). Add:
   ```
   (defn- on-changes [ev]
     (let [payload (js/JSON.parse (obj/get ev "data"))
           revn    (obj/get payload "revn")
           body    (obj/get payload "body")
           decoded (t/decode-str body)            ; -> {:id :revn :changes [...]} (cljs)
           file-id (:id decoded)
           changes (:changes decoded)]
       (when (and file-id (seq changes))
         (st/emit! (dwn/handle-file-change
                    {:type :file-change :file-id file-id
                     :changes (vec changes) :revn revn :vern 0})))))
   ```
   Register in `start-client!`: `(.addEventListener es "changes" on-changes)`.
   NOTE confirm `handle-file-change` schema keys (`:type` required — see schema:handle-file-change).
2. Guard: `handle-file-change` requires a workspace context (file open). on-changes only
   fires in filesystem mode where the workspace is mounted — safe. If decode/apply throws,
   wrap in try/catch so a bad frame can't kill the SSE client.

### Wave R3 — e2e + docs + push
1. Node SSE e2e `pencilpot/e2e/ai/realtime.mjs` (no browser): spawn runtime, open an
   EventSource/raw-http GET `/pencilpot/live`, do an SDK `wc.moveShape` + `commit()`
   (JSON accept), assert a `changes` SSE frame arrives whose decoded body carries the
   move change for that shape id. Proves the runtime→wire half end-to-end.
2. Playwright vf check (optional, may be flaky): open SPA, AI moves a shape via SDK,
   assert the shape's DOM transform updates without reload. Keep behind the vf harness.
3. Docs: arch-12 + SKILL "realtime" row; capabilities ledger. Push pencilpot + main.

## Risks / decisions
- **revn drift**: SPA applies AI changes with the runtime's revn (:source :remote). Local
  single-user+AI, runtime does no OCC — acceptable. On user Save the runtime ignores revn.
- **Decode ns**: must use the SAME transit reader the SPA uses for rp responses so #uuid,
  keywords, shape records decode identically. Worker MUST grep for the actual ns/fn.
- **Ordering**: SSE is ordered per connection; changes arrive after the status frame. Fine.
- **No new deps.** Runtime = mjs (no build). Frontend = CLJS (heavy release rebuild).

## Build
- R1: mjs only — no rebuild. Test via `cd pencilpot && node run-tests.mjs --unit` or node --test.
- R2: `cd frontend && SHADOW_SERVER_URL=http://localhost:3449 clojure -M:dev:shadow-cljs release main worker` (~minutes). SCSS unaffected.
- Always run node scripts through ctx_execute with a timeout.
