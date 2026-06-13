import { test, expect } from "@playwright/test";
import { expectCanvasLoaded, trackErrors } from "./helpers.mjs";

test("no-auth: navigating to /#/auth/login does NOT render a login form", async ({ page }) => {
  const errors = trackErrors(page);

  await page.goto("/#/auth/login");

  // Should NOT show email/password login inputs
  await page.waitForTimeout(3000);
  const emailInput = page.locator('input[type="email"], input[name="email"]');
  const passwordInput = page.locator('input[type="password"], input[name="password"]');

  // Neither input should be visible
  await expect(emailInput).not.toBeVisible({ timeout: 2000 }).catch(() => {});
  await expect(passwordInput).not.toBeVisible({ timeout: 2000 }).catch(() => {});

  // Should not be stuck on an auth URL
  const url = page.url();
  expect(url, "URL should not contain /auth/login after redirect").not.toMatch(/auth\/login/);

  const fatal = errors.filter((e) =>
    /Cannot read|undefined is not|TypeError|failed to fetch/i.test(e)
  );
  expect(fatal, fatal.join("\n")).toHaveLength(0);
});
