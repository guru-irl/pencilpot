import { test, expect } from "@playwright/test";
import { expectCanvasLoaded, trackErrors } from "./helpers.mjs";

const WS = "#/workspace?team-id=0398e5fc-95c9-80d6-8008-29071f0fdaed&file-id=0398e5fc-95c9-80d6-8008-29088f3ee53a";

test("our own self-built bundle renders a file from the EDN store (no penpot-hl)", async ({ page }) => {
  const errors = trackErrors(page);
  let upstreamHit = false;
  page.on("request", (r) => { if (r.url().includes(":9101")) upstreamHit = true; });
  let indexFromUs = false;
  page.on("response", (r) => { if (r.url().endsWith("/") || r.url().includes("index.html")) indexFromUs = r.status() === 200; });
  await page.goto(WS);
  await expectCanvasLoaded(page, expect);
  expect(upstreamHit, "no request hit penpot-hl :9101").toBe(false);
  const fatal = errors.filter((e) => /Cannot read|undefined is not|TypeError|failed to fetch/i.test(e));
  expect(fatal, fatal.join("\n")).toHaveLength(0);
});
