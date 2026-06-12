import { test, expect } from "@playwright/test";
import { expectCanvasLoaded, trackErrors } from "./helpers.mjs";
import fs from "node:fs";

const WS = fs.readFileSync(new URL("./workspace-url.txt", import.meta.url), "utf8").trim();

test("serve: canvas renders with get-file produced from disk by the engine", async ({ page }) => {
  trackErrors(page);
  let servedFromDisk = false;
  page.on("response", (r) => {
    if (r.url().includes("get-file") && !r.url().includes("libraries") && !r.url().includes("thumbnail")
        && r.headers()["x-pencilpot-source"] === "disk") servedFromDisk = true;
  });
  await page.goto(WS);
  await expectCanvasLoaded(page, expect);
  expect(servedFromDisk, "get-file was served from disk via headless-core").toBe(true);
});
