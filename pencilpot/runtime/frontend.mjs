import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

export function distDir() {
  return process.env.PENCILPOT_FRONTEND || path.resolve(HERE, "../../frontend/resources/public");
}

// Runtime-injected config.js body (replaces the env-templated one in stock
// Penpot). The save chrome, dirty indicator, Ctrl/Cmd+S handling and the
// external-changes banner are now native CLJS (app.main.data.pencilpot + the
// native header/File menu), so config.js only seeds the bootstrap globals.
export function configJs({ publicUri = "", fileId = null, teamId = null } = {}) {
  return `globalThis.penpotPublicURI=${publicUri ? JSON.stringify(publicUri) : "location.origin"};`
    // `disable-render-wasm-info` strips the upstream dev default that paints a
    // "WebGL rendering" debug label on the wasm canvas every frame. penpotFlags=""
    // would otherwise inherit common/flags `default` (a dev flag set), leaving the
    // debug overlay visible in a shipped pencilpot session.
    + `globalThis.penpotFlags="disable-render-wasm-info";`
    + `globalThis.pencilpotFile=${JSON.stringify({ fileId, teamId })};`;
}
