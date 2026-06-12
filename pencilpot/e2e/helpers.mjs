// Shared helpers for driving + asserting the Penpot SPA via Playwright.

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
