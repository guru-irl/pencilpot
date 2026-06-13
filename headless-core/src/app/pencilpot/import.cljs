(ns app.pencilpot.import
  "Native .penpot (binfile v3 ZIP) → pencilpot store converter.

  The ZIP is unpacked by Node; this ns receives a grouped JSON structure
  and does all decoding/assembly purely inside the engine — no external
  Penpot backend, no network.

  Entry-point: `import-binfile-v3` (exported as `importBinfileV3`)."
  (:require
   [app.common.json            :as json]
   [app.common.schema          :as sm]
   [app.common.types.color     :as ctcl]
   [app.common.types.component :as ctc]
   [app.common.types.file      :as ctf]
   [app.common.types.page      :as ctp]
   [app.common.types.shape     :as cts]
   [app.common.types.tokens-lib :as ctob]
   [app.common.types.typography :as cty]
   [app.common.uuid            :as uuid]
   [app.pencilpot.store        :as store]))

;; ---------------------------------------------------------------------------
;; Decoders (malli json-transformer — mirror of backend v3.clj)
;; ---------------------------------------------------------------------------

(def ^:private decode-shape
  (sm/decoder cts/schema:shape sm/json-transformer))

(def ^:private decode-page
  (sm/decoder ctp/schema:page sm/json-transformer))

(def ^:private decode-color
  (sm/decoder ctcl/schema:library-color sm/json-transformer))

(def ^:private decode-typography
  (sm/decoder cty/schema:typography sm/json-transformer))

(def ^:private decode-tokens-lib
  (sm/decoder ctob/schema:tokens-lib sm/json-transformer))

(def ^:private decode-component
  (sm/decoder ctc/schema:component sm/json-transformer))

(def ^:private decode-media
  (sm/decoder ctf/schema:media sm/json-transformer))

;; ---------------------------------------------------------------------------
;; Helpers
;; ---------------------------------------------------------------------------

(defn- ->clj
  "Parse a JSON string into kebab-keyword clojure data."
  [json-str]
  (json/->clj (.parse js/JSON json-str) :key-fn json/read-kebab-key))

(defn- ->clj-raw
  "Parse a JSON string into plain clojure data (no key transform) — used for
  tokens-lib which expects its own structure."
  [json-str]
  (json/->clj (.parse js/JSON json-str)))

;; ---------------------------------------------------------------------------
;; Manifest
;; ---------------------------------------------------------------------------

(defn- parse-manifest
  "Parse the manifest.json text → {:version :type :files [{:id :name :features}] :relations}"
  [manifest-text]
  (let [raw (->clj manifest-text)]
    ;; Coerce file :id strings to UUID objects (they come as plain strings)
    (update raw :files
            (fn [files]
              (mapv (fn [f] (update f :id uuid/uuid)) files)))))

;; ---------------------------------------------------------------------------
;; Assemble a single file
;; ---------------------------------------------------------------------------

(defn- decode-shapes
  "Given a map {sid-str → json-str} decode each shape."
  [shapes-json]
  (reduce-kv
   (fn [acc sid-str shape-str]
     (let [sid   (uuid/uuid sid-str)
           raw   (->clj shape-str)
           shape (decode-shape raw)]
       (assoc acc sid shape)))
   {}
   shapes-json))

(defn- decode-page-data
  "Given page JSON text + shapes map {sid-str → json-str}, decode the page
  and assemble its :objects."
  [page-text shapes-json]
  (let [raw-page (->clj page-text)
        page     (decode-page raw-page)
        objects  (decode-shapes shapes-json)
        ;; Page from v3.clj drops :options and :index at the file-data level.
        ;; We keep :id and :name and inject :objects.
        page     (-> page
                     (dissoc :options :index)
                     (assoc :objects objects))]
    page))

(defn- decode-colors
  "Given {:color-id-str → json-str}, decode each library-color."
  [colors-json]
  (reduce-kv
   (fn [acc cid-str color-str]
     (let [cid   (uuid/uuid cid-str)
           raw   (->clj color-str)
           color (decode-color raw)]
       (assoc acc cid color)))
   {}
   (or colors-json {})))

(defn- decode-typographies
  "Given {:typ-id-str → json-str}, decode each typography."
  [typos-json]
  (reduce-kv
   (fn [acc tid-str typo-str]
     (let [tid  (uuid/uuid tid-str)
           raw  (->clj typo-str)
           typo (decode-typography raw)]
       (assoc acc tid typo)))
   {}
   (or typos-json {})))

(defn- decode-components
  "Given {:comp-id-str → json-str}, decode each component."
  [comps-json]
  (reduce-kv
   (fn [acc cid-str comp-str]
     (let [cid  (uuid/uuid cid-str)
           raw  (->clj comp-str)
           comp (decode-component raw)]
       (assoc acc cid comp)))
   {}
   (or comps-json {})))

(defn- decode-tokens-lib-entry
  "Decode a tokens-lib JSON string (plain DTCG-JSON, not kebab-keyed)."
  [tokens-str]
  (when (and tokens-str (not= tokens-str "null"))
    (let [raw (->clj-raw tokens-str)]
      (decode-tokens-lib raw))))

(defn- assemble-file-data
  "Given all decoded file-level parts, build the :data map shape expected
  by serialize-store / the pencilpot engine."
  [{:keys [file-meta pages-data colors typographies components tokens-lib]}]
  ;; pages-data: [{:id uuid :name str :objects {uuid shape} ...}]
  ;; sorted by the :index already stripped; we preserve iteration order
  ;; (pages-data is ordered by page-index from Node).
  (let [page-order  (mapv :id pages-data)
        pages-index (reduce (fn [m p] (assoc m (:id p) p)) {} pages-data)]
    {:pages       page-order
     :pages-index pages-index
     :components  (when (seq components) components)
     :colors      (when (seq colors) colors)
     :typographies (when (seq typographies) typographies)
     :tokens-lib  tokens-lib
     :options     (:options file-meta)}))

;; ---------------------------------------------------------------------------
;; Public export: importBinfileV3
;; ---------------------------------------------------------------------------

(defn ^:export import-binfile-v3
  "Convert a grouped binfile-v3 JSON structure into a pencilpot store parts map.

  `entries-json` is a JSON string with shape:
    {
      \"manifest\": \"<manifest.json text>\",
      \"files\": {
        \"<file-id-str>\": {
          \"file\": \"<file.json text>\",
          \"pages\": {
            \"<page-id-str>\": {
              \"page\": \"<page.json text>\",
              \"shapes\": { \"<shape-id-str>\": \"<shape.json text>\", … }
            }
          },
          \"colors\":       { \"<id-str>\": \"<color.json>\", … },
          \"typographies\":  { \"<id-str>\": \"<typo.json>\",  … },
          \"components\":    { \"<id-str>\": \"<comp.json>\",  … },
          \"tokensLib\":     \"<tokens.json text>\" | null,
          \"mediaIds\":      [\"<uuid-str>\", …]
        }
      }
    }

  Returns a JSON string:
    {
      \"parts\": { manifest:edn, pages:{id:edn}, components:{id:edn}, media:[id] },
      \"mediaIds\": [\"<uuid-str>\", …]
    }"
  [entries-json]
  (let [entries  (js->clj (js/JSON.parse entries-json))
        ;; Parse manifest
        manifest (parse-manifest (get entries "manifest"))
        ;; Pick first file (single-file import; multi-file TODO)
        first-file-entry (-> manifest :files first)
        file-id          (:id first-file-entry)
        file-id-str      (str file-id)
        file-name        (:name first-file-entry)
        features         (:features first-file-entry)

        files-map        (get entries "files")
        file-entry       (get files-map file-id-str)

        ;; Parse file-level metadata (options etc.)
        file-meta        (when (get file-entry "file")
                           (->clj (get file-entry "file")))

        ;; Decode pages (in order as provided by Node)
        pages-raw        (get file-entry "pages" {})
        pages-data       (->> pages-raw
                              (map (fn [[pid-str page-entry]]
                                     (let [page-text   (get page-entry "page")
                                           shapes-json (get page-entry "shapes" {})]
                                       (decode-page-data page-text shapes-json))))
                              (vec))

        ;; Decode file-level library entries
        colors        (decode-colors (get file-entry "colors"))
        typographies  (decode-typographies (get file-entry "typographies"))
        components    (decode-components (get file-entry "components"))
        tokens-lib    (decode-tokens-lib-entry (get file-entry "tokensLib"))
        media-ids     (vec (get file-entry "mediaIds" []))

        ;; Assemble the file :data
        data          (assemble-file-data
                       {:file-meta    file-meta
                        :pages-data   pages-data
                        :colors       colors
                        :typographies typographies
                        :components   components
                        :tokens-lib   tokens-lib})

        ;; Build a state map compatible with serialize-store
        state         {:data     data
                       :revn     (or (:revn file-meta) 0)
                       :vern     (or (:vern file-meta) 0)
                       :name     file-name
                       :features (set (or features []))
                       :libraries []
                       :is-shared (boolean (:is-shared file-meta))}

        ;; Serialize to canonical EDN parts (same format as normal designs)
        parts         (store/serialize-store file-id state)]

    (js/JSON.stringify
     (clj->js {:parts    parts
               :mediaIds media-ids}))))
