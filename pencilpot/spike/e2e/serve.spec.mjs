import { test, expect } from "@playwright/test";
import { expectCanvasLoaded, trackErrors } from "./helpers.mjs";
import fs from "node:fs";
import { readFile } from "../store.mjs";
import { createSession } from "../../../headless-core/target/headless/penpot.js";

const WS = fs.readFileSync(new URL("./workspace-url.txt", import.meta.url), "utf8").trim();

test("serve: canvas renders with get-file produced from disk by the engine", async ({ page }) => {
  trackErrors(page);
  // Deterministic: await the disk-served get-file response (registered before navigation).
  const diskGetFile = page.waitForResponse(
    (r) => r.url().includes("get-file")
        && !r.url().includes("libraries") && !r.url().includes("thumbnail")
        && r.headers()["x-pencilpot-source"] === "disk",
    { timeout: 30_000 }
  );
  await page.goto(WS);
  await expectCanvasLoaded(page, expect);
  await diskGetFile; // throws if no disk-served get-file arrived
});

test("serve: editing the canvas persists to disk and survives reload", async ({ page }) => {
  trackErrors(page);
  const id = process.env.PENCILPOT_FILE_ID;
  const before = readFile(id)?.meta?.revn ?? 0;

  await page.goto(WS);
  await expectCanvasLoaded(page, expect);

  // Wait for the file to settle, then try to select everything and nudge.
  // We click the canvas viewport first to ensure keyboard focus, then select all.
  const viewport = page.locator('[class*="viewport"], #workspace-viewport, [class*="workspace"]').first();
  await expect(viewport).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(2000);

  const updated = page.waitForResponse(
    (r) => r.url().includes("update-file") && r.status() === 200,
    { timeout: 30_000 }
  );

  // Click on canvas to ensure focus
  await viewport.click({ position: { x: 200, y: 200 } });
  await page.waitForTimeout(500);
  // Select all shapes
  await page.keyboard.press("Control+a");
  await page.waitForTimeout(300);
  // Nudge right 5 times (each arrow nudge is 1px, triggers update-file)
  for (let i = 0; i < 5; i++) {
    await page.keyboard.press("ArrowRight");
    await page.waitForTimeout(100);
  }

  await updated;
  await page.waitForTimeout(1500);

  const after = readFile(id)?.meta?.revn ?? 0;
  expect(after, "revn incremented on disk").toBeGreaterThan(before);

  await page.reload();
  await expectCanvasLoaded(page, expect);
});
