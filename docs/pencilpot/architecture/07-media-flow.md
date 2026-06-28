# Architecture Note: Phase 4 — Media / Image Flow

**Status:** Complete.
**Branch:** `pencilpot`
**Locations:** `pencilpot/runtime/media.mjs`, `pencilpot/runtime/rpc.mjs`,
`pencilpot/runtime/multipart.mjs`, `pencilpot/runtime/image-size.mjs`,
`pencilpot/runtime/server.mjs`, `pencilpot/runtime/import-binfile.mjs`,
`pencilpot/bin/pencilpot.mjs`, `pencilpot/store/store.mjs`,
`pencilpot/runtime/worktree.mjs`.
**Updated:** Phase 4 media flow complete (import re-keying, runtime serve route,
local upload/from-url/clone RPCs, store-model integration). Commit chain
`0ca3a22408` → `61676f812c` → `1d23c6f2d9` → `f2cfaf7c5c` → `90399b78e3` →
`eb76c31feb`. Plan: [`2026-06-21-pencilpot-media-flow.md`](../superpowers/plans/2026-06-21-pencilpot-media-flow.md).

---

## Overview

Image fills/shapes in a Penpot design reference media by id. When pencilpot
unlinked the SaaS backend, that flow broke at four layers: import discarded the
id mapping, no runtime route served the bytes, the upload RPC was a `200 {}`
stub, and the on-disk store ignored media entirely. This note documents the
pencilpot media model that fixes all four — **a filesystem-native, no-backend,
file-media-id-keyed `media/` directory** that the canvas reads directly and the
upload RPCs write directly.

The guiding decision (plan "Option A"): **store media on disk keyed by the
file-media-object id** — the id a shape actually references — so both the serve
route and the upload write are direct filesystem operations, mirroring the font
asset route.

## The two id spaces (why import had to re-key)

A Penpot `.penpot` archive separates *what a shape references* from *where the
bytes live*:

- **file-media-object id** — the id baked into a shape: `:fill-image {:id 8bff608e-… }`
  (an `:image`-type shape uses `:metadata {:id …}` with the same inner keys).
- **storage-object id** — the id the binary blob is named with inside the archive
  (`objects/<storage-id>.<ext>`), plus an optional thumbnail storage-object.

The archive's per-file media descriptor (`files/<fid>/media/<file-media-id>.json`)
is the **join** between them and carries the metadata:

```json
{ "id":"8bff608e-…", "mediaId":"5839e54f-…", "thumbnailId":"bd3054f2-…",
  "mtype":"image/jpeg", "name":"Currents", "width":500, "height":500 }
```

The canvas resolves images **by file-media-id** (`GET /assets/by-file-media-id/<id>`,
frontend `config.cljs` `resolve-file-media`). So on disk pencilpot keys media by
the **file-media-id**, not the storage-id the binary happens to be named with.
Pre-fix import threw the join away and wrote binaries under their storage-id, so
`8bff608e.jpg` — the name a fill resolves to — never existed on disk.

## The 4-layer on-disk contract

Media lives under the open design directory, keyed by file-media-id:

```
<design>/media/<file-media-id>.<ext>            full image binary           (required)
<design>/media/<file-media-id>.json             sidecar { width,height,mtype,name }  (required)
<design>/media/<file-media-id>.thumbnail.<ext>  thumbnail binary            (optional)
```

- The **binary** is what the canvas paints. `<ext>` derives from the mtype
  (`media.mjs` `EXT_CONTENT_TYPES`, `rpc.mjs` `MTYPE_EXT`).
- The **sidecar** (`<id>.json`) carries `{width,height,mtype,name}` — used to
  label the served bytes and to answer the media-object responses. It is also
  the marker that a binary is a *primary, store-managed* image (see store model).
- The **thumbnail** is optional; the serve route falls back to the full image
  when it is absent.

There is **no separate index file and no storage-id space on disk** — the
directory listing *is* the registry.

## Data flow

```
 import (.penpot)                  upload (runtime, browser)
 ─────────────                     ────────────────────────
 files/<fid>/media/<fmid>.json     POST /api/.../upload-file-media-object
   = { id, mediaId, thumbId, … }     (multipart: content=<blob>, name, file-id, is-local)
 objects/<storageId>.<ext> ─┐         │
                            │         ▼  parseMultipart → imageSize(probe) → randomUUID()
 join by mediaId ───────────┘         │
   ▼                                  ▼
 <design>/media/<fmid>.<ext>  ◄──────  <design>/media/<new-id>.<ext>
 <design>/media/<fmid>.json   ◄──────  <design>/media/<new-id>.json
   ▲                                  │ response: media-object map (transit ~u<id> | json)
   │  GET /assets/by-file-media-id/<id>(/thumbnail)   ▲
   └──────────  canvas <image> fill / WebGL texture ──┘
```

## Import: re-keying media by file-media-id

`pencilpot/runtime/import-binfile.mjs` (consumed by the `pencilpot import` CLI in
`bin/pencilpot.mjs`).

1. **Retain the descriptor** (`groupEntries`, `PAT_MEDIA` branch, `import-binfile.mjs:195-223`):
   each `files/<fid>/media/<mid>.json` is parsed and the full join record is kept
   in `fileSlot._descriptors`: `{ fileMediaId: mid, mediaId, thumbnailId, width,
   height, mtype, name }` (it also records `_primaryIds`/`_thumbnailIds`).
2. **Index binaries by storage-id**, skipping the JSON twin (`import-binfile.mjs:314-330`):
   each `objects/<id>.<ext>` is mapped `storageId → {srcPath, ext}`. A `.penpot`
   stores every storage object as a **PAIR** — the image binary *and* a metadata
   twin `objects/<id>.json` sharing the same id stem; without the `if (ext ===
   "json") continue` guard the twin clobbers the real image and the join resolves
   to JSON text instead of pixels (the bug fixed by `90399b78e3`).
3. **Join** (`import-binfile.mjs:335-360`): for each descriptor, look up its
   `mediaId` binary and emit a media entry **keyed by `fileMediaId`**:
   `{ id: fileMediaId, srcPath, ext, width, height, mtype, name }`, attaching
   `thumbnailSrcPath/thumbnailExt` when the `thumbnailId` binary is present. A
   descriptor whose primary binary is genuinely absent is warned and skipped.
4. **Non-descriptor fallback** (`import-binfile.mjs:364`): if the archive has *no*
   media descriptors at all, fall back to the raw binaries keyed by their own id
   (`effectiveMedia = descriptors.length > 0 ? resolvedMedia : mediaFiles`) so
   plain-binary imports do not regress.
5. **Stable staging** (`import-binfile.mjs:368-397`): resolved media is copied to a
   throwaway temp dir (`pencilpot-media-…`) before the extraction tmp is cleaned
   up, and returned with a `cleanup()` the caller must invoke.

The CLI then **writes the on-disk layout** (`bin/pencilpot.mjs:694-719`): for each
`mediaFile` it copies `srcPath → <design>/media/<id>.<ext>`, writes the sidecar
`<id>.json = {width,height,mtype,name}`, optionally copies the thumbnail to
`<id>.thumbnail.<ext>`, then calls `cleanup()`. (Commit `0ca3a22408`.)

## Runtime: serving media — `GET /assets/by-file-media-id/<id>`

`pencilpot/runtime/server.mjs:125-148`, resolver `pencilpot/runtime/media.mjs`.
(Commit `61676f812c`.)

- The route is checked **before `serveStatic`** (right after the font
  `/assets/by-id/` route it mirrors) so an unknown id returns **404** instead of
  falling through to the SPA `index.html`.
- It strips an optional trailing `/thumbnail`, then calls
  `resolveMediaAsset(CONFIG.design, id, {thumbnail})`.
- On a hit it streams the file with the resolved `content-type` and an immutable
  cache header (`cache-control: public, max-age=31536000, immutable`); on a miss
  it `404`s with `"media not found"`.

`resolveMediaAsset(designDir, id, {thumbnail})` (`media.mjs:62-90`):

- **Path-safety:** `isUnsafeId` rejects ids containing `/`, `\`, `..`, or NUL, and
  a null `designDir` (so the id can never escape `<design>/media`).
- It `readdirSync`s `<design>/media` and matches by prefix: `isFull` =
  `<id>.<ext>` excluding the `.thumbnail.` variant and the `.json` sidecar;
  `isThumb` = `<id>.thumbnail.<ext>`.
- **Thumbnail fallback:** a thumbnail request serves `<id>.thumbnail.<ext>` when
  present, otherwise falls back to the full `<id>.<ext>` (Penpot tolerates a
  full-size thumbnail).
- **Content-type** is taken from the *served file's* extension first (so a
  thumbnail in a different format is still labelled correctly), then the sidecar
  `mtype`, then `application/octet-stream`.

## Runtime: the media RPCs (local writes)

`pencilpot/runtime/rpc.mjs` `handleRpc`, before the unhandled-RPC warning path.
(Commit `1d23c6f2d9`.) All three honour the request's `Accept` header — returning
a transit map (`encodeTransitMediaObject`, `rpc.mjs:378-394`) when transit is
requested, else JSON — and the transit `:id` is encoded as a transit uuid
(`~u<id>`) so the SPA bakes a real UUID into the shape's `:fill-image :id`.

| RPC | `rpc.mjs` | Behaviour |
|---|---|---|
| `upload-file-media-object` | `579-590` | Parse the multipart body (`parseMultipart`), require a file part, `writeMediaObject(...)`. The load-bearing add/replace-image path — replacing pre-fix `200 {}`. |
| `create-file-media-object-from-url` | `592-607` | `transitGet` the `url`/`name`, `fetch(url)` (error on non-OK), `writeMediaObject` the fetched bytes. |
| `clone-file-media-object` | `609-617` | `transitGet` + `unTransitUuid` the source `id`, `cloneMediaObject(...)`. |

**`writeMediaObject`** (`rpc.mjs:402-424`): probe dimensions with `imageSize(bytes)`
(falling back to the multipart-declared mtype and `0×0` when the probe can't read
the format), mint `randomUUID()`, pick `ext` from the final mtype, write
`<design>/media/<id>.<ext>` + the `<id>.json` sidecar, and return the media-object
map `{ id, name, width, height, mtype, is-local, created-at, modified-at }` — the
exact shape the SPA destructures (`{:keys [id name width height mtype]}`).

**`cloneMediaObject`** (`rpc.mjs:427-450`): `resolveMediaAsset` the source, copy
`<src>.<ext> → <new-id>.<ext>`, merge+rewrite the sidecar under the new id, and
copy the thumbnail when present.

### Hand-rolled helpers (no new npm deps)

- **`multipart.mjs`** `parseMultipart(buffer, contentTypeHeader)` — a scoped
  `multipart/form-data` parser (Node built-ins only): extract the boundary, index
  every delimiter, split each part on the first blank line, and return
  `{ fields:{name,file-id,is-local,…}, file:{filename, mtype, bytes} | null }`.
  Scoped to penpot's single-file-per-request uploads (one `content` file part +
  simple text fields), not a general RFC-7578 implementation.
- **`image-size.mjs`** `imageSize(buffer) → {width,height,mtype} | null` — probes
  PNG (IHDR), JPEG (walk to the first SOF marker), GIF (logical screen), and WebP
  (VP8/VP8L/VP8X); returns `null` on anything else so the caller falls back to the
  multipart-declared mtype.

## Media in the store model

`pencilpot/store/store.mjs` (commit `f2cfaf7c5c`). Media is part of the
`readDesign`/`writeDesign` store parts (`{manifest, pages, components, media}`),
but disk-managed out-of-band rather than rewritten on save:

- **`readDesign().media`** (`readMediaIds`, `store.mjs:39-57`) lists the
  **sidecar-backed primary ids** in `<dir>/media`: the `<id>` of each `<id>.<ext>`
  that has a matching `<id>.json`, excluding the `.json` sidecars and
  `.thumbnail.` variants, and skipping stray binaries with no sidecar. Tolerant of
  a missing/empty media dir.
- **`writeDesign`** (`store.mjs:6-18`) creates `media/` but **never writes or
  prunes** it — `prune()` is scoped to `*.edn` under `pages/`/`components/`. A
  Save therefore never deletes or rewrites media binaries (they are written
  directly by the upload RPC / import). An orphaned binary left by a Discard is
  harmless.

## Media is EXCLUDED from the dirty signature

`pencilpot/runtime/worktree.mjs` `computeSig` (`worktree.mjs:40-58`) — the
content-only signature that drives the manual-save dirty flag — folds only
`manifest`/`pages`/`components` and **intentionally omits `media`**. Per the
in-code rationale: the saved baseline derives media from disk filenames
(`readDesign`), while a staged copy derives it from the file's `:media` registry
(`serializeStore`), which is **empty** for these designs — folding media here
would couple two divergent sources and spuriously mark every design with on-disk
media dirty on first open. Media binaries are durable on disk the moment they are
uploaded; the *fill EDN* that references a new id persists on the next Save like
any other content edit. (See [`08-working-copy-dirty-persistence.md`](08-working-copy-dirty-persistence.md).)

## Verification

`pencilpot/e2e/vf/verify-media.mjs` (commit `eb76c31feb`) boots
`runtime/server.mjs` (STABLE SVG renderer) against a throwaway copy of the
DefaultLauncher project and asserts, non-vacuously against the pre-fix runtime:
(1) the canonical now-playing image serves at `/assets/by-file-media-id/<id>` →
HTTP 200 + `image/jpeg` + JPEG magic bytes, and an unknown id → 404; (2) opening
the now-playing page makes the canvas actually request that URL and get 200; (3)
a programmatic "replace image" — POST a generated PNG to `upload-file-media-object`
— returns a non-empty media-object (uuid id, `width/height > 0`, `mtype
image/png`) and the new id is immediately servable. Skips (exit 0) if the source
project is absent.

## Source map

| Concern | File / lines | Commit |
|---|---|---|
| Import: retain descriptor join (two id spaces) | `runtime/import-binfile.mjs:195-223` | `0ca3a22408` |
| Import: index binaries, skip JSON twin | `runtime/import-binfile.mjs:314-330` | `90399b78e3` |
| Import: join → file-media-id-keyed media + thumbnail + fallback | `runtime/import-binfile.mjs:335-397` | `0ca3a22408` |
| CLI: write `media/<id>.<ext>` + sidecar + thumbnail | `bin/pencilpot.mjs:694-719` | `0ca3a22408` |
| Serve route `/assets/by-file-media-id/<id>(/thumbnail)` | `runtime/server.mjs:125-148` | `61676f812c` |
| Resolver (path-safety, thumbnail fallback, content-type) | `runtime/media.mjs:62-90` | `61676f812c` |
| `upload-file-media-object` / `…-from-url` / `clone-…` RPCs | `runtime/rpc.mjs:579-617` | `1d23c6f2d9` |
| `writeMediaObject` / `cloneMediaObject` / transit encoding | `runtime/rpc.mjs:378-450` | `1d23c6f2d9` |
| Hand-rolled multipart parser | `runtime/multipart.mjs` | `1d23c6f2d9` |
| Hand-rolled image-dimension probe | `runtime/image-size.mjs` | `1d23c6f2d9` |
| Store model: `readDesign().media`, `writeDesign` preserves | `store/store.mjs:6-57` | `f2cfaf7c5c` |
| Media excluded from dirty signature | `runtime/worktree.mjs:40-58` | (manual-save chain) |
| E2E regression (serve 200, upload round-trip) | `e2e/vf/verify-media.mjs` | `eb76c31feb` |
| Plan | `docs/superpowers/plans/2026-06-21-pencilpot-media-flow.md` | — |
