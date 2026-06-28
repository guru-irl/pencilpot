(ns app.headless.session
  (:require
   [app.common.types.shape :as cts]              ; setup-shape (geometry)
   [app.common.types.text :as txt]               ; change-text (text content + styles)
   [app.common.files.changes :as cfc]            ; process-changes (apply to file-data)
   [app.common.files.changes-builder :as pcb]    ; update-shapes -> :mod-obj diffs
   [app.common.logic.libraries :as cll]          ; generate-instantiate-component
   [app.common.logic.shapes :as cls]             ; generate-delete-shapes / generate-relocate
   [app.common.files.helpers :as cfh]            ; get-parent-id (reorder within parent)
   [app.common.geom.point :as gpt]               ; gpt/point (instance position)
   [app.common.types.shape.layout :as ctl]       ; grid cells (add-grid-column/assign-cells/reorder)
   [app.common.types.shape.interactions :as csi] ; prototype interactions (navigate/overlay)
   [app.common.types.component :as ctk]          ; swap-keep-attrs (component swap)
   [app.common.geom.modifiers :as gm]            ; set-objects-modifiers (layout engine)
   [app.common.types.modifiers :as ctm]          ; reflow-modifiers (seed)
   [app.common.geom.shapes :as gsh]              ; transform-shape (apply modifiers)
   [app.common.geom.shapes.common :as gco]       ; shape->center (rotation pivot)
   [app.common.files.validate :as cfv]           ; validate-file-schema! (parity oracle)
   [app.common.types.file :as ctf]               ; make-file-data
   [app.common.types.tokens-lib :as ctob]        ; design tokens (sets/tokens/themes)
   [app.common.types.token :as cto]              ; token-types + apply/unapply-token-to-shape
   [app.common.transit :as t]                    ; decode-str / encode-str (wire + record handlers)
   [app.common.uuid :as uuid]
   [app.common.geom.matrix]                       ; side-effect: transit handler
   [app.common.geom.point]                        ; side-effect: transit handler
   [app.pencilpot.store :as store]               ; canonical-EDN store serializer
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

;; Hydrated :data (from get-file transit OR canonical EDN via load-store) is not
;; schema-clean for sm/check-fn, which validates WITHOUT running the schema's own
;; :decode/json coercions.  Two gaps, both validation-only (this never touches
;; session state, the wire transit, or the on-disk EDN):
;;  (1) shapes arrive as PLAIN MAPS, but schema:shape starts with [:fn shape?] =
;;      (implements? IShape) — it wants Shape INSTANCES (the schema declares this
;;      via :decode/json -> decode-shape -> create-shape).  Coerce maps -> records.
;;  (2) load-store re-emits :tokens-lib / :options even when nil; schema:data marks
;;      them {:optional true} (absent is OK) but NON-nillable, so present-and-nil
;;      fails.  Drop them when nil so empty / AI-authored designs validate clean.
;; NOTE: a non-nil :tokens-lib map (e.g. an imported design's token library) needs
;; a TokensLib *instance* (valid-tokens-lib? = instance? TokensLib) which has no
;; cheap reconstructor from the decoded internal form — that case is out of scope
;; here and stays flagged by validate (see .superpowers/sdd/ai-Afix-findings.md).
(defn- ->shape-record [o] (if (cts/shape? o) o (cts/create-shape o)))
(defn- coerce-data-for-validation [data]
  (let [fix-objects (fn [objs] (when objs (reduce-kv (fn [m k v] (assoc m k (->shape-record v))) {} objs)))]
    (cond-> data
      (:pages-index data) (update :pages-index
                                  (fn [pi] (reduce-kv (fn [m k p] (assoc m k (update p :objects fix-objects))) {} pi)))
      (:components data)  (update :components
                                  (fn [cs] (reduce-kv (fn [m k c] (assoc m k (cond-> c (:objects c) (update :objects fix-objects)))) {} cs)))
      (nil? (:tokens-lib data)) (dissoc :tokens-lib)
      (nil? (:options data))    (dissoc :options))))

(defn- page-id-of [data] (-> data meta ::page-id))

;; pencilpot's frontend is always the modern (components/v2 + wasm) build, so the
;; served file/team MUST declare the modern feature SET — otherwise the SPA treats
;; it as a legacy file (active-feature? uses contains?, so a vector checks indices,
;; not membership) and the options/design panel (and the viewer) render empty.
(defn- modern-features [features]
  (into #{"fdata/shape-data-type" "fdata/path-data" "styles/v2"
          "layout/grid" "components/v2" "plugins/runtime"
          "design-tokens/v1" "tokens/numeric-input" "variants/v1"
          "render-wasm/v1" "text-editor/v2" "text-editor-wasm/v1"}
        (map str (or features []))))

;; Builds the full get-file-shaped :file map (UUID :id, live :data, modern features)
;; PLUS the JSON `meta` map (string :id).  Shared by getFileResponse and
;; getViewerBundle so the served file payload can never drift between the two.
;;   meta-m :id MUST be a STRING (clj->js of a UUID mangles → re-hydrate crash);
;;   resp   :id MUST be a proper UUID (SPA keys the file by UUID).
(defn- build-file-resp [file-id features st]
  (let [data            (:data st)
        envelope        (:file-envelope st)
        revn            (get st :revn 0)
        vern            (get st :vern 0)
        nm              (get st :name "Pencilpot File")
        served-features (modern-features features)
        meta-m          {:id       (str file-id)
                         :name     nm
                         :revn     revn
                         :vern     vern
                         :features served-features}
        resp            (if envelope
                          ;; Full round-trip: restore the original envelope (its :id is already a UUID) + live :data
                          (-> envelope
                              (assoc :data data)
                              (assoc :revn revn)
                              (assoc :vern vern)
                              (assoc :features served-features))
                          (assoc meta-m :data data :id file-id))]
    {:served-features served-features :meta-m meta-m :resp resp}))

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
               hidden    (or (some-> lib (ctob/get-theme (ctob/get-id (ctob/make-hidden-theme))))
                             (ctob/make-hidden-theme))
               hidden+   (ctob/enable-set hidden set-name)
               changes   (-> (pcb/empty-changes nil)
                             (pcb/with-library-data data)
                             (pcb/set-token-set set-id token-set)
                             (pcb/set-token set-id (:id token) token)
                             (pcb/set-token-theme (ctob/get-id hidden) hidden+)
                             (pcb/set-active-token-themes #{ctob/hidden-theme-path}))]
           (apply-changes! state changes)
           (str (:id token))))
       :addToken
       ;; FILE-level design token of ANY type (color, dimension, spacing, sizing,
       ;; border-radius, opacity, rotation, font-size, number, typography, …).
       ;; Generalizes addColorToken. opts: {set?, name, type?="color", value}.
       ;; Same library wiring (set + hidden theme + activate) so it resolves.
       ;; ctob/make-token validates the value per type; invalid type fails fast.
       (fn [json]
         (let [{:keys [set name type value]} (args json)
               tkw      (keyword (or type "color"))
               _        (when-not (contains? cto/token-types tkw)
                          (throw (ex-info (str "addToken: invalid type " (pr-str (or type "color"))
                                               "; valid: " (pr-str cto/token-types)) {})))
               set-name (or set "Global")
               data     (:data @state)
               lib      (:tokens-lib data)
               existing (some-> lib (ctob/get-set-by-name set-name))
               token-set (or existing (ctob/make-token-set :name set-name))
               set-id    (ctob/get-id token-set)
               token     (ctob/make-token :name name :type tkw :value value)
               hidden    (or (some-> lib (ctob/get-theme (ctob/get-id (ctob/make-hidden-theme))))
                             (ctob/make-hidden-theme))
               hidden+   (ctob/enable-set hidden set-name)
               changes   (-> (pcb/empty-changes nil)
                             (pcb/with-library-data data)
                             (pcb/set-token-set set-id token-set)
                             (pcb/set-token set-id (:id token) token)
                             (pcb/set-token-theme (ctob/get-id hidden) hidden+)
                             (pcb/set-active-token-themes #{ctob/hidden-theme-path}))]
           (apply-changes! state changes)
           (str (:id token))))
       :applyToken
       ;; Bind an existing token (by name) to attributes of a shape, writing the
       ;; shape's :applied-tokens. opts: {token, attributes:[…]} where attributes
       ;; are shape token-attr keywords (:fill :stroke-color :width :height
       ;; :rotation :opacity :r1..:r4 :p1..:p4 …). The value resolves when the
       ;; design is opened with the tokens runtime; here we record the binding.
       (fn [shape-id json]
         (let [{:keys [token attributes]} (args json)
               pid     (:page-id @state)
               objects (objects-of state)
               sid     (uuid/parse shape-id)
               lib     (:tokens-lib (:data @state))
               tok     (some->> (when lib (ctob/get-all-tokens lib))
                                (filter #(= token (:name %)))
                                first)
               _       (when (nil? tok)
                         (throw (ex-info (str "applyToken: no token named " (pr-str token)) {})))
               attrs   (set (map keyword attributes))
               ch      (-> (pcb/empty-changes nil pid)
                           (pcb/with-page-id pid)
                           (pcb/with-objects objects)
                           (pcb/update-shapes [sid]
                                              (fn [s] (cto/apply-token-to-shape {:shape s :token tok :attributes attrs}))))]
           (apply-changes! state ch)
           js/undefined))
       :unapplyToken
       ;; Remove any token bound to the given attributes of a shape.
       (fn [shape-id json]
         (let [{:keys [attributes]} (args json)
               pid     (:page-id @state)
               objects (objects-of state)
               sid     (uuid/parse shape-id)
               attrs   (set (map keyword attributes))
               ch      (-> (pcb/empty-changes nil pid)
                           (pcb/with-page-id pid)
                           (pcb/with-objects objects)
                           (pcb/update-shapes [sid]
                                              (fn [s] (cto/unapply-tokens-from-shape s attrs))))]
           (apply-changes! state ch)
           js/undefined))
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
               ;; Hydrated-from-disk :data is plain maps and (crucially) lost its
               ;; :id key, so the generator would (a) clone plain maps that fail
               ;; pcb/add-object's cts/check-shape ([:fn shape?] => Shape record) and
               ;; (b) stamp the instance root with :component-file (:id data) = nil
               ;; (schema wants a uuid). Coerce shapes -> records AND restore :id so
               ;; the produced instance matches what a real make-file-data session
               ;; yields. Read-only on LIVE state: only the emitted changes are applied.
               data      (-> (:data @state)
                             (coerce-data-for-validation)
                             (assoc :id file-id))
               page      (get-in data [:pages-index pid])
               objects   (:objects page)
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
       :addInteraction
       ;; Add a prototype interaction to a shape (closes the interaction-authoring
       ;; gap). opts: {shapeId, destination?, eventType?="click",
       ;; actionType?="navigate", preserveScroll?}. Builds a schema-valid
       ;; interaction via the interactions helpers and appends it to the shape's
       ;; :interactions vector (a :mod-obj change via pcb/update-shapes, which —
       ;; unlike pcb/add-object — does not run cts/check-shape, so it is safe on
       ;; hydrated plain-map shapes). Returns the interaction as JSON.
       (fn [json]
         (let [{:keys [shapeId destination eventType actionType preserveScroll]} (args json)
               sid     (uuid/parse shapeId)
               pid     (:page-id @state)
               objects (objects-of state)
               shape   (get objects sid)
               dest-id (when destination (uuid/parse destination))
               et      (keyword (or eventType "click"))
               at      (keyword (or actionType "navigate"))
               _       (when-not (contains? csi/event-types et)
                         (throw (ex-info (str "addInteraction: invalid eventType " (pr-str (or eventType "click"))
                                              "; valid: " (pr-str csi/event-types)) {})))
               _       (when-not (contains? csi/action-types at)
                         (throw (ex-info (str "addInteraction: invalid actionType " (pr-str (or actionType "navigate"))
                                              "; valid: " (pr-str csi/action-types)) {})))
               base    (-> csi/default-interaction
                           (csi/set-event-type et shape)
                           (csi/set-action-type at))
               inter   (cond-> base
                         (and (csi/has-destination base) (some? dest-id))
                         (csi/set-destination dest-id)
                         (and (csi/has-preserve-scroll base) (some? preserveScroll))
                         (csi/set-preserve-scroll (boolean preserveScroll)))
               ch      (-> (pcb/empty-changes nil pid)
                           (pcb/with-page-id pid)
                           (pcb/with-objects objects)
                           (pcb/update-shapes [sid]
                                              (fn [s] (update s :interactions csi/add-interaction inter))))]
           (apply-changes! state ch)
           (js/JSON.stringify (->plain-js inter))))
       :updateShapes
       ;; Generic attribute edit on EXISTING shapes (closes the "append-only" gap).
       ;; ids: JSON array of shape ids; attrs: JSON object of shape attributes to
       ;; merge (fills/strokes/opacity/rotation/name/blend-mode/constraints-h/v/
       ;; rx/ry/r1..r4/hidden/blocked/proportion-lock/…). args() keywordizes nested
       ;; map keys, so fills/strokes arrive in Penpot shape form; we keyword-coerce
       ;; known enum-VALUED attrs. Raw pcb/update-shapes (the setFlexLayout path)
       ;; does NOT run cts/check-shape -> safe on hydrated plain-map shapes.
       ;; Returns the count of shapes updated.
       (fn [ids-json attrs-json]
         (let [pid     (:page-id @state)
               objects (objects-of state)
               ids     (mapv uuid/parse (args ids-json))
               raw     (args attrs-json)
               ;; Refuse identity/structure/geometry keys: setting them raw would
               ;; break referential integrity or geometry consistency (and the
               ;; schema-only validate() would not catch it). Steer to the verbs.
               deny    #{:id :type :shapes :parent-id :frame-id :component-id
                         :component-file :component-root :main-instance :shape-ref
                         :selrect :points :x :y :width :height :transform
                         :transform-inverse :rotation :applied-tokens :interactions}
               bad     (filter deny (keys raw))
               _       (when (seq bad)
                         (throw (ex-info (str "updateShapes: refusing to set structural/geometry key(s) "
                                              (pr-str (vec bad)) "; use moveShape/resizeShape/reparentShape/"
                                              "reorderShape/groupShapes/applyToken/addInteraction instead") {})))
               enum-ks #{:constraints-h :constraints-v :blend-mode :grow-type
                         :vertical-align :horizontal-align}
               attrs   (reduce-kv (fn [m k v]
                                    (assoc m k (if (and (contains? enum-ks k) (string? v))
                                                 (keyword v) v)))
                                  {} raw)
               ids'    (filterv #(contains? objects %) ids)
               ch      (-> (pcb/empty-changes nil pid)
                           (pcb/with-page-id pid)
                           (pcb/with-objects objects)
                           (pcb/update-shapes ids' (fn [s] (merge s attrs))
                                              {:attrs (set (keys attrs))}))]
           (apply-changes! state ch)
           (count ids')))
       :deleteShapes
       ;; Delete EXISTING shapes (and their descendants) via Penpot's own
       ;; generator, which handles component copies (hidden not deleted), masks,
       ;; and empty-group cleanup. Returns the count requested. No cts/check-shape
       ;; on this path, so hydrated plain-map shapes are fine.
       (fn [ids-json]
         (let [pid     (:page-id @state)
               data    (:data @state)
               page    (get-in data [:pages-index pid])
               objects (:objects page)
               ids     (filterv #(contains? objects %) (mapv uuid/parse (args ids-json)))
               [_ ch]  (-> (pcb/empty-changes nil pid)
                           (cls/generate-delete-shapes data page objects ids {}))]
           (when (seq ids) (apply-changes! state ch))
           (count ids)))
       :reparentShape
       ;; Move an existing shape under a new parent (board/group/frame) at an
       ;; optional index. cls/generate-relocate emits the :mov-objects + parent
       ;; registration + empty-group cleanup the UI uses. opts: {parentId, index?}.
       (fn [shape-id json]
         (let [{:keys [parentId index]} (args json)
               pid     (:page-id @state)
               data    (:data @state)
               objects (:objects (get-in data [:pages-index pid]))
               sid     (uuid/parse shape-id)
               par     (uuid/parse parentId)
               ch      (-> (pcb/empty-changes nil pid)
                           (pcb/with-page-id pid)
                           (pcb/with-objects objects)
                           (pcb/with-library-data data)
                           (cls/generate-relocate par (or index 0) [sid]))]
           (apply-changes! state ch)
           (str sid)))
       :reorderShape
       ;; Change z-order: relocate the shape within its CURRENT parent to `index`.
       (fn [shape-id json]
         (let [{:keys [index]} (args json)
               pid     (:page-id @state)
               data    (:data @state)
               objects (:objects (get-in data [:pages-index pid]))
               sid     (uuid/parse shape-id)
               par     (cfh/get-parent-id objects sid)
               ch      (-> (pcb/empty-changes nil pid)
                           (pcb/with-page-id pid)
                           (pcb/with-objects objects)
                           (pcb/with-library-data data)
                           (cls/generate-relocate par (or index 0) [sid]))]
           (apply-changes! state ch)
           (str sid)))
       :moveShape
       ;; Move an existing shape (and its whole subtree) to an absolute position
       ;; {x,y} or by a relative delta {dx,dy}. A pure translation: apply gsh/move
       ;; with the same vector to the shape + every descendant, so groups/frames
       ;; carry their children. Absolute target is measured from the shape's selrect.
       (fn [shape-id json]
         (let [{:keys [x y dx dy]} (args json)
               pid     (:page-id @state)
               objects (objects-of state)
               sid     (uuid/parse shape-id)
               sr      (:selrect (get objects sid))
               v       (gpt/point (cond (some? dx) dx (some? x) (- x (:x sr)) :else 0)
                                  (cond (some? dy) dy (some? y) (- y (:y sr)) :else 0))
               ids     (into [sid] (cfh/get-children-ids objects sid))
               ch      (-> (pcb/empty-changes nil pid)
                           (pcb/with-page-id pid)
                           (pcb/with-objects objects)
                           (pcb/update-shapes ids (fn [s] (gsh/move s v))))
               _       (apply-changes! state ch)
               ;; reflow ancestor containers (groups auto-size to children) so
               ;; their geometry stays consistent after the subtree moved.
               objs2   (objects-of state)
               anc     (->> (cfh/get-parent-ids objs2 sid) (remove #(= % root-frame)) vec)
               ch2     (when (seq anc)
                         (-> (pcb/empty-changes nil pid)
                             (pcb/with-page-id pid)
                             (pcb/with-objects objs2)
                             (pcb/resize-parents anc)))]
           (when ch2 (apply-changes! state ch2))
           (str sid)))
       :resizeShape
       ;; Resize an existing shape to {width?,height?}. Uses Penpot's own dimension
       ;; modifiers through the layout/modifier engine (gm/set-objects-modifiers),
       ;; so children reflow/scale exactly as in the UI. Width and height are
       ;; applied as separate passes (the engine recomputes geometry between them).
       (fn [shape-id json]
         (let [{:keys [width height]} (args json)
               pid    (:page-id @state)
               sid    (uuid/parse shape-id)
               do-dim (fn [attr value]
                        (when (number? value)
                          (let [objects (objects-of state)
                                shape   (get objects sid)
                                tree    {sid {:modifiers (ctm/change-dimensions-modifiers shape attr value)}}
                                res     (gm/set-objects-modifiers tree objects)
                                ids     (vec (keys res))
                                ch      (-> (pcb/empty-changes nil pid)
                                            (pcb/with-page-id pid)
                                            (pcb/with-objects objects)
                                            (pcb/update-shapes ids
                                                               (fn [s] (gsh/transform-shape s (get-in res [(:id s) :modifiers])))))]
                            (apply-changes! state ch))))]
           (do-dim :width width)
           (do-dim :height height)
           (str sid)))
       :rotateShape
       ;; Rotate an existing shape by `angle` degrees about its own center
       ;; (or {cx,cy}). Uses ctm/rotation-modifiers through the modifier engine
       ;; so :rotation AND :selrect/:points are recomputed exactly as in the UI
       ;; (children of a group/board rotate with it). This is the geometry-correct
       ;; path; raw :rotation stays refused by updateShapes.
       (fn [shape-id json]
         (let [{:keys [angle cx cy]} (args json)
               pid     (:page-id @state)
               sid     (uuid/parse shape-id)
               objects (objects-of state)
               shape   (get objects sid)
               center  (if (and (number? cx) (number? cy))
                         (gpt/point cx cy)
                         (gco/shape->center shape))
               tree    {sid {:modifiers (ctm/rotation-modifiers shape center angle)}}
               res     (gm/set-objects-modifiers tree objects)
               ids     (vec (keys res))
               ch      (-> (pcb/empty-changes nil pid)
                           (pcb/with-page-id pid)
                           (pcb/with-objects objects)
                           (pcb/update-shapes ids
                                              (fn [s] (gsh/transform-shape s (get-in res [(:id s) :modifiers])))))]
           (apply-changes! state ch)
           (str sid)))
       :swapComponent
       ;; Replace a component instance with an instance of a DIFFERENT component,
       ;; preserving position/size (ctk/swap-keep-attrs). Uses Penpot's own
       ;; cll/generate-component-swap (delete old + instantiate new). Like
       ;; instantiateComponent it instantiates, so it needs the same hydrated-data
       ;; coercion (records + restored :data :id). Returns the new instance root id.
       (fn [shape-id new-component-id]
         (let [pid       (:page-id @state)
               sid       (uuid/parse shape-id)
               new-cid   (uuid/parse new-component-id)
               data      (-> (:data @state) (coerce-data-for-validation) (assoc :id file-id))
               page      (get-in data [:pages-index pid])
               objects   (:objects page)
               libraries {file-id {:id file-id :data data}}
               shape     (get objects sid)
               parent    (get objects (:parent-id shape))
               index     (or (first (keep-indexed (fn [i x] (when (= x sid) i)) (:shapes parent))) 0)
               target-cell (when (ctl/grid-layout? parent) (ctl/get-cell-by-shape-id parent sid))
               keep-props  (select-keys shape ctk/swap-keep-attrs)
               [new-shape _ changes]
               (-> (pcb/empty-changes nil pid)
                   (cll/generate-component-swap objects shape data page libraries new-cid
                                                index target-cell keep-props false))]
           (apply-changes! state changes)
           (str (:id new-shape))))
       :detachInstance
       ;; Detach a component instance (and its children) from its component, so it
       ;; becomes a plain shape tree. cll/generate-detach-instance strips the
       ;; :component-*/:shape-ref links via pcb/update-shapes (no cts/check-shape),
       ;; so it is safe on hydrated plain-map shapes.
       (fn [shape-id]
         (let [pid     (:page-id @state)
               data    (:data @state)
               page    (get-in data [:pages-index pid])
               sid     (uuid/parse shape-id)
               libraries {file-id {:id file-id :data data}}
               ch      (-> (pcb/empty-changes nil pid)
                           (pcb/with-page-id pid)
                           (pcb/with-objects (:objects page))
                           (cll/generate-detach-instance page libraries sid))]
           (apply-changes! state ch)
           js/undefined))
       :groupShapes
       ;; Group existing shapes (sharing a parent) into a new :group. Mirrors the
       ;; UI's prepare-create-group core: create the group (a cts/setup-shape
       ;; record, so pcb/add-object's check-shape passes even on hydrated designs)
       ;; already listing the children, add it at the last child's position, then
       ;; change-parent the children into it. Returns the new group id.
       (fn [ids-json json]
         (let [{:keys [name]} (args json)
               pid     (:page-id @state)
               objects (objects-of state)
               ids     (->> (mapv uuid/parse (args ids-json))
                            (cfh/order-by-indexed-shapes objects))
               shapes  (mapv #(get objects %) ids)
               first-s (first shapes)
               parent-id (:parent-id first-s)
               frame-id  (:frame-id first-s)
               selrect (gsh/shapes->rect shapes)
               gidx    (inc (cfh/get-position-on-parent objects (:id (last shapes))))
               gid     (uuid/next)
               group   (cts/setup-shape {:id gid :type :group :name (or name "Group")
                                         :shapes (mapv :id shapes) :selrect selrect
                                         :x (:x selrect) :y (:y selrect)
                                         :width (:width selrect) :height (:height selrect)
                                         :parent-id parent-id :frame-id frame-id :index gidx})
               ch      (-> (pcb/empty-changes nil pid)
                           (pcb/with-page-id pid)
                           (pcb/with-objects objects)
                           (pcb/add-object group {:index gidx})
                           (pcb/change-parent gid (reverse shapes)))]
           (apply-changes! state ch)
           (str gid)))
       :ungroupShape
       ;; Dissolve a group: relocate its children out to the group's parent at the
       ;; group's position. cls/generate-relocate auto-removes the now-empty group.
       (fn [group-id]
         (let [pid     (:page-id @state)
               data    (:data @state)
               objects (:objects (get-in data [:pages-index pid]))
               gid     (uuid/parse group-id)
               group   (get objects gid)
               parent-id (cfh/get-parent-id objects gid)
               gidx    (inc (cfh/get-position-on-parent objects gid))
               kids    (->> (:shapes group) (cfh/order-by-indexed-shapes objects) vec)
               ch      (-> (pcb/empty-changes nil pid)
                           (pcb/with-page-id pid)
                           (pcb/with-objects objects)
                           (pcb/with-library-data data)
                           (cls/generate-relocate parent-id gidx kids))]
           (apply-changes! state ch)
           js/undefined))
       :objects  (fn [] (js/JSON.stringify (->plain-js (get-in (:data @state) [:pages-index (:page-id @state) :objects]))))
       :getShape (fn [id] (js/JSON.stringify (->plain-js (get-in (:data @state) [:pages-index (:page-id @state) :objects (uuid/uuid id)]))))
       :validate (fn []
                   (let [file {:id file-id :data (coerce-data-for-validation (:data @state)) :features features}]
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
       :bumpRevn
       (fn [] (let [n (inc (:revn @state 0))] (swap! state assoc :revn n) n))
       :serializeStore
       ;; Returns JSON: {manifest:"<edn>", pages:{"<uuid>":"<edn>",...}, components:{...}, media:[...]}
       ;; The EDN is canonical (sorted keys, #uuid literals) and deterministic.
       (fn [] (js/JSON.stringify (clj->js (store/serialize-store file-id @state))))
       :loadStore
       ;; Resets the session's data from a parts map previously produced by serializeStore.
       ;; `parts` may be a JS object (clj->js boundary) — js->clj converts keys to strings.
       (fn [parts]
         (let [loaded (store/load-store (js->clj parts))]
           (swap! state #(-> %
                             (assoc :data     (:data loaded))
                             (assoc :revn     (:revn loaded))
                             (assoc :vern     (:vern loaded))
                             (assoc :name     (:name loaded))
                             (assoc :features (:features loaded))
                             (assoc :libraries (:libraries loaded))
                             ;; Reset page cursor to first page from the loaded data
                             (assoc :page-id  (first (get-in loaded [:data :pages])))
                             ;; Reset frame/stack to root
                             (assoc :frame-id root-frame)
                             (assoc :stack    [root-frame])))
           js/undefined))
       :getFileResponse
       ;; Returns JSON: { meta: {id, name, revn, vern, features, ...}, transit: "<transit-string>" }
       ;; If a full file envelope was captured on hydration (:file-envelope in state), the transit
       ;; is the FULL get-file-shaped map (all SPA keys preserved) with :data refreshed from the
       ;; engine.  Otherwise emits the minimal shape for round-trip/scratch usage.
       ;; Ready for createSession({fromTransit, meta}) or the stock SPA's get-file consumer.
       (fn []
         (let [{:keys [meta-m resp]} (build-file-resp file-id features @state)
               body (t/encode-str resp)]
           (js/JSON.stringify (clj->js {:meta meta-m :transit body}))))
       :getViewerBundle
       ;; Returns JSON: { transit: "<transit-string>" } — the body for the SPA's
       ;; :get-view-only-bundle RPC.  The WHOLE bundle is transit-encoded in ONE
       ;; pass so transit's key/value cache (^ refs) stays coherent; NEVER embed a
       ;; separately-encoded file string (that corrupts the cache).  The :file slot
       ;; is the SAME map getFileResponse emits (shared build-file-resp).
       ;; extras-json = {teamId, projectId, projectName, fonts}:
       ;;   teamId/projectId -> uuid/parse (fallback uuid/zero); projectName -> str;
       ;;   fonts -> OPAQUE pass-through list of font-variant maps (runtime supplies
       ;;   the correct shape; `args` already keywordized them).
       ;; :features is the SAME modern set in BOTH :file and :team (viewer does
       ;; (features/initialize (:features team)) and keys the file by it).
       (fn [extras-json]
         (let [extras   (args extras-json)
               team-id  (or (some-> (:teamId extras) uuid/parse) uuid/zero)
               proj-id  (or (some-> (:projectId extras) uuid/parse) uuid/zero)
               proj-nm  (or (:projectName extras) "Local")
               fonts    (or (:fonts extras) [])
               {:keys [served-features resp]} (build-file-resp file-id features @state)
               bundle   {:project     {:id proj-id :name proj-nm}
                         :file        resp
                         :team        {:id team-id :name "Local" :features served-features}
                         :share-links []
                         :libraries   []
                         :users       []
                         :thumbnails  {}
                         :permissions {:type :membership :is-owner true :is-admin true
                                       :can-edit true :can-read true}
                         :fonts       fonts}
               body     (t/encode-str bundle)]
           (js/JSON.stringify (clj->js {:transit body}))))
       :mapFontsToVariable
       ;; Map families onto a variable font WITH per-family axis settings.
       ;; mapping: {"Family Name" {"fontId" "custom-…" "family" "Google Sans Flex"
       ;;                          "axes" {"wdth" 62.5 "opsz" 120 …}}}
       ;; For any node whose :font-family matches a key: rewrite :font-id,
       ;; :font-family and :font-variant-id (<style>-<weight>), and MERGE the axis
       ;; map into :font-variation-settings (existing axes kept unless overridden).
       ;; :font-weight / :font-size / :font-style are left untouched.
       ;; Also strips cached :position-data from text shapes so the new font +
       ;; axes are re-laid-out on load (stale position-data otherwise paints the
       ;; OLD font/width until the next edit — it only regenerates when nil).
       (fn [mapping-json]
         (let [mapping (js->clj (js/JSON.parse mapping-json))
               transform-node
               (fn [node]
                 (if (map? node)
                   (let [;; drop stale layout cache so it regenerates from the new font
                         node (if (contains? node :position-data) (dissoc node :position-data) node)]
                     (if (contains? node :font-family)
                       (let [spec (get mapping (:font-family node))]
                         (if spec
                           (let [weight   (or (:font-weight node) "400")
                                 style    (if (= "italic" (:font-style node)) "italic" "normal")
                                 new-fam  (get spec "family" (:font-family node))
                                 new-id   (get spec "fontId")
                                 axes     (get spec "axes")
                                 existing (or (:font-variation-settings node) {})
                                 merged   (merge existing axes)]
                             (cond-> node
                               new-id       (assoc :font-id new-id)
                               true         (assoc :font-family new-fam
                                                   :font-variant-id (str style "-" weight))
                               (seq merged) (assoc :font-variation-settings merged)))
                           node))
                       node))
                   node))]
           ;; (1) Record per-page shape changes so commit() / the MCP map_fonts_variable
           ;;     tool persist the remap (the round-trip fix). update-shapes records a
           ;;     :mod-obj per shape whose postwalk output differs (font attrs +
           ;;     :position-data strip). Plain-map safe (no cts/check-shape).
           (doseq [pid (keys (get-in @state [:data :pages-index]))]
             (let [objects (get-in @state [:data :pages-index pid :objects])
                   ids     (filterv #(not= (get objects %)
                                           (walk/postwalk transform-node (get objects %)))
                                    (keys objects))]
               (when (seq ids)
                 (let [ch (-> (pcb/empty-changes nil pid)
                              (pcb/with-page-id pid)
                              (pcb/with-objects objects)
                              (pcb/update-shapes ids (fn [s] (walk/postwalk transform-node s))))]
                   (apply-changes! state ch)))))
           ;; (2) Transform the remaining file-level data (typographies, components, …)
           ;;     for full CLI parity. Idempotent on the page shapes already transformed
           ;;     in (1): their :font-family is now the variable family (not a mapping
           ;;     key) and :position-data is already stripped, so re-walking is a no-op.
           (swap! state update :data (fn [d] (walk/postwalk transform-node d)))
           js/undefined))
       :retargetFonts
       (fn [mapping-json]
         ;; Walk EVERY map in the file data; for any node that has :font-family
         ;; matching a key in `mapping`, rewrite :font-id and :font-variant-id.
         ;; Covers text shapes (shape-level attrs + nested content tree) and typographies.
         (let [mapping (js->clj (js/JSON.parse mapping-json))
               ;; mapping: {"Family Name" "new-font-id", ...}
               transform-node
               (fn [node]
                 (if (and (map? node) (contains? node :font-family))
                   (let [fam    (:font-family node)
                         new-id (get mapping fam)]
                     (if new-id
                       (let [weight (or (:font-weight node) "400")]
                         (assoc node
                           :font-id         new-id
                           :font-variant-id (str "normal-" weight)))
                       node))
                   node))]
           (swap! state update :data (fn [d] (walk/postwalk transform-node d)))
           js/undefined))})

(defn ^:export create-session
  "args-json: either {empty:true,name} for a fresh file,
   {dataTransit, fileId, features} hydrated from get-file (transit),
   {fromTransit, meta} to re-hydrate from a getFileResponse() result, or
   {fromStore, ...} to re-hydrate from a serializeStore() result."
  [args-json]
  ;; Rename `name` and `meta` to `nm-arg` / `meta-arg` to avoid shadowing
  ;; clojure.core/name and clojure.core/meta (matching convention in mk-shape etc.).
  (let [{:keys [empty dataTransit fileId features fromTransit fromStore]
         nm-arg   :name
         meta-arg :meta} (args args-json)
        ;; fromStore path: load from canonical-EDN parts map.
        ;; We must re-parse from the raw JSON to get string-keyed maps (not keyword-keyed),
        ;; because the uuid-string keys in :pages/:components must stay as strings for
        ;; store/load-store (which uses (get parts "manifest") etc.).
        ;; `args` uses :keywordize-keys true which would corrupt uuid-string keys.
        raw-parsed        (js->clj (js/JSON.parse args-json))
        from-store-raw    (get raw-parsed "fromStore")
        from-store-loaded (when from-store-raw (store/load-store from-store-raw))
        ;; fromTransit path: decode a transit body (either a full get-file response or a
        ;; getFileResponse()-emitted body).  Both have :data inline; a full get-file also
        ;; carries :permissions/:team-id/:project-id/:version etc. — we keep the whole map
        ;; as :file-envelope so getFileResponse can re-emit all SPA-required keys.
        decoded-ft (when fromTransit (t/decode-str fromTransit))
        ;; Preserve the full envelope (everything except :data, which we manage live).
        envelope   (when (and decoded-ft (:data decoded-ft))
                     (dissoc decoded-ft :data))
        ;; Choose file-id: prefer fromStore > meta-arg.id > fileId > decoded > fresh
        file-id (cond
                  from-store-loaded             (:file-id from-store-loaded)
                  (and meta-arg (:id meta-arg)) (uuid/uuid (:id meta-arg))
                  fileId                        (uuid/uuid fileId)
                  decoded-ft                    (or (:id decoded-ft) (uuid/next))
                  :else                         (uuid/next))
        ;; get-file transit decodes to a FULL FILE map (keys: :id :data :revn
        ;; :vern :features ...), so unwrap :data; tolerate a bare data value too.
        decoded (when (and (not empty) (not fromTransit) (not fromStore))
                  (when dataTransit (t/decode-str dataTransit)))
        data    (cond
                  empty             (empty-data)
                  from-store-loaded (:data from-store-loaded)
                  fromTransit       (or (:data decoded-ft) decoded-ft)
                  :else             (or (:data decoded) decoded))
        _       (when-not empty
                  (when-not (:pages data)
                    (throw (ex-info "create-session: decoded file has no :pages (bad hydrate payload)" {}))))
        page-id (or (page-id-of data) (first (:pages data)))
        feats   (or features
                    (when from-store-loaded (:features from-store-loaded))
                    (when decoded-ft (:features decoded-ft))
                    ["components/v2" "fdata/shape-data-type" "fdata/path-data"
                     "styles/v2" "layout/grid" "plugins/runtime"])
        ;; Carry revn/vern/name from fromStore > decoded-ft > meta-arg
        revn    (or (when from-store-loaded (:revn from-store-loaded))
                    (when decoded-ft (:revn decoded-ft))
                    (when meta-arg (:revn meta-arg))
                    0)
        vern    (or (when from-store-loaded (:vern from-store-loaded))
                    (when decoded-ft (:vern decoded-ft))
                    (when meta-arg (:vern meta-arg))
                    0)
        nm      (or (when from-store-loaded (:name from-store-loaded))
                    (when decoded-ft (:name decoded-ft))
                    (when meta-arg (:name meta-arg))
                    nm-arg
                    "Pencilpot File")]
    (make-session (atom {:data data :page-id page-id :frame-id root-frame
                         :stack [root-frame] :changes []
                         :revn revn :vern vern :name nm
                         :file-envelope envelope})
                  file-id (set feats))))
