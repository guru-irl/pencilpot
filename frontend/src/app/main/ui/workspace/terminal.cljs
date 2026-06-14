;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS INC Sucursal en España SL

(ns app.main.ui.workspace.terminal
  "pencilpot integrated terminal — a collapsible, VS Code-style bottom dock that
   hosts an xterm.js terminal wired to the runtime PTY over a WebSocket
   (`/pencilpot/terminal`).

   xterm.js (and its fit addon) are imperative DOM/IO libraries; we drive them
   directly via JS interop, mirroring how Penpot consumes other npm libs
   (e.g. highlight.js in `app.util.code-highlight`).

   Wire protocol (mirrors pencilpot/runtime/terminal.mjs):
     - Raw text frames are shell I/O, forwarded verbatim.
     - Control frames are prefixed with a NUL byte (\\u0000) + JSON:
         server -> client: {\"type\":\"ready\"|\"exit\"|\"error\", ...}
         client -> server: {\"type\":\"resize\",\"cols\":N,\"rows\":M}"
  (:require-macros [app.main.style :as stl])
  (:require
   ["@xterm/addon-fit" :as addon-fit]
   ["@xterm/xterm" :as xterm]
   [app.main.data.workspace.layout :as dwl]
   [app.main.store :as st]
   [app.util.dom :as dom]
   [rumext.v2 :as mf]))

(def ^:private min-height 120)
(def ^:private max-height 720)
(def ^:private default-height 280)

;; Control-frame prefix: a single NUL byte.  Must match the runtime.
(def ^:private ctrl-prefix (js/String.fromCharCode 0))

;; Theme tuned to match Penpot's dark workspace surfaces.
(def ^:private theme
  #js {:background "#18181a"
       :foreground "#e3e3e8"
       :cursor "#7b61ff"
       :cursorAccent "#18181a"
       :selectionBackground "#7b61ff66"})

(defn- ws-url
  "Derive the terminal WebSocket URL from the current origin."
  []
  (str (.replace (.-origin js/location) #"^http" "ws") "/pencilpot/terminal"))

(defn- send-ctrl!
  [sock obj]
  (when (and sock (= (.-readyState sock) (.-OPEN js/WebSocket)))
    (.send sock (str ctrl-prefix (js/JSON.stringify (clj->js obj))))))

(defn- make-terminal
  "Create an xterm Terminal + FitAddon, mount it into `node`, and connect a
   WebSocket to the runtime PTY.  Returns a JS object with #js{:term :fit :dispose}.
   The socket is stored in an atom so reconnect (after the shell exits) is cheap."
  [node]
  (let [term     (xterm/Terminal.
                  #js {:fontFamily "ui-monospace, \"SF Mono\", \"JetBrains Mono\", Menlo, Consolas, monospace"
                       :fontSize 13
                       :lineHeight 1.2
                       :cursorBlink true
                       :scrollback 5000
                       :theme theme
                       :allowProposedApi true})
        fit      (addon-fit/FitAddon.)
        sock*    (atom nil)
        disposed (atom false)
        last-dim (atom #js {:cols 0 :rows 0})]

    (.loadAddon term fit)
    (.open term node)

    (letfn [(send-resize! []
              (reset! last-dim #js {:cols (.-cols term) :rows (.-rows term)})
              (send-ctrl! @sock* {:type "resize" :cols (.-cols term) :rows (.-rows term)}))

            (handle-ctrl! [data]
              (let [^js ctrl (try (js/JSON.parse (subs data 1)) (catch :default _ nil))]
                (when ctrl
                  (case (.-type ctrl)
                    "ready" (when (false? (.-pty ctrl))
                              (.writeln term "[33m[pencilpot] node-pty unavailable — degraded pipe mode (no TTY).[0m"))
                    "exit"  (.writeln term (str "\r\n[90m[process exited with code " (.-code ctrl) "] — press Enter to restart[0m"))
                    "error" (.writeln term (str "\r\n[31m[pencilpot terminal error] " (.-message ctrl) "[0m"))
                    nil))))

            (connect! []
              (let [sock (js/WebSocket. (ws-url))]
                (set! (.-binaryType sock) "arraybuffer")
                (reset! sock* sock)
                (set! (.-onopen sock) (fn [_] (send-resize!)))
                (set! (.-onmessage sock)
                      (fn [ev]
                        (let [data (if (string? (.-data ev))
                                     (.-data ev)
                                     (.decode (js/TextDecoder.) (.-data ev)))]
                          (if (and (pos? (.-length data))
                                   (= (subs data 0 1) ctrl-prefix))
                            (handle-ctrl! data)
                            (.write term data)))))
                (set! (.-onclose sock)
                      (fn [_]
                        (when-not @disposed
                          (.writeln term "\r\n[90m[disconnected] — press Enter to reconnect[0m"))))
                (set! (.-onerror sock) (fn [_] nil))))]

      ;; Forward keystrokes; Enter reconnects when the socket is closed.
      (.onData term
               (fn [d]
                 (let [sock @sock*]
                   (cond
                     (and sock (= (.-readyState sock) (.-OPEN js/WebSocket)))
                     (.send sock d)

                     (= d "\r")
                     (do (.clear term) (connect!))))))

      (.onResize term (fn [_] (send-resize!)))

      (connect!)

      #js {:term term
           :fit (fn []
                  (when-not @disposed
                    (try (.fit fit) (catch :default _ nil))
                    (when (or (not= (.-cols term) (.-cols @last-dim))
                              (not= (.-rows term) (.-rows @last-dim)))
                      (send-resize!))))
           :focus (fn [] (when-not @disposed (.focus term)))
           :dispose (fn []
                      (reset! disposed true)
                      (when-let [s @sock*] (try (.close s) (catch :default _ nil)))
                      (try (.dispose term) (catch :default _ nil)))})))

(defn- close-terminal!
  []
  (st/emit! (dwl/remove-layout-flag :terminal)))

(mf/defc terminal-dock*
  "Bottom-dock terminal.  Rendered only when the `:terminal` layout flag is set;
   mounting creates a fresh PTY session, unmounting tears it down."
  []
  (let [host-ref  (mf/use-ref nil)
        term-ref  (mf/use-ref nil)
        height    (mf/use-state default-height)
        dragging? (mf/use-state false)]

    ;; Create the xterm instance once the host node is mounted; dispose on unmount.
    (mf/with-effect []
      (let [node      (mf/ref-val host-ref)
            ^js inst  (make-terminal node)]
        (mf/set-ref-val! term-ref inst)
        (js/requestAnimationFrame
         (fn []
           ((.-fit inst))
           ((.-focus inst))))
        (fn []
          ((.-dispose inst))
          (mf/set-ref-val! term-ref nil))))

    ;; Re-fit when the dock height changes.
    (mf/with-effect [@height]
      (when-let [^js inst (mf/ref-val term-ref)]
        (js/requestAnimationFrame (fn [] ((.-fit inst))))))

    (let [on-resize-down
          (mf/use-fn
           (fn [event]
             (dom/prevent-default event)
             (reset! dragging? true)
             (let [start-y      (.-clientY event)
                   start-height @height
                   on-move      (fn [ev]
                                  (let [dy     (- start-y (.-clientY ev))
                                        next-h (-> (+ start-height dy)
                                                   (max min-height)
                                                   (min max-height))]
                                    (reset! height next-h)))
                   on-up*       (atom nil)]
               (reset! on-up*
                       (fn [_]
                         (reset! dragging? false)
                         (.removeEventListener js/window "mousemove" on-move)
                         (.removeEventListener js/window "mouseup" @on-up*)))
               (.addEventListener js/window "mousemove" on-move)
               (.addEventListener js/window "mouseup" @on-up*))))

          on-close
          (mf/use-fn (fn [event]
                       (dom/prevent-default event)
                       (close-terminal!)))]

      [:section {:class (stl/css :terminal-dock)
                 :style {:height (str @height "px")}}
       [:div {:class (stl/css-case :terminal-resizer true
                                   :is-dragging @dragging?)
              :on-mouse-down on-resize-down}]
       [:header {:class (stl/css :terminal-header)}
        [:span {:class (stl/css :terminal-title)} "Terminal"]
        [:div {:class (stl/css :terminal-actions)}
         [:button {:class (stl/css :terminal-close)
                   :title "Close terminal (Ctrl+`)"
                   :on-click on-close}
          "✕"]]]
       [:div {:class (stl/css :terminal-body)
              :ref host-ref}]])))
