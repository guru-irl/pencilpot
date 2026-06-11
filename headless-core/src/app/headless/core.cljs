(ns app.headless.core
  (:require
   [app.common.types.shape :as cts]
   [app.common.files.changes-builder :as pcb]
   [app.common.transit :as t]
   [app.common.uuid :as uuid]
   [app.common.geom.matrix]
   [app.common.geom.point]
   [clojure.walk :as walk]))

;; `clj->js` does not know how to convert cljs.core/UUID records, so they would
;; otherwise leak through as opaque record objects ({rd, V, C, $}). Stringify
;; every UUID before handing the data to `clj->js` so the JSON carries plain
;; uuid strings.
(defn- stringify-uuids
  [data]
  (walk/postwalk (fn [x] (if (uuid? x) (str x) x)) data))

;; NOTE on key-casing: the JSON args come in camelCase (pageId, fileId,
;; sessionId, ...). `(js->clj ... :keywordize-keys true)` produces camelCase
;; KEYWORDS (:pageId, :fileId, ...), NOT kebab-case. So we destructure the
;; actual camelCase keyword names the JSON produces.
(defn- add-board-change
  [{:keys [pageId x y width height name parentId frameId]}]
  (let [board-id (uuid/next)
        pid      (uuid/uuid pageId)
        parent   (if parentId (uuid/uuid parentId) uuid/zero)
        frame    (if frameId (uuid/uuid frameId) uuid/zero)
        shape    (cts/setup-shape
                  {:id board-id :type :frame :name (or name "Board")
                   :x x :y y :width width :height height
                   :parent-id parent :frame-id frame})
        changes  (-> (pcb/empty-changes nil pid)
                     (pcb/with-page-id pid)
                     (pcb/with-objects {})
                     (pcb/add-object shape))]
    (:redo-changes changes)))

(defn ^:export build-add-board-change
  [args-json]
  (let [args (js->clj (js/JSON.parse args-json) :keywordize-keys true)
        redo (add-board-change args)]
    (js/JSON.stringify (clj->js (stringify-uuids redo)))))

(defn ^:export build-add-board-body
  [args-json]
  (let [{:keys [fileId sessionId revn vern features] :as args}
        (js->clj (js/JSON.parse args-json) :keywordize-keys true)
        redo   (add-board-change args)
        params {:id (uuid/uuid fileId)
                :session-id (uuid/uuid sessionId)
                :revn revn
                :vern vern
                :features (set features)
                :changes redo}]
    (t/encode-str params)))
