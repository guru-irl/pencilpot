// Regression guard: geometry record types (Matrix/Point/Rect) must survive the
// EDN round-trip so the frontend never receives NaN transforms.
//
// Root cause (fixed): `canon` in store.cljs flattened Matrix/Point/Rect
// records to plain maps.  On load, `read-edn` returned plain maps;
// `getFileResponse` transit-encoded them without the ~#matrix/~#point/~#rect
// transit tags; the frontend's matrix math received plain maps → NaN transforms
// → every shape rendered as `matrix(NaN, …)` + the options/design panel showed
// empty dimensions.
//
// Fix: `canon` now wraps geometry records in `GeomTaggedLiteral` which emits
// #penpot/matrix "a,b,c,d,e,f" / #penpot/point "x,y" / #penpot/rect "…".
// `read-edn` reconstructs real Matrix/Point/Rect instances so transit encoding
// emits the correct tagged forms.
//
// This spec asserts:
//   1. ZERO console errors matching `matrix(NaN` (the visible symptom).
//   2. After selecting a shape, the options/design panel shows real numeric
//      dimensions (W/H), not NaN or empty.

import { test, expect } from "@playwright/test";
import { expectCanvasLoaded, trackErrors } from "./helpers.mjs";

const WS =
  "#/workspace?team-id=0398e5fc-95c9-80d6-8008-29071f0fdaed&file-id=0398e5fc-95c9-80d6-8008-29088f3ee53a";

test("render: no matrix(NaN) errors after EDN round-trip", async ({ page }) => {
  const errors = trackErrors(page);

  await page.goto(WS);
  await expectCanvasLoaded(page, expect);

  // Let the workspace fully settle — all shapes should have rendered by now.
  await page.waitForTimeout(3000);

  // Assert zero NaN transform errors.  Before the fix there were hundreds of
  // these in the console for every shape on the page.
  const nanErrors = errors.filter((e) =>
    /matrix\(NaN|attribute (transform|cx|cy|r|width|height)[^:]*NaN/i.test(e)
  );
  expect(
    nanErrors,
    `Found ${nanErrors.length} NaN transform error(s) — geometry records were not preserved through EDN:\n` +
      nanErrors.slice(0, 5).join("\n")
  ).toHaveLength(0);
});

test("render: options panel shows real W/H after selecting a shape", async ({ page }) => {
  const errors = trackErrors(page);

  await page.goto(WS);
  await expectCanvasLoaded(page, expect);

  // Wait for workspace to settle.
  await page.waitForTimeout(2000);

  // Select all shapes so at least one is selected.
  const viewport = page
    .locator('[class*="viewport"], #workspace-viewport, [class*="workspace"]')
    .first();
  await expect(viewport).toBeVisible({ timeout: 15_000 });
  await viewport.click({ position: { x: 200, y: 200 }, force: true });
  await page.waitForTimeout(400);
  await page.keyboard.press("Control+a");
  await page.waitForTimeout(600);

  // The design/options panel on the right should contain numeric width/height
  // inputs.  Before the fix the panel was EMPTY because NaN dimensions cannot
  // be rendered by the Penpot UI.
  //
  // The panel inputs are inside the right sidebar.  We look for an input with a
  // numeric value (not NaN, not empty) in the options/measures section.
  const panelHasNumericDimension = await page.evaluate(() => {
    // Penpot renders the design panel as a set of input[type=number] or
    // span/input elements in the right panel.  We look for any visible input
    // that has a finite numeric value — this proves the panel populated.
    const inputs = Array.from(
      document.querySelectorAll(
        '[class*="options"] input, [class*="design"] input, [class*="element-list"] input, [class*="inspect"] input, aside input'
      )
    );
    return inputs.some((el) => {
      const v = parseFloat(el.value);
      return !isNaN(v) && isFinite(v) && v > 0;
    });
  });

  expect(
    panelHasNumericDimension,
    "Options/design panel has no finite numeric dimension value after selecting shapes — " +
      "panel may be empty due to NaN geometry (matrix(NaN) bug)"
  ).toBe(true);

  // No NaN errors during the session.
  const nanErrors = errors.filter((e) =>
    /matrix\(NaN|attribute (transform|cx|cy|r|width|height)[^:]*NaN/i.test(e)
  );
  expect(
    nanErrors,
    `Found ${nanErrors.length} NaN transform error(s) during options-panel test:\n` +
      nanErrors.slice(0, 5).join("\n")
  ).toHaveLength(0);
});
