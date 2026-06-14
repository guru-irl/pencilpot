import { test, expect } from "@playwright/test";
import { expectCanvasLoaded, trackErrors } from "./helpers.mjs";

const WS = "#/workspace?team-id=0398e5fc-95c9-80d6-8008-29071f0fdaed&file-id=0398e5fc-95c9-80d6-8008-29088f3ee53a";

// The integrated terminal dock is a pencilpot addition (bottom dock, VS Code-style).
// It is headless-safe: the PTY/xterm path is pure DOM + WebSocket (no WebGL), so it
// works in headless Chromium where the canvas-render assertions cannot.
test("integrated terminal: toggle dock, echo round-trips through the PTY", async ({ page }) => {
  const errors = trackErrors(page);

  await page.goto(WS);
  await expectCanvasLoaded(page, expect);

  // Reveal the terminal via the main menu → View → Show terminal.
  // (Deterministic in headless; the Ctrl+` mousetrap shortcut needs canvas focus
  //  which is flaky under automation.)
  await page.getByLabel("Main menu").click({ timeout: 15_000 });
  await page.locator("#file-menu-view").click({ timeout: 10_000 });
  await page.locator("#file-menu-terminal").click({ timeout: 10_000 });

  // The dock and an xterm instance must appear.
  const dock = page.locator('[class*="terminal-dock"]');
  await expect(dock).toBeVisible({ timeout: 15_000 });
  const xterm = page.locator(".xterm");
  await expect(xterm.first()).toBeVisible({ timeout: 15_000 });

  // Focus the terminal and type a marker command.
  await xterm.first().click();
  await page.keyboard.type("echo pencilpot-terminal-ok");
  await page.keyboard.press("Enter");

  // The xterm screen renders the marker — both the echoed input line and the
  // command's output line — so >=2 occurrences proves the PTY round-trip.
  await expect
    .poll(
      async () => {
        const txt = await dock.innerText().catch(() => "");
        return (txt.match(/pencilpot-terminal-ok/g) || []).length;
      },
      { timeout: 15_000, intervals: [250, 500, 1000] },
    )
    .toBeGreaterThanOrEqual(2);

  // Screenshot the dock for the deliverable.
  await page.screenshot({ path: "test-results/terminal-dock.png", fullPage: false });

  const fatal = errors.filter((e) => /Cannot read|undefined is not|TypeError/i.test(e));
  expect(fatal, fatal.join("\n")).toHaveLength(0);
});
