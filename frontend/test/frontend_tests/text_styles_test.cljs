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
