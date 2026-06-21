import { test } from "node:test";
import assert from "node:assert/strict";
import { stripPositionData, normalizeEdnWhitespace, stripRevn } from "../store/edn.mjs";

test("strips :position-data key and its balanced vector value", () => {
  const edn = '{:id 1 :position-data [#penpot/rect "1,2,3"] :name "x"}';
  assert.equal(stripPositionData(edn), '{:id 1  :name "x"}');
});

test("strips nested vectors inside position-data", () => {
  const edn = '{:position-data [{:fills [{:c 1}] :rect [0 0]}] :y 9}';
  assert.equal(stripPositionData(edn), '{ :y 9}');
});

test("does not get confused by ] inside a string literal", () => {
  const edn = '{:position-data [{:text "a]b]c"}] :z 1}';
  assert.equal(stripPositionData(edn), '{ :z 1}');
});

test("returns input unchanged when key absent", () => {
  const edn = '{:id 1 :name "no pd here"}';
  assert.equal(stripPositionData(edn), edn);
});

test("strips multiple occurrences", () => {
  const edn = ':position-data [1] middle :position-data [2] end';
  assert.equal(stripPositionData(edn), ' middle  end');
});

// ── normalizeEdnWhitespace ──────────────────────────────────────────────────
test("normalizeEdnWhitespace collapses inter-token whitespace and blank lines", () => {
  const edn = ':a\n      \n      :b';
  assert.equal(normalizeEdnWhitespace(edn), ':a :b');
});

test("normalizeEdnWhitespace collapses mixed spaces/tabs/newlines to a single space", () => {
  const edn = '{:a   1\n\t :b\t\t2}';
  assert.equal(normalizeEdnWhitespace(edn), '{:a 1 :b 2}');
});

test("normalizeEdnWhitespace folds commas (EDN whitespace) and delimiter-adjacent spacing", () => {
  // comma-style disk serializer vs comma-free engine output must canonicalize equal
  const comma = '{:id 1, :name "x", :v [1, 2, 3]}';
  const spaced = '{ :id 1 :name "x" :v [ 1 2 3 ] }';
  assert.equal(normalizeEdnWhitespace(comma), '{:id 1 :name "x" :v[1 2 3]}');
  assert.equal(normalizeEdnWhitespace(comma), normalizeEdnWhitespace(spaced));
});

test("normalizeEdnWhitespace preserves whitespace INSIDE a string literal verbatim", () => {
  // multiple spaces + a newline inside the string must survive untouched while
  // the surrounding inter-token / delimiter whitespace is normalized away.
  const edn = '{ :t   "foo   bar\nbaz" }';
  assert.equal(normalizeEdnWhitespace(edn), '{:t "foo   bar\nbaz"}');
});

test("normalizeEdnWhitespace keeps commas INSIDE string literals", () => {
  const edn = '{:t "a, b, c"}';
  assert.equal(normalizeEdnWhitespace(edn), '{:t "a, b, c"}');
});

test("normalizeEdnWhitespace handles escaped quotes inside strings", () => {
  // the \" must not be read as the closing quote, so the trailing spaces stay
  // inside the string and are preserved.
  const edn = '{:t "a\\"b   c"   :z 1}';
  assert.equal(normalizeEdnWhitespace(edn), '{:t "a\\"b   c" :z 1}');
});

test("normalizeEdnWhitespace drops leading/trailing whitespace", () => {
  assert.equal(normalizeEdnWhitespace('\n  :a 1  \n'), ':a 1');
});

// ── stripRevn ───────────────────────────────────────────────────────────────
test("stripRevn removes the :revn integer but leaves :vern untouched", () => {
  const edn = '{:name "x" :revn 257 :vern 0}';
  assert.equal(stripRevn(edn), '{:name "x" :revn :vern 0}');
});

test("stripRevn is a no-op when :revn is absent", () => {
  const edn = '{:name "x" :vern 0}';
  assert.equal(stripRevn(edn), edn);
});
