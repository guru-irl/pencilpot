import { test, expect } from "@playwright/test";
import { expectCanvasLoaded, trackErrors } from "./helpers.mjs";

test("boot-direct: navigate to root / and land in workspace without get-profile", async ({ page }) => {
  const errors = trackErrors(page);

  // Track forbidden auth-layer API requests.
  // get-profile (exact command) is the root of the auth machinery we deleted.
  // Note: get-profiles-for-file-comments is a different command and is allowed.
  // Note: get-teams may still be called by team-container for data loading — that's OK.
  const profileRequests = [];
  page.on("request", (r) => {
    const url = r.url();
    // Match only the exact get-profile command (not get-profiles-for-file-comments etc.)
    if (/\/api\/[^?]*\/get-profile(\?|$)/.test(url)) {
      profileRequests.push(url);
    }
  });

  // Navigate to root — no hash, no workspace URL
  await page.goto("/");

  // Should end up in the workspace (canvas visible, not bounced to /auth/login)
  await expectCanvasLoaded(page, expect);

  // Zero get-profile calls (that was the auth gate we deleted)
  expect(profileRequests, "get-profile was requested: " + profileRequests.join(", "))
    .toHaveLength(0);

  const fatal = errors.filter((e) =>
    /Cannot read|undefined is not|TypeError|failed to fetch/i.test(e)
  );
  expect(fatal, fatal.join("\n")).toHaveLength(0);
});

test("no-collab: no websocket connection to /ws/notifications after boot", async ({ page }) => {
  const wsUrls = [];
  page.on("websocket", (ws) => wsUrls.push(ws.url()));

  await page.goto("/");
  await expectCanvasLoaded(page, expect);

  // Give any deferred ws init a moment to fire
  await page.waitForTimeout(3000);

  const notifWs = wsUrls.filter((u) => u.includes("/ws/notifications"));
  expect(notifWs, "unexpected websocket to /ws/notifications: " + notifWs.join(", "))
    .toHaveLength(0);
});
