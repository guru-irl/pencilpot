import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { createSession } from "../../headless-core/target/headless/penpot.js";
import { writeDesign, readDesign } from "../store/store.mjs";
import { getFile, updateFileJson } from "../runtime/rpc.mjs";
import { initWorktree, stage, save, discard, status } from "../runtime/worktree.mjs";

// Seed a tiny design dir with a single rect we can mutate.
function seedDir() {
  const s = createSession(JSON.stringify({ empty: true }));
  const b = s.addBoard(JSON.stringify({ x: 0, y: 0, width: 100, height: 100, name: "B" }));
  const r = s.addRect(JSON.stringify({ x: 10, y: 10, width: 20, height: 20, parentId: b }));
  s.closeBoard();
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pp-wt-")), "home.penpot");
  writeDesign(dir, JSON.parse(s.serializeStore()));
  return { dir, r };
}

// Concatenated on-disk content of every page EDN (to detect disk writes).
function diskPages(dir) {
  const parts = readDesign(dir);
  return Object.values(parts.pages).join("\n");
}

function shapeXFromDisk(dir, id) {
  const parts = readDesign(dir);
  const s = createSession(JSON.stringify({ fromStore: parts }));
  return JSON.parse(s.getShape(id)).x;
}

test("manual-save: update-file stages in memory and does NOT touch disk until save()", () => {
  const { dir, r } = seedDir();
  initWorktree(dir);                       // ← activate the working copy for this dir
  assert.equal(status().dirty, false, "clean after init");

  const diskBefore = diskPages(dir);
  const res = updateFileJson(dir, JSON.stringify([
    { type: "mod-obj", id: r, operations: [{ type: "set", attr: "x", val: 99 }] },
  ]));
  assert.equal(res.revn, 1, "revn bumped");

  // Disk is UNCHANGED, but the working copy reflects the edit.
  assert.equal(diskPages(dir), diskBefore, "disk not written on edit");
  assert.equal(status().dirty, true, "marked dirty after edit");
  assert.equal(shapeXFromDisk(dir, r), 10, "on-disk shape still old value (10)");

  // get-file serves the in-memory working copy (so reloads keep unsaved edits).
  const { meta, transit } = getFile(dir);
  const live = createSession(JSON.stringify({ fromTransit: transit, meta }));
  assert.equal(JSON.parse(live.getShape(r)).x, 99, "get-file serves staged edit");

  // Explicit save flushes to disk and clears dirty.
  const sv = save();
  assert.equal(sv.saved, true);
  assert.equal(status().dirty, false, "clean after save");
  assert.equal(shapeXFromDisk(dir, r), 99, "edit now persisted to disk");
  assert.notEqual(diskPages(dir), diskBefore, "disk changed after save");
});

test("manual-save: discard() reverts the working copy to the on-disk version", () => {
  const { dir, r } = seedDir();
  initWorktree(dir);

  updateFileJson(dir, JSON.stringify([
    { type: "mod-obj", id: r, operations: [{ type: "set", attr: "x", val: 77 }] },
  ]));
  assert.equal(status().dirty, true, "dirty after edit");

  discard();
  assert.equal(status().dirty, false, "clean after discard");
  // Working copy (served by get-file) is back to the on-disk value.
  const { meta, transit } = getFile(dir);
  const live = createSession(JSON.stringify({ fromTransit: transit, meta }));
  assert.equal(JSON.parse(live.getShape(r)).x, 10, "discard reverted the staged edit");
  assert.equal(shapeXFromDisk(dir, r), 10, "disk unchanged throughout");

  // Reset module state so other test files aren't affected by the bound dir.
  initWorktree(null);
});

// ── Content-signature dirty detection ───────────────────────────────────────
// A design goes dirty only when the staged working copy actually differs from
// the last-saved content, not on every update-file RPC.
const partsOf = (name) => ({ manifest: `{:name "${name}"}`, pages: { p1: "{:a 1}" }, components: {}, media: [] });

function seedBaseline(name) {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pp-wt-")), "home.penpot");
  writeDesign(dir, partsOf(name));   // on-disk saved baseline
  return dir;
}

test("dirty-sig: staging content identical to the saved baseline does NOT mark dirty", () => {
  const dir = seedBaseline("X");
  initWorktree(dir);
  stage(dir, partsOf("X"), 1);          // same content as saved baseline
  assert.equal(status().dirty, false, "no-op stage must not be dirty");
  initWorktree(null);
});

test("dirty-sig: staging changed content marks dirty; save clears it", () => {
  const dir = seedBaseline("X");
  initWorktree(dir);
  stage(dir, partsOf("Y"), 2);          // changed
  assert.equal(status().dirty, true, "changed content is dirty");
  save();
  assert.equal(status().dirty, false, "save clears dirty");
  stage(dir, partsOf("Y"), 3);          // same as just-saved
  assert.equal(status().dirty, false, "re-staging saved content is not dirty");
  initWorktree(null);
});

test("dirty-sig: media present on disk does NOT dirty a media-empty stage (media is disk-managed, out-of-band)", () => {
  // Tasks 1/3 write media binaries + sidecars straight to <dir>/media, so
  // readDesign(dir).media (the saved baseline) reports them.  serializeStore()
  // derives media from the file's :media registry, which is empty for these
  // designs, so a staged working copy carries media: [].  The dirty signature
  // must IGNORE media (binaries are tracked out-of-band; any image add/replace
  // already dirties via the page EDN) — otherwise every design with on-disk
  // media would be spuriously dirty on the first stage after load.
  const dir = seedBaseline("X");
  fs.writeFileSync(path.join(dir, "media", "aaaa.png"), Buffer.from([1, 2, 3]));
  fs.writeFileSync(path.join(dir, "media", "aaaa.json"), '{"width":1,"height":1,"mtype":"image/png","name":"a"}');
  fs.writeFileSync(path.join(dir, "media", "aaaa.thumbnail.png"), Buffer.from([4, 5, 6]));
  initWorktree(dir);
  // baseline readDesign().media === ["aaaa"]; staged parts carry media: [] (empty registry)
  stage(dir, partsOf("X"), 1);
  assert.equal(status().dirty, false, "media-only difference (disk baseline vs media-empty stage) must NOT dirty");
  initWorktree(null);
});

test("position-data-only change does NOT mark dirty; real edit does", () => {
  const s = createSession(JSON.stringify({ empty: true }));
  const b = s.addBoard(JSON.stringify({ x: 0, y: 0, width: 100, height: 100, name: "B" }));
  s.closeBoard();
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pp-pd-")), "home.penpot");
  // Seed a page EDN that carries a :position-data vector.
  const parts = JSON.parse(s.serializeStore());
  const pid = Object.keys(parts.pages)[0];
  parts.pages[pid] = parts.pages[pid].replace(/\}\s*$/, ' :position-data [#penpot/rect "1,2,3"]}');
  writeDesign(dir, parts);

  initWorktree(dir);
  // Re-read baseline (writeDesign strips pd on disk in Task A3, but the in-memory
  // store still carries it; either way the dirty check ignores pd).
  assert.equal(status().dirty, false, "clean after init");

  // Stage a store whose ONLY difference is the position-data value.
  const pdChanged = { ...parts, pages: { ...parts.pages,
    [pid]: parts.pages[pid].replace("1,2,3", "9,9,9") } };
  stage(dir, pdChanged, 1);
  assert.equal(status().dirty, false, "position-data-only change must NOT dirty");

  // Stage a real content change (rename) — must dirty.
  const realEdit = { ...parts, pages: { ...parts.pages,
    [pid]: parts.pages[pid].replace(':name "B"', ':name "RENAMED"') } };
  stage(dir, realEdit, 2);
  assert.equal(status().dirty, true, "real content edit MUST dirty");
  initWorktree(null);
});

// ── Content-only signature: ignore :revn bumps + EDN whitespace drift ────────
// Opening a design with NO user edits used to report "Unsaved changes": the SPA
// sends one no-op `update-file` on open, which (1) bumps manifest :revn and
// (2) re-serializes pages with clean whitespace, while the on-disk EDN carries
// the blank-line residue left when writeDesign stripped :position-data.  Neither
// is user content, so the dirty signature must ignore both.
const BLANK_RESIDUE = '{:a 1\n      \n      :b 2}';   // disk: orphaned blank line after a stripped :position-data
const CLEAN_PAGE    = '{:a 1\n      :b 2}';            // engine: same content, clean whitespace
function seedRevnBaseline() {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pp-wt-")), "home.penpot");
  // baseline on disk: :revn 1 + a page with the blank-line residue
  writeDesign(dir, { manifest: '{:name "X" :revn 1}', pages: { p1: BLANK_RESIDUE }, components: {}, media: [] });
  return dir;
}

test("dirty-sig: a :revn-only bump (no-op open update-file) does NOT mark dirty", () => {
  const dir = seedRevnBaseline();
  initWorktree(dir);
  // identical content, only :revn bumped 1 -> 2 (what the open update-file does)
  stage(dir, { manifest: '{:name "X" :revn 2}', pages: { p1: BLANK_RESIDUE }, components: {}, media: [] }, 2);
  assert.equal(status().dirty, false, ":revn bump alone must NOT dirty");
  initWorktree(null);
});

test("dirty-sig: whitespace-only drift (disk blank-line residue vs clean engine output) does NOT mark dirty", () => {
  const dir = seedRevnBaseline();
  initWorktree(dir);
  // engine re-serializes the same page with clean whitespace (no blank line)
  stage(dir, { manifest: '{:name "X" :revn 1}', pages: { p1: CLEAN_PAGE }, components: {}, media: [] }, 2);
  assert.equal(status().dirty, false, "whitespace-only formatting drift must NOT dirty");
  initWorktree(null);
});

test("dirty-sig: the combined no-op open (revn bump + whitespace drift) does NOT mark dirty", () => {
  const dir = seedRevnBaseline();
  initWorktree(dir);
  stage(dir, { manifest: '{:name "X" :revn 2}', pages: { p1: CLEAN_PAGE }, components: {}, media: [] }, 2);
  assert.equal(status().dirty, false, "combined revn+whitespace no-op must NOT dirty");
  initWorktree(null);
});

test("dirty-sig: a REAL content change still marks dirty (fix does not mask edits)", () => {
  const dir = seedRevnBaseline();
  initWorktree(dir);
  // same whitespace shape, but :b value actually changed 2 -> 99
  stage(dir, { manifest: '{:name "X" :revn 2}', pages: { p1: '{:a 1\n      :b 99}' }, components: {}, media: [] }, 2);
  assert.equal(status().dirty, true, "real content edit MUST still dirty");
  initWorktree(null);
});

test("dirty-sig: a real string-value change still marks dirty", () => {
  const dir = seedRevnBaseline();
  initWorktree(dir);
  stage(dir, { manifest: '{:name "RENAMED" :revn 2}', pages: { p1: CLEAN_PAGE }, components: {}, media: [] }, 2);
  assert.equal(status().dirty, true, "changing a real string value MUST dirty");
  initWorktree(null);
});
