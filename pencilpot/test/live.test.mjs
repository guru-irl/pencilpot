// Unit tests for pencilpot/runtime/live.mjs
// Tests the self-write suppression logic and basic watcher/SSE channel behaviour.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// We import the module under test.  During the RED phase this file does not yet
// exist and all imports will fail, which is the expected behaviour.
import {
  createLiveWatcher,
  noteSelfWrite,
} from "../runtime/live.mjs";

// ---------------------------------------------------------------------------
// Helper: create a temporary design dir with the expected sub-structure.
// ---------------------------------------------------------------------------
function makeTmpDesignDir() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pp-live-"));
  const dir = path.join(root, "home");
  fs.mkdirSync(path.join(dir, "pages"), { recursive: true });
  fs.mkdirSync(path.join(dir, "components"), { recursive: true });
  fs.writeFileSync(path.join(dir, "manifest.edn"), ":revn 0");
  return dir;
}

// ---------------------------------------------------------------------------
// Test 1: createLiveWatcher returns an object with the expected interface
// ---------------------------------------------------------------------------
test("createLiveWatcher returns { close, clients }", () => {
  const dir = makeTmpDesignDir();
  const watcher = createLiveWatcher(dir);
  assert.ok(typeof watcher === "object" && watcher !== null, "should return an object");
  assert.ok(typeof watcher.close === "function", "should have .close()");
  assert.ok(watcher.clients instanceof Set, "should have .clients (a Set)");
  watcher.close();
});

// ---------------------------------------------------------------------------
// Test 2: noteSelfWrite executes (adopts the current content as baseline)
// ---------------------------------------------------------------------------
test("noteSelfWrite runs without error", () => {
  // Suppression is content-based: noteSelfWrite() snapshots the on-disk .edn
  // content as the runtime's baseline.  Behaviour is verified in Test 3.
  noteSelfWrite();
  assert.ok(true, "noteSelfWrite executed without error");
});

// ---------------------------------------------------------------------------
// Test 3: a self-write (write THEN noteSelfWrite) is suppressed — no matter how
// many files change or how the OS batches/delays the fs events.
// ---------------------------------------------------------------------------
test("self-write (write then noteSelfWrite) is suppressed", async () => {
  const dir = makeTmpDesignDir();
  const received = [];
  const watcher = createLiveWatcher(dir);

  // Register a mock SSE client.
  const mockClient = { write: (data) => received.push(data), req: null, res: null };
  watcher.clients.add(mockClient);

  // SPA write path: write many files (like a large design save) and THEN adopt
  // the result as the baseline — exactly what rpc.mjs persistChanges does.
  for (let i = 0; i < 20; i++) {
    fs.writeFileSync(path.join(dir, "pages", `p${i}.edn`), `:p ${i}`);
  }
  fs.writeFileSync(path.join(dir, "manifest.edn"), ":revn 1");
  noteSelfWrite();                       // baseline now == just-written content

  // Wait well past the debounce so any pending check fires.
  await new Promise((r) => setTimeout(r, 600));

  watcher.clients.delete(mockClient);
  watcher.close();

  assert.equal(received.length, 0, "self-write change must NOT produce a reload event");
});

// ---------------------------------------------------------------------------
// Test 3b: a no-op rewrite (identical content) does not fire a reload.
// ---------------------------------------------------------------------------
test("rewriting identical content does not fire a reload", async () => {
  const dir = makeTmpDesignDir();
  const received = [];
  const watcher = createLiveWatcher(dir);
  watcher.clients.add({ write: (data) => received.push(data) });

  // Rewrite the manifest with byte-identical content (baseline == current).
  fs.writeFileSync(path.join(dir, "manifest.edn"), ":revn 0");
  await new Promise((r) => setTimeout(r, 600));

  watcher.close();
  assert.equal(received.length, 0, "identical-content rewrite must NOT reload");
});

// ---------------------------------------------------------------------------
// Test 4: external file change AFTER the suppression window fires a reload
// ---------------------------------------------------------------------------
test("external file change after suppression window fires a reload event", async () => {
  const dir = makeTmpDesignDir();
  const received = [];
  const watcher = createLiveWatcher(dir);

  // Register a mock SSE client.
  const mockClient = { write: (data) => received.push(data) };
  watcher.clients.add(mockClient);

  // Note a self-write in the past (beyond the 1500 ms suppression window).
  // We fake the internal clock by calling noteSelfWrite() and then patching
  // the export to backdate the stamp.  Since we cannot reach the closure
  // directly, we instead just wait for the window to expire before writing.
  // This test sets a longer timeout (3 s) to span the 1.5 s suppression window.
  noteSelfWrite();                // arm the self-write clock
  await new Promise((r) => setTimeout(r, 1800)); // wait out the window

  // Now do an external write (NOT via noteSelfWrite()).
  fs.writeFileSync(path.join(dir, "manifest.edn"), ":revn 2");

  // Wait for debounce + buffer.
  await new Promise((r) => setTimeout(r, 600));

  watcher.clients.delete(mockClient);
  watcher.close();

  assert.ok(received.length > 0, "external change after window should produce a reload event");
  assert.ok(received[0].includes("reload"), "event data should contain 'reload'");
}, { timeout: 5000 });

// ---------------------------------------------------------------------------
// Test 5: multiple clients all receive the reload event
// ---------------------------------------------------------------------------
test("all connected clients receive the reload event on external change", async () => {
  const dir = makeTmpDesignDir();
  const received1 = [];
  const received2 = [];
  const watcher = createLiveWatcher(dir);

  const client1 = { write: (d) => received1.push(d) };
  const client2 = { write: (d) => received2.push(d) };
  watcher.clients.add(client1);
  watcher.clients.add(client2);

  // Ensure suppression window has passed (call noteSelfWrite with old timestamp).
  // We simply don't call noteSelfWrite at all so the initial state (ts=0) is well past.
  // Touch the manifest.
  fs.writeFileSync(path.join(dir, "manifest.edn"), ":revn 3");

  await new Promise((r) => setTimeout(r, 600));

  watcher.clients.delete(client1);
  watcher.clients.delete(client2);
  watcher.close();

  assert.ok(received1.length > 0, "client1 should receive reload event");
  assert.ok(received2.length > 0, "client2 should receive reload event");
}, { timeout: 3000 });

// ---------------------------------------------------------------------------
// Test 6: close() shuts down the watcher without throwing
// ---------------------------------------------------------------------------
test("close() shuts down the watcher cleanly", () => {
  const dir = makeTmpDesignDir();
  const watcher = createLiveWatcher(dir);
  assert.doesNotThrow(() => watcher.close(), "close() must not throw");
  // Calling close a second time should also not throw.
  assert.doesNotThrow(() => watcher.close(), "second close() must not throw");
});

// ---------------------------------------------------------------------------
// Test 7: watcher on a non-existent directory does not throw
// ---------------------------------------------------------------------------
test("createLiveWatcher on non-existent dir returns a no-op watcher", () => {
  const watcher = createLiveWatcher(null);
  assert.ok(typeof watcher.close === "function", "should have .close()");
  assert.ok(watcher.clients instanceof Set, "should have .clients");
  watcher.close();
});
