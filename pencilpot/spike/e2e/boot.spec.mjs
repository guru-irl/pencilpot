import { test, expect } from "@playwright/test";
import { expectCanvasLoaded, trackErrors } from "./helpers.mjs";
import fs from "node:fs";

const WS = fs.readFileSync(new URL("./workspace-url.txt", import.meta.url), "utf8").trim();

test("boot: SPA renders the canvas from replayed fixtures", async ({ page }) => {
  const errors = trackErrors(page);
  const apiHits = [];
  page.on("request", (r) => { if (r.url().includes("/api/")) apiHits.push(new URL(r.url()).pathname); });

  await page.goto(WS);
  await expectCanvasLoaded(page, expect);

  expect(apiHits.length, "the SPA made API calls").toBeGreaterThan(0);
  const fatal = errors.filter((e) => /Cannot read|undefined is not|TypeError|failed to fetch/i.test(e));
  expect(fatal, `fatal console errors: ${fatal.join("\n")}`).toHaveLength(0);
});
