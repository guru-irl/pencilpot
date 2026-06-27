import { test } from "node:test";
import assert from "node:assert/strict";
import { createSession } from "../target/headless/penpot.js";

// getViewerBundle builds the :get-view-only-bundle response body for the SPA viewer.
// The WHOLE bundle is transit-encoded in ONE pass (correct ^ cache) and returned as
// JSON { transit: "<transit-string>" }.  We assert on transit string markers (the
// house style — see store.test.mjs transitTags) plus the real page id, which proves
// :file :data :pages-index is populated (not an empty/nil bundle that 404s the viewer).

const TEAM_ID = "0398e5fc-95c9-80d6-8008-29071f0fdaed";
const PROJ_ID = "a0b0c325-382e-80da-8008-238861a34c9c";

function viewerBundleTransit(session) {
  const out = JSON.parse(
    session.getViewerBundle(
      JSON.stringify({
        teamId: TEAM_ID,
        projectId: PROJ_ID,
        projectName: "Default",
        fonts: [{ id: "custom-x", "font-id": "custom-x", name: "X" }],
      }),
    ),
  );
  return out.transit;
}

test("getViewerBundle emits a non-empty view-only bundle as one transit doc", () => {
  // {empty:true} seeds a file-data with ONE real page -> pages-index is populated.
  const s = createSession(JSON.stringify({ empty: true }));
  const pageId = Object.keys(JSON.parse(s.serializeStore()).pages)[0];
  assert.ok(pageId, "fixture must have a page");

  const transit = viewerBundleTransit(s);
  assert.equal(typeof transit, "string");
  assert.ok(transit.length > 0, "transit body must be non-empty");

  // Bundle shape the viewer's bundle-fetched consumes.
  for (const marker of [
    "~:file",
    "~:pages-index",
    "~:team",
    "~:project",
    "~:permissions",
    "~:can-edit",
    "~:features",
  ]) {
    assert.ok(transit.includes(marker), `bundle transit must contain ${marker}`);
  }

  // :file :data :pages-index must carry the REAL page (proves a non-empty file,
  // i.e. the viewer will NOT raise :not-found).
  assert.ok(transit.includes(pageId), "bundle must inline the real page id in pages-index");

  // Modern feature set in BOTH :file and :team (viewer keys file + (features/initialize team)).
  assert.ok(transit.includes("components/v2"), "must declare components/v2");
  assert.ok(transit.includes("render-wasm/v1"), "must declare render-wasm/v1");

  // team id round-trips (transit encodes uuids as ~u<uuid>).
  assert.ok(transit.includes(TEAM_ID), "team id must round-trip");

  // fonts pass-through (opaque list supplied by the runtime).
  assert.ok(transit.includes("custom-x"), "fonts must pass through into :fonts");
});
