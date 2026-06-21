import { test } from "node:test";
import assert from "node:assert/strict";
import { stripPositionData } from "../store/edn.mjs";

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
