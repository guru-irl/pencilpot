import { test } from "node:test";
import assert from "node:assert/strict";
import { createSession } from "../target/headless/penpot.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Collect all ~# transit tag names from a transit JSON string. */
function transitTags(transitStr) {
  const tags = new Set();
  let i = 0;
  while (i < transitStr.length) {
    const idx = transitStr.indexOf('"~#', i);
    if (idx === -1) break;
    const end = transitStr.indexOf('"', idx + 3);
    if (end !== -1) tags.add(transitStr.slice(idx + 3, end));
    i = idx + 3;
  }
  return tags;
}

test("serializeStore -> loadStore round-trips a file losslessly", () => {
  const s = createSession(JSON.stringify({ empty: true }));
  const b = s.addBoard(JSON.stringify({ x: 0, y: 0, width: 100, height: 100, name: "B" }));
  s.addRect(JSON.stringify({ x: 10, y: 10, width: 20, height: 20, parentId: b }));
  s.closeBoard();
  const parts = JSON.parse(s.serializeStore()); // {manifest, pages:{id:edn}, components:{id:edn}, media:[]}
  assert.ok(parts.manifest.includes(":id"), "manifest is EDN");
  assert.ok(Object.keys(parts.pages).length >= 1, "has >=1 page");
  const s2 = createSession(JSON.stringify({ fromStore: parts }));
  assert.deepEqual(JSON.parse(s2.objects()), JSON.parse(s.objects()), "objects identical after round-trip");
});

test("serializeStore preserves Matrix/Point/Rect geometry types (NaN-rendering regression guard)", () => {
  // This is the core regression guard for the matrix(NaN) rendering bug.
  // If Matrix/Point/Rect are serialised as plain maps instead of typed tagged
  // literals, the transit encoder encodes them without the ~#matrix/~#point/
  // ~#rect tags, and the frontend's geometry math produces NaN transforms →
  // broken rendering + empty options panel.

  const s = createSession(JSON.stringify({ empty: true }));
  const b = s.addBoard(JSON.stringify({ x: 0, y: 0, width: 200, height: 150, name: "Board" }));
  s.addRect(JSON.stringify({ x: 20, y: 30, width: 80, height: 60, parentId: b }));
  s.closeBoard();

  // ── 1. EDN must contain typed tagged literals, not plain maps ──────────────
  const parts = JSON.parse(s.serializeStore());
  const pageEdn = Object.values(parts.pages)[0];

  assert.ok(
    pageEdn.includes("#penpot/matrix"),
    "page EDN contains #penpot/matrix (Matrix preserved as typed literal)"
  );
  assert.ok(
    pageEdn.includes("#penpot/point"),
    "page EDN contains #penpot/point (Point preserved as typed literal)"
  );
  assert.ok(
    pageEdn.includes("#penpot/rect"),
    "page EDN contains #penpot/rect (Rect preserved as typed literal)"
  );
  // Ensure we did NOT flatten Matrix to a plain map — no bare {:a N :b N ...}
  // where N is a double, adjacent to :transform.
  assert.ok(
    !pageEdn.match(/:transform\s*\{:a\s/),
    "page EDN does NOT have plain-map :transform {:a ...} (was not flattened)"
  );

  // ── 2. After EDN round-trip, getFileResponse transit must carry typed tags ─
  const s2 = createSession(JSON.stringify({ fromStore: parts }));
  const result = JSON.parse(s2.getFileResponse());
  const tags = transitTags(result.transit);

  assert.ok(
    tags.has("matrix"),
    `transit from EDN-round-tripped session must contain ~#matrix; found tags: ${JSON.stringify([...tags])}`
  );
  assert.ok(
    tags.has("point"),
    `transit from EDN-round-tripped session must contain ~#point; found tags: ${JSON.stringify([...tags])}`
  );
  assert.ok(
    tags.has("rect"),
    `transit from EDN-round-tripped session must contain ~#rect; found tags: ${JSON.stringify([...tags])}`
  );

  // ── 3. Geometry values are sane (no NaN) after round-trip ─────────────────
  const objects = JSON.parse(s2.objects());
  for (const [id, shape] of Object.entries(objects)) {
    const t = shape.transform;
    if (t) {
      assert.ok(
        !isNaN(t.a) && !isNaN(t.b) && !isNaN(t.c) && !isNaN(t.d) && !isNaN(t.e) && !isNaN(t.f),
        `shape ${id} has NaN in transform after EDN round-trip: ${JSON.stringify(t)}`
      );
    }
    const sr = shape.selrect;
    if (sr) {
      assert.ok(
        !isNaN(sr.x) && !isNaN(sr.y) && !isNaN(sr.width) && !isNaN(sr.height),
        `shape ${id} has NaN in selrect after EDN round-trip: ${JSON.stringify(sr)}`
      );
    }
  }

  // ── 4. Determinism: serialize twice = byte-identical ──────────────────────
  assert.equal(
    s.serializeStore(),
    s.serializeStore(),
    "geometry types don't break determinism (serialize twice = byte-identical)"
  );
});

test("canonical EDN is deterministic (serialize twice -> byte-identical)", () => {
  const s = createSession(JSON.stringify({ empty: true }));
  const b = s.addBoard(JSON.stringify({ x: 0, y: 0, width: 100, height: 100, name: "B" }));
  s.closeBoard();
  assert.equal(s.serializeStore(), s.serializeStore(), "two serializations byte-identical");
});

test("serializeStore -> loadStore preserves design tokens (tokens-lib)", () => {
  // Create a session with a color token.
  const s = createSession(JSON.stringify({ empty: true }));
  s.addColorToken(JSON.stringify({ name: "brand.primary", value: "#ff0000" }));

  // The manifest EDN must contain the #penpot/tokens-lib tagged literal.
  const parts1 = JSON.parse(s.serializeStore());
  assert.ok(
    parts1.manifest.includes("#penpot/tokens-lib"),
    "manifest EDN contains #penpot/tokens-lib tagged literal"
  );

  // Round-trip: load from the serialized store.
  const s2 = createSession(JSON.stringify({ fromStore: parts1 }));

  // Re-serializing must produce byte-identical output — proves full reconstruction,
  // not data-dropping.
  assert.equal(
    s2.serializeStore(),
    s.serializeStore(),
    "tokens-lib round-trips losslessly (byte-identical re-serialization)"
  );

  // The token must be accessible after the round-trip.
  const tokensData = JSON.parse(s2.tokens());
  const tokenNames = (tokensData.tokens || []).map((t) => t.name);
  assert.ok(
    tokenNames.includes("brand.primary"),
    `token 'brand.primary' present after round-trip; found: ${JSON.stringify(tokenNames)}`
  );
});
