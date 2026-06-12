import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

// A project root = dir containing shared/ (and a .git). init creates both.
export function initProject(root) {
  fs.mkdirSync(path.join(root, "shared"), { recursive: true });
  if (!fs.existsSync(path.join(root, ".git"))) {
    execFileSync("git", ["init", "-q"], { cwd: root });
    fs.writeFileSync(path.join(root, ".gitignore"), ".pencilpot-cache/\n");
  }
  return root;
}

// Walk up from any path to the nearest dir containing shared/ or .git.
export function resolveProjectRoot(start) {
  let d = fs.existsSync(start) && fs.statSync(start).isDirectory() ? start : path.dirname(start);
  for (;;) {
    if (fs.existsSync(path.join(d, "shared")) || fs.existsSync(path.join(d, ".git"))) return d;
    const up = path.dirname(d);
    if (up === d) return path.dirname(start); // fallback: design's parent
    d = up;
  }
}

export function listDesigns(root) {
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.endsWith(".penpot") && e.name !== "shared")
    .map((e) => path.join(root, e.name));
}
