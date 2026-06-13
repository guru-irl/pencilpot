(ns app.pencilpot.store
  "Canonical-EDN serializer/deserializer for the pencilpot on-disk store.

  Lossless: keywords, #uuid literals, sets, and Penpot record types (e.g.
  TokensLib, PathData) all survive the round-trip.
  Deterministic: sorted-map-by print-representation ensures byte-identical
  output when data is unchanged, keeping git diffs minimal."
  (:require
   [cljs.reader :as reader]
   [clojure.pprint :as pp]
   [app.common.uuid :as uuid]
   [app.common.types.path :as path]
   [app.common.types.tokens-lib :as ctob]))

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
  become vectors (preserving order).  Scalars pass through unchanged."
  [x]
  (cond
    (map? x)    (into (sorted-map-by kcmp)
                      (map (fn [[k v]] [k (canon v)]) x))
    (set? x)    (into (sorted-set-by kcmp)
                      (map canon x))
    (vector? x) (mapv canon x)
    (seq? x)    (mapv canon x)
    :else       x))

(defn canonical-edn
  "Return a deterministic, pretty-printed EDN string for `data`."
  [data]
  (binding [cljs.pprint/*print-right-margin*  80
            cljs.core/*print-namespace-maps*  false]
    (with-out-str (pp/pprint (canon data)))))

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

(defn read-edn
  "Parse an EDN string produced by `canonical-edn`.  Supports the #uuid
  tagged literal and all Penpot tagged literals that appear in file :data
  (#penpot/tokens-lib and #penpot/path-data)."
  [s]
  (reader/read-string {:readers {'uuid              uuid/uuid
                                 'penpot/tokens-lib edn-read-tokens-lib
                                 'penpot/path-data  edn-read-path-data}}
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
