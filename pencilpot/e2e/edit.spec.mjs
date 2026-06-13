import { test, expect } from "@playwright/test";
import { expectCanvasLoaded } from "./helpers.mjs";
import fs from "node:fs";
import path from "node:path";

const WS = "#/workspace?team-id=0398e5fc-95c9-80d6-8008-29071f0fdaed&file-id=0398e5fc-95c9-80d6-8008-29088f3ee53a";

// DESIGN is relative to the pencilpot/ dir (process.cwd() when running npx playwright test from pencilpot/).
const DESIGN = path.join(process.cwd(), ".scratch", "proj", "designs", "home");

function revn() {
  const txt = fs.readFileSync(path.join(DESIGN, "manifest.edn"), "utf8");
  const m = txt.match(/:revn\s+(\d+)/);
  return Number(m ? m[1] : -1);
}

test("edit: a canvas edit persists to the EDN store and survives reload", async ({ page }) => {
  const before = revn();

  await page.goto(WS);
  await expectCanvasLoaded(page, expect);

  // Wait for the workspace to fully settle after initial load.
  await page.waitForTimeout(2000);

  const updated = page.waitForResponse(
    (r) => r.url().includes("update-file") && r.status() === 200,
    { timeout: 30_000 }
  );

  // Click the viewport to focus it, then select all and nudge.
  const viewport = page.locator('[class*="viewport"], #workspace-viewport, [class*="workspace"]').first();
  await expect(viewport).toBeVisible({ timeout: 15_000 });
  await viewport.click({ position: { x: 400, y: 400 } });
  await page.waitForTimeout(400);
  await page.keyboard.press("Control+a");
  await page.waitForTimeout(300);
  for (let i = 0; i < 5; i++) {
    await page.keyboard.press("ArrowRight");
    await page.waitForTimeout(100);
  }

  await updated;
  await page.waitForTimeout(1500);

  expect(revn(), "manifest revn incremented on disk").toBeGreaterThan(before);

  await page.reload();
  await expectCanvasLoaded(page, expect);
});
