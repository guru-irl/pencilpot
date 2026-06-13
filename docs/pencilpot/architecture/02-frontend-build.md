# Pencilpot — Building the frontend (render-wasm + app bundle)

The frontend bundle is **generated** (all artifacts gitignored). Building it from source requires the render-wasm toolchain. Recorded here because it's non-obvious and easy to get wrong.

## Toolchain (pinned to Penpot's devenv)
- **Rust 1.91.0** (rustup), target **`wasm32-unknown-emscripten`**.
- **Emscripten 4.0.6** (emsdk).
- Skia is **not** compiled — render-wasm downloads prebuilt Skia binaries (`SKIA_BINARIES_URL` in `render-wasm/_build_env`, v0.93.1).

Install (host, one-time):
```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain 1.91.0
source "$HOME/.cargo/env"; rustup target add wasm32-unknown-emscripten
git clone --depth 1 https://github.com/emscripten-core/emsdk.git "$HOME/emsdk"
cd "$HOME/emsdk" && ./emsdk install 4.0.6 && ./emsdk activate 4.0.6
```

## Step 1 — render-wasm → render_wasm_shared.js
`render-wasm/build` hardcodes `/opt/emsdk`; run the steps manually if emsdk is elsewhere. NOTE: do **not** use `set -u` — `_build_env` reads unset `NODE_ENV`.
```bash
export NODE_ENV=development            # => BUILD_MODE=debug (release = -O3, slower)
source "$HOME/.cargo/env"; source "$HOME/emsdk/emsdk_env.sh"
cd render-wasm && source ./_build_env
setup            # corepack + pnpm install (in render-wasm)
build            # cargo build -> wasm32-unknown-emscripten (downloads Skia, ~10 min)
copy_artifacts ../frontend/resources/public/js      # render-wasm.js, render-wasm.wasm, worker/render.js
copy_shared_artifact                                # render_wasm_shared.js -> frontend/src/app/render_wasm/api/shared.js
```
**Critical:** `frontend/src/app/render_wasm/api/shared.js` (the ~3.8KB glue, NOT the 18MB cljs `:shared` module of the same basename) is a **compile-time `:require`** of `app/render_wasm/wasm.cljs`. Without it, `build:app:main` fails with `The required JS dependency "./api/shared.js" is not available`. It can ONLY come from the render-wasm build — it is not a shipped/deployed asset.

## Step 2 — app bundle
```bash
cd frontend
corepack pnpm install
corepack pnpm run build:app          # clear cache + :main + :worker + :libs (CLJS, ~80s)
corepack pnpm run build:app:assets   # index.html (from index.mustache), css (sass), svgsprite, polyfills
```
Outputs to `frontend/resources/public/` (index.html, js/*, css/main.css, fonts, images).

## config.js is runtime-injected (NOT built)
`build:app:assets` does NOT produce `js/config.js`. In stock Penpot it's templated at container start from `PENPOT_*` env. index.html `<script src="config.js">` sets `window.penpotPublicURI`, `penpotFlags`, etc. **The pencilpot runtime must serve `config.js`** (set `penpotPublicURI=origin`, flags, + `window.pencilpotFile`).

## Quick rebuild after editing frontend CLJS (Phase 2 strip)
Only `pnpm run build:app:main` (+ `:assets` if templates/scss changed) is needed; render-wasm artifacts persist. ~1 min.
