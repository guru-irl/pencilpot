(ns app.headless.session
  (:require
   [app.common.types.shape :as cts]              ; setup-shape (geometry)
   [app.common.types.text :as txt]               ; change-text (text content + styles)
   [app.common.files.changes :as cfc]            ; process-changes (apply to file-data)
   [app.common.files.changes-builder :as pcb]    ; update-shapes -> :mod-obj diffs
   [app.common.logic.libraries :as cll]          ; generate-instantiate-component
   [app.common.geom.point :as gpt]               ; gpt/point (instance position)
   [app.common.types.shape.layout :as ctl]       ; grid cells (add-grid-column/assign-cells/reorder)
   [app.common.geom.modifiers :as gm]            ; set-objects-modifiers (layout engine)
   [app.common.types.modifiers :as ctm]          ; reflow-modifiers (seed)
   [app.common.geom.shapes :as gsh]              ; transform-shape (apply modifiers)
   [app.common.files.validate :as cfv]           ; validate-file-schema! (parity oracle)
   [app.common.types.file :as ctf]               ; make-file-data
   [app.common.types.tokens-lib :as ctob]        ; design tokens (sets/tokens/themes)
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

;; --- flex auto-layout ------------------------------------------------------
;; Default flex layout attrs (mirrors frontend shape_layout.cljs initial-flex-layout).
(def ^:private initial-flex-layout
  {:layout :flex :layout-flex-dir :row :layout-gap-type :multiple
   :layout-gap {:row-gap 0 :column-gap 0} :layout-align-items :start
   :layout-justify-content :start :layout-align-content :stretch
   :layout-wrap-type :nowrap :layout-padding-type :simple
   :layout-padding {:p1 0 :p2 0 :p3 0 :p4 0}})

;; Default grid layout attrs (mirrors frontend shape_layout.cljs initial-grid-layout).
(def ^:private initial-grid-layout
  {:layout :grid :layout-grid-dir :row :layout-gap-type :multiple
   :layout-gap {:row-gap 0 :column-gap 0} :layout-align-items :start
   :layout-justify-items :start :layout-align-content :stretch
   :layout-justify-content :stretch :layout-padding-type :simple
   :layout-padding {:p1 0 :p2 0 :p3 0 :p4 0}
   :layout-grid-cells {} :layout-grid-rows [] :layout-grid-columns []})

(defn- objects-of [state]
  (get-in (:data @state) [:pages-index (:page-id @state) :objects]))

;; Apply a pcb/* changes map's :redo-changes to the working copy + record them.
(defn- apply-changes! [state changes]
  (let [redo (:redo-changes changes)]
    (swap! state #(-> %
                      (update :data cfc/process-changes redo false)
                      (update :changes into redo)))
    redo))

;; Apply a RAW vector of change maps (e.g. hand-built :add-component/:mod-obj)
;; to the working copy + record them, in order.
(defn- apply-raw-changes! [state redo]
  (swap! state #(-> %
                    (update :data cfc/process-changes redo false)
                    (update :changes into redo)))
  redo)

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
       :addRect    (fn [json] (add-shape! state (mk-shape state :rect   (args json))))
       :addEllipse (fn [json] (add-shape! state (mk-shape state :circle (args json))))
       :addText
       (fn [json]
         (let [{:keys [x y width height name characters fontSize fontId fills growType parentId]} (args json)
               {:keys [stack frame-id]} @state
               styles (cond-> {}
                        (seq fills) (assoc :fills (mapv (fn [f] {:fill-color (:fillColor f)
                                                                 :fill-opacity (or (:fillOpacity f) 1)}) fills))
                        fontSize    (assoc :font-size (str fontSize))
                        fontId      (assoc :font-id fontId :font-family fontId))
               shape (-> (cts/setup-shape
                          {:id (uuid/next) :type :text :name (or name "Text")
                           :x x :y y :width (or width 200) :height (or height 30)
                           :grow-type (keyword (or growType "auto-width"))
                           :parent-id (if parentId (uuid/parse parentId) (peek stack))
                           :frame-id frame-id})
                         (update :content txt/change-text (or characters "") styles)
                         (dissoc :position-data))]
           (add-shape! state shape)))
       :setFlexLayout
       (fn [board-id opts-json]
         (let [{:keys [dir gap padding align justify wrap]} (args opts-json)
               bid  (uuid/parse board-id)
               pid  (:page-id @state)
               flex (cond-> initial-flex-layout
                      dir             (assoc :layout-flex-dir (keyword dir))
                      align           (assoc :layout-align-items (keyword align))
                      justify         (assoc :layout-justify-content (keyword justify))
                      wrap            (assoc :layout-wrap-type (keyword wrap))
                      (some? gap)     (assoc :layout-gap {:row-gap gap :column-gap gap})
                      (some? padding) (assoc :layout-padding {:p1 padding :p2 padding :p3 padding :p4 padding}))
               ;; (A) set the flex layout attrs on the board
               objs1 (objects-of state)
               ch1   (-> (pcb/empty-changes nil pid)
                         (pcb/with-page-id pid)
                         (pcb/with-objects objs1)
                         (pcb/update-shapes [bid] (fn [s] (merge s flex))))
               _     (apply-changes! state ch1)
               ;; (B) reflow children via Penpot's own modifier engine
               objs2 (objects-of state)
               tree  {bid {:modifiers (ctm/reflow-modifiers)}}
               res   (gm/set-objects-modifiers tree objs2)
               ids   (vec (keys res))
               ch2   (-> (pcb/empty-changes nil pid)
                         (pcb/with-page-id pid)
                         (pcb/with-objects objs2)
                         (pcb/update-shapes ids
                                            (fn [s] (gsh/transform-shape s (get-in res [(:id s) :modifiers])))))
               _     (apply-changes! state ch2)]
           (js/JSON.stringify #js {:reflowed (count ids)})))
       :setGridLayout
       (fn [board-id opts-json]
         (let [{:keys [cols gap padding dir]} (args opts-json)
               bid   (uuid/parse board-id)
               pid   (:page-id @state)
               ncols (max 1 (or cols 2))
               ;; Default to :column flow so children overflow into new ROWS
               ;; (keeping the column count fixed at `ncols`); explicit `dir` wins.
               grid  (cond-> (assoc initial-grid-layout :layout-grid-dir :column)
                       dir             (assoc :layout-grid-dir (keyword dir))
                       (some? gap)     (assoc :layout-gap {:row-gap gap :column-gap gap})
                       (some? padding) (assoc :layout-padding {:p1 padding :p2 padding :p3 padding :p4 padding}))
               ;; (A) set grid attrs + columns + assign cells on the board
               objs1     (objects-of state)
               board0    (get objs1 bid)
               gridboard (-> board0
                             (merge grid)
                             (as-> b (reduce (fn [acc _] (ctl/add-grid-column acc ctl/default-track-value)) b (range ncols)))
                             (ctl/assign-cells objs1)
                             (ctl/reorder-grid-children))
               ch1   (-> (pcb/empty-changes nil pid)
                         (pcb/with-page-id pid)
                         (pcb/with-objects objs1)
                         (pcb/update-shapes [bid] (fn [_] gridboard)))
               _     (apply-changes! state ch1)
               ;; (B) reflow (the :grid branch of set-objects-modifiers fires automatically)
               objs2 (objects-of state)
               tree  {bid {:modifiers (ctm/reflow-modifiers)}}
               res   (gm/set-objects-modifiers tree objs2)
               ids   (vec (keys res))
               ch2   (-> (pcb/empty-changes nil pid)
                         (pcb/with-page-id pid)
                         (pcb/with-objects objs2)
                         (pcb/update-shapes ids
                                            (fn [s] (gsh/transform-shape s (get-in res [(:id s) :modifiers])))))
               _     (apply-changes! state ch2)]
           (js/JSON.stringify #js {:reflowed (count ids)})))
       :setGrowType
       (fn [shape-id mode]
         (let [pid (:page-id @state) id (uuid/parse shape-id)
               ch (-> (pcb/empty-changes nil pid)
                      (pcb/with-page-id pid)
                      (pcb/with-objects (objects-of state))
                      (pcb/update-shapes [id] (fn [s] (assoc s :grow-type (keyword mode)))))]
           (apply-changes! state ch) js/undefined))
       :setConstraints
       (fn [shape-id opts-json]
         (let [{:keys [h v]} (args opts-json)
               pid (:page-id @state) id (uuid/parse shape-id)
               ch (-> (pcb/empty-changes nil pid)
                      (pcb/with-page-id pid)
                      (pcb/with-objects (objects-of state))
                      (pcb/update-shapes [id] (fn [s] (cond-> s
                                                         h (assoc :constraints-h (keyword h))
                                                         v (assoc :constraints-v (keyword v))))))]
           (apply-changes! state ch) js/undefined))
       :addColorToken
       (fn [json]
         ;; FILE-level design tokens. Mirrors frontend create-token-with-set
         ;; (library_edit.cljs:491-519): set-token-set + set-token + a hidden
         ;; theme that enables the set + activate that hidden theme, so the
         ;; token actually resolves. Builders are library-level: needs
         ;; (pcb/with-library-data data), NOT with-page-id/with-objects.
         (let [{:keys [set name value]} (args json)
               set-name (or set "Global")
               data     (:data @state)
               ;; reuse an existing set by name if present, else make a new one
               lib      (:tokens-lib data)
               existing (some-> lib (ctob/get-set-by-name set-name))
               token-set (or existing (ctob/make-token-set :name set-name))
               set-id    (ctob/get-id token-set)
               token     (ctob/make-token :name name :type :color :value value)
               hidden    (ctob/make-hidden-theme)
               hidden+   (ctob/enable-set hidden set-name)
               changes   (-> (pcb/empty-changes nil)
                             (pcb/with-library-data data)
                             (pcb/set-token-set set-id token-set)
                             (pcb/set-token set-id (:id token) token)
                             (pcb/set-token-theme (ctob/get-id hidden) hidden+)
                             (pcb/set-active-token-themes #{ctob/hidden-theme-path}))]
           (apply-changes! state changes)
           (str (:id token))))
       :tokens
       (fn []
         ;; Read the file-level TokensLib back into a JSON summary.
         (let [lib (:tokens-lib (:data @state))]
           (if (nil? lib)
             (js/JSON.stringify #js {:sets #js [] :tokens #js []})
             (let [set-names (vec (ctob/get-set-names lib))
                   tokens    (->> (ctob/get-all-tokens lib)
                                  (mapv (fn [t] {:name  (:name t)
                                                 :value (:value t)
                                                 :type  (clojure.core/name (:type t))})))]
               (js/JSON.stringify (->plain-js {:sets set-names :tokens tokens}))))))
       :createComponent
       ;; Promote an existing BOARD (a :frame) into a main component.
       ;; Mirrors files.builder/add-component: emit :add-component + :mod-obj,
       ;; apply both in order, record. Returns the component id (stringified).
       (fn [board-id json]
         (let [{:keys [name]} (args json)
               bid   (uuid/parse board-id)
               pid   (:page-id @state)
               cid   (uuid/next)
               board (get (objects-of state) bid)
               change1 {:type :add-component :id cid
                        :name (or name (:name board)) :path ""
                        :main-instance-id bid :main-instance-page pid}
               change2 {:type :mod-obj :id bid :page-id pid
                        :operations [{:type :set :attr :component-root :val true}
                                     {:type :set :attr :main-instance :val true}
                                     {:type :set :attr :component-id :val cid}
                                     {:type :set :attr :component-file :val file-id}]}]
           (apply-raw-changes! state [change1 change2])
           (str cid)))
       :instantiateComponent
       ;; Instantiate a copy of an existing component at (x,y) using Penpot's
       ;; own generator (cll/generate-instantiate-component), which produces the
       ;; copy shapes carrying the required :shape-ref/:component-* for the
       ;; server's referential-integrity validation. Returns the copy root id.
       (fn [component-id json]
         (let [{:keys [x y]} (args json)
               cid       (uuid/parse component-id)
               pid       (:page-id @state)
               data      (:data @state)
               page      (get-in data [:pages-index pid])
               objects   (objects-of state)
               libraries {file-id {:id file-id :data data}}
               changes0  (-> (pcb/empty-changes nil pid)
                             (pcb/with-page-id pid)
                             (pcb/with-objects objects))
               [new-shape changes]
               (cll/generate-instantiate-component
                changes0 objects file-id cid
                (gpt/point (or x 0) (or y 0)) page libraries)]
           (apply-changes! state changes)
           (str (:id new-shape))))
       :objects  (fn [] (js/JSON.stringify (->plain-js (get-in (:data @state) [:pages-index (:page-id @state) :objects]))))
       :getShape (fn [id] (js/JSON.stringify (->plain-js (get-in (:data @state) [:pages-index (:page-id @state) :objects (uuid/uuid id)]))))
       :validate (fn []
                   (let [file {:id file-id :data (:data @state) :features features}]
                     (try (cfv/validate-file-schema! file) (js/JSON.stringify #js [])
                          (catch :default e (js/JSON.stringify #js [(ex-message e)])))))
       ;; Apply a JSON array of change maps (single-page, test-only convenience — NOT
       ;; the canonical update path; use applyTransitUpdate for real SPA changes).
       ;; Each change must be a plain map with :type, :id, :page-id, :operations etc.
       ;; We inject :page-id from the session's current page when absent.
       :applyChanges
       (fn [json]
         (let [pid       (:page-id @state)
               raw-arr   (js->clj (js/JSON.parse json) :keywordize-keys true)
               ;; keywordize type/attr values that should be keywords
               kw-change (fn [c]
                           (cond-> c
                             (:type c)    (update :type keyword)
                             (nil? (:page-id c)) (assoc :page-id pid)
                             (:operations c)
                             (update :operations
                                     (fn [ops]
                                       (mapv (fn [op]
                                               (cond-> op
                                                 (:type op)  (update :type keyword)
                                                 (:attr op)  (update :attr keyword)
                                                 (:id op)    (update :id uuid/uuid)))
                                             ops)))
                             (:id c) (update :id uuid/uuid)
                             (:page-id c) (update :page-id uuid/uuid)))
               changes   (mapv kw-change raw-arr)]
           (apply-raw-changes! state changes)
           js/undefined))
       ;; Apply a full transit-encoded update-file request body (canonical path).
       ;; Real Penpot update-file changes already carry their own :page-id (or are
       ;; intentionally page-less / component-targeted), so they are applied VERBATIM.
       ;; Do NOT inject the session's current page-id — doing so can mis-target
       ;; multi-page or component changes.
       :applyTransitUpdate
       (fn [transit-body]
         (let [decoded  (t/decode-str transit-body)
               changes  (or (:changes decoded) [])]
           ;; transit-decoded changes already have keyword types/attrs and UUID ids
           (apply-raw-changes! state changes)
           js/undefined))
       :pendingChanges (fn [] (js/JSON.stringify (->plain-js (:changes @state))))
       :clearChanges
       (fn [] (swap! state assoc :changes []) js/undefined)
       :commitBody
       (fn [json]
         (let [{:keys [sessionId revn vern]} (args json)
               params {:id file-id :session-id (uuid/parse sessionId)
                       :revn revn :vern vern :features (set features) :changes (:changes @state)}]
           (t/encode-str params)))
       :getFileResponse
       ;; Returns JSON: { meta: {id, name, revn, vern, features, ...}, transit: "<transit-string>" }
       ;; If a full file envelope was captured on hydration (:file-envelope in state), the transit
       ;; is the FULL get-file-shaped map (all SPA keys preserved) with :data refreshed from the
       ;; engine.  Otherwise emits the minimal shape for round-trip/scratch usage.
       ;; Ready for createSession({fromTransit, meta}) or the stock SPA's get-file consumer.
       (fn []
         (let [data     (:data @state)
               st       @state
               envelope (:file-envelope st)
               revn     (get st :revn 0)
               vern     (get st :vern 0)
               nm       (get st :name "Pencilpot File")
               meta-m   {:id       (str file-id)
                         :name     nm
                         :revn     revn
                         :vern     vern
                         :features (vec features)}
               resp     (if envelope
                          ;; Full round-trip: restore the original envelope + live :data
                          (-> envelope
                              (assoc :data data)
                              (assoc :revn revn)
                              (assoc :vern vern))
                          (assoc meta-m :data data))
               body     (t/encode-str resp)]
           (js/JSON.stringify (clj->js {:meta meta-m :transit body}))))})

(defn ^:export create-session
  "args-json: either {empty:true,name} for a fresh file,
   {dataTransit, fileId, features} hydrated from get-file (transit), or
   {fromTransit, meta} to re-hydrate from a getFileResponse() result."
  [args-json]
  ;; Rename `name` and `meta` to `nm-arg` / `meta-arg` to avoid shadowing
  ;; clojure.core/name and clojure.core/meta (matching convention in mk-shape etc.).
  (let [{:keys [empty dataTransit fileId features fromTransit]
         nm-arg   :name
         meta-arg :meta} (args args-json)
        ;; fromTransit path: decode a transit body (either a full get-file response or a
        ;; getFileResponse()-emitted body).  Both have :data inline; a full get-file also
        ;; carries :permissions/:team-id/:project-id/:version etc. — we keep the whole map
        ;; as :file-envelope so getFileResponse can re-emit all SPA-required keys.
        decoded-ft (when fromTransit (t/decode-str fromTransit))
        ;; Preserve the full envelope (everything except :data, which we manage live).
        envelope   (when (and decoded-ft (:data decoded-ft))
                     (dissoc decoded-ft :data))
        ;; Choose file-id: prefer meta-arg.id > fileId > decoded > fresh
        file-id (cond
                  (and meta-arg (:id meta-arg)) (uuid/uuid (:id meta-arg))
                  fileId                        (uuid/uuid fileId)
                  decoded-ft                    (or (:id decoded-ft) (uuid/next))
                  :else                         (uuid/next))
        ;; get-file transit decodes to a FULL FILE map (keys: :id :data :revn
        ;; :vern :features ...), so unwrap :data; tolerate a bare data value too.
        decoded (when (and (not empty) (not fromTransit)) (when dataTransit (t/decode-str dataTransit)))
        data    (cond
                  empty       (empty-data)
                  fromTransit (or (:data decoded-ft) decoded-ft)
                  :else       (or (:data decoded) decoded))
        _       (when-not empty
                  (when-not (:pages data)
                    (throw (ex-info "create-session: decoded file has no :pages (bad hydrate payload)" {}))))
        page-id (or (page-id-of data) (first (:pages data)))
        feats   (or features
                    (when decoded-ft (:features decoded-ft))
                    ["components/v2" "fdata/shape-data-type" "fdata/path-data"
                     "styles/v2" "layout/grid" "plugins/runtime"])
        ;; Carry revn/vern/name from decoded-ft or meta-arg for getFileResponse round-trips
        revn    (or (when decoded-ft (:revn decoded-ft)) (when meta-arg (:revn meta-arg)) 0)
        vern    (or (when decoded-ft (:vern decoded-ft)) (when meta-arg (:vern meta-arg)) 0)
        nm      (or (when decoded-ft (:name decoded-ft)) (when meta-arg (:name meta-arg)) nm-arg "Pencilpot File")]
    (make-session (atom {:data data :page-id page-id :frame-id root-frame
                         :stack [root-frame] :changes []
                         :revn revn :vern vern :name nm
                         :file-envelope envelope})
                  file-id (set feats))))
