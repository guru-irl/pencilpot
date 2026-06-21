;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS INC Sucursal en España SL

(ns app.main.data.pencilpot
  "Native pencilpot manual-save integration: save status, Ctrl/Cmd+S, the
   external-change notification and the File>Rename trigger. Replaces the former
   injected save-manager script. Active only when the served config.js set
   globalThis.pencilpotFile (same signal app.main.ui.routes uses)."
  (:require
   [app.main.data.notifications :as ntf]
   [app.main.store :as st]
   [app.util.object :as obj]))

(defn enabled?
  "True when the runtime exposed globalThis.pencilpotFile (filesystem mode)."
  []
  (some? (obj/get js/globalThis "pencilpotFile")))

;; {:dirty bool :saving bool} — plain atom so the header can mf/deref it.
(defonce status (atom {:dirty false :saving false}))

;; Bumped to ask the header to enter file-name editing (File > Rename).
(defonce rename-request (atom 0))

(defn request-rename!
  "Bump the rename-request tick to ask the header to enter rename mode."
  []
  (swap! rename-request inc))

(defn save!
  "Flush the working copy to disk via POST /pencilpot/save. No-op unless the
   document is dirty and a save is not already in flight."
  []
  (let [{:keys [dirty saving]} @status]
    (when (and dirty (not saving))
      (swap! status assoc :saving true)
      (-> (js/fetch "/pencilpot/save" #js {:method "POST"})
          (.then  (fn [res]
                    (if (.-ok res)
                      ;; Clear the in-flight flag FIRST, then reconcile :dirty
                      ;; from the server's authoritative status.  If a
                      ;; concurrent update-file staged a late edit during this
                      ;; save, its dirty=true echo was suppressed by on-status
                      ;; while :saving was set; this GET runs after :saving
                      ;; clears and captures that edit instead of forcing a
                      ;; stale "Saved" (which would let beforeunload drop it).
                      (do (swap! status assoc :saving false :dirty false)
                          (-> (js/fetch "/pencilpot/status")
                              (.then (fn [r] (.json r)))
                              (.then (fn [s] (swap! status assoc :dirty (boolean (obj/get s "dirty")))))
                              (.catch (fn [_] nil))))
                      (do (swap! status assoc :saving false)
                          (js/alert "pencilpot: save failed — check the runtime log.")))))
          (.catch (fn [_]
                    (swap! status assoc :saving false)
                    (js/alert "pencilpot: save failed — check the runtime log.")))))))

(defn- on-status
  [ev]
  (let [data (js/JSON.parse (obj/get ev "data"))]
    ;; ignore status echoes while our own save is in flight
    (when-not (:saving @status)
      (swap! status assoc :dirty (boolean (obj/get data "dirty"))))))

(defn- on-reload
  [_ev]
  ;; external CLI/MCP edit on disk — offer a reload (no auto-reload: it would
  ;; throw away in-progress UI state).
  (st/emit!
   (ntf/dialog
    :content "pencilpot: this file changed on disk. Reload to see the latest version?"
    :controls :inline-actions
    :accept {:label "Reload"
             :callback #(.reload (.-location js/window))}
    :cancel {:label "Dismiss"
             :callback #(st/emit! (ntf/hide :tag :pencilpot-external))}
    :tag :pencilpot-external)))

(defonce ^:private started? (atom false))

(defn start-client!
  "Idempotent: when enabled?, open the SSE channel to /pencilpot/live and bind
   Ctrl/Cmd+S and beforeunload. Safe to call multiple times."
  []
  (when (and (enabled?) (not @started?))
    (reset! started? true)
    (let [es (js/EventSource. "/pencilpot/live")]
      (.addEventListener es "status" on-status)
      (.addEventListener es "reload" on-reload))
    (.addEventListener
     js/window "keydown"
     (fn [e]
       (when (and (or (.-ctrlKey e) (.-metaKey e)) (not (.-altKey e))
                  (or (= (.-key e) "s") (= (.-key e) "S")))
         (.preventDefault e)
         (.stopPropagation e)
         (save!)))
     true)
    (.addEventListener
     js/window "beforeunload"
     (fn [e]
       (when (:dirty @status)
         (set! (.-returnValue e) "")
         "")))))
