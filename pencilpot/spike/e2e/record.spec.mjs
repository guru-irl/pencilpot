import { test, expect } from "@playwright/test";
import { login, trackErrors } from "./helpers.mjs";
import fs from "node:fs";

test("record: login, open the test file, nudge a shape", async ({ page }) => {
  trackErrors(page);
  await login(page);
  // Penpot dashboard shows files as cards; double-click opens the workspace.
  await page.getByText(/Headless Test File/i).first().dblclick();
  await page.waitForURL(/workspace/i, { timeout: 30_000 });
  const u = new URL(page.url());
  fs.writeFileSync(new URL("./workspace-url.txt", import.meta.url), u.hash || (u.pathname + u.search));
  await page.waitForTimeout(4000);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Control+a");
  for (let i = 0; i < 5; i++) await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(3000);
});
