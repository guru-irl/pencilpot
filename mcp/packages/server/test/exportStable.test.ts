import { test } from "node:test";
import assert from "node:assert/strict";
import { PenpotUtils } from "../../plugin/src/PenpotUtils";

const noSleep = async () => {};

test("bytesEqual compares content, not identity", () => {
    assert.equal(PenpotUtils.bytesEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3])), true);
    assert.equal(PenpotUtils.bytesEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4])), false);
    assert.equal(PenpotUtils.bytesEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2, 3])), false);
});

test("exportUntilStable returns as soon as two consecutive exports match", async () => {
    // export #1 = [1], export #2 = [2] (changed), export #3 = [2] (stable) -> return at #3
    const frames = [new Uint8Array([1]), new Uint8Array([2]), new Uint8Array([2]), new Uint8Array([9])];
    let i = 0;
    const exporter = async () => frames[i++];

    const result = await PenpotUtils.exportUntilStable(exporter, { waitMs: 0, maxAttempts: 5, sleep: noSleep });
    assert.deepEqual([...result], [2]);
    assert.equal(i, 3, "should stop exporting once stable, not consume later frames");
});

test("exportUntilStable with maxAttempts=1 behaves like the old single-export path", async () => {
    let calls = 0;
    const exporter = async () => {
        calls++;
        return new Uint8Array([7]);
    };
    const result = await PenpotUtils.exportUntilStable(exporter, { waitMs: 0, maxAttempts: 1, sleep: noSleep });
    assert.deepEqual([...result], [7]);
    assert.equal(calls, 1);
});

test("exportUntilStable returns the latest frame if it never stabilizes within the budget", async () => {
    let i = 0;
    const exporter = async () => new Uint8Array([i++]); // always changing
    const result = await PenpotUtils.exportUntilStable(exporter, { waitMs: 0, maxAttempts: 3, sleep: noSleep });
    // 3 attempts -> frames 0,1,2 ; never stable -> returns the last one
    assert.deepEqual([...result], [2]);
});
