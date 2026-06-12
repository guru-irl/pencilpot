# Architecture Note: Phase 0 Viability Spike

**Status:** Complete (GO decision).
**Branch:** `pencilpot`
**Location:** `pencilpot/spike/`
**Updated:** Phase 0 complete; findings feed Phase 1 (sub-projects L + S).

---

## The Chokepoint Insight

Penpot's entire backend dependency funnels through one chokepoint: `frontend/src/app/main/repo.cljs`'s `cmd!` function (HTTP RPC, transit-encoded responses). The stock designer SPA has no other backend surface — no direct DB access, no separate REST calls, no gRPC. If a local server speaks the same RPC contract for the ~20 commands the workspace actually uses, the designer runs unmodified at the data layer.

This is the keystone insight from the umbrella spec (§3). Phase 0 confirmed it empirically.

---

## The Proxy → Record → Replay → Serve Progression

The spike built the local server in four progressive stages, each provable in isolation:

```
Stage A: proxy
  Browser ──► localhost:7777 ──► penpot-hl:9101 (all traffic forwarded)
                    └─ recorder.mjs captures every /api/* exchange to recordings/

Stage B: replay
  Browser ──► localhost:7777 ──► fixtures.mjs (no penpot-hl contact for /api/*)
                    │            (assets still proxied)
                    └─ SPA boots into canvas from captured bytes alone

Stage C: serve (get-file from disk)
  Browser ──► localhost:7777 ──► get-file: headless-core + store/<id>.transit
                    │            everything else: fixtures
                    └─ Canvas renders a real file from disk, no upstream API

Stage D: serve (update-file round-trip)
  Browser ──► localhost:7777 ──► update-file: apply changes → persist → revn++
                    │            get-file: serves mutated file on next load
                    └─ Edit in canvas → disk → reload proves the write path
```

Each stage is an automated Playwright spec (`boot.spec.mjs`, `serve.spec.mjs`).

---

## System Diagram

```
  penpot-hl:9101
  (compiled assets only
   in stage B-D)
       │
       │ GET /js/* /css/* /fonts/*
       ▼
  localhost:7777  ◄───── Browser (stock Penpot SPA)
  ┌─────────────────────────────────────────────────┐
  │  server.mjs  (PENCILPOT_MODE=serve)             │
  │                                                 │
  │  /api/rpc/command/get-file      ─► api.mjs      │
  │                                      │          │
  │  /api/rpc/command/update-file   ─► api.mjs      │
  │                                      │          │
  │  /api/rpc/command/*  (others)   ─► fixtures.mjs │
  │                                      │          │
  │  /ws/notifications             stub (no-op)     │
  │                                      │          │
  │  static assets                  proxy.mjs       │
  └──────────────────────────────────────┼──────────┘
                                         │
                    ┌────────────────────┴──────────────────┐
                    │                                       │
              headless-core                           store/
              penpot.js                        <id>.transit
              (session.cljs)                  <id>.meta.json
              createSession()                       │
              applyTransitUpdate()       readFile() / writeFile()
              getFileResponse()
```

No JVM. No Postgres. No auth. No collab server.

---

## Key Design Decisions

### Single-origin + public-uri rewrite

The stock SPA bakes `penpotPublicURI` into `/js/config.js` pointing at the real backend. `proxy.mjs` intercepts that file and appends:

```js
globalThis.penpotPublicURI = location.origin;
globalThis.penpotFlags = "";
```

This forces the SPA to send all RPC calls to our origin (`:7777`) with zero changes to the frontend source. This trick carries into Phase 1; Phase 2 (sub-project F) will replace it with a proper build-time repoint.

### WebSocket stub

The SPA opens `/ws/notifications` immediately on workspace load for real-time collaboration presence. A silent no-op `WebSocketServer` (from the `ws` package, `attachWsStub` in `proxy.mjs`) accepts the connection and ignores all client messages. The SPA proceeds into the canvas without error. Real-time collab is a non-goal (spec §2); this stub is permanent in Pencilpot.

### `getFileResponse()` — fully-inline get-file emission

`session.cljs` gained a new exported method `getFileResponse()` that serialises the current in-memory file model back to transit-encoded bytes in the exact shape the SPA's `get-file` handler expects — with all `:data` (pages, pages-index, options, tokens-lib, components) inline, no fragment pointers.

v2.15.4 does not use `get-file-fragment` at all; one inline blob is the entire file. `getFileResponse()` exploits this: it round-trips cleanly (hydrate from transit → apply changes → re-emit transit) and gives the SPA a valid response it renders without modification.

This design carries directly into Phase 1 (sub-project L) for the `get-file` handler.

### On-disk store (spike format)

The spike stores each file as two files:

- `store/<id>.transit` — the full transit-encoded file data blob (the `:data` value from the get-file envelope), produced by `getFileResponse()`.
- `store/<id>.meta.json` — file metadata: `id`, `name`, `revn`, `vern`, `features`, etc.

This is intentionally a minimal spike format — a single opaque blob, not diff-friendly. Phase 1 (sub-project S) replaces it with the exploded git-native directory format (per-page JSON, manifest, `media/`). The spike store is the correct place to prototype the hydrate/persist cycle before committing to the exploded layout.

### Transit as the canonical change path

Two change-application paths exist in the spike:

- `applyTransitUpdate(body)` — decodes the SPA's transit-encoded `update-file` body, extracts `:changes`, calls `process-changes`. **This is canonical** and is what the router uses for live SPA traffic.
- `applyChanges(jsonChanges)` — accepts a JSON change array. **Test-only convenience**; cannot losslessly represent all Penpot change types (keyword-valued attrs, `:add-obj :obj` shapes). See SPIKE-REPORT.md §Deferred item L1.

Phase 1 must use the transit path for all production traffic.

---

## Fixtures: special-case handling

`fixtures.mjs` applies two transformations on load (beyond the straight verbatim-replay default):

1. **Anonymous `get-profile` filtered out.** A capture where the profile id is the all-zeros UUID (anonymous/unauthenticated) is skipped; the SPA bounces to `/auth/login` on that id. The fixture loader keeps only authenticated captures.
2. **`get-enabled-flags` 401 → 200 `[]`.** If the recording captured a 401 for this command (e.g. the recorder ran before login completed), the fixture is promoted to a 200 with an empty flag set rather than replaying the 401, which would cause the SPA to bounce.

Both are codified in `fixtures.mjs`'s `load()` function and need no manual intervention.

---

## Verified Results Summary

| Checkpoint | Automated? | Result |
|---|---|---|
| SPA boots from fixtures (no upstream API) | Playwright | PASS |
| Canvas renders with get-file from disk | Playwright | PASS (deterministic, 2 runs) |
| Canvas edit → update-file → disk → reload | Playwright | PASS |
| Engine round-trip (getFileResponse) | node:test | PASS |
| Mutate + disk persist (applyUpdate) | node:test | PASS |
| headless-core engine suite (17 tests) | node:test | PASS |

Decision: **GO**. See `pencilpot/spike/SPIKE-REPORT.md` for the full findings, RPC contract table, and deferred items for Phase 1.
