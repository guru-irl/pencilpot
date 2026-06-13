// Regression guard: unhandled RPCs must not crash the workspace.
//
// The bug: SPA posts /api/main/methods/update-profile-props after any
// interaction (e.g. create-board + move); the old runtime returned 404
// "no stub: update-profile-props"; Penpot's repo layer raises
// :unable-to-process-repository-response on ANY non-2xx → workspace
// crashes with an "Internal Error" screen.
//
// Fix: unknown RPCs now return HTTP 200 with an empty transit map.
// This spec asserts that directly and also checks no internal-error
// overlay appeared.

import { test, expect } from "@playwright/test";
import { expectCanvasLoaded, trackErrors } from "./helpers.mjs";

const WS =
  "#/workspace?team-id=0398e5fc-95c9-80d6-8008-29071f0fdaed&file-id=0398e5fc-95c9-80d6-8008-29088f3ee53a";

test("no-crash: unhandled RPC update-profile-props returns 200 and does not crash the workspace", async ({
  page,
}) => {
  const errors = trackErrors(page);

  await page.goto(WS);
  await expectCanvasLoaded(page, expect);

  // Wait for workspace to fully settle.
  await page.waitForTimeout(1000);

  // Directly fire the RPC that previously caused the crash.
  const status = await page.evaluate(async () => {
    const r = await fetch("/api/main/methods/update-profile-props", {
      method: "POST",
      headers: {
        "content-type": "application/transit+json",
        accept: "application/transit+json",
      },
      body: '["^ "]',
    });
    return r.status;
  });

  expect(status).toBe(200);

  // Give Penpot time to process the response and potentially crash.
  await page.waitForTimeout(500);

  // Assert the "Internal Error" overlay did NOT appear.
  const errorOverlay = page.locator(
    '[class*="error"], [class*="internal-error"], [data-error]'
  );
  // Filter to overlays that contain the crash message text.
  const crashOverlay = page.getByText(/internal error|unable.to.process/i);
  await expect(crashOverlay).not.toBeVisible({ timeout: 2000 });

  // Also check captured console errors for the repo crash string.
  const repoErrors = errors.filter((e) =>
    /unable-to-process-repository-response|Internal Error/i.test(e)
  );
  expect(repoErrors, repoErrors.join("\n")).toHaveLength(0);
});

test("no-crash: several unhandled RPC commands all return 200", async ({ page }) => {
  const errors = trackErrors(page);

  await page.goto(WS);
  await expectCanvasLoaded(page, expect);
  await page.waitForTimeout(500);

  // Test a range of fire-and-forget SaaS RPCs that the SPA may call.
  const commands = [
    "update-profile-props",
    "create-team-presence",
    "update-team-presence",
    "audit",
  ];

  const statuses = await page.evaluate(async (cmds) => {
    const results = {};
    for (const cmd of cmds) {
      const r = await fetch(`/api/main/methods/${cmd}`, {
        method: "POST",
        headers: {
          "content-type": "application/transit+json",
          accept: "application/transit+json",
        },
        body: '["^ "]',
      });
      results[cmd] = r.status;
    }
    return results;
  }, commands);

  for (const [cmd, status] of Object.entries(statuses)) {
    expect(status, `${cmd} should return 200 not ${status}`).toBe(200);
  }

  await page.waitForTimeout(500);

  const repoErrors = errors.filter((e) =>
    /unable-to-process-repository-response|Internal Error/i.test(e)
  );
  expect(repoErrors, repoErrors.join("\n")).toHaveLength(0);
});
