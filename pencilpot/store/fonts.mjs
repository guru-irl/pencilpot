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
