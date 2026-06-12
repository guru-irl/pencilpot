// Shared helpers for driving + asserting the Penpot SPA via Playwright.
export const ADMIN = { email: "hl@penpot.local", password: "penpot1234" };

// Log into penpot-hl through our proxy (only needed in proxy/record mode).
// Penpot uses hash routing (/#/auth/login).
// Form: input[type=email] placeholder="Work email", input[type=password] placeholder="Password",
// button[type=submit] text="Continue".
export async function login(page) {
  await page.goto("/#/auth/login");
  await page.locator("input[type=email]").fill(ADMIN.email);
  await page.locator("input[type=password]").fill(ADMIN.password);
  await page.getByRole("button", { name: /continue/i }).click();
  await page.waitForURL(/dashboard/i, { timeout: 30_000 });
}

// Assert we are in the workspace canvas (NOT bounced to login) and the file rendered.
export async function expectCanvasLoaded(page, expect) {
  await expect(page).not.toHaveURL(/auth\/login/i);
  const viewport = page.locator('[class*="viewport"], #workspace-viewport, [class*="workspace"]');
  await expect(viewport.first()).toBeVisible({ timeout: 30_000 });
}

// Capture console + page errors so a spec can assert no FATAL errors.
export function trackErrors(page) {
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(String(e)));
  return errors;
}
