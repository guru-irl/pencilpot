import { test } from "node:test";
import assert from "node:assert/strict";
import { PenpotUtils } from "../../plugin/src/PenpotUtils";

/**
 * Builds a small mock shape tree. Any node whose id is in `poison` throws when its
 * `children` is accessed, simulating the "corrupt board" failure mode from pain point #1
 * where property access on a half-mutated board throws a TypeError.
 */
function node(id: string, children: any[] = [], opts: { poisonChildren?: boolean; poisonPredicateMatch?: boolean } = {}): any {
    const n: any = { id, name: id };
    if (opts.poisonChildren) {
        Object.defineProperty(n, "children", {
            get() {
                throw new TypeError("Cannot read properties of undefined (reading 'findShape')");
            },
            enumerable: true,
        });
    } else {
        n.children = children;
    }
    return n;
}

test("findShape still finds a good node when a sibling subtree is corrupt", () => {
    const corrupt = node("corrupt", [], { poisonChildren: true });
    const target = node("target");
    const root = node("root", [corrupt, target]);

    const found = PenpotUtils.findShape((s: any) => s.id === "target", root);
    assert.equal(found?.id, "target");
});

test("findShapes collects all good matches and isolates a corrupt node", () => {
    const corrupt = node("corrupt", [], { poisonChildren: true });
    const a = node("hit-a");
    const b = node("hit-b");
    const root = node("root", [a, corrupt, b]);

    const found = PenpotUtils.findShapes((s: any) => s.id.startsWith("hit"), root);
    assert.deepEqual(
        found.map((s: any) => s.id).sort(),
        ["hit-a", "hit-b"]
    );
});

test("a predicate that throws on one node does not abort the whole traversal", () => {
    const boom = node("boom");
    const target = node("target");
    const root = node("root", [boom, target]);

    const found = PenpotUtils.findShape((s: any) => {
        if (s.id === "boom") throw new Error("predicate blew up");
        return s.id === "target";
    }, root);
    assert.equal(found?.id, "target");
});

test("traversal of a fully healthy tree is unchanged", () => {
    const root = node("root", [node("a", [node("b")]), node("c")]);
    assert.equal(PenpotUtils.findShape((s: any) => s.id === "b", root)?.id, "b");
    assert.equal(PenpotUtils.findShapes(() => true, root).length, 4);
});
