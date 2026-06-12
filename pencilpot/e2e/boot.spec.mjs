import { test, expect } from "@playwright/test";
import { expectCanvasLoaded, trackErrors } from "./helpers.mjs";

const WS = "#/workspace?team-id=0398e5fc-95c9-80d6-8008-29071f0fdaed&file-id=0398e5fc-95c9-80d6-8008-29088f3ee53a";

test("boot: designer renders a real file from the EDN store", async ({ page }) => {
  const errors = trackErrors(page);

  // Register the disk-served get-file waiter BEFORE navigation so the response is not missed.
  // Using waitForResponse ensures we await the event even if the canvas renders before it fires.
  const diskGetFile = page.waitForResponse(
    (r) =>
      r.url().includes("get-file") &&
      !r.url().includes("libraries") &&
      !r.url().includes("thumbnail") &&
      r.headers()["x-pencilpot-source"] === "disk",
    { timeout: 30_000 }
  );

  await page.goto(WS);
  await expectCanvasLoaded(page, expect);

  // Await the response promise — throws if no disk-served get-file arrived within timeout.
  await diskGetFile;

  const fatal = errors.filter((e) => /Cannot read|undefined is not|TypeError|failed to fetch/i.test(e));
  expect(fatal, fatal.join("\n")).toHaveLength(0);
});
