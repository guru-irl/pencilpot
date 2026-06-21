# Pencilpot media/image flow — investigation + fix plan

Date: 2026-06-21
Branch: `pencilpot`
Status: APPROVED — execute via subagent-driven-development (RED tests first)

## Bottom line

Images do not render and "replace image" fails because pencilpot's media flow was
gutted when the design UI was unlinked from the SaaS backend. Four layers are broken:

1. **Import discards the file-media-id → storage-id mapping.** A penpot image fill
   references a **file-media-object id** (`:fill-image {:id 8bff608e-… }`). The binary
   lives under a different **storage-object id** (`5839e54f-…`). The `.penpot` descriptor
   (`files/<fid>/media/<file-media-id>.json`) carries the join + metadata:
   ```json
   { "id":"8bff608e-…", "mediaId":"5839e54f-…", "thumbnailId":"bd3054f2-…",
     "mtype":"image/jpeg", "name":"Currents", "width":500, "height":500, "isLocal":true }
   ```
   `import-binfile.mjs` parses this descriptor but **throws away** the `id → mediaId`
   mapping, then `bin/pencilpot.mjs:698` writes binaries named by **storage-id**
   (`5839e54f.jpg`). So `8bff608e.jpg` — the name the fill resolves to — never exists on
   disk. The on-disk media is unreferenced by any page.

2. **No runtime route serves media.** The canvas GETs
   `/assets/by-file-media-id/<file-media-id>` (`config.cljs:256` `resolve-file-media`).
   The runtime's only asset route is `/assets/by-id/<id>` (fonts only) → image 404s.

3. **`upload-file-media-object` is a no-op stub** returning `200 {}` (the
   `[pencilpot] unhandled RPC …` warning). On "replace image", `upload-fill-image`
   (`media.cljs:294`) ALWAYS re-uploads and depends on the response; `{}` →
   `{:id nil :width nil …}` → the image vanishes. This RPC is **load-bearing**, not
   unused — it must be IMPLEMENTED locally (write the blob to `<design>/media/`), which
   also removes the warning.

4. **`store.mjs` ignores media** — `readDesign` returns `media:[]`, `writeDesign` never
   persists binaries — so media is outside the working-copy / save model.

## Decisions (confirmed with user)

- **Implement** `upload-file-media-object` (write file to `/media`, return a real
  media-object), do NOT delete it. Removing it would break add/replace image.
- **Option A storage model:** media is stored on disk **keyed by file-media-id**:
  `<design>/media/<file-media-id>.<ext>` + a sidecar `<file-media-id>.json`
  (`{width,height,mtype,name}`). Optional thumbnail `<file-media-id>.thumbnail.<ext>`.
  Makes the runtime route a direct filesystem lookup (mirrors the font route) and makes
  upload a direct write. No separate index file, no storage-id space on disk.
- **No new npm deps** — hand-roll the multipart parser and the image-dimension probe with
  Node built-ins (target jpeg/png at minimum; gif/webp best-effort).
- Keep the manual-save model: media binaries are written to disk immediately on upload
  (content-addressed-ish; an orphan after Discard is harmless). The fill EDN referencing
  the new id persists on the next Save like any other edit.

## Reference facts (verified)

- `config.cljs:252-264`: `resolve-media` → `/assets/by-id/<id>`;
  `resolve-file-media` → `/assets/by-file-media-id/<id>` (+ `/<id>/thumbnail`).
- `api.cljs:702 fetch-image` → `resolve-file-media` → `js/fetch` → `createImageBitmap`
  → WebGL texture (the live WASM/SVG canvas path).
- `media.cljs:62 image-uploaded` / `colorpicker.cljs:166 on-fill-image-success` destructure
  `{:keys [name width height id mtype]}` from the upload response → build
  `{:fill-image {:id :width :height :mtype :keep-aspect-ratio true} :fill-opacity 1}`.
- `repo.cljs:279`: `:upload-file-media-object` is a **multipart** POST
  (`form-data {:file-id :name :is-local :content <blob>}`) to
  `/api/main/methods/upload-file-media-object`. Header `x-external-session-id`.
- Other media RPCs the SPA may call: `:create-file-media-object-from-url`
  (`{:name :file-id :url :is-local}`), `:clone-file-media-object`
  (`{:is-local :file-id :id}`), `:assemble-file-media-object` (chunked — large files),
  `:get-file-object-thumbnails` (`{:file-id [...]}`).
- `handleRpc` (`rpc.mjs:253`) dispatches by `cmd(req.url)`; unknown methods hit the
  benign-200 + `console.warn("[pencilpot] unhandled RPC …")` path (rpc.mjs:~375).
- `readBody(req)` (`proxy.mjs`) returns a Buffer of the full request body.
- `server.mjs:104` font route is the template for the new media route (checked BEFORE
  `serveStatic`). `designDir` / `CONFIG.design` is the media root's parent.
- Original `.penpot`: `/home/guru/Downloads/Default Design System.penpot` (2 image media
  descriptors: `8bff608e-…-c3bf` and `8bff608e-…-d48f`).
- On-disk canonical design: `/mnt/data/src/DefaultLauncher/design/` — pages reference
  `8bff608e-…` fills; `media/` holds mis-keyed storage-id jpgs (`26c71c32`,`5839e54f`,
  `835c6f4a`,`bd3054f2`). Font-mapping edits did NOT touch media binaries or fill ids, so
  dropping correctly-keyed `8bff608e*.jpg` into `media/` fixes rendering without
  re-importing (preserves the committed GSF mapping).
- Tests: pencilpot unit via `cd pencilpot && node run-tests.mjs --unit` (node:test).
  e2e boot reference: `pencilpot/e2e/vf/vf-stress.mjs` (spawn `runtime/server.mjs`,
  `PENCILPOT_PROJECT`/`PENCILPOT_PORT`, chromium swiftshader).

---

## Task 1 — import: media keyed by file-media-id (+ metadata)  [RED→GREEN]

**Files:** `pencilpot/runtime/import-binfile.mjs`, `pencilpot/bin/pencilpot.mjs`,
new test `pencilpot/test/import-media.test.mjs`.

**Change `import-binfile.mjs`:**
- In `groupEntries`, while parsing each `PAT_MEDIA` descriptor, RETAIN the full record:
  `{ fileMediaId: mid, mediaId: desc.mediaId, thumbnailId: desc.thumbnailId,
     width: desc.width, height: desc.height, mtype: desc.mtype, name: desc.name }`.
- After collecting binaries (`objects/<storage-id>.<ext>`), build
  `storageId → {srcPath, ext}`.
- Emit `mediaFiles` keyed by **file-media-id**: for each descriptor, look up the binary
  for its `mediaId` and push
  `{ id: fileMediaId, srcPath, ext, width, height, mtype, name,
     thumbnailSrcPath?, thumbnailExt? }` (thumbnail from `thumbnailId`'s binary if present).
- Keep the existing "primary media not found in zip" warning for descriptors whose
  `mediaId` binary is genuinely absent (skip those).
- If a project has NO descriptors (raw binaries only), preserve the current fallback
  (emit binaries by their own id) so non-descriptor imports don't regress.

**Change `bin/pencilpot.mjs` (~694-705):** for each mediaFile write
`<mediaDir>/<id>.<ext>` (copy from `srcPath`) AND a sidecar
`<mediaDir>/<id>.json` = `JSON.stringify({width,height,mtype,name})`. If
`thumbnailSrcPath`, also write `<id>.thumbnail.<ext>`.

**Test (`import-media.test.mjs`):** import the original `.penpot`
(skip the test gracefully if the file is absent — `t.skip`), assert:
- a `mediaFiles` entry exists with `id === "8bff608e-…-d48f"` (a fill-referenced id),
- its `width/height/mtype/name` match the descriptor (`500/500/"image/jpeg"/"Currents"`),
- NO `mediaFiles` entry is keyed by a bare storage-id (`5839e54f` etc.).

**Acceptance:** new test fails against current code, passes after the change; existing
unit suite stays green.

## Task 2 — runtime: serve `/assets/by-file-media-id/<id>` (+ `/thumbnail`)  [RED→GREEN]

**Files:** `pencilpot/runtime/server.mjs`, new helper (inline or `runtime/media.mjs`),
new test `pencilpot/test/media-route.test.mjs`.

- Add a route BEFORE `serveStatic` (mirror the font route at server.mjs:104):
  `GET /assets/by-file-media-id/<id>` → resolve `<CONFIG.design>/media/<id>.<ext>`
  (glob the extension, or read the sidecar's `mtype` to pick content-type). Stream bytes
  with `content-type` from the sidecar `mtype` (fallback: extension map / octet-stream)
  and an immutable cache header.
  `GET /assets/by-file-media-id/<id>/thumbnail` → serve `<id>.thumbnail.<ext>` if present,
  else FALL BACK to the full `<id>.<ext>` (penpot tolerates this).
- Unknown id → 404 (do not fall through to the SPA index).

**Test:** copy a tiny fixture design dir (one `media/<id>.png` + `<id>.json`) to /tmp,
boot `server.mjs`, `fetch` the route, assert `200`, correct `content-type`, body bytes
equal the file; assert thumbnail falls back to full; assert unknown id → 404.

**Acceptance:** new test fails before the route exists, passes after.

## Task 3 — runtime: implement `upload-file-media-object` (+ from-url, clone)  [RED→GREEN]

**Files:** `pencilpot/runtime/rpc.mjs`, new `pencilpot/runtime/multipart.mjs`
(hand-rolled parser) + `pencilpot/runtime/image-size.mjs` (hand-rolled probe),
new test `pencilpot/test/upload-media.test.mjs`.

- `multipart.mjs`: parse `multipart/form-data` from the raw Buffer + boundary
  (from `content-type`). Return `{ fields: {name,file-id,is-local,...},
  file: {filename, mtype, bytes:Buffer} }`. Scope: single file part named `content` +
  simple text fields. (Penpot uploads one file per request.)
- `image-size.mjs`: probe `{width,height,mtype}` from a Buffer — JPEG (SOF0..SOF15
  markers), PNG (IHDR), GIF (logical screen), WebP (VP8/VP8L/VP8X). Throw/return null on
  unknown; caller falls back to `0×0` + the multipart part's mtype.
- In `handleRpc`, add a branch for `command === "upload-file-media-object"`:
  read the body Buffer, parse multipart, probe dims, generate a new uuid `id`, pick `ext`
  from mtype, write `<design>/media/<id>.<ext>` + `<id>.json` sidecar, then respond with a
  transit/json media-object map honoring the request's Accept header:
  `{:id :name :width :height :mtype :is-local :created-at :modified-at}`
  (transit-encode when `accept` includes transit — reuse the existing transit map encoder
  used by other handlers). The `name` comes from the multipart `name` field (fallback to
  the filename).
- `create-file-media-object-from-url`: fetch the `url`, then same write+respond.
- `clone-file-media-object`: copy `<src-id>.<ext>` → `<new-id>.<ext>` (+ sidecar) and
  return the new media-object.
- These branches MUST be added BEFORE the unhandled-RPC warning path so the warning
  stops firing for them.

**Test:** boot `server.mjs` against a temp design; POST a real small PNG as multipart to
`/api/main/methods/upload-file-media-object`; assert response is a NON-empty media-object
with `id` (uuid), `width>0`, `height>0`, `mtype==="image/png"`; assert
`<design>/media/<id>.png` now exists; then `GET /assets/by-file-media-id/<id>` returns 200
+ the bytes (exercises Task 2 too). Add a unit test for `image-size` (known PNG/JPEG byte
fixtures) and `multipart` (a hand-built multipart body).

**Acceptance:** new tests fail before implementation, pass after; the
`[pencilpot] unhandled RPC upload-file-media-object` warning no longer appears for an
upload (assert via captured server stderr or absence of the benign-200 transit `["^ "]`).

## Task 4 — store/worktree: media in the model  [RED→GREEN]

**Files:** `pencilpot/store/store.mjs`, `pencilpot/runtime/worktree.mjs` (if needed),
extend `pencilpot/test/store.test.mjs`.

- `readDesign`: populate `media` with the list of media ids present in `<dir>/media`
  (the `<id>` of each `<id>.<ext>` that has a sidecar, excluding `.thumbnail.` and `.json`).
- `writeDesign`: must NOT delete media binaries/sidecars (the `prune` calls already only
  touch `*.edn` under pages/components — confirm media is untouched; add an explicit test).
- Confirm `worktree` save/discard never drops `<dir>/media` contents.

**Test:** `writeDesign` over a dir that already has `media/<id>.png` + sidecar leaves them
intact; `readDesign().media` lists the id.

**Acceptance:** new assertions pass; no existing test regresses.

## Task 5 — repair DefaultLauncher on-disk media (one-time)

**Not a code change — a data repair**, gated behind Tasks 1-2 being correct.

- Run the FIXED import (Task 1) on `/home/guru/Downloads/Default Design System.penpot`
  into a throwaway temp project; collect the produced `media/8bff608e-…-c3bf.<ext>`,
  `8bff608e-…-d48f.<ext>` (+ `.json` sidecars, + thumbnails).
- Copy those file-media-id-keyed files into
  `/mnt/data/src/DefaultLauncher/design/media/`, and REMOVE the mis-keyed storage-id
  files (`26c71c32*`,`5839e54f*`,`835c6f4a*`,`bd3054f2*`) that no page references.
- Verify: every `:fill-image :id` in `design/pages/*.edn` has a matching
  `media/<id>.<ext>` on disk.
- Commit the repaired design under the DefaultLauncher repo (separate from the penpot
  source commits).

**Acceptance:** zero dangling fill ids; the canonical design's media dir is keyed by
file-media-id with sidecars.

## Task 6 — e2e regression: now-playing renders + replace round-trips

**Files:** new `pencilpot/e2e/vf/verify-media.mjs`.

- Boot `runtime/server.mjs` against a copy of the repaired DefaultLauncher design.
- Open the now-playing page; capture network: assert the
  `/assets/by-file-media-id/<id>` request(s) return **200** (not 404) and the canvas
  paints (image present — check via `<img>`/canvas texture count or a non-blank region).
- Programmatic replace: POST a new image to `upload-file-media-object`, assert non-empty
  media-object; assert a follow-up `GET /assets/by-file-media-id/<new-id>` → 200.
- Tear down server + browser in `finally`.

**Acceptance:** harness exits 0; asserts image network 200 + non-empty upload + new-id
served. Fails (404 / empty) against pre-fix runtime.

---

## Execution notes

- One fresh-context implementer per task (async), single writer, commit per task; then a
  fresh-context reviewer (spec + quality) before advancing. Broad whole-branch review at
  the end. OMIT `model` on dispatch.
- TDD: each task writes its failing test FIRST, then implements to green.
- Risk areas to watch in review: hand-rolled multipart boundary edge-cases (trailing
  CRLF, quoted filenames), image-size marker walking (JPEG segment lengths), content-type
  for thumbnail fallback, and NOT regressing the non-descriptor import fallback.
