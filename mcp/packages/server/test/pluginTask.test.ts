import { test } from "node:test";
import assert from "node:assert/strict";
import { PluginTask } from "../src/PluginTask";

test("toRequest carries timeoutSecs so it survives a cross-instance (Redis) hop", () => {
    const task = new PluginTask("executeCode", { code: "return 1;" });
    task.timeoutSecs = 300;
    const request = task.toRequest();
    assert.equal(request.timeoutSecs, 300);
    assert.equal(request.task, "executeCode");
    assert.deepEqual(request.params, { code: "return 1;" });
});

test("toRequest omits timeoutSecs (undefined) when none was set", () => {
    const task = new PluginTask("executeCode", { code: "return 1;" });
    const request = task.toRequest();
    assert.equal(request.timeoutSecs, undefined);
});
