;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS INC Sucursal en España SL

(ns frontend-tests.fonts-test
  (:require
   [app.main.fonts :as fonts]
   [cljs.test :as t :include-macros true]))

(def sample-font
  {:id "sourcesanspro"
   :name "Source Sans Pro"
   :family "sourcesanspro"
   :variants
   [{:id "200"
     :name "200"
     :weight "200"
     :style "normal"
     :suffix "extralight"
     :ttf-url "sourcesanspro-extralight.ttf"}
    {:id "200italic"
     :name "200 Italic"
     :weight "200"
     :style "italic"
     :suffix "extralightitalic"
     :ttf-url "sourcesanspro-extralightitalic.ttf"}
    {:id "300"
     :name "300"
     :weight "300"
     :style "normal"
     :suffix "light"
     :ttf-url "sourcesanspro-light.ttf"}
    {:id "300italic"
     :name "300 Italic"
     :weight "300"
     :style "italic"
     :suffix "lightitalic"
     :ttf-url "sourcesanspro-lightitalic.ttf"}
    {:id "regular"
     :name "400"
     :weight "400"
     :style "normal"
     :ttf-url "sourcesanspro-regular.ttf"}
    {:id "italic"
     :name "400 Italic"
     :weight "400"
     :style "italic"
     :ttf-url "sourcesanspro-italic.ttf"}
    {:id "bold"
     :name "700"
     :weight "700"
     :style "normal"
     :ttf-url "sourcesanspro-bold.ttf"}
    {:id "bolditalic"
     :name "700 Italic"
     :weight "700"
     :style "italic"
     :ttf-url "sourcesanspro-bolditalic.ttf"}
    {:id "black"
     :name "900"
     :weight "900"
     :style "normal"
     :ttf-url "sourcesanspro-black.ttf"}
    {:id "blackitalic"
     :name "900 Italic"
     :weight "900"
     :style "italic"
     :ttf-url "sourcesanspro-blackitalic.ttf"}]
   :backend :builtin})

(t/deftest find-closest-weight-variant-test
  (t/testing "finds exact weight match"
    (let [result (fonts/find-closest-variant sample-font "400" nil)]
      (t/is (= "400" (:weight result)))
      (t/is (= "normal" (:style result)))))

  (t/testing "finds exact weight match with style"
    (let [result (fonts/find-closest-variant sample-font "400" "italic")]
      (t/is (= "400" (:weight result)))
      (t/is (= "italic" (:style result)))))

  (t/testing "chooses higher weight when exactly between two weights"
    (let [result (fonts/find-closest-variant sample-font "350" nil)]
      (t/is (= "400" (:weight result)))))

  (t/testing "finds exact weight match with style"
    (let [result (fonts/find-closest-variant sample-font "350" "italic")]
      (t/is (= "400" (:weight result)))
      (t/is (= "italic" (:style result)))))

  (t/testing "finds closest weight below minimum available"
    (let [result (fonts/find-closest-variant sample-font "0" nil)]
      (t/is (= "200" (:weight result)))))

  (t/testing "finds closest weight above maximum available"
    (let [result (fonts/find-closest-variant sample-font "1000" nil)]
      (t/is (= "900" (:weight result)))))

  (t/testing "keeps the closest weight match when style is not found"
    (let [font {:id "sourcesanspro"
                :name "Source Sans Pro"
                :family "sourcesanspro"
                :variants
                [{:id "200italic"
                  :name "200 Italic"
                  :weight "200"
                  :style "italic"
                  :suffix "extralightitalic"
                  :ttf-url "sourcesanspro-extralightitalic.ttf"}
                 {:id "300"
                  :name "300"
                  :weight "300"
                  :style "normal"
                  :suffix "light"
                  :ttf-url "sourcesanspro-light.ttf"}
                 {:id "300italic"
                  :name "300 Italic"
                  :weight "300"
                  :style "italic"
                  :suffix "lightitalic"
                  :ttf-url "sourcesanspro-lightitalic.ttf"}]}
          result (fonts/find-closest-variant font "200" nil)]
      (t/is (= "200" (:weight result)))
      (t/is (= "italic" (:style result))))))

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
