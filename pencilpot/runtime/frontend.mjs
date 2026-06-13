import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

export function distDir() {
  return process.env.PENCILPOT_FRONTEND || path.resolve(HERE, "../../frontend/resources/public");
}

// Runtime-injected config.js body (replaces the env-templated one in stock Penpot).
export function configJs({ publicUri = "", fileId = null, teamId = null } = {}) {
  return `globalThis.penpotPublicURI=${publicUri ? JSON.stringify(publicUri) : "location.origin"};`
    + `globalThis.penpotFlags="";`
    + `globalThis.pencilpotFile=${JSON.stringify({ fileId, teamId })};`;
}
