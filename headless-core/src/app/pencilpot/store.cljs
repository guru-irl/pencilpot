(ns app.pencilpot.store
  "Canonical-EDN serializer/deserializer for the pencilpot on-disk store.

  Lossless: keywords, #uuid literals, sets, and Penpot record types (e.g.
  TokensLib, PathData, Matrix, Point, Rect) all survive the round-trip.
  Deterministic: sorted-map-by print-representation ensures byte-identical
  output when data is unchanged, keeping git diffs minimal."
  (:require
   [cljs.reader :as reader]
   [goog.string :as gstr]
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
  "Total comparator over any two values, ordering by printed representation.

  Fast-paths the homogeneous common cases (keyword/keyword, string/string,
  number/number) with native `compare`, which is byte-for-byte equivalent to
  comparing their pr-str forms for those types — with ONE exception: mixing a
  qualified keyword (`:a/x`) with an unqualified keyword (`:b`) orders
  differently under native compare (namespace-first) than under pr-str. To keep
  ordering identical to the historical pr-str comparator we only fast-path
  keywords when BOTH have the same namespace (both nil ⇒ both unqualified, the
  overwhelmingly common case); otherwise we fall back to pr-str. Numbers compare
  identically as long as both are the same kind, which they are here (all EDN
  numeric leaves). Anything mixed/other falls back to the pr-str comparator."
  [a b]
  (cond
    (and (keyword? a) (keyword? b)
         (= (namespace a) (namespace b)))
    (compare a b)

    (and (string? a) (string? b))
    (compare a b)

    (and (number? a) (number? b))
    (compare a b)

    :else
    (compare (pr-str a) (pr-str b))))

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
    (grc/rect? x)   (let [ext (apply dissoc (into {} x) [:x :y :width :height :x1 :y1 :x2 :y2])]
                      (if (empty? ext)
                        ;; Pure geometry rect (selrect, points bbox, …): compact literal.
                        (rect->tagged-literal x)
                        ;; A Rect carrying extension keys — text :position-data entries are
                        ;; Rect records with :text/:fills/:font-* assoc'd on. The compact
                        ;; #penpot/rect literal only emits the 8 geometry fields and would
                        ;; DROP that text data (-> blank text on reload). Emit the whole
                        ;; record as a plain map so every key survives (matches the
                        ;; plain-map form the import path produces).
                        (into (sorted-map-by kcmp)
                              (map (fn [[k v]] [k (canon v)]) (into {} x)))))
    (map? x)        (into (sorted-map-by kcmp)
                          (map (fn [[k v]] [k (canon v)]) x))
    (set? x)        (into (sorted-set-by kcmp)
                          (map canon x))
    (vector? x)     (mapv canon x)
    (seq? x)        (mapv canon x)
    :else           x))

;; ---------------------------------------------------------------------------
;; Fast deterministic EDN pretty-printer
;;
;; cljs.pprint/pprint is pathologically slow (~3s for a 1.4MB design), and the
;; whole design is re-serialised on every edit.  This hand-rolled emitter walks
;; the already-canonicalised structure (maps are sorted-map-by kcmp, sets are
;; sorted-set-by kcmp, geometry is wrapped in GeomTaggedLiteral) and appends to
;; a goog.string.StringBuffer.  Leaves/tagged-literals are emitted via pr-str so
;; #uuid / #penpot/* / GeomTaggedLiteral all print correctly; only collections
;; are hand-formatted.
;;
;; Layout (diff-friendly, stable):
;;   - maps:    one `:key value` entry per line, no trailing commas
;;   - vectors/sets containing any collection: one element per line
;;   - vectors/sets of scalars only: inline `[a b c]`
;;   - empty collections: `{}` `[]` `#{}`
;; This layout differs from the old pprint output — existing on-disk designs are
;; reformatted once on next write; the parsed data is identical.
;; ---------------------------------------------------------------------------

(def ^:private indent-unit "  ")

(defn- emit-indent! [^js sb depth]
  (dotimes [_ depth] (.append sb indent-unit)))

(defn- coll-val?
  "True when `x` is a collection we hand-format multi-line (map/vector/set/seq).
  GeomTaggedLiteral is NOT a collection — it prints as a scalar via pr-str."
  [x]
  (or (map? x) (vector? x) (set? x) (seq? x)))

(defn- any-coll? [coll]
  (reduce (fn [_ x] (if (coll-val? x) (reduced true) false)) false coll))

(declare emit!)

(defn- emit-map! [^js sb m depth]
  (if (zero? (count m))
    (.append sb "{}")
    (let [child (inc depth)]
      (.append sb "{")
      (doseq [[k v] m]
        (.append sb "\n")
        (emit-indent! sb child)
        (.append sb (pr-str k))
        (.append sb " ")
        (emit! sb v child))
      (.append sb "}"))))

(defn- emit-seq-multiline! [^js sb coll open close depth]
  (let [child (inc depth)]
    (.append sb open)
    (doseq [x coll]
      (.append sb "\n")
      (emit-indent! sb child)
      (emit! sb x child))
    (.append sb close)))

(defn- emit-seq-inline! [^js sb coll open close]
  (.append sb open)
  (loop [xs (seq coll)
         first? true]
    (when xs
      (when-not first? (.append sb " "))
      ;; scalars/tagged-literals only on this path → pr-str is correct & fast
      (.append sb (pr-str (first xs)))
      (recur (next xs) false)))
  (.append sb close))

(defn- emit-coll! [^js sb coll open close depth]
  (cond
    (zero? (count coll)) (do (.append sb open) (.append sb close))
    (any-coll? coll)     (emit-seq-multiline! sb coll open close depth)
    :else                (emit-seq-inline! sb coll open close)))

(defn- emit! [^js sb x depth]
  (cond
    (map? x)    (emit-map! sb x depth)
    (vector? x) (emit-coll! sb x "[" "]" depth)
    (set? x)    (emit-coll! sb x "#{" "}" depth)
    (seq? x)    (emit-coll! sb x "(" ")" depth)
    :else       (.append sb (pr-str x))))

(defn canonical-edn
  "Return a deterministic, pretty-printed EDN string for `data`.

  `canon` first normalises maps/sets into kcmp-sorted collections and wraps
  geometry records as tagged literals; `emit!` then renders that structure with
  a fast string builder.  Output is deterministic (git-stable) and losslessly
  parsed back by `read-edn`."
  [data]
  (binding [cljs.core/*print-namespace-maps* false]
    (let [sb (gstr/StringBuffer.)]
      (emit! sb (canon data) 0)
      (.append sb "\n")
      (.toString sb))))

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
