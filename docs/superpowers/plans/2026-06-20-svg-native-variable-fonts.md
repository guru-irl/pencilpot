# SVG-Native Variable Fonts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the stable SVG/HTML renderer render variable-font axes (e.g. `slnt`, `wdth`, `opsz`) by loading the VF as a variable `@font-face` and emitting `font-variation-settings` on text — so the wasm renderer is no longer needed for variable fonts.

**Architecture:** Two surgical emissions in the existing SVG text path. (1) `app.main.fonts` already classifies a custom font as `:variable` with `:axes` metadata (built by `data/fonts.cljs prepare-font`); we add a single *variable* `@font-face` (weight/stretch ranges) for those fonts instead of N static faces. (2) `app.main.ui.shapes.text.styles/generate-text-styles` emits `fontVariationSettings` from the text node's existing `:font-variation-settings` map. The runtime metadata, the `fontsdb` population, and the typography axis UI controls are **already implemented** — this plan only adds the SVG render-side emissions.

**Tech Stack:** ClojureScript (shadow-cljs), browser CSS variable fonts, Playwright e2e.

## Global Constraints

- Target the **stable SVG/HTML renderer only**. Do NOT touch `render-wasm/`, the wasm api, or re-enable `&wasm=true`. The launcher default stays SVG.
- `:font-variation-settings` is a map of `tag-string → number`, e.g. `{"slnt" -10 "wdth" 151}`. It lives on the text **leaf node** (the `data` arg of `generate-text-styles`). The `wght` axis is **excluded** from it (driven separately by `:font-weight`).
- An axis map has keys `{:tag <string> :min <number> :max <number> :default <number> :name <string>}`. `:axes` is a vector of these, present on a `:variable` font in `fontsdb`.
- Variable `@font-face`: emit `font-weight: <wght.min> <wght.max>` (default `1 1000` when no wght axis); `font-stretch: <wdth.min>% <wdth.max>%` (or `normal` when no wdth axis); `font-style: normal`; **no `format()` hint** (browser sniffs the served file). All non-weight/width axes are driven per-text via `font-variation-settings`, not via the face.
- **Static (non-variable) custom fonts must keep byte-identical `@font-face` output.** Only `:variable` fonts get the new path.
- No new dependencies. ClojureScript only.
- Unit tests: `cd frontend && clojure -M:dev:shadow-cljs compile test && node target/tests/test.js` (filter noise; look for the `frontend-tests.*` results and `0 failures`).
- Release build (Task 3 only): `cd frontend && clojure -M:dev:shadow-cljs release main worker` → outputs to `frontend/resources/public/js/`.
- Commit after each task.

---

### Task 1: Emit `font-variation-settings` in the SVG text styles

**Files:**
- Modify: `frontend/src/app/main/ui/shapes/text/styles.cljs` (add helper + one `cond->` clause in `generate-text-styles`, ~line 68-160)
- Test: `frontend/test/frontend_tests/text_styles_test.cljs` (create)

**Interfaces:**
- Consumes: the text node `data` map already passed to `generate-text-styles`, which may contain `:font-variation-settings` (`{tag-string → number}`).
- Produces: `app.main.ui.shapes.text.styles/variation-settings->css` — `(variation-settings->css {"slnt" -10 "wdth" 151}) => "\"slnt\" -10, \"wdth\" 151"`; returns `nil` for nil/empty/non-map input.

- [ ] **Step 1: Write the failing test**

Create `frontend/test/frontend_tests/text_styles_test.cljs`:

```clojure
(ns frontend-tests.text-styles-test
  (:require
   [app.main.ui.shapes.text.styles :as sts]
   [cljs.test :as t :include-macros true]))

(t/deftest variation-settings->css-test
  (t/testing "formats a tag->number map as CSS font-variation-settings"
    (t/is (= "\"slnt\" -10, \"wdth\" 151"
             (sts/variation-settings->css {"slnt" -10 "wdth" 151}))))
  (t/testing "single axis"
    (t/is (= "\"opsz\" 40" (sts/variation-settings->css {"opsz" 40}))))
  (t/testing "nil / empty / non-map yields nil"
    (t/is (nil? (sts/variation-settings->css nil)))
    (t/is (nil? (sts/variation-settings->css {})))
    (t/is (nil? (sts/variation-settings->css "x")))))
```

Register the test namespace if the runner uses an explicit list: check `frontend/test/test_main.cljs` (or the `:test` build's entry). If it auto-discovers `frontend-tests.*`, no change is needed; otherwise add `frontend-tests.text-styles-test` to the require/run list exactly as the existing `frontend-tests.fonts-test` is registered.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && clojure -M:dev:shadow-cljs compile test && node target/tests/test.js 2>&1 | grep -A3 -iE "text-styles|var(ying|iation)|fail|error" | head -40`
Expected: FAIL — `variation-settings->css` is not defined (compile error or failing assertion).

- [ ] **Step 3: Add the helper**

In `styles.cljs`, immediately above `(defn generate-text-styles` (~line 68), add:

```clojure
(defn variation-settings->css
  "Turn a {tag-string -> number} map into a CSS `font-variation-settings`
   value: {\"slnt\" -10 \"wdth\" 151} => \"\\\"slnt\\\" -10, \\\"wdth\\\" 151\".
   Returns nil for nil/empty/non-map input (so callers can guard with `some?`)."
  [settings]
  (when (and (map? settings) (seq settings))
    (->> settings
         (map (fn [[tag value]] (str "\"" tag "\" " value)))
         (str/join ", "))))
```

(`cuerdas.core :as str` is already required in this ns.)

- [ ] **Step 4: Wire it into `generate-text-styles`**

In the final `(cond-> base ...)` of `generate-text-styles`, add a clause directly after the `(some? font)` `-> (obj/set! ... "fontWeight" ...)` clause and before the `(= grow-type :auto-width)` clause:

```clojure
       (some? (variation-settings->css (:font-variation-settings data)))
       (obj/set! "fontVariationSettings"
                 (variation-settings->css (:font-variation-settings data)))
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd frontend && clojure -M:dev:shadow-cljs compile test && node target/tests/test.js 2>&1 | grep -iE "text-styles|[0-9]+ failures|[0-9]+ error" | head`
Expected: PASS — the text-styles tests pass; overall `0 failures, 0 errors` for the suite (pre-existing tests unaffected).

- [ ] **Step 6: Commit**

```bash
git add frontend/src/app/main/ui/shapes/text/styles.cljs frontend/test/frontend_tests/text_styles_test.cljs
git commit -m "feat(fonts): emit font-variation-settings in SVG text styles"
```

---

### Task 2: Emit a variable `@font-face` for variable custom fonts

**Files:**
- Modify: `frontend/src/app/main/fonts.cljs` (add helpers + branch `generate-custom-font-css` and the `:custom` branch of `fetch-font-css`, ~line 172-360)
- Test: `frontend/test/frontend_tests/fonts_test.cljs` (extend existing)

**Interfaces:**
- Consumes: a `fontsdb` font map. A variable one looks like `{:family "Google Sans Flex" :variable true :axes [{:tag "wght" :min 100 :max 900 :default 400 :name "Weight"} {:tag "wdth" :min 25 :max 151 :default 100 :name "Width"} {:tag "slnt" :min -10 :max 0 :default 0 :name "Slant"}] :variants [{::app.main.fonts/woff1-file-id "custom-google-sans-flex-w100" ...} ...]}`.
- Produces: `app.main.fonts/generate-variable-font-css` — returns a single `@font-face` string for a `:variable` font. Existing `generate-custom-font-variant-css` is unchanged and still used for non-variable fonts.

- [ ] **Step 1: Write the failing tests**

Append to `frontend/test/frontend_tests/fonts_test.cljs` (inside the ns, after existing tests):

```clojure
(def sample-variable-font
  {:id "custom-google-sans-flex"
   :family "Google Sans Flex"
   :variable true
   :axes [{:tag "wght" :min 100 :max 900 :default 400 :name "Weight"}
          {:tag "wdth" :min 25 :max 151 :default 100 :name "Width"}
          {:tag "slnt" :min -10 :max 0 :default 0 :name "Slant"}]
   :variants [{:id "normal-100" :style "normal" :weight "100"
               :app.main.fonts/woff1-file-id "vf-file-id"}]})

(t/deftest generate-variable-font-css-test
  (let [css (fonts/generate-variable-font-css sample-variable-font)]
    (t/testing "single @font-face for the family"
      (t/is (= 1 (count (re-seq #"@font-face" css))))
      (t/is (re-find #"font-family: 'Google Sans Flex'" css)))
    (t/testing "wght axis -> font-weight range"
      (t/is (re-find #"font-weight: 100 900" css)))
    (t/testing "wdth axis -> font-stretch percent range"
      (t/is (re-find #"font-stretch: 25% 151%" css)))
    (t/testing "no format() hint (browser sniffs)"
      (t/is (not (re-find #"format\(" css))))
    (t/testing "src points at the single VF file id"
      (t/is (re-find #"vf-file-id" css)))))

(t/deftest variable-font-without-axes-defaults-test
  (let [css (fonts/generate-variable-font-css
             {:family "X" :variable true :axes []
              :variants [{:app.main.fonts/woff1-file-id "id1"}]})]
    (t/is (re-find #"font-weight: 1 1000" css))
    (t/is (re-find #"font-stretch: normal" css))))
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && clojure -M:dev:shadow-cljs compile test && node target/tests/test.js 2>&1 | grep -iE "variable-font|generate-variable|fail|error" | head`
Expected: FAIL — `generate-variable-font-css` is not defined.

- [ ] **Step 3: Add the helpers**

In `fonts.cljs`, in the `;; --- LOADER: CUSTOM` section, directly after `generate-custom-font-variant-css` (~line 195), add:

```clojure
(def variable-font-face-template
  "@font-face {
    font-family: '%(family)s';
    font-style: normal;
    font-weight: %(weight)s;
    font-stretch: %(stretch)s;
    font-display: block;
    src: url(%(uri)s);
  }")

(defn- axis-by-tag
  [axes tag]
  (d/seek #(= tag (:tag %)) axes))

(defn- vf-weight-range
  "CSS font-weight range from the wght axis, or a permissive default."
  [axes]
  (if-let [a (axis-by-tag axes "wght")]
    (str (:min a) " " (:max a))
    "1 1000"))

(defn- vf-stretch-range
  "CSS font-stretch percent range from the wdth axis, or `normal`."
  [axes]
  (if-let [a (axis-by-tag axes "wdth")]
    (str (:min a) "% " (:max a) "%")
    "normal"))

(defn generate-variable-font-css
  "A single variable @font-face for a `:variable` custom font. The wght/wdth
   axes become CSS font-weight/font-stretch RANGES so the browser exposes the
   axis range; all other axes (slnt, opsz, GRAD, ...) are driven per-text via
   `font-variation-settings` (see text/styles.cljs). No format() hint is emitted
   so the browser sniffs the served file."
  [{:keys [family axes variants]}]
  (let [variant (first variants)]
    (str/fmt variable-font-face-template
             {:family family
              :weight (vf-weight-range axes)
              :stretch (vf-stretch-range axes)
              :uri (asset-id->uri (::woff1-file-id variant))})))
```

(`app.common.data :as d` and `cuerdas.core :as str` are already required.)

- [ ] **Step 4: Branch the two CSS generators on `:variable`**

Replace `generate-custom-font-css` (~line 197) with:

```clojure
(defn- generate-custom-font-css
  [{:keys [family variants variable] :as font}]
  (if variable
    (generate-variable-font-css font)
    (->> variants
         (map #(generate-custom-font-variant-css family %))
         (str/join "\n"))))
```

In `fetch-font-css`, replace the `(= :custom backend)` branch body so variable fonts return the variable face:

```clojure
      (= :custom backend)
      (rx/of (if (:variable font)
               (generate-variable-font-css font)
               (generate-custom-font-variant-css
                family (get-variant font font-variant-id))))
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd frontend && clojure -M:dev:shadow-cljs compile test && node target/tests/test.js 2>&1 | grep -iE "variable-font|generate-variable|[0-9]+ failures|[0-9]+ error" | head`
Expected: PASS — new tests pass; existing `fonts-test` assertions still pass (`0 failures`).

- [ ] **Step 6: Commit**

```bash
git add frontend/src/app/main/fonts.cljs frontend/test/frontend_tests/fonts_test.cljs
git commit -m "feat(fonts): load variable custom fonts as a variable @font-face"
```

---

### Task 3: Rebuild frontend + end-to-end SVG-mode axis verification

**Files:**
- Create: `pencilpot/e2e/vf/vf-render-svg.mjs` (adapt from `pencilpot/e2e/vf/vf-render.mjs`)
- No source changes (integration gate for Tasks 1-2).

**Interfaces:**
- Consumes: `generate-variable-font-css` (Task 2) and `fontVariationSettings` emission (Task 1), now compiled into `frontend/resources/public/js/`.
- Produces: a passing SVG-mode axis-render check on the real `pencilpot-vftest` file (no wasm).

- [ ] **Step 1: Build the frontend release bundle**

Run: `cd frontend && clojure -M:dev:shadow-cljs release main worker 2>&1 | tail -20`
Expected: build completes, `Build completed` / writes `resources/public/js/main.js` (no compile errors). This is slow (minutes) — allow up to ~15 min.

- [ ] **Step 2: Write the SVG-mode e2e harness**

Read `pencilpot/e2e/vf/vf-render.mjs`, `seed.mjs`, and `shoot.mjs` first to reuse their seeding + server-boot helpers. Create `pencilpot/e2e/vf/vf-render-svg.mjs` that:
- Seeds two copies of the vftest design whose single text leaf differs ONLY in `:font-variation-settings` — variant A `{"wdth" 25}`, variant B `{"wdth" 151}` (use the same seeding mechanism `vf-render.mjs` already uses).
- Boots a pencilpot runtime per copy (reuse the existing boot helper).
- Opens the workspace URL **without** `&wasm=true` (stable SVG renderer).
- Waits for the text to render: `await page.evaluate(() => document.fonts.ready)` then a short settle; assert there is **no** `<canvas>` driving the viewport (SVG mode) — `await page.locator('canvas').count()` is 0 or the viewport is SVG.
- Screenshots the rendered text element's bounding box for A and B (`page.locator(<text selector>).screenshot()` — works in SVG mode because the page goes idle, unlike wasm).
- Computes RMSE(A,B) (reuse the RMSE helper in `shoot.mjs`/`vf-render.mjs`).
- Asserts `RMSE > 1.0` (width 25 vs 151 is a large visible difference) → axes render.
- Asserts the VF file (`custom-google-sans-flex*`) appears in the page's network requests (font was fetched).
- Prints `PASS`/`FAIL` and exits non-zero on FAIL.

- [ ] **Step 3: Run the SVG-mode axis check**

Run: `cd pencilpot && node e2e/vf/vf-render-svg.mjs 2>&1 | tail -15`
Expected: `PASS` — RMSE well above 1.0, VF fetched true, 0 canvas.

- [ ] **Step 4: Regression — static custom font still loads**

Confirm the unit suite still proves non-variable output is unchanged:
Run: `cd frontend && node target/tests/test.js 2>&1 | grep -iE "[0-9]+ failures|[0-9]+ error" | tail`
Expected: `0 failures, 0 errors`. (The existing `fonts-test` covers static custom `@font-face` output; it must remain green.)

- [ ] **Step 5: Commit**

```bash
git add pencilpot/e2e/vf/vf-render-svg.mjs
git commit -m "test(vf): SVG-mode variable-font axis render e2e"
```

---

## Self-Review

**Spec coverage:** Task 1 → `font-variation-settings` emission (the slnt/wdth/opsz render). Task 2 → variable `@font-face` (the variable face the axes act on). Task 3 → end-to-end proof on the real file + static-font regression. All three gaps from the diagnosis are covered.

**Placeholder scan:** All code blocks are complete. Task 3 Step 2 describes adapting an existing harness rather than pasting it verbatim (the harness API isn't fully known without reading the files) — the implementer must read `vf-render.mjs`/`seed.mjs`/`shoot.mjs` and reuse their helpers; the assertion contract is fully specified.

**Type consistency:** `variation-settings->css` takes `{tag-string→number}` (from the node), returns string|nil. `generate-variable-font-css` takes a `fontsdb` font map (`:family`/`:axes`/`:variants`), returns a string. `axis-by-tag`/`vf-weight-range`/`vf-stretch-range` operate on the `:axes` vector with `{:tag :min :max}` keys — consistent with the runtime encoding and the typography UI.

---

## Task 4 (added after Task 3 gate failed): close the `svg_text` / `position-data` path

**Why:** The Task 3 gate proved the visible workspace text is painted by `svg_text.cljs` from the
shape's `:position-data`, NOT by `generate-text-styles` (which only feeds the off-screen html
measurement overlay). `position-data` is regenerated from the live DOM by `tsp/calc-position-data`
(`text_svg_position.cljs`) — but only when the shape changed or `:position-data` is nil
(`viewport_texts_html.cljs text-change?`). So: an **axis edit** changes content → regenerates
`position-data`, and the fix flows through. The chain needs the variation value carried through
measurement → `position-data` → `svg_text`.

**Files:**
- Modify: `frontend/src/app/util/text_svg_position.cljs` (`calc-position-data` `transform-data`, ~line 92-110)
- Modify: `frontend/src/app/main/ui/shapes/text/svg_text.cljs` (the `<text>` `:style` `#js`, ~line 80-92)
- Modify: `pencilpot/e2e/vf/vf-render-svg.mjs` (force regeneration by seeding `:position-data` nil)

- [ ] **4.1** In `transform-data`'s map literal, after the `:font-style` entry, add:
```clojure
                     :font-variation-settings
                     (let [v (get-prop styles "font-variation-settings")]
                       (when (and (some? v) (not= v "normal")) v))
```
(Do NOT wrap in `dm/str` — nil must propagate so the surrounding `(into position (filter val) {...})`
drops it when absent. `get-prop` reads the browser-normalized computed CSS string, e.g. `"wdth" 25`.)

- [ ] **4.2** In `svg_text.cljs`, in the `<text>` `:style` `#js` map, after `:fontStyle (:font-style data)`, add:
```clojure
                                             :fontVariationSettings (:font-variation-settings data)
```
(When nil, React omits it — non-variable text is unaffected.)

- [ ] **4.3** In `vf-render-svg.mjs`, strip stored `:position-data` (set nil / remove it) on the text
shape of EACH seeded copy, so the workspace regenerates `position-data` from the content tree (which
carries `:font-variation-settings`). The bare stored rect must not be used. After `document.fonts.ready`,
poll up to ~12s until the VF asset (`custom-google-sans-flex`) is fetched (regeneration is async:
measurement → `update-position-data` → re-render), then settle and screenshot.

- [ ] **4.4** Rebuild: `cd frontend && clojure -M:dev:shadow-cljs release main worker`.

- [ ] **4.5** Run `cd pencilpot && node e2e/vf/vf-render-svg.mjs` → PASS (RMSE>1.0, canvas 0, VF fetched true).

- [ ] **4.6** Regression: `cd frontend && clojure -M:dev:shadow-cljs compile test && node target/tests/test.js` → `0 failures`.

- [ ] **4.7** Commit (`feat(fonts): render variable-font axes in the SVG text path`).
