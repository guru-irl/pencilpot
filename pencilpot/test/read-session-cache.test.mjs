import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { createSession } from "../../headless-core/target/headless/penpot.js";
import { writeDesign } from "../store/store.mjs";
import { __readSessionFor, updateFileJson, getFile } from "../runtime/rpc.mjs";
import { initWorktree, save, discard } from "../runtime/worktree.mjs";

// Seed a tiny design dir with a single rect we can mutate; returns { dir, r }.
function seedDir() {
  const s = createSession(JSON.stringify({ empty: true }));
  const b = s.addBoard(JSON.stringify({ x: 0, y: 0, width: 100, height: 100, name: "B" }));
  const r = s.addRect(JSON.stringify({ x: 10, y: 10, width: 20, height: 20, parentId: b }));
  s.closeBoard();
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pp-rsc-")), "home.penpot");
  writeDesign(dir, JSON.parse(s.serializeStore()));
  return { dir, r };
}

const xOf = (session, id) => JSON.parse(session.getShape(id)).x;

test("read-session cache: same content reuses ONE session (cache hit)", () => {
  const { dir } = seedDir();
  initWorktree(dir);
  const s1 = __readSessionFor(dir);
  const s2 = __readSessionFor(dir);
  assert.strictEqual(s1, s2, "second read at same content returns the cached session");
});

test("read-session cache: edit (stage) invalidates and read-after-write is fresh", () => {
  const { dir, r } = seedDir();
  initWorktree(dir);
  const s1 = __readSessionFor(dir);
  assert.equal(xOf(s1, r), 10, "initial x");

  updateFileJson(dir, JSON.stringify([
    { type: "mod-obj", id: r, operations: [{ type: "set", attr: "x", val: 99 }] },
  ]));

  const s2 = __readSessionFor(dir);
  assert.notStrictEqual(s2, s1, "session rebuilt after edit (content ref changed)");
  assert.equal(xOf(s2, r), 99, "rebuilt session reflects the edit (no stale)");
  // getFile (the real read path) also reflects the edit.
  const { transit, meta } = getFile(dir);
  const live = createSession(JSON.stringify({ fromTransit: transit, meta }));
  assert.equal(xOf(live, r), 99, "getFile serves the edited working copy");
});

test("read-session cache: discard invalidates (no stale post-edit session)", () => {
  const { dir, r } = seedDir();
  initWorktree(dir);
  __readSessionFor(dir); // warm
  updateFileJson(dir, JSON.stringify([
    { type: "mod-obj", id: r, operations: [{ type: "set", attr: "x", val: 99 }] },
  ]));
  const sEdited = __readSessionFor(dir);
  assert.equal(xOf(sEdited, r), 99, "edited session has x=99");

  discard(); // revert to on-disk content (x=10) WITHOUT bumping revn

  const sAfter = __readSessionFor(dir);
  assert.notStrictEqual(sAfter, sEdited, "session rebuilt after discard");
  assert.equal(xOf(sAfter, r), 10, "post-discard read is reverted content, NOT stale 99");
});

test("read-session cache: save does NOT invalidate (content unchanged by save)", () => {
  const { dir, r } = seedDir();
  initWorktree(dir);
  updateFileJson(dir, JSON.stringify([
    { type: "mod-obj", id: r, operations: [{ type: "set", attr: "x", val: 99 }] },
  ]));
  const s1 = __readSessionFor(dir);
  save(); // flushes disk; does not replace the in-memory _store ref
  const s2 = __readSessionFor(dir);
  assert.strictEqual(s2, s1, "save keeps the same cached session (no content change)");
  assert.equal(xOf(s2, r), 99, "still the saved content");
});

test("read-session cache: non-open dirs always read fresh and never evict the open session", () => {
  const { dir: dirA } = seedDir();
  initWorktree(dirA);                 // dirA is the OPEN design
  const a1 = __readSessionFor(dirA);

  const { dir: dirB } = seedDir();    // a different, NON-open dir (acts like a library)
  const b1 = __readSessionFor(dirB);
  const b2 = __readSessionFor(dirB);
  assert.notStrictEqual(b1, b2, "non-open dir reads are always fresh (uncached)");

  const a2 = __readSessionFor(dirA);
  assert.strictEqual(a2, a1, "open-design session is NOT evicted by library reads");
});
