(ns app.headless.session
  (:require
   [app.common.types.shape :as cts]              ; setup-shape (geometry)
   [app.common.files.changes :as cfc]            ; process-changes (apply to file-data)
   [app.common.files.validate :as cfv]           ; validate-file-schema! (parity oracle)
   [app.common.types.file :as ctf]               ; make-file-data
   [app.common.transit :as t]                    ; decode-str / encode-str (wire + record handlers)
   [app.common.uuid :as uuid]
   [app.common.geom.matrix]                       ; side-effect: transit handler
   [app.common.geom.point]                        ; side-effect: transit handler
   [clojure.walk :as walk]))

(def ^:private root-frame uuid/zero)              ; page root frame id

;; --- helpers ---------------------------------------------------------------
(defn- stringify-uuids [x] (walk/postwalk #(if (uuid? %) (str %) %) x))
(defn- ->plain-js [x] (-> x stringify-uuids clj->js))
(defn- args [json] (js->clj (js/JSON.parse json) :keywordize-keys true))

(defn- empty-data []
  ;; a single-page empty file-data with a page whose root frame is uuid/zero.
  ;; `make-file-data` seeds :pages / :pages-index and (via make-empty-page)
  ;; puts the ROOT FRAME shape at uuid/zero into the page's :objects, so an
  ;; :add-obj with :parent-id=uuid/zero is valid.
  (let [page-id (uuid/next)]
    (-> (ctf/make-file-data (uuid/next) page-id)  ; (file-id page-id) -> data w/ that page
        (with-meta {::page-id page-id}))))

(defn- page-id-of [data] (-> data meta ::page-id))

;; Build + apply + record one :add-obj change (mirrors files.builder/commit-shape).
(defn- add-shape! [state shape]
  (let [{:keys [page-id frame-id]} @state
        change {:type :add-obj :id (:id shape) :page-id page-id
                :parent-id (:parent-id shape) :frame-id frame-id :obj shape}]
    (swap! state #(-> %
                      (update :data cfc/process-changes [change] false)
                      (update :changes conj change)))
    (str (:id shape))))

(defn- mk-shape [state type {:keys [x y width height name parentId fills strokes]}]
  (let [{:keys [stack frame-id]} @state
        valid-fills   (when (seq fills)
                        (into [] (keep (fn [f]
                                         (when (:fillColor f)
                                           {:fill-color    (:fillColor f)
                                            :fill-opacity  (or (:fillOpacity f) 1)}))) fills))
        valid-strokes (when (seq strokes)
                        (mapv (fn [s]
                                {:stroke-color     (:strokeColor s)
                                 :stroke-opacity   (or (:strokeOpacity s) 1)
                                 :stroke-width     (or (:strokeWidth s) 1)
                                 :stroke-style     (keyword (or (:strokeStyle s) "solid"))
                                 :stroke-alignment (keyword (or (:strokeAlignment s) "center"))})
                              strokes))]
    (cts/setup-shape
     (cond-> {:id (uuid/next) :type type :name (or name (clojure.core/name type))
              :x x :y y :width width :height height
              :parent-id (if parentId (uuid/parse parentId) (peek stack))
              :frame-id frame-id}
       (seq valid-fills)   (assoc :fills valid-fills)
       (seq valid-strokes) (assoc :strokes valid-strokes)))))

;; --- the JS-facing session object ------------------------------------------
(defn- make-session [state file-id features]
  #js {:addBoard
       (fn [json]
         (let [shape (mk-shape state :frame (args json))
               id    (add-shape! state shape)]
           ;; entering a board: push it as the parent + active frame
           (swap! state #(-> % (update :stack conj (:id shape)) (assoc :frame-id (:id shape))))
           id))
       :closeBoard
       (fn []
         (swap! state (fn [s]
                        (let [stack  (if (> (count (:stack s)) 1) (pop (:stack s)) (:stack s))
                              fid    (or (peek stack) root-frame)]
                          (assoc s :stack stack :frame-id fid))))
         js/undefined)
       :addRect  (fn [json] (add-shape! state (mk-shape state :rect (args json))))
       :objects  (fn [] (js/JSON.stringify (->plain-js (get-in (:data @state) [:pages-index (:page-id @state) :objects]))))
       :getShape (fn [id] (js/JSON.stringify (->plain-js (get-in (:data @state) [:pages-index (:page-id @state) :objects (uuid/uuid id)]))))
       :validate (fn []
                   (let [file {:id file-id :data (:data @state) :features features}]
                     (try (cfv/validate-file-schema! file) (js/JSON.stringify #js [])
                          (catch :default e (js/JSON.stringify #js [(ex-message e)])))))
       :pendingChanges (fn [] (js/JSON.stringify (->plain-js (:changes @state))))
       :commitBody
       (fn [json]
         (let [{:keys [sessionId revn vern]} (args json)
               params {:id file-id :session-id (uuid/parse sessionId)
                       :revn revn :vern vern :features (set features) :changes (:changes @state)}]
           (t/encode-str params)))})

(defn ^:export create-session
  "args-json: either {empty:true,name} for a fresh file, or
   {dataTransit, fileId, features} hydrated from get-file (transit)."
  [args-json]
  (let [{:keys [empty dataTransit fileId features]} (args args-json)
        file-id (if fileId (uuid/uuid fileId) (uuid/next))
        ;; get-file transit decodes to a FULL FILE map (keys: :id :data :revn
        ;; :vern :features ...), so unwrap :data; tolerate a bare data value too.
        decoded (when-not empty (t/decode-str dataTransit))
        data    (if empty (empty-data) (or (:data decoded) decoded))
        page-id (or (page-id-of data) (first (:pages data)))
        feats   (or features ["components/v2" "fdata/shape-data-type" "fdata/path-data"
                              "styles/v2" "layout/grid" "plugins/runtime"])]
    (make-session (atom {:data data :page-id page-id :frame-id root-frame
                         :stack [root-frame] :changes []})
                  file-id (set feats))))
