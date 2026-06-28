# 09 — Local Profile & Profile-RPC Removal (Phase 4)

**Status:** Complete.
**Branch:** `pencilpot`
**Locations:**
`frontend/src/app/main.cljs` (`seed-local-profile`),
`frontend/src/app/main/data/profile.cljs` (`fetch-profile` / `refresh-profile` / `update-profile-props` / onboarding props),
`frontend/src/app/plugins/register.cljs` (`save-to-store` / `load-from-store`),
`pencilpot/e2e/vf/verify-no-profile-rpc.mjs`.
**Updated:** Phase 4 — three frontend choke points gutted of network; verified zero profile RPCs. (Pairs with the position-data half of the same plan, documented in `08-working-copy-dirty-persistence.md`.)

---

## Overview

Pencilpot has **no profile backend**. Stock Penpot opens the workspace by calling `:get-profile`
(via `refresh-profile`) and persists UI preferences with `:update-profile-props` — both fired on
**every** workspace open and logged `unhandled RPC …` against the pencilpot runtime, which serves no
such command. This change makes profile, props, and the plugin registry **fully local, zero-network**
by editing exactly **three** frontend choke points, while preserving the local app-state behaviour the
workspace UI depends on:

| Concern | Stock Penpot | Pencilpot |
|---|---|---|
| Boot identity | `:get-profile` RPC → `set-profile` | local profile **seeded** at boot (`seed-local-profile`) |
| Read / refresh profile | `fetch-profile` → `rp/cmd! :get-profile` | `fetch-profile` re-emits the seeded profile locally |
| Write preferences | `update-profile-props` → `rp/cmd! :update-profile-props` (+ `refresh-profile`) | local `[:profile :props]` merge only; no RPC |
| Plugin registry persist | `save-to-store` → `rp/cmd! :update-profile-props {:plugins …}` | `save-to-store` → `swap! st/state assoc-in [:profile :props :plugins]` |

This is a **deliberate hard-fork removal**, not a gated behaviour — stock-Penpot safety is not a
requirement here. The only invariants kept: the frontend must still **compile** (functions referenced
elsewhere stay defined) and the app must still **boot** (downstream code reading `:profile` from state
never NPEs, because the profile is seeded).

---

## 1. Boot — a synthetic local profile (`main.cljs`)

`app.main/seed-local-profile` (`frontend/src/app/main.cljs:70-83`) is a plain `UpdateEvent` that puts a
synthetic profile into app-state so no `:get-profile` is ever needed:

```clojure
;; pencilpot: seed a synthetic local profile so downstream code reading
;; :profile from state never NPEs (no get-profile RPC is made).
(defn- seed-local-profile []
  (ptk/reify ::seed-local-profile
    ptk/UpdateEvent
    (update [_ state]
      (let [profile {:id (uuid/next) :email "local@pencilpot" :fullname "Local"
                     :lang "" :theme "default" :props {}}]
        (-> state (assoc :profile-id (:id profile))
                  (assoc :profile profile))))))
```

It is emitted **synchronously during boot**, before routing, in `::initialize`'s `WatchEvent`
(`main.cljs:95-98`):

```clojure
;; Seed a local profile and initialize routing immediately — no get-profile RPC.
(rx/of (ev/initialize) (seed-local-profile) (rt/init-routes))
```

So by the time any view mounts, `:profile` / `:profile-id` are populated. (A fresh `uuid/next` id makes
`is-authenticated?` true — `is-authenticated?` only rejects `uuid/zero` — so authenticated-only branches
still behave.)

---

## 2. `fetch-profile` / `refresh-profile` — no `get-profile` (`profile.cljs`)

`fetch-profile` (`profile.cljs:97-105`) no longer calls `rp/cmd! :get-profile`. It re-emits the
**already-seeded** profile as the `::profile-fetched` data-event that `refresh-profile` (and any other
waiter) is listening for:

```clojure
(defn fetch-profile []
  (ptk/reify ::fetch-profile
    ;; pencilpot: no get-profile RPC. The local profile is seeded at boot
    ;; (app.main/seed-local-profile); re-emit it so refresh-profile and any other
    ;; ::profile-fetched waiters resolve locally.
    ptk/WatchEvent
    (watch [_ state _]
      (rx/of (ptk/data-event ::profile-fetched (:profile state))))))
```

`refresh-profile` (`profile.cljs:107-121`) is **unchanged in shape** and keeps working with zero
network: it emits `(fetch-profile)`, filters the stream for `profile-fetched?`, takes the authenticated
result, and maps it to `set-profile`. Because `fetch-profile` now feeds that stream locally, the whole
`refresh-profile → fetch-profile → set-profile` chain resolves without a single RPC.

---

## 3. `update-profile-props` — local props only (`profile.cljs`)

`update-profile-props` (`profile.cljs:283-296`) keeps its `UpdateEvent` (the local
`[:profile :props]` merge the UI reads), but its `WatchEvent` no longer calls `rp/cmd!` and no longer
chains `refresh-profile` (which used to drag in a `get-profile`). The only remaining side effect is a
**local** feature recompute when the renderer preference changes:

```clojure
(defn update-profile-props [props]
  (ptk/reify ::update-profile-props
    ptk/UpdateEvent
    (update [_ state] (update-in state [:profile :props] merge props))

    ;; pencilpot: no profile backend. Persist nothing and do NOT refresh-profile
    ;; (that chained get-profile). Keep only the local feature recompute when the
    ;; renderer prop changes.
    ptk/WatchEvent
    (watch [_ _ _]
      (if (contains? props :renderer)
        (rx/of (features/recompute-features))
        (rx/empty)))))
```

This is the highest-frequency offender: the workspace mount emits
`update-profile-props {:workspace-visited true}` (`set-workspace-visited`), so in stock Penpot a profile
write fired on every open. Now it mutates local state only.

### 3a. Onboarding / release-notes / questions ride the same local path

The onboarding and questions props funnel through `update-profile-props`, so they are local as a
consequence — no separate change was needed beyond gutting the one event:

- `mark-onboarding-as-viewed` (`profile.cljs:299-308`) → `update-profile-props {:onboarding-viewed true :release-notes-viewed <version>}`.
- `mark-questions-as-answered` (`profile.cljs:310-321`) → `update-profile-props {:onboarding-questions-answered true …}`.

Both update `[:profile :props]` locally and emit no network call.

---

## 4. Plugin registry — local state, not a profile RPC (`register.cljs`)

The plugin registry previously persisted itself by POSTing `:update-profile-props {:plugins …}`.
`save-to-store` (`plugins/register.cljs:97-102`) now writes straight into local profile state, and
`load-from-store` (`:104-106`) reads it back from the same place, closing the loop with zero network
(the commit also dropped the now-unused `app.main.repo` and `beicon` requires):

```clojure
(defn save-to-store []
  ;; pencilpot: no profile backend — keep the plugin registry in local profile
  ;; state only (load-from-store reads it back from there).
  (let [registry (update @registry :data d/update-vals d/without-nils)]
    (swap! st/state assoc-in [:profile :props :plugins] registry)))

(defn load-from-store []
  (reset! registry (get-in @st/state [:profile :props :plugins] {})))
```

`init` (`:108-110`) calls `load-from-store`; `install-plugin!` / `remove-plugin!` call `save-to-store`.
Since the plugin list lives under `[:profile :props :plugins]` — the same map seeded empty at boot — the
registry is consistent within a session without a backend. (It is **session-local**: there is no profile
persistence layer, so the plugin list does not survive a reload. Acceptable for the local single-user
tool; see residual notes.)

---

## 5. Scope — what was NOT touched

This change targeted the **two RPCs that fired on every workspace open** (`get-profile`,
`update-profile-props`) plus the plugin-registry write. Other profile-write RPCs remain **defined** in
`profile.cljs` (e.g. `persist-profile` → `:update-profile` from theme toggle, `profile.cljs:123`;
`update-password` → `:update-profile-password`; `update-photo` → `:update-profile-photo`;
`update-notifications` → `:update-profile-notifications`; account/recovery/access-token events). They are
intentionally left intact: they keep the frontend compiling, and the settings/dashboard surfaces that
trigger them were already removed in the Phase 2 frontend strip (`03-frontend-strip.md`), so they do not
fire in the shipped workspace-only shell. Removing their bodies was out of scope for this plan.

---

## 6. Verification — zero profile RPCs (`verify-no-profile-rpc.mjs`)

`pencilpot/e2e/vf/verify-no-profile-rpc.mjs` boots the runtime over a copy of the `.scratch/proj`
fixture, opens the workspace in headless Chromium on the **SVG renderer**, and records every
`/api/main/methods|command/<command>` request. It asserts:

- **(a) workspace mount** — after the header (`[aria-label="Main menu"]`) renders and
  `set-workspace-visited` settles, **zero** `get-profile` / `update-profile-props` requests were made.
- **(b) renderer change** — it rewrites `config.js` to enable the `:render-switch` flag, drives the real
  Preferences menu to toggle WebGL rendering (firing `update-profile-props {:renderer …}`), and asserts
  **zero** profile RPCs again. If the menu can't be driven it reports **SKIP** (flow (a) already exercises
  the network layer and the RPC removal is unconditional).
- **Non-vacuity guards** — it asserts the app made **other** RPCs (e.g. `get-file`), proving the request
  interceptor works and the app is live, so "zero profile RPCs" is meaningful, not vacuous.
- **Final hard gate** — total `get-profile` + `update-profile-props` across the whole session == 0.

`SKIP exit 0` when the fixture is absent. (The `PROFILE_RE` matches both `/methods/` and `/command/` URL
shapes so the assertion holds regardless of RPC path style.)

---

## Source map

| File | What |
|---|---|
| `frontend/src/app/main.cljs:68-98` | `seed-local-profile` + its emission in `::initialize` (no `get-profile` at boot) |
| `frontend/src/app/main/data/profile.cljs:97-105` | `fetch-profile` re-emits seeded profile (`::profile-fetched`) — no `:get-profile` |
| `frontend/src/app/main/data/profile.cljs:107-121` | `refresh-profile` — unchanged, now resolves locally |
| `frontend/src/app/main/data/profile.cljs:283-296` | `update-profile-props` — local props merge + renderer recompute only, no RPC |
| `frontend/src/app/main/data/profile.cljs:299-321` | onboarding / release-notes / questions props ride `update-profile-props` |
| `frontend/src/app/plugins/register.cljs:97-110` | `save-to-store`/`load-from-store`/`init` — plugin registry in local state |
| `pencilpot/e2e/vf/verify-no-profile-rpc.mjs` | e2e proof: zero `get-profile`/`update-profile-props` calls |

| Commit | Change |
|---|---|
| `72e07c8744` | `fetch-profile` resolves the local seeded profile (no `get-profile` RPC) |
| `0bb6119bb3` | `update-profile-props` no longer hits the network (local props only) |
| `94bd9d36cf` | plugin registry persists to local state, not `update-profile-props` RPC |
| `a8ea5ac05b` | onboarding/release-notes props update locally, no `update-profile-props` RPC |
| `a7ce5d7347` | e2e — frontend makes zero `get-profile`/`update-profile-props` calls |

Plan: `docs/superpowers/plans/2026-06-21-pencilpot-positiondata-and-profile-rpc.md` (Part B). The seed
itself predates Part B (added with the Phase 2 boot-to-workspace flow, `03-frontend-strip.md`).
