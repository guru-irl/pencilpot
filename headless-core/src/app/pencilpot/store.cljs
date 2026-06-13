(ns app.pencilpot.store
  "Canonical-EDN serializer/deserializer for the pencilpot on-disk store.

  Lossless: keywords, #uuid literals, sets, and Penpot record types (e.g.
  TokensLib, PathData, Matrix, Point, Rect) all survive the round-trip.
  Deterministic: sorted-map-by print-representation ensures byte-identical
  output when data is unchanged, keeping git diffs minimal."
  (:require
   [cljs.reader :as reader]
   [clojure.pprint :as pp]
   [app.common.uuid :as uuid]
   [app.common.types.path :as path]
   [app.common.types.tokens-lib :as ctob]
   [app.common.geom.matrix :as gmt]
   [app.common.geom.point :as gpt]
   [app.common.geom.rect :as grc]))

;; ---------------------------------------------------------------------------
;; Geometry tagged-literal wrapper
;;
;; In ClojureScript, pprint's type-dispatcher returns :map for ANY IMap
;; implementor — including geometry records (Matrix, Point, Rect).  This means
;; defmethod pp/simple-dispatch Matrix (which calls pr) is NEVER reached:
;; pprint always takes the :map branch and formats records as plain maps
;; {:a 1, :b 0, ...}, destroying type information.
;;
;; GeomTaggedLiteral is a plain deftype (not IMap) that wraps one geometry
;; value and emits the Penpot tagged-literal form via IPrintWithWriter.
;; Because it does not implement IMap, type-dispatcher returns :default, which
;; calls pprint-simple-default → (pr-str obj) → IPrintWithWriter → the tag.
;; ---------------------------------------------------------------------------

(deftype GeomTaggedLiteral [tag repr]
  Object
  (toString [_] (str "#" tag " \"" repr "\""))

  cljs.core/IPrintWithWriter
  (-pr-writer [_ writer _opts]
    (-write writer (str "#" tag " \"" repr "\""))))

(defn- matrix->tagged-literal
  "Wrap a Matrix record as a GeomTaggedLiteral that prints as
  #penpot/matrix \"a,b,c,d,e,f\"."
  [m]
  (GeomTaggedLiteral.
   "penpot/matrix"
   (str (.-a m) "," (.-b m) "," (.-c m) "," (.-d m) "," (.-e m) "," (.-f m))))

(defn- point->tagged-literal
  "Wrap a Point record as a GeomTaggedLiteral that prints as
  #penpot/point \"x,y\"."
  [p]
  (GeomTaggedLiteral.
   "penpot/point"
   (str (.-x p) "," (.-y p))))

(defn- rect->tagged-literal
  "Wrap a Rect record as a GeomTaggedLiteral that prints as
  #penpot/rect \"x,y,width,height,x1,y1,x2,y2\".
  All eight fields are serialised so round-trip is lossless."
  [r]
  (GeomTaggedLiteral.
   "penpot/rect"
   (str (.-x r) "," (.-y r) "," (.-width r) "," (.-height r)
        "," (.-x1 r) "," (.-y1 r) "," (.-x2 r) "," (.-y2 r))))

;; ---------------------------------------------------------------------------
;; Canonical ordering helpers
;; ---------------------------------------------------------------------------

(defn- kcmp
  "Total comparator over any two values by their printed representation."
  [a b]
  (compare (pr-str a) (pr-str b)))

(defn- canon
  "Recursively turn every map into a sorted-map (keys ordered by pr-str) and
  every set into a sorted-set (elements ordered by pr-str).  Vectors and seqs
  become vectors (preserving order).  Scalars pass through unchanged.

  IMPORTANT: Penpot geometry records (Matrix, Point, Rect) implement IMap and
  therefore satisfy map?.  We detect them BEFORE the plain-map branch and
  wrap them in GeomTaggedLiteral so that pp/pprint emits the correct
  tagged-literal form (#penpot/matrix, #penpot/point, #penpot/rect) rather
  than flattening them to plain maps {:a 1, :b 0, …}.  Preserving the types
  ensures that read-edn reconstructs real Matrix/Point/Rect instances, so
  getFileResponse() transit-encodes them with the correct transit tags and the
  frontend's geometry math never receives NaN transforms."
  [x]
  (cond
    (gmt/matrix? x) (matrix->tagged-literal x)
    (gpt/point? x)  (point->tagged-literal x)
    (grc/rect? x)   (rect->tagged-literal x)
    (map? x)        (into (sorted-map-by kcmp)
                          (map (fn [[k v]] [k (canon v)]) x))
    (set? x)        (into (sorted-set-by kcmp)
                          (map canon x))
    (vector? x)     (mapv canon x)
    (seq? x)        (mapv canon x)
    :else           x))

(defn canonical-edn
  "Return a deterministic, pretty-printed EDN string for `data`."
  [data]
  (binding [cljs.pprint/*print-right-margin*  80
            cljs.core/*print-namespace-maps*  false]
    (with-out-str (pp/pprint (canon data)))))

;; ---------------------------------------------------------------------------
;; EDN tag readers
;; ---------------------------------------------------------------------------

(defn- edn-read-tokens-lib
  "EDN tag reader for #penpot/tokens-lib.

  The tagged value is the DTCG-JSON map produced by `export-dtcg-json`
  (string-keyed DTCG structure), or nil when the library is empty
  (`export-dtcg-json` returns nil for an empty TokensLib).

  Uses Penpot's own `parse-multi-set-dtcg-json` to reconstruct the record
  with full fidelity — no hand-rolled reconstruction."
  [v]
  (when (some? v)
    (ctob/parse-multi-set-dtcg-json v)))

(defn- edn-read-path-data
  "EDN tag reader for #penpot/path-data.

  The tagged value is the SVG path string (d= attribute style) written by
  PathData's IPrintWithWriter.  We parse it back via path/from-string."
  [v]
  (when (and v (seq v))
    (path/from-string v)))

(defn- edn-read-matrix
  "EDN tag reader for #penpot/matrix.

  The tagged value is the string \"a,b,c,d,e,f\" written by
  GeomTaggedLiteral.  We reuse gmt/str->matrix (Penpot's own parser) to
  reconstruct the Matrix record — no hand-rolled matrix math."
  [v]
  (gmt/str->matrix v))

(defn- edn-read-point
  "EDN tag reader for #penpot/point.

  The tagged value is the string \"x,y\" written by GeomTaggedLiteral.
  We parse x,y and construct via gpt/point."
  [v]
  (let [[x y] (map js/parseFloat (.split v ","))]
    (gpt/point x y)))

(defn- edn-read-rect
  "EDN tag reader for #penpot/rect.

  The tagged value is the string \"x,y,width,height,x1,y1,x2,y2\" written
  by GeomTaggedLiteral.  We parse the fields and construct via grc/make-rect
  + assoc the x1/y1/x2/y2 fields explicitly."
  [v]
  (let [[x y width height x1 y1 x2 y2] (map js/parseFloat (.split v ","))]
    (grc/map->Rect {:x x :y y :width width :height height
                    :x1 x1 :y1 y1 :x2 x2 :y2 y2})))

(defn read-edn
  "Parse an EDN string produced by `canonical-edn`.  Supports the #uuid
  tagged literal and all Penpot tagged literals that appear in file :data
  (#penpot/tokens-lib, #penpot/path-data, #penpot/matrix, #penpot/point,
  #penpot/rect)."
  [s]
  (reader/read-string
   {:readers {'uuid              uuid/uuid
              'penpot/tokens-lib edn-read-tokens-lib
              'penpot/path-data  edn-read-path-data
              'penpot/matrix     edn-read-matrix
              'penpot/point      edn-read-point
              'penpot/rect       edn-read-rect}}
   s))

;; ---------------------------------------------------------------------------
;; Public API
;; ---------------------------------------------------------------------------

(defn serialize-store
  "Convert the in-memory session state atom value into a flat map of
  EDN strings, ready for JSON serialisation to disk.

  Returns:
    {:manifest   \"<edn>\"       ; file-level metadata
     :pages      {\"<uuid-str>\" \"<edn>\" …}   ; one entry per page
     :components {\"<uuid-str>\" \"<edn>\" …}   ; one entry per component
     :media      [\"<uuid-str>\" …]}             ; media-id list only"
  [file-id state]
  (let [data (:data state)
        manifest {:id        file-id
                  :name      (:name state "Pencilpot File")
                  :revn      (get state :revn 0)
                  :vern      (get state :vern 0)
                  :features  (get state :features #{})
                  :page-order (vec (:pages data))
                  :options   (:options data)
                  :tokens-lib (:tokens-lib data)
                  :libraries  (get state :libraries [])
                  :is-shared  (boolean (:is-shared state))}]
    {:manifest   (canonical-edn manifest)
     :pages      (into {} (map (fn [[id p]] [(str id) (canonical-edn p)])
                               (:pages-index data)))
     :components (into {} (map (fn [[id c]] [(str id) (canonical-edn c)])
                               (:components data)))
     :media      (mapv str (keys (:media data)))}))

(defn load-store
  "Reconstruct a session state map from the parts map produced by
  `serialize-store` (JS-boundary: keys are strings).

  Returns a map with the same shape as the session atom — ready to be
  merged/reset by the caller."
  [parts]
  (let [manifest (read-edn (get parts "manifest"))
        pages    (into {}
                       (map (fn [[k v]] [(uuid/uuid k) (read-edn v)])
                            (get parts "pages")))
        comps    (into {}
                       (map (fn [[k v]] [(uuid/uuid k) (read-edn v)])
                            (get parts "components")))]
    {:file-id  (:id manifest)
     :revn     (:revn manifest)
     :vern     (:vern manifest)
     :name     (:name manifest)
     :features (:features manifest)
     :libraries (:libraries manifest)
     :data     {:pages       (:page-order manifest)
                :pages-index pages
                :components  comps
                :options     (:options manifest)
                :tokens-lib  (:tokens-lib manifest)}}))
