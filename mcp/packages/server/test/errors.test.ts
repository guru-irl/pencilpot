import { test } from "node:test";
import assert from "node:assert/strict";
import { describeError } from "../src/utils/errors";
import { formatPluginError } from "../../plugin/src/formatError";

// --- server-side describeError: unwraps Error so the agent does not see "Error: ..." noise ---

test("describeError returns the bare message for an Error (no 'Error:' prefix)", () => {
    assert.equal(describeError(new Error("boom")), "boom");
});

test("describeError preserves a custom error name when it is informative", () => {
    class ValidationError extends Error {
        constructor(msg: string) {
            super(msg);
            this.name = "ValidationError";
        }
    }
    assert.equal(describeError(new ValidationError("bad field x")), "ValidationError: bad field x");
});

test("describeError handles strings and other values", () => {
    assert.equal(describeError("plain string"), "plain string");
    assert.equal(describeError(42), "42");
});

// --- plugin-side formatPluginError: keeps name + message + a few stack frames + cause ---

test("formatPluginError includes name and message", () => {
    const out = formatPluginError(new TypeError("Cannot read properties of undefined"));
    assert.match(out, /TypeError: Cannot read properties of undefined/);
});

test("formatPluginError includes a few stack frames when present", () => {
    const err = new Error("with stack");
    err.stack = "Error: with stack\n    at foo (a.js:1:1)\n    at bar (b.js:2:2)\n    at baz (c.js:3:3)\n    at qux (d.js:4:4)";
    const out = formatPluginError(err);
    assert.match(out, /foo \(a\.js:1:1\)/);
    // stack is truncated, so the 4th frame must NOT appear
    assert.doesNotMatch(out, /qux/);
});

test("formatPluginError surfaces the cause chain", () => {
    const cause = new Error("root cause");
    const err = new Error("outer", { cause });
    const out = formatPluginError(err);
    assert.match(out, /outer/);
    assert.match(out, /root cause/);
});

test("formatPluginError handles non-Error values", () => {
    assert.equal(formatPluginError("just a string"), "just a string");
    assert.match(formatPluginError({ code: "X" }), /"code": "X"|code/);
});
