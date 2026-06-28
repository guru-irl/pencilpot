import { test } from "node:test";
import assert from "node:assert/strict";
import { createSession } from "../target/headless/penpot.js";

// Regression for the AI-dev "commit gated" bug (Finding #2): a session HYDRATED
// from a get-file transit body OR from a serializeStore() parts map must validate
// clean.  Before the fix, validate() returned ["invalid file data"] because the
// hydrated shapes were plain maps (schema:shape's [:fn shape?] wants Shape
// INSTANCES), and load-store re-emitted nil :tokens-lib / :options (present-nil
// fails the optional-but-non-nillable schema).

function authored() {
  const s = createSession(JSON.stringify({ empty: true, name: "RT" }));
  s.addBoard(JSON.stringify({ x: 0, y: 0, width: 320, height: 200, name: "Board" }));
  s.addRect(JSON.stringify({ x: 20, y: 20, width: 80, height: 60, name: "Rect", fills: [{ fillColor: "#3366ff" }] }));
  s.closeBoard();
  return s;
}

test("dataTransit round-trip: get-file transit re-hydrate validates clean", () => {
  const src = authored();
  assert.deepEqual(JSON.parse(src.validate()), [], "authored file is valid");

  const fr = JSON.parse(src.getFileResponse());           // { meta, transit }
  const rehydrated = createSession(JSON.stringify({
    dataTransit: fr.transit, fileId: fr.meta.id, features: fr.meta.features,
  }));
  assert.deepEqual(JSON.parse(rehydrated.validate()), [],
    "session hydrated from get-file transit validates clean (plain-map shapes coerced)");
});

test("fromStore round-trip: serializeStore parts re-hydrate validates clean", () => {
  const src = authored();
  const parts = JSON.parse(src.serializeStore());
  const rehydrated = createSession(JSON.stringify({ fromStore: parts }));
  assert.deepEqual(JSON.parse(rehydrated.validate()), [],
    "session hydrated from serializeStore parts validates clean (nil tokens-lib/options dropped)");
});

test("empty starter via serializeStore validates clean (no spurious nil :tokens-lib)", () => {
  // mirrors `pencilpot new`: empty session -> serializeStore -> reload
  const empty = createSession(JSON.stringify({ empty: true }));
  const parts = JSON.parse(empty.serializeStore());
  const reloaded = createSession(JSON.stringify({ fromStore: parts }));
  assert.deepEqual(JSON.parse(reloaded.validate()), [],
    "an empty round-tripped starter validates clean");
});
