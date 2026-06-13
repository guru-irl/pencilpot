;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS INC Sucursal en España SL

(ns app.main.ui.routes
  (:require
   [app.common.data.macros :as dm]
   [app.config :as cf]
   [app.main.features :as features]
   [app.main.router :as rt]
   [app.main.store :as st]
   [app.util.object :as obj]
   [beicon.v2.core :as rx]
   [cuerdas.core :as str]
   [potok.v2.core :as ptk]))

;; pencilpot: auth/dashboard routes removed; only workspace + viewer are needed.
(def routes
  [["/frame-preview" :frame-preview]

   ["/view" :viewer]

   ["/view/:file-id" :viewer-legacy]

   (when *assert*
     ["/debug/icons-preview" :debug-icons-preview])

   (when *assert*
     ["/debug/playground" :debug-playground])

   ;; Used for export
   ["/render-sprite/:file-id" :render-sprite]

   ["/workspace" :workspace]
   ["/workspace/:project-id/:file-id" :workspace-legacy]])


;; pencilpot: navigate to workspace using window.pencilpotFile when no other route matches.
(defn- nav-to-pencilpot-workspace
  []
  (let [pf      (obj/get js/globalThis "pencilpotFile")
        file-id (some-> pf (obj/get "fileId"))
        team-id (some-> pf (obj/get "teamId"))]
    (when (and file-id team-id)
      (st/emit! (rt/nav :workspace {:file-id file-id :team-id team-id})))))

(defn on-navigate
  [router path send-event-info?]
  (let [location        (.-location js/document)
        [base-path _]   (str/split path "?")
        location-path   (dm/str (.-origin location) (.-pathname location))
        valid-location? (= location-path (dm/str cf/public-uri))
        match           (rt/match router path)
        empty-path?     (or (= base-path "") (= base-path "/"))]

    (cond
      (not valid-location?)
      (st/emit! (rt/assign-exception {:type :not-found}))

      (some? match)
      (st/emit! (rt/navigated match send-event-info?))

      ;; For root or any unknown path (incl. /auth/*) boot straight into the workspace.
      (or empty-path? (not (some? match)))
      (nav-to-pencilpot-workspace))))

(defn init-routes
  []
  (ptk/reify ::init-routes
    ptk/WatchEvent
    (watch [_ _ stream]
      (rx/merge
       (rx/of (rt/initialize-router routes)
              (rt/initialize-history on-navigate))
       (->> stream
            (rx/filter (ptk/type? ::rt/navigated))
            (rx/map deref)
            (rx/map #(dm/get-in % [:query-params :wasm]))
            (rx/buffer 2 1)
            (rx/filter (fn [[v1 v2]] (not= v1 v2)))
            (rx/map features/recompute-features))))))
