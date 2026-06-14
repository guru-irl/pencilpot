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

/** Weight ramp registered for a variable font (one entry per slot, all sharing
 *  the single VF file). Mirrors how Penpot models a custom family + how the
 *  DefaultLauncher VF was hand-registered. */
const VF_WEIGHT_RAMP = [100, 200, 300, 400, 500, 600, 700, 800, 900];

/**
 * Add a variable font file to the project.
 *
 * Options:
 *   file       — absolute path to the source font file (required, must exist)
 *   family     — font family name (required; derived from filename if omitted)
 *   fontId     — optional stable font-group id; defaults to `custom-<slug(family)>`
 *   axes       — array of { tag, min, default, max, name } (required, non-empty)
 *   instances  — optional array of { name, coords } named instances
 *
 * Copies the file into `<projectRoot>/fonts/<fontId><ext>` ONCE and writes a
 * FULL WEIGHT RAMP (100–900) of variant descriptors that all share that single
 * VF file, each carrying `variable: true` + axes (+ instances). The fontId is
 * `custom-<slug>` so the renderer classifies the family as a loadable :custom
 * font (the `font-backend` only treats `custom-`/`gfont-` prefixes as loadable;
 * a `vf-` prefix was misclassified as :builtin and never loaded), and weight
 * matching against the content's font-weight resolves a variant per weight.
 *
 * Idempotent: every variant id for this family (`<fontId>-w<weight>`) is
 * replaced on re-add. Returns the family descriptor:
 *   { fontId, family, file, format, variable, axes, instances?, variants:[…] }
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

  // Family-level font-id. MUST start with `custom-` so the renderer's
  // `font-backend` classifies it as a loadable custom font.
  let fId = fontId ?? `custom-${slugify(family)}`;
  if (!fId.startsWith("custom-")) fId = `custom-${fId}`;

  const dir = fontsDir(projectRoot);
  fs.mkdirSync(dir, { recursive: true });

  // Single shared VF binary, named after the family font-id.
  const destFile = `${fId}${ext}`;
  fs.copyFileSync(file, path.join(dir, destFile));

  const hasInstances = Array.isArray(instances) && instances.length > 0;

  // Write a variant per weight in the ramp, all pointing at the one file.
  const data = readFontsJson(projectRoot);
  // Drop any prior ramp entries for this family (idempotent re-add).
  data.variants = data.variants.filter((v) => v.fontId !== fId);

  const variants = VF_WEIGHT_RAMP.map((weight) => {
    const variant = {
      id: `${fId}-w${weight}`,
      fontId: fId,
      family,
      weight,
      style: "normal",
      file: destFile,
      format,
      variable: true,
      axes,
    };
    if (hasInstances) variant.instances = instances;
    return variant;
  });

  data.variants.push(...variants);
  fs.writeFileSync(fontsJsonPath(projectRoot), JSON.stringify(data, null, 2));

  const descriptor = { fontId: fId, family, file: destFile, format, variable: true, axes, variants };
  if (hasInstances) descriptor.instances = instances;
  return descriptor;
}
