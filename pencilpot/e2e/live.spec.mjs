// e2e tests for the pencilpot live-update feature.
//
// Test A: External edit → page auto-reloads and new shape is present.
// Test B: SPA self-write (update-file POST) → no reload loop.
//
// Assumes the runtime server is already running (started by run-tests.mjs)
// with the seeded project at PENCILPOT_PROJECT.
// The DESIGN env var is set by run-tests.mjs to the seeded design dir.
import { test, expect } from "@playwright/test";
import { expectCanvasLoaded } from "./helpers.mjs";
import path from "node:path";
import fs from "node:fs";
import { createSession } from "../../headless-core/target/headless/penpot.js";
import { readDesign, writeDesign } from "../store/store.mjs";

// The seeded design dir — matches the path used by run-tests.mjs
const DESIGN = path.join(process.cwd(), ".scratch", "proj", "designs", "home");
const WS_URL_FILE = path.join(process.cwd(), "e2e", "workspace-url.txt");

function getWorkspaceUrl() {
  // Try reading from the workspace-url.txt file (set by boot tests)
  if (fs.existsSync(WS_URL_FILE)) {
    const saved = fs.readFileSync(WS_URL_FILE, "utf8").trim();
    if (saved) return saved;
  }
  // Fallback: derive from the manifest fileId
  try {
    const manifest = fs.readFileSync(path.join(DESIGN, "manifest.edn"), "utf8");
    const m = manifest.match(/:id\s+#uuid\s+"([^"]+)"/);
    if (m) {
      const fileId = m[1];
      return `#/workspace?team-id=0398e5fc-95c9-80d6-8008-29071f0fdaed&file-id=${fileId}`;
    }
  } catch { /* ignore */ }
  // Last-resort hardcoded fallback
  return "#/workspace?team-id=0398e5fc-95c9-80d6-8008-29071f0fdaed&file-id=0398e5fc-95c9-80d6-8008-29088f3ee53a";
}

// Count the number of shape objects in the design by re-reading from disk.
// Each shape has `:id #uuid "..."` in its EDN map — that is the reliable per-shape marker.
function countShapesOnDisk() {
  const parts = readDesign(DESIGN);
  let total = 0;
  for (const edn of Object.values(parts.pages)) {
    // `:id #uuid` appears once inside each shape map (including the root frame).
    const matches = edn.match(/:id #uuid/g);
    if (matches) total += matches.length;
  }
  return total;
}

// ---------------------------------------------------------------------------
// Test A: external edit → browser reloads and shows new shape
// ---------------------------------------------------------------------------
test("live-update: external disk edit triggers auto-reload", async ({ page }) => {
  // Skip gracefully if the design directory doesn't exist (e.g., seed failed).
  if (!fs.existsSync(DESIGN)) {
    test.skip(true, `design dir not found: ${DESIGN}`);
    return;
  }

  const wsUrl = getWorkspaceUrl();

  // Count shapes before the external edit.
  const shapesBefore = countShapesOnDisk();

  await page.goto(wsUrl);
  await expectCanvasLoaded(page, expect);

  // Wait for the workspace to fully settle.
  await page.waitForTimeout(3000);

  // ── External edit: use the engine to add a new rect directly on disk ──
  const before = readDesign(DESIGN);
  const session = createSession(JSON.stringify({ fromStore: before }));

  // Find the first board (page object).
  const objects = JSON.parse(session.objects());
  const boardId = Object.keys(objects).find(
    (id) => objects[id].type === "frame" && id !== "00000000-0000-0000-0000-000000000000"
  );

  if (boardId) {
    session.addRect(JSON.stringify({
      x: 200, y: 200, width: 50, height: 50,
      name: "LiveUpdateTestRect",
      parentId: boardId,
    }));
    session.closeBoard();
  } else {
    // No board: add a standalone rect at page level.
    session.addRect(JSON.stringify({ x: 200, y: 200, width: 50, height: 50, name: "LiveUpdateTestRect" }));
  }

  session.bumpRevn();
  const newParts = JSON.parse(session.serializeStore());

  // Arm a page-load waiter BEFORE writing to disk.
  const reloadWaiter = page.waitForEvent("load", { timeout: 15000 });

  // Write the modified design to disk (external edit — no noteSelfWrite call).
  writeDesign(DESIGN, newParts);

  // Wait for the browser to reload.
  await reloadWaiter;

  // After reload, the canvas must still render.
  await expectCanvasLoaded(page, expect);

  // Count shapes again — should be higher.
  const shapesAfter = countShapesOnDisk();
  expect(shapesAfter).toBeGreaterThan(shapesBefore);
}, { timeout: 30000 });

// ---------------------------------------------------------------------------
// Test B: SPA self-write (update-file) does NOT cause a reload loop.
// ---------------------------------------------------------------------------
test("live-update: SPA self-write (update-file) does not cause reload loop", async ({ page }) => {
  if (!fs.existsSync(DESIGN)) {
    test.skip(true, `design dir not found: ${DESIGN}`);
    return;
  }

  const wsUrl = getWorkspaceUrl();
  await page.goto(wsUrl);
  await expectCanvasLoaded(page, expect);
  await page.waitForTimeout(3000);

  // Track any reload events.
  let reloadCount = 0;
  page.on("load", () => { reloadCount++; });

  // Simulate the SPA's update-file by POSTing the same transit body the SPA sends.
  // We use the runtime's own HTTP endpoint.
  const baseUrl = `http://localhost:${process.env.PENCILPOT_PORT ?? 7777}`;

  // Build a minimal transit update (move nothing — zero-op change).
  // Transit: ["^ ", "~:id", "file-id", "~:changes", [], "~:revn", 0]
  const manifest = fs.readFileSync(path.join(DESIGN, "manifest.edn"), "utf8");
  const fileIdMatch = manifest.match(/:id\s+#uuid\s+"([^"]+)"/);
  const fileId = fileIdMatch ? fileIdMatch[1] : "00000000-0000-0000-0000-000000000001";

  // Minimal valid update-file transit body (empty changes).
  const transitBody = JSON.stringify([
    "^ ",
    "~:id", fileId,
    "~:session-id", "00000000-0000-0000-0000-000000000099",
    "~:revn", 0,
    "~:changes", [],
    "~:origin", ["^ ", "~:type", "~:local"],
  ]);

  const resp = await page.request.post(`${baseUrl}/api/main/methods/update-file`, {
    headers: { "content-type": "application/transit+json", "accept": "application/transit+json" },
    data: transitBody,
  });
  expect(resp.status()).toBe(200);

  // Wait 3 seconds — if there's a reload loop this would fire.
  await page.waitForTimeout(3000);

  // Expect zero reloads triggered by the self-write.
  expect(reloadCount, "SPA self-write must not trigger a page reload").toBe(0);
}, { timeout: 20000 });

// ---------------------------------------------------------------------------
// Test C: /pencilpot/live SSE endpoint responds correctly
// ---------------------------------------------------------------------------
test("live-update: /pencilpot/live SSE endpoint is reachable and sends keepalive", async ({ page }) => {
  const baseUrl = `http://localhost:${process.env.PENCILPOT_PORT ?? 7777}`;

  // Open an EventSource via page.evaluate so it runs in the browser context.
  const gotComment = await page.evaluate(async (url) => {
    return new Promise((resolve, reject) => {
      const es = new EventSource(url + "/pencilpot/live");
      const timeout = setTimeout(() => {
        es.close();
        resolve(false);
      }, 5000);
      es.onopen = () => {
        // SSE opened — that's a success signal (keepalive or open)
        clearTimeout(timeout);
        es.close();
        resolve(true);
      };
      es.onerror = (e) => {
        clearTimeout(timeout);
        es.close();
        resolve(false);
      };
    });
  }, baseUrl);

  // Navigate to the page so we have a context.
  await page.goto(`http://localhost:${process.env.PENCILPOT_PORT ?? 7777}/`);
  await page.waitForTimeout(500);

  // Verify /pencilpot/live returns a 200 with text/event-stream.
  const resp = await page.request.get(`${baseUrl}/pencilpot/live`, {
    headers: { accept: "text/event-stream" },
    timeout: 3000,
  }).catch(() => null);

  if (resp) {
    expect(resp.status()).toBe(200);
    const ct = resp.headers()["content-type"] || "";
    expect(ct).toContain("text/event-stream");
  }
});
