import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveTaskTimeoutSecs, DEFAULT_TASK_TIMEOUT_SECS } from "../src/utils/taskTimeout";

test("returns the default when neither env nor override is set", () => {
    assert.equal(resolveTaskTimeoutSecs(undefined, undefined), DEFAULT_TASK_TIMEOUT_SECS);
});

test("a positive override wins over everything", () => {
    assert.equal(resolveTaskTimeoutSecs("45", 120), 120);
});

test("a valid env value is used when there is no override", () => {
    assert.equal(resolveTaskTimeoutSecs("90", undefined), 90);
});

test("non-positive / non-numeric override is ignored, falling back to env", () => {
    assert.equal(resolveTaskTimeoutSecs("90", 0), 90);
    assert.equal(resolveTaskTimeoutSecs("90", -5), 90);
    assert.equal(resolveTaskTimeoutSecs("90", NaN), 90);
});

test("invalid env value falls back to the default", () => {
    assert.equal(resolveTaskTimeoutSecs("not-a-number", undefined), DEFAULT_TASK_TIMEOUT_SECS);
    assert.equal(resolveTaskTimeoutSecs("0", undefined), DEFAULT_TASK_TIMEOUT_SECS);
    assert.equal(resolveTaskTimeoutSecs("-10", undefined), DEFAULT_TASK_TIMEOUT_SECS);
    assert.equal(resolveTaskTimeoutSecs("", undefined), DEFAULT_TASK_TIMEOUT_SECS);
});
