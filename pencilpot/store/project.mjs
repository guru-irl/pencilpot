import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

// ---------------------------------------------------------------------------
// New .pencil project model
// ---------------------------------------------------------------------------

/**
 * Find the single *.pencil file in a directory.
 * Returns the full path or null if not found.
 */
function findPencilFile(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return null;
  }
  const files = entries.filter((e) => e.endsWith(".pencil"));
  if (files.length === 1) return path.join(dir, files[0]);
  return null;
}

/**
 * Initialise a new .pencil project.
 *
 * initProject(root, name)  — new API: writes <name>.pencil + designs/ + shared/ + git
 * initProject(root)        — backward-compat: skips .pencil manifest; just shared/ + git
 *
 * Returns root.
 */
export function initProject(root, name) {
  fs.mkdirSync(path.join(root, "shared"), { recursive: true });
  if (!fs.existsSync(path.join(root, ".git"))) {
    execFileSync("git", ["init", "-q"], { cwd: root });
    fs.writeFileSync(path.join(root, ".gitignore"), ".pencilpot-cache/\n");
  }
  if (name !== undefined) {
    fs.mkdirSync(path.join(root, "designs"), { recursive: true });
    const manifest = { name, designs: [], default: null, version: 1 };
    fs.writeFileSync(path.join(root, `${name}.pencil`), JSON.stringify(manifest, null, 2));
  }
  return root;
}

/**
 * Add a design entry to a project.
 * Creates designs/<name>/ on disk and records the entry in the .pencil manifest.
 * Sets `default` to the first design if it was null.
 * Returns the absolute path to the design dir.
 */
export function addDesign(root, name) {
  const pencilPath = findPencilFile(root);
  if (!pencilPath) throw new Error(`No .pencil manifest found in ${root}`);
  const designDir = path.join(root, "designs", name);
  fs.mkdirSync(designDir, { recursive: true });
  const manifest = JSON.parse(fs.readFileSync(pencilPath, "utf8"));
  if (!manifest.designs.find((d) => d.name === name)) {
    manifest.designs.push({ name, path: `designs/${name}` });
  }
  if (manifest.default === null) manifest.default = manifest.designs[0].name;
  fs.writeFileSync(pencilPath, JSON.stringify(manifest, null, 2));
  return designDir;
}

/**
 * Parse a .pencil file and return a project descriptor:
 *   { root, name, designs: [{name, dir}], default }
 */
export function readProject(pencilPath) {
  const root = path.dirname(pencilPath);
  const raw = JSON.parse(fs.readFileSync(pencilPath, "utf8"));
  return {
    root,
    name: raw.name,
    designs: (raw.designs || []).map((d) => ({
      name: d.name,
      dir: path.join(root, d.path),
    })),
    default: raw.default ?? null,
  };
}

/**
 * Resolve the project from any path inside (or at) the project tree.
 * Walks up from `anyPath` to find the nearest directory containing a single
 * *.pencil file.  Also accepts a direct path to a .pencil file.
 * Returns the same object as readProject().
 * Throws a clear error if no project is found.
 */
export function resolveProject(anyPath) {
  // If given a .pencil file directly, use its directory.
  let start;
  if (anyPath.endsWith(".pencil") && fs.existsSync(anyPath)) {
    return readProject(anyPath);
  }
  start = fs.existsSync(anyPath) && fs.statSync(anyPath).isDirectory()
    ? anyPath
    : path.dirname(anyPath);

  let d = start;
  for (;;) {
    const pencilFile = findPencilFile(d);
    if (pencilFile) return readProject(pencilFile);
    const up = path.dirname(d);
    if (up === d) break; // reached filesystem root
    d = up;
  }
  throw new Error(`No .pencil project found above ${anyPath}`);
}

/**
 * List designs in a project root dir.
 * Reads the .pencil manifest and returns [{name, dir}].
 */
export function listDesigns(root) {
  const pencilPath = findPencilFile(root);
  if (!pencilPath) return [];
  const { designs } = readProject(pencilPath);
  return designs;
}

// ---------------------------------------------------------------------------
// Backward-compat: Phase 1 API
// ---------------------------------------------------------------------------

/**
 * Walk up from any path to the nearest dir containing shared/ or .git.
 * Kept for callers (rpc.mjs) that still use the Phase 1 API.
 */
export function resolveProjectRoot(start) {
  let d = fs.existsSync(start) && fs.statSync(start).isDirectory() ? start : path.dirname(start);
  for (;;) {
    if (fs.existsSync(path.join(d, "shared")) || fs.existsSync(path.join(d, ".git"))) return d;
    const up = path.dirname(d);
    if (up === d) return path.dirname(start); // fallback: design's parent
    d = up;
  }
}
