import { test } from "node:test";
import assert from "node:assert/strict";
import { runScript } from "../sdk/script.mjs";

test("runScript returns the value and captures console output", async () => {
  const fakeWc = { n: 0, addRect() { this.n++; return "id"; } };
  const r = await runScript("console.log('hi', 2); for (let i=0;i<3;i++) wc.addRect({}); return wc.n;", { wc: fakeWc });
  assert.equal(r.result, 3);
  assert.match(r.log, /hi 2/);
});

test("runScript surfaces errors with message", async () => {
  const r = await runScript("throw new Error('boom');", {});
  assert.equal(r.ok, false);
  assert.match(r.error, /boom/);
});

test("runScript supports top-level await", async () => {
  const r = await runScript("const x = await Promise.resolve(41); return x + 1;", {});
  assert.equal(r.result, 42);
});
