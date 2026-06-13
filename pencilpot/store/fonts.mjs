/**
 * Font storage for Pencilpot projects.
 *
 * Layout inside a project root:
 *   fonts/
 *     fonts.json          — index of all added font variants
 *     <id>.<ext>          — binary font files (woff2, ttf, otf, woff)
 *
 * fonts.json shape:
 *   {
 *     "variants": [
 *       {
 *         "id":     "<family-slug>-<weight>-<style>",
 *         "fontId": "<uuid-or-same-as-id>",
 *         "family": "Font Family Name",
 *         "weight": 400,
 *         "style":  "normal",
 *         "file":   "<id>.<ext>",
 *         "format": "woff2" | "ttf" | "otf" | "woff"
 *       }
 *     ]
 *   }
 *
 * Variable-font variants carry extra keys:
 *   {
 *     ...static fields...,
 *     "variable":  true,
 *     "axes":      [{ "tag", "min", "default", "max", "name" }, …],
 *     "instances": [{ "name", "coords": { "<tag>": value, … } }, …]  // optional
 *   }
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

// ── format detection ──────────────────────────────────────────────────────────

const EXT_FORMAT = {
  ".woff2": "woff2",
  ".woff":  "woff1",
  ".ttf":   "ttf",
  ".otf":   "otf",
};

function detectFormat(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return EXT_FORMAT[ext] ?? "ttf";
}

// ── id generation ─────────────────────────────────────────────────────────────

function slugify(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function variantId(family, weight, style) {
  return `${slugify(family)}-${weight}-${slugify(style)}`;
}

// ── helpers ───────────────────────────────────────────────────────────────────

function fontsDir(projectRoot) {
  return path.join(projectRoot, "fonts");
}

function fontsJsonPath(projectRoot) {
  return path.join(fontsDir(projectRoot), "fonts.json");
}

function readFontsJson(projectRoot) {
  const p = fontsJsonPath(projectRoot);
  if (!fs.existsSync(p)) return { variants: [] };
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

// ── public API ────────────────────────────────────────────────────────────────

/**
 * Read all font variants registered in the project.
 * Returns [] if no fonts have been added.
 */
export function readFonts(projectRoot) {
  return readFontsJson(projectRoot).variants;
}

/**
 * Add a font file to the project.
 *
 * Options:
 *   file    — absolute path to the source font file (required)
 *   family  — font family name (required; derive from filename if omitted)
 *   weight  — numeric weight, default 400
 *   style   — "normal" | "italic", default "normal"
 *   fontId  — optional stable font-group id; defaults to same as variant id
 *
 * Copies the file into `<projectRoot>/fonts/<id>.<ext>`, updates fonts.json,
 * and returns the new variant descriptor.
 */
export function addFont(projectRoot, { file, family, weight = 400, style = "normal", fontId } = {}) {
  if (!file) throw new Error("addFont: file is required");
  if (!fs.existsSync(file)) throw new Error(`addFont: file not found: ${file}`);

  // Derive family from filename if not provided
  if (!family) {
    family = path.basename(file, path.extname(file)).replace(/[-_]+/g, " ");
  }

  const format = detectFormat(file);
  const ext = path.extname(file).toLowerCase();
  const id = variantId(family, weight, style);

  // Ensure fontId is stable: use provided one or fall back to variant id
  const fId = fontId ?? id;

  const dir = fontsDir(projectRoot);
  fs.mkdirSync(dir, { recursive: true });

  // Determine destination filename (unique: avoid overwriting different-family files)
  const destFile = `${id}${ext}`;
  const destPath = path.join(dir, destFile);
  fs.copyFileSync(file, destPath);

  // Update fonts.json
  const data = readFontsJson(projectRoot);
  // Remove any existing variant with same id before appending (idempotent re-add)
  data.variants = data.variants.filter((v) => v.id !== id);
  const variant = { id, fontId: fId, family, weight, style, file: destFile, format };
  data.variants.push(variant);
  fs.writeFileSync(fontsJsonPath(projectRoot), JSON.stringify(data, null, 2));

  return variant;
}

/**
 * Add a variable font file to the project.
 *
 * Options:
 *   file       — absolute path to the source font file (required, must exist)
 *   family     — font family name (required; derived from filename if omitted)
 *   fontId     — optional stable font-group id; defaults to `vf-<slug(family)>`
 *   axes       — array of { tag, min, default, max, name } (required, non-empty)
 *   instances  — optional array of { name, coords } named instances
 *
 * Copies the file into `<projectRoot>/fonts/<id><ext>` and writes ONE variant
 * descriptor carrying `variable: true`, the axes, and (if any) the instances.
 * The variant id equals the fontId so the whole variable family is one entry.
 * Idempotent: any existing variant with the same id is replaced.
 *
 * The variant's `weight` is taken from the `wght` axis default (else 400) and
 * `style` is always "normal" (italic is expressed through the `slnt`/`ital`
 * axes for variable fonts).
 */
export function addVariableFont(projectRoot, { file, family, fontId, axes, instances } = {}) {
  if (!file) throw new Error("addVariableFont: file is required");
  if (!fs.existsSync(file)) throw new Error(`addVariableFont: file not found: ${file}`);
  if (!Array.isArray(axes) || axes.length === 0) {
    throw new Error("addVariableFont: axes are required (non-empty array)");
  }

  // Derive family from filename if not provided
  if (!family) {
    family = path.basename(file, path.extname(file)).replace(/[-_]+/g, " ");
  }

  const format = detectFormat(file);
  const ext = path.extname(file).toLowerCase();

  // The whole variable font is a single entry keyed by fontId.
  const fId = fontId ?? `vf-${slugify(family)}`;
  const id = fId;

  // Default weight = the wght axis default, else 400.
  const wghtAxis = axes.find((a) => a.tag === "wght");
  const weight = wghtAxis && Number.isFinite(wghtAxis.default) ? Math.round(wghtAxis.default) : 400;

  const dir = fontsDir(projectRoot);
  fs.mkdirSync(dir, { recursive: true });

  const destFile = `${id}${ext}`;
  const destPath = path.join(dir, destFile);
  fs.copyFileSync(file, destPath);

  // Update fonts.json (idempotent re-add)
  const data = readFontsJson(projectRoot);
  data.variants = data.variants.filter((v) => v.id !== id);
  const variant = {
    id,
    fontId: fId,
    family,
    weight,
    style: "normal",
    file: destFile,
    format,
    variable: true,
    axes,
  };
  if (Array.isArray(instances) && instances.length > 0) {
    variant.instances = instances;
  }
  data.variants.push(variant);
  fs.writeFileSync(fontsJsonPath(projectRoot), JSON.stringify(data, null, 2));

  return variant;
}
