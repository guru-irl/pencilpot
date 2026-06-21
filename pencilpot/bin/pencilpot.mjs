#!/usr/bin/env node
/**
 * pencilpot CLI — new / open / install-desktop / uninstall-desktop
 *
 * Usage:
 *   pencilpot new <name|dir> [--design <d>]
 *   pencilpot open <path.pencil|dir> [--no-window] [--port N]
 *   pencilpot install-desktop
 *   pencilpot uninstall-desktop
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:net";

// ---------------------------------------------------------------------------
// Arg parser (minimal, no deps)
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const args = argv.slice(2); // drop node + script
  let cmd = args[0];
  const flags = {};
  const positional = [];

  // Normalise --help / -h as a pseudo-command so the switch below can handle it.
  if (cmd === "--help" || cmd === "-h") {
    cmd = "--help";
    return { cmd, flags, positional };
  }

  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (a === "--help" || a === "-h") {
      flags["help"] = true;
    } else if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        // Accumulate multi-value flags (e.g. --family / --map can repeat)
        if (key === "family" || key === "map") {
          if (!Array.isArray(flags[key])) flags[key] = [];
          flags[key].push(next);
        } else {
          flags[key] = next;
        }
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(a);
    }
  }
  return { cmd, flags, positional };
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------
const RUNTIME_DIR = path.resolve(import.meta.dirname, "../runtime");
const SERVER_MJS  = path.join(RUNTIME_DIR, "server.mjs");
const LAUNCH_MJS  = path.join(RUNTIME_DIR, "launch.mjs");

/** Pick a free TCP port. */
function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

/** Poll until GET <url> responds with any 2xx or 404, up to timeoutMs. */
async function waitForHttp(url, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (r.status < 500) return true;
    } catch {}
    await new Promise((res) => setTimeout(res, 200));
  }
  return false;
}

// ---------------------------------------------------------------------------
// Sub-commands
// ---------------------------------------------------------------------------

async function cmdNew(positional, flags) {
  const arg = positional[0];
  if (!arg) {
    console.error("Usage: pencilpot new <name|dir> [--design <d>]");
    process.exit(1);
  }

  // If arg contains a separator it's a path; else treat as name in cwd.
  const dir  = path.resolve(arg);
  const name = path.basename(dir);

  fs.mkdirSync(dir, { recursive: true });

  // Import store helpers (dynamic so tests can mock before calling)
  const { initProject, addDesign } = await import("../store/project.mjs");
  const { writeDesign } = await import("../store/store.mjs");
  const { createSession } = await import("../../headless-core/target/headless/penpot.js");

  initProject(dir, name);

  const pencilPath = path.join(dir, `${name}.pencil`);
  console.log(`created ${pencilPath}`);

  // Always scaffold a starter design so the project is immediately openable.
  const designName = flags["design"] || "main";
  const designDir = addDesign(dir, designName);
  // Write a blank starter design using the engine so manifest.edn exists.
  const s = createSession(JSON.stringify({ empty: true }));
  writeDesign(designDir, JSON.parse(s.serializeStore()));
  console.log(`added starter design "${designName}" → ${designDir}`);
}

async function cmdOpen(positional, flags) {
  const arg = positional[0];
  if (!arg) {
    console.error("Usage: pencilpot open <path.pencil|dir> [--no-window] [--port N]");
    process.exit(1);
  }

  const { resolveProject } = await import("../store/project.mjs");

  let proj;
  try {
    proj = resolveProject(path.resolve(arg));
  } catch (e) {
    console.error(`Error resolving project: ${e.message}`);
    process.exit(1);
  }

  // Find the .pencil file for this project
  const pencilPath = path.join(proj.root, `${proj.name}.pencil`);

  const noWindow = flags["no-window"] === true;
  const port = flags["port"] ? Number(flags["port"]) : await findFreePort();

  // Spawn the runtime server
  const child = spawn(
    process.execPath,
    [SERVER_MJS],
    {
      env: {
        ...process.env,
        PENCILPOT_PROJECT: pencilPath,
        PENCILPOT_PORT: String(port),
        ...(flags["design"] ? { PENCILPOT_DESIGN: flags["design"] } : {}),
      },
      stdio: "inherit",
    }
  );

  // Propagate SIGTERM to the child then exit cleanly
  const cleanup = (signal) => {
    try { child.kill(signal || "SIGTERM"); } catch {}
    process.exit(0);
  };
  process.on("SIGTERM", () => cleanup("SIGTERM"));
  process.on("SIGINT",  () => cleanup("SIGINT"));

  child.on("exit", (code) => {
    process.exit(code ?? 0);
  });

  // Wait for server to be ready
  const ready = await waitForHttp(`http://localhost:${port}/`, 10_000);
  if (!ready) {
    console.error(`Runtime did not start within 10 s on port ${port}`);
    cleanup();
    process.exit(1);
  }

  // Build workspace URL (use the design's file id if available)
  const TEAM_ID = "0398e5fc-95c9-80d6-8008-29071f0fdaed";
  let fileId = null;
  if (proj.default) {
    const entry = proj.designs.find((d) => d.name === proj.default);
    if (entry) {
      try {
        const manifest = fs.readFileSync(path.join(entry.dir, "manifest.edn"), "utf8");
        const m = manifest.match(/:id\s+#uuid\s+"([^"]+)"/);
        if (m) fileId = m[1];
      } catch {}
    }
  }

  const wsUrl = fileId
    // Default to the stable SVG renderer. The render-wasm path drives a
    // continuous WebGL2 canvas that glitches badly on pan/zoom in this
    // environment, and it is NOT required for variable fonts: the browser
    // renders font-variation-settings natively on SVG/HTML text (proven with
    // the project's own VF file). VF support is being implemented in the SVG
    // path (variable @font-face + font-variation-settings emission). Append
    // `&wasm=true` manually only if you need to compare against render-wasm.
    ? `http://localhost:${port}/#/workspace?team-id=${TEAM_ID}&file-id=${fileId}`
    : `http://localhost:${port}/`;

  console.log(`pencilpot open → ${wsUrl}`);

  if (!noWindow) {
    // Launch chromeless app window (fire-and-forget)
    spawn(process.execPath, [LAUNCH_MJS, wsUrl], { stdio: "inherit" });
  }

  // In --no-window mode: stay alive so the test can interact.
  // In window mode: also stay alive to keep the server running.
  // Either way we block here; cleanup on SIGTERM/SIGINT above handles exit.
  await new Promise(() => {}); // block forever
}

function cmdInstallDesktop() {
  const HOME = process.env.HOME || os.homedir();
  const binDir        = path.join(HOME, ".local", "bin");
  const mimeDir       = path.join(HOME, ".local", "share", "mime", "packages");
  const appsDir       = path.join(HOME, ".local", "share", "applications");
  const binLink       = path.join(binDir, "pencilpot");
  const mimeTarget    = path.join(mimeDir, "pencilpot.xml");
  const desktopTarget = path.join(appsDir, "pencilpot.desktop");

  // Resolve absolute path to this script
  const thisBin = path.resolve(import.meta.filename);

  // Ensure the bin is executable
  try { fs.chmodSync(thisBin, 0o755); } catch (e) {
    console.warn(`  warning: could not chmod +x ${thisBin}: ${e.message}`);
  }

  // 1. Symlink ~/.local/bin/pencilpot → this script
  fs.mkdirSync(binDir, { recursive: true });
  try { fs.unlinkSync(binLink); } catch {}
  fs.symlinkSync(thisBin, binLink);
  console.log(`  installed symlink: ${binLink} → ${thisBin}`);

  // Check PATH
  const pathDirs = (process.env.PATH || "").split(":");
  if (!pathDirs.includes(binDir)) {
    console.log(`  NOTE: ${binDir} is not on PATH — add it to your shell profile.`);
  }

  // 2. MIME type
  fs.mkdirSync(mimeDir, { recursive: true });
  const mimeXml = path.resolve(import.meta.dirname, "../desktop/pencilpot.xml");
  fs.copyFileSync(mimeXml, mimeTarget);
  console.log(`  installed MIME: ${mimeTarget}`);
  try {
    execFileSync("update-mime-database", [path.join(HOME, ".local", "share", "mime")], { stdio: "inherit" });
  } catch (e) {
    console.warn(`  warning: update-mime-database failed: ${e.message}`);
  }

  // 3. Desktop entry
  fs.mkdirSync(appsDir, { recursive: true });
  const templatePath = path.resolve(import.meta.dirname, "../desktop/pencilpot.desktop");
  const template = fs.readFileSync(templatePath, "utf8");
  const rendered = template.replaceAll("__PENCILPOT_BIN__", binLink);
  fs.writeFileSync(desktopTarget, rendered, { mode: 0o644 });
  console.log(`  installed .desktop: ${desktopTarget}`);
  try {
    execFileSync("update-desktop-database", [appsDir], { stdio: "inherit" });
  } catch (e) {
    console.warn(`  warning: update-desktop-database failed: ${e.message}`);
  }
  try {
    execFileSync("xdg-mime", ["default", "pencilpot.desktop", "application/x-pencil"], { stdio: "inherit" });
  } catch (e) {
    console.warn(`  warning: xdg-mime default failed: ${e.message}`);
  }

  console.log("\nDesktop integration installed:");
  console.log(`  bin       ${binLink}`);
  console.log(`  MIME      ${mimeTarget}`);
  console.log(`  .desktop  ${desktopTarget}`);
}

function cmdUninstallDesktop() {
  const HOME = process.env.HOME || os.homedir();
  const binLink       = path.join(HOME, ".local", "bin", "pencilpot");
  const mimeTarget    = path.join(HOME, ".local", "share", "mime", "packages", "pencilpot.xml");
  const appsDir       = path.join(HOME, ".local", "share", "applications");
  const desktopTarget = path.join(appsDir, "pencilpot.desktop");

  let removed = [];

  // Remove symlink
  try { fs.unlinkSync(binLink); removed.push(binLink); } catch {}

  // Remove MIME and update
  try { fs.unlinkSync(mimeTarget); removed.push(mimeTarget); } catch {}
  try {
    execFileSync("update-mime-database", [path.join(HOME, ".local", "share", "mime")], { stdio: "inherit" });
  } catch (e) {
    console.warn(`  warning: update-mime-database failed: ${e.message}`);
  }

  // Remove .desktop and update
  try { fs.unlinkSync(desktopTarget); removed.push(desktopTarget); } catch {}
  try {
    execFileSync("update-desktop-database", [appsDir], { stdio: "inherit" });
  } catch (e) {
    console.warn(`  warning: update-desktop-database failed: ${e.message}`);
  }

  if (removed.length === 0) {
    console.log("Nothing to remove — desktop integration was not installed.");
  } else {
    console.log("Removed:");
    for (const f of removed) console.log(`  ${f}`);
  }
}

// ---------------------------------------------------------------------------
// retarget-fonts command — consolidate duplicate font-ids per family
// ---------------------------------------------------------------------------
async function cmdRetargetFonts(positional, flags) {
  const arg = positional[0];
  if (!arg) {
    console.error("Usage: pencilpot retarget-fonts <project> [--family \"Name=fontId\" …] [--design <name>]");
    process.exit(1);
  }

  const { resolveProject } = await import("../store/project.mjs");
  const { readDesign, writeDesign } = await import("../store/store.mjs");
  const { createSession } = await import("../../headless-core/target/headless/penpot.js");

  let proj;
  try {
    proj = resolveProject(path.resolve(arg));
  } catch (e) {
    console.error(`Error resolving project: ${e.message}`);
    process.exit(1);
  }

  // Resolve which design to operate on
  const designName = flags["design"] || proj.default;
  if (!designName) {
    console.error("No default design and no --design flag. Use --design <name>.");
    process.exit(1);
  }
  const designEntry = proj.designs.find((d) => d.name === designName);
  if (!designEntry) {
    console.error(`Design "${designName}" not found in project.`);
    process.exit(1);
  }
  const designDir = designEntry.dir;

  // Load design into engine
  const storeParts = readDesign(designDir);
  const session = createSession(JSON.stringify({ fromStore: storeParts }));

  // Build the family → fontId mapping
  let mapping; // { "Family Name": "new-font-id", ... }

  const familyFlags = flags["family"]; // string[] | undefined
  if (familyFlags && familyFlags.length > 0) {
    // Explicit mode: --family "Name=fontId"
    mapping = {};
    for (const entry of familyFlags) {
      const eqIdx = entry.indexOf("=");
      if (eqIdx < 1) {
        console.error(`Invalid --family value "${entry}" — expected "Family Name=font-id"`);
        process.exit(1);
      }
      const name = entry.slice(0, eqIdx).trim();
      const fontId = entry.slice(eqIdx + 1).trim();
      mapping[name] = fontId;
    }
    console.log("Explicit font mapping:");
    for (const [fam, id] of Object.entries(mapping)) {
      console.log(`  "${fam}" → ${id}`);
    }
  } else {
    // Auto-consolidate mode: detect families with >1 font-id in the design EDN
    // Scan the serialised store's page EDN strings for :font-family / :font-id pairs
    const pagesDir = path.join(designDir, "pages");
    const familyToIds = {}; // { "Family Name": Set<string> }

    const pageFiles = fs.existsSync(pagesDir)
      ? fs.readdirSync(pagesDir).filter((f) => f.endsWith(".edn"))
      : [];

    // Also scan manifest (may contain typographies)
    const allEdnFiles = [
      ...pageFiles.map((f) => path.join(pagesDir, f)),
      path.join(designDir, "manifest.edn"),
    ];

    for (const filePath of allEdnFiles) {
      if (!fs.existsSync(filePath)) continue;
      const edn = fs.readFileSync(filePath, "utf8");
      // Find every :font-family occurrence, then look nearby for :font-id
      const famRe = /:font-family\s+"([^"]+)"/g;
      let m;
      while ((m = famRe.exec(edn)) !== null) {
        const fam = m[1];
        if (fam.startsWith('"')) continue; // skip escaped \" artefacts
        const start = Math.max(0, m.index - 300);
        const end   = Math.min(edn.length, m.index + 300);
        const ctx   = edn.slice(start, end);
        const idM   = /:font-id\s+"([^"]+)"/.exec(ctx);
        if (idM) {
          if (!familyToIds[fam]) familyToIds[fam] = new Set();
          familyToIds[fam].add(idM[1]);
        }
      }
    }

    // Auto-consolidation: families with >1 font-id
    mapping = {};
    let hasDupes = false;
    for (const [fam, ids] of Object.entries(familyToIds)) {
      if (ids.size > 1) {
        hasDupes = true;
        const slug = fam.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
        const canonicalId = `custom-${slug}`;
        mapping[fam] = canonicalId;
        console.log(`auto-consolidate: "${fam}" (${ids.size} ids: ${[...ids].join(", ")}) → ${canonicalId}`);
      }
    }

    if (!hasDupes) {
      console.log("No duplicate font-ids found per family — nothing to consolidate.");
      process.exit(0);
    }
  }

  if (Object.keys(mapping).length === 0) {
    console.log("Empty mapping — nothing to do.");
    process.exit(0);
  }

  // Baseline validation (pre-existing issues should not block the retarget)
  const baselineErrs = JSON.parse(session.validate());

  // Apply the retarget in the engine
  session.retargetFonts(JSON.stringify(mapping));

  // Validate post-retarget; warn if there are new errors (not present in baseline)
  const postErrs = JSON.parse(session.validate());
  const newErrs = postErrs.filter((e) => !baselineErrs.includes(e));
  if (newErrs.length > 0) {
    console.error("Validation introduced new errors after retargetFonts:");
    for (const e of newErrs) console.error(" ", e);
    process.exit(1);
  }
  if (baselineErrs.length > 0) {
    console.warn(`  note: ${baselineErrs.length} pre-existing validation issue(s) unchanged (not caused by retarget)`);
  }

  // Persist
  writeDesign(designDir, JSON.parse(session.serializeStore()));

  console.log(`\nretarget-fonts complete — design "${designName}" updated.`);
  console.log("Families rewritten:", Object.keys(mapping).join(", "));
}

// ---------------------------------------------------------------------------
// map-variable command — map families onto a variable font WITH per-family
// axis settings (wdth/opsz/GRAD/ROND/slnt). Realises true variable-font widths
// (e.g. Condensed/Compressed/Wide) that static instances can't express, and
// folds non-Google families (Bebas Neue, Archivo) onto the variable font.
// ---------------------------------------------------------------------------
async function cmdMapVariable(positional, flags) {
  const arg = positional[0];
  if (!arg) {
    console.error('Usage: pencilpot map-variable <project> --font-id <id> [--var-family <name>] --map "Family=wdth:62.5,opsz:120" [--map …] [--design <name>]');
    process.exit(1);
  }

  const fontId = flags["font-id"];
  if (!fontId) {
    console.error("--font-id <variable-font-id> is required (e.g. custom-google-sans-flex).");
    process.exit(1);
  }
  const varFamily = flags["var-family"] || "Google Sans Flex";
  const mapFlags = flags["map"]; // string[] | undefined
  if (!mapFlags || mapFlags.length === 0) {
    console.error('At least one --map "Family=tag:value,…" is required.');
    process.exit(1);
  }

  // Build mapping: { "Source Family": { fontId, family, axes: {tag: number} } }
  const mapping = {};
  for (const entry of mapFlags) {
    const eqIdx = entry.indexOf("=");
    if (eqIdx < 1) {
      console.error(`Invalid --map value "${entry}" — expected "Family Name=tag:value,…"`);
      process.exit(1);
    }
    const srcFamily = entry.slice(0, eqIdx).trim();
    const axisSpec = entry.slice(eqIdx + 1).trim();
    const axes = {};
    if (axisSpec) {
      for (const pair of axisSpec.split(",")) {
        const m = /^\s*([A-Za-z]{1,4})\s*[:=]\s*(-?\d+(?:\.\d+)?)\s*$/.exec(pair);
        if (!m) {
          console.error(`Invalid axis spec "${pair}" in --map "${entry}" — expected tag:value (e.g. wdth:62.5)`);
          process.exit(1);
        }
        axes[m[1]] = Number(m[2]);
      }
    }
    mapping[srcFamily] = { fontId, family: varFamily, axes };
  }

  const { resolveProject } = await import("../store/project.mjs");
  const { readDesign, writeDesign } = await import("../store/store.mjs");
  const { createSession } = await import("../../headless-core/target/headless/penpot.js");

  let proj;
  try {
    proj = resolveProject(path.resolve(arg));
  } catch (e) {
    console.error(`Error resolving project: ${e.message}`);
    process.exit(1);
  }
  const designName = flags["design"] || proj.default;
  if (!designName) {
    console.error("No default design and no --design flag. Use --design <name>.");
    process.exit(1);
  }
  const designEntry = proj.designs.find((d) => d.name === designName);
  if (!designEntry) {
    console.error(`Design "${designName}" not found in project.`);
    process.exit(1);
  }
  const designDir = designEntry.dir;

  console.log(`Variable font: ${fontId}  (family "${varFamily}")`);
  console.log("Family → axes:");
  for (const [fam, spec] of Object.entries(mapping)) {
    const a = Object.entries(spec.axes).map(([t, v]) => `${t}=${v}`).join(", ") || "(defaults)";
    console.log(`  "${fam}" → ${a}`);
  }

  const storeParts = readDesign(designDir);
  const session = createSession(JSON.stringify({ fromStore: storeParts }));

  const baselineErrs = JSON.parse(session.validate());
  session.mapFontsToVariable(JSON.stringify(mapping));
  const postErrs = JSON.parse(session.validate());
  const newErrs = postErrs.filter((e) => !baselineErrs.includes(e));
  if (newErrs.length > 0) {
    console.error("Validation introduced new errors after mapFontsToVariable:");
    for (const e of newErrs) console.error(" ", e);
    process.exit(1);
  }
  if (baselineErrs.length > 0) {
    console.warn(`  note: ${baselineErrs.length} pre-existing validation issue(s) unchanged (not caused by this command)`);
  }

  writeDesign(designDir, JSON.parse(session.serializeStore()));
  console.log(`\nmap-variable complete — design "${designName}" updated.`);
  console.log("Families mapped to variable font:", Object.keys(mapping).join(", "));
}

function printHelp() {
  console.log(`
pencilpot <command> [args] [--flags]

Commands:
  new <name|dir> [--design <d>]          Scaffold a new .pencil project (starter design included)
  open <path.pencil|dir> [--no-window]   Start the runtime and open the editor
       [--port N] [--design <name>]      Open a specific design by name
  import <file.penpot> [targetDir]       Import a .penpot file as a design (native, no backend)
         [--project <dir>]               Project directory (default: cwd; bootstrapped if absent)
         [--name <design>]               Design name (default: file basename)
  designs <path.pencil|dir>              List designs in the project (marks the default)
  set-default <path.pencil|dir> <name>   Set the default design
  add-font <fontfile> [--project <dir>]  Add a custom font file to the project
           [--family <name>] [--weight 400] [--style normal] [--id <fontId>]
  add-variable-font <fontfile>           Add a variable font; discovers axes +
           [--project <dir>] [--family <name>] [--id <fontId>]   named instances from fvar
  add-google <Family> [--project <dir>]  Fetch + register a Google font
           [--variable] [--weights 100..900] [--axes wght,wdth]
  fonts <path.pencil|dir>               List added fonts + report missing families
  retarget-fonts <project> [--family "Name=fontId" …]
                                         Rewrite every font-id ref in the design to a
                                         canonical id per family (consolidates duplicates)
  map-variable <project> --font-id <id>  Map families onto a VARIABLE font with per-family
       [--var-family <name>]             axis settings (realises true Condensed/Compressed/
       --map "Family=wdth:62.5,opsz:120"  Wide widths; folds Bebas Neue/Archivo onto it).
       [--map …] [--design <name>]       Repeat --map per source family.
  install-desktop                         Install as a desktop app
  uninstall-desktop                       Remove the desktop app entry
  --help, -h                              Show this help

Examples:
  pencilpot new my-design
  pencilpot open my-design/my-design.pencil
  pencilpot open my-design/ --port 8080 --no-window
  pencilpot open my-design/ --design wireframes --no-window
  pencilpot import Wireframes.penpot --project my-design/ --name wireframes
  pencilpot import Wireframes.penpot /tmp/new-project
  pencilpot designs my-design/
  pencilpot set-default my-design/ wireframes
  pencilpot add-font MyFont.ttf --project my-design/ --family "My Font" --weight 400
  pencilpot add-variable-font GoogleSansFlex.ttf --project my-design/
  pencilpot add-google Roboto --project my-design/ --weights 400,700
  pencilpot add-google "Roboto Flex" --project my-design/ --variable --axes wght,wdth
  pencilpot fonts my-design/
`.trim());
}

// ---------------------------------------------------------------------------
// import command (native — no external backend)
// ---------------------------------------------------------------------------
async function cmdImport(positional, flags) {
  const filePath = positional[0];
  if (!filePath) {
    console.error("Usage: pencilpot import <file.penpot> [targetDir] [--project <dir>] [--name <design>]");
    process.exit(1);
  }

  const absFile = path.resolve(filePath);
  if (!fs.existsSync(absFile)) {
    console.error(`File not found: ${absFile}`);
    process.exit(1);
  }

  const { initProject, resolveProject, addDesign, setDefault } = await import("../store/project.mjs");
  const { writeDesign } = await import("../store/store.mjs");
  const { createSession } = await import("../../headless-core/target/headless/penpot.js");

  // Resolve project dir:
  //   --project <dir>   explicit: add to an existing project at <dir>
  //   positional[1]     explicit: use/create that dir as the project root
  //   default (none)    create a NEW project in a subdir named after the file slug
  //                     under cwd — do NOT walk up to reuse any ancestor project.

  // Derive slug for new-project naming (same logic used for designName)
  const baseName = path.basename(absFile, ".penpot");
  const fileSlug = baseName.toLowerCase().replace(/[^a-z0-9-_]/g, "-");

  let projectArg;
  /** Whether to resolve an existing project (walk-up allowed) vs always bootstrap fresh. */
  let allowAncestorReuse = false;

  if (flags["project"]) {
    projectArg = path.resolve(flags["project"]);
    allowAncestorReuse = true; // --project explicitly targets an existing project dir
  } else if (positional[1]) {
    projectArg = path.resolve(positional[1]);
    allowAncestorReuse = false; // positional dir: always bootstrap at that exact location
  } else {
    // Default: create a clearly-named new subdir under cwd — never reuse an ancestor.
    projectArg = path.resolve(process.cwd(), fileSlug);
    allowAncestorReuse = false;
  }

  // Try to resolve an existing project; if none exists (or we must not reuse one), bootstrap.
  let proj;
  let bootstrapped = false;
  try {
    if (!allowAncestorReuse) throw new Error("skip walk-up");
    proj = resolveProject(projectArg);
  } catch {
    // No project found (or walk-up disabled) — bootstrap one at projectArg.
    const projDir = projectArg;
    fs.mkdirSync(projDir, { recursive: true });
    const projName = path.basename(projDir);
    initProject(projDir, projName);
    proj = resolveProject(projDir);
    bootstrapped = true;
    console.log(`bootstrapped project "${projName}" at ${projDir}`);
  }

  // Derive design name from flag or filename (fileSlug already computed above)
  const designName = flags["name"] || fileSlug;

  console.log(`importing ${absFile} → designs/${designName} (native, no backend)…`);

  // Native conversion: unzip → engine decode/assemble → serialize to EDN store
  const { importPenpot } = await import("../runtime/import-binfile.mjs");
  const { parts, mediaFiles, cleanup } = await importPenpot(absFile);

  try {
    // Register + write design to project
    const designDir = addDesign(proj.root, designName);
    writeDesign(designDir, parts);

    // Copy media binary files into designDir/media/ (srcPath is in a stable temp dir)
    if (mediaFiles.length > 0) {
      const mediaDir = path.join(designDir, "media");
      fs.mkdirSync(mediaDir, { recursive: true });
      for (const mf of mediaFiles) {
        const { id, srcPath, ext, width, height, mtype, name, thumbnailSrcPath, thumbnailExt } = mf;
        const dest = path.join(mediaDir, `${id}.${ext}`);
        try {
          fs.copyFileSync(srcPath, dest);
          // Sidecar metadata used by the runtime media route + media-object responses.
          fs.writeFileSync(
            path.join(mediaDir, `${id}.json`),
            JSON.stringify({ width: width ?? null, height: height ?? null, mtype: mtype ?? null, name: name ?? null }),
          );
          // Optional thumbnail binary, keyed by the same file-media-id.
          if (thumbnailSrcPath) {
            fs.copyFileSync(thumbnailSrcPath, path.join(mediaDir, `${id}.thumbnail.${thumbnailExt}`));
          }
        } catch (e) {
          console.warn(`  warning: could not copy media ${id}.${ext}: ${e.message}`);
        }
      }
      console.log(`  copied ${mediaFiles.length} media file(s) → ${mediaDir}`);
    }
  } finally {
    // Clean up the stable temp dir used for media staging
    if (cleanup) cleanup();
  }

  // Set the imported design as the project's default (makes it visible on open)
  setDefault(proj.root, designName);

  // Summary
  const pageCount = Object.keys(parts.pages || {}).length;
  const compCount = Object.keys(parts.components || {}).length;
  const pencilPath = path.join(proj.root, `${proj.name}.pencil`);
  console.log(`imported ${path.basename(absFile)} → designs/${designName}`);
  console.log(`  pages: ${pageCount}  components: ${compCount}  media: ${mediaFiles.length}`);
  console.log(`  default design → ${designName}`);
  console.log(`  project: ${pencilPath}`);
  console.log(`  run: pencilpot open ${pencilPath}`);
}

// ---------------------------------------------------------------------------
// designs command — list a project's designs (mark the default)
// ---------------------------------------------------------------------------
async function cmdDesigns(positional, flags) {
  const arg = positional[0];
  if (!arg) {
    console.error("Usage: pencilpot designs <path.pencil|dir>");
    process.exit(1);
  }
  const { resolveProject } = await import("../store/project.mjs");
  let proj;
  try {
    proj = resolveProject(path.resolve(arg));
  } catch (e) {
    console.error(`Error resolving project: ${e.message}`);
    process.exit(1);
  }
  console.log(`Project: ${proj.name}  (${proj.root})`);
  if (proj.designs.length === 0) {
    console.log("  (no designs)");
  } else {
    for (const d of proj.designs) {
      const marker = d.name === proj.default ? " (default)" : "";
      console.log(`  ${d.name}${marker}`);
    }
  }
}

// ---------------------------------------------------------------------------
// set-default command — change the default design
// ---------------------------------------------------------------------------
async function cmdSetDefault(positional, flags) {
  const arg = positional[0];
  const designName = positional[1];
  if (!arg || !designName) {
    console.error("Usage: pencilpot set-default <path.pencil|dir> <design>");
    process.exit(1);
  }
  const { resolveProject, setDefault } = await import("../store/project.mjs");
  let proj;
  try {
    proj = resolveProject(path.resolve(arg));
  } catch (e) {
    console.error(`Error resolving project: ${e.message}`);
    process.exit(1);
  }
  try {
    setDefault(proj.root, designName);
  } catch (e) {
    console.error(`Error: ${e.message}`);
    process.exit(1);
  }
  console.log(`default design → ${designName}`);
}

// ---------------------------------------------------------------------------
// add-font command — add a custom font file to a project
// ---------------------------------------------------------------------------
async function cmdAddFont(positional, flags) {
  const fontFile = positional[0];
  if (!fontFile) {
    console.error("Usage: pencilpot add-font <fontfile> [--project <dir>] [--family <name>] [--weight 400] [--style normal] [--id <fontId>]");
    process.exit(1);
  }

  const absFontFile = path.resolve(fontFile);
  if (!fs.existsSync(absFontFile)) {
    console.error(`Font file not found: ${absFontFile}`);
    process.exit(1);
  }

  const { resolveProject } = await import("../store/project.mjs");
  const { addFont } = await import("../store/fonts.mjs");

  // Resolve project: --project flag or walk up from cwd
  let proj;
  const projectArg = flags["project"] ? path.resolve(flags["project"]) : process.cwd();
  try {
    proj = resolveProject(projectArg);
  } catch (e) {
    console.error(`Error: no project found at ${projectArg}. Run 'pencilpot new' first or pass --project <dir>.`);
    process.exit(1);
  }

  const family  = flags["family"]  ?? undefined;  // let addFont derive from filename if omitted
  const weight  = flags["weight"]  ? Number(flags["weight"])  : 400;
  const style   = flags["style"]   ?? "normal";
  const fontId  = flags["id"]      ?? undefined;

  if (!family) {
    // Require --family explicitly (prevents silent mis-derivation)
    const derived = path.basename(absFontFile, path.extname(absFontFile)).replace(/[-_]+/g, " ");
    console.log(`  note: --family not set, deriving from filename: "${derived}"`);
  }

  const variant = addFont(proj.root, { file: absFontFile, family, weight, style, fontId });

  console.log(`added font:`);
  console.log(`  family:  ${variant.family}`);
  console.log(`  weight:  ${variant.weight}`);
  console.log(`  style:   ${variant.style}`);
  console.log(`  format:  ${variant.format}`);
  console.log(`  id:      ${variant.id}`);
  console.log(`  file:    fonts/${variant.file}`);
}

// ---------------------------------------------------------------------------
// add-variable-font command — register a variable font + its axis metadata
// ---------------------------------------------------------------------------
async function cmdAddVariableFont(positional, flags) {
  const fontFile = positional[0];
  if (!fontFile) {
    console.error("Usage: pencilpot add-variable-font <fontfile> [--project <dir>] [--family <name>] [--id <fontId>]");
    process.exit(1);
  }

  const absFontFile = path.resolve(fontFile);
  if (!fs.existsSync(absFontFile)) {
    console.error(`Font file not found: ${absFontFile}`);
    process.exit(1);
  }

  const { resolveProject } = await import("../store/project.mjs");
  const { addVariableFont } = await import("../store/fonts.mjs");
  const { readFvar, readFontFamilyName } = await import("../store/fvar.mjs");

  // Resolve project: --project flag or walk up from cwd
  const projectArg = flags["project"] ? path.resolve(flags["project"]) : process.cwd();
  let proj;
  try {
    proj = resolveProject(projectArg);
  } catch (e) {
    console.error(`Error: no project found at ${projectArg}. Run 'pencilpot new' first or pass --project <dir>.`);
    process.exit(1);
  }

  // Parse the variable-font axes + instances out of the file.
  let fvar;
  const buffer = fs.readFileSync(absFontFile);
  try {
    fvar = readFvar(buffer);
  } catch (e) {
    console.error(`error: ${e.message}`);
    process.exit(1);
  }

  // Family precedence: --family (first value if array) → name table → filename.
  let family = flags["family"];
  if (Array.isArray(family)) family = family[0];
  if (!family) {
    family = readFontFamilyName(buffer) ?? undefined;
  }
  if (!family) {
    family = path.basename(absFontFile, path.extname(absFontFile)).replace(/[-_]+/g, " ");
  }

  const fontId = flags["id"] ?? undefined;

  const variant = addVariableFont(proj.root, {
    file: absFontFile,
    family,
    fontId,
    axes: fvar.axes,
    instances: fvar.instances,
  });

  console.log(`added variable font:`);
  console.log(`  family:  ${variant.family}`);
  console.log(`  font-id: ${variant.fontId}`);
  console.log(`  format:  ${variant.format}`);
  console.log(`  file:    fonts/${variant.file}`);
  console.log(`  weights: ${variant.variants.map((v) => v.weight).join(", ")} (${variant.variants.length} variants share one VF file)`);
  console.log(`  axes (${fvar.axes.length}):`);
  for (const a of fvar.axes) {
    console.log(`    ${a.tag.padEnd(4)}  ${a.min} .. ${a.default} .. ${a.max}   ${a.name}`);
  }
  if (fvar.instances.length > 0) {
    console.log(`  named instances (${fvar.instances.length}):`);
    for (const inst of fvar.instances) {
      const coords = Object.entries(inst.coords).map(([t, v]) => `${t}=${v}`).join(" ");
      console.log(`    ${inst.name}  [${coords}]`);
    }
  } else {
    console.log(`  named instances: (none)`);
  }
}

// ---------------------------------------------------------------------------
// add-google command — fetch + register a Google font (static or variable)
// ---------------------------------------------------------------------------
async function cmdAddGoogle(positional, flags) {
  const family = positional[0];
  if (!family) {
    console.error("Usage: pencilpot add-google <Family> [--project <dir>] [--variable] [--weights 100..900] [--axes wght,wdth]");
    process.exit(1);
  }

  const { resolveProject } = await import("../store/project.mjs");
  const { addFont, addVariableFont } = await import("../store/fonts.mjs");
  const { buildCSS2URL } = await import("../runtime/gfonts.mjs");
  const { readFvar } = await import("../store/fvar.mjs");

  const projectArg = flags["project"] ? path.resolve(flags["project"]) : process.cwd();
  let proj;
  try {
    proj = resolveProject(projectArg);
  } catch (e) {
    console.error(`error: no project found at ${projectArg}. Run 'pencilpot new' first or pass --project <dir>.`);
    process.exit(1);
  }

  const variable = flags["variable"] === true;
  const weights = flags["weights"];           // e.g. "100..900" | "400,700"
  const axesFlag = flags["axes"];             // e.g. "wght,wdth"

  const css2Url = buildCSS2URL(family, { variable, weights, axes: axesFlag });

  const DESKTOP_UA =
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

  /** Fetch with a desktop UA + timeout; throws on non-2xx or network failure. */
  async function fetchWithTimeout(url, asBuffer = false, timeoutMs = 15000) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: ctrl.signal, headers: { "User-Agent": DESKTOP_UA } });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return asBuffer ? Buffer.from(await res.arrayBuffer()) : await res.text();
    } finally {
      clearTimeout(timer);
    }
  }

  console.log(`fetching ${css2Url}`);

  let css;
  try {
    css = await fetchWithTimeout(css2Url);
  } catch (e) {
    console.error(`error: could not fetch Google Fonts CSS (${e.message})`);
    process.exit(1);
  }

  // Parse the CSS per @font-face block so we can associate each src url with its
  // font-weight. Google emits one block per (weight × unicode-subset); the font
  // file is identical across subsets, so we dedup by font-weight and keep the
  // first url for each.  All `src: url(...)` entries are also collected raw for
  // the variable path (which expects a single VF file).
  const urls = [];                        // all gstatic urls (in document order)
  const byWeight = new Map();             // weight(number) → first url
  for (const block of css.split("@font-face")) {
    const um = block.match(/url\((https:\/\/fonts\.gstatic\.com\/[^)'"]+)\)/);
    if (!um) continue;
    const url = um[1];
    urls.push(url);
    const wm = block.match(/font-weight:\s*([^;]+);/);
    // font-weight may be a single value ("400") or a range ("100 900") for VF.
    const w = wm ? Number(String(wm[1]).trim().split(/\s+/)[0]) : 400;
    if (!byWeight.has(w)) byWeight.set(w, url);
  }
  if (urls.length === 0) {
    console.error("error: no font src URLs found in Google Fonts CSS response");
    process.exit(1);
  }

  // Temp dir for downloaded font files.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pp-gfont-"));

  try {
    if (variable) {
      // Variable: a single VF file is expected. Use the first src URL.
      const url = urls[0];
      const ext = (url.match(/\.(woff2|woff|ttf|otf)(\?|$)/i) || [, "woff2"])[1].toLowerCase();
      let buf;
      try {
        buf = await fetchWithTimeout(url, true);
      } catch (e) {
        console.error(`error: could not download variable font (${e.message})`);
        process.exit(1);
      }
      const tmpFile = path.join(tmpDir, `${family.replace(/\s+/g, "")}.${ext}`);
      fs.writeFileSync(tmpFile, buf);

      // Axis discovery: parse fvar from ttf/otf; for woff2 we cannot parse the
      // compressed table without a decompressor, so fall back to the requested
      // --axes (documented limitation).
      let axes = [];
      let instances = [];
      if (ext === "ttf" || ext === "otf") {
        try {
          const fvar = readFvar(buf);
          axes = fvar.axes;
          instances = fvar.instances;
        } catch (e) {
          console.warn(`  note: could not parse fvar from ${ext} (${e.message}); using requested axes`);
        }
      } else {
        console.warn(`  note: ${ext} is compressed — fvar not parsed; deriving axes from --axes/CSS request`);
      }

      if (axes.length === 0) {
        // Build minimal axes from the requested --axes tags (range unknown → wide).
        const tags = axesFlag
          ? String(axesFlag).split(",").map((s) => s.trim()).filter(Boolean)
          : ["wght"];
        axes = tags.map((tag) => ({
          tag,
          min: tag === "wght" ? 100 : 0,
          default: tag === "wght" ? 400 : 0,
          max: tag === "wght" ? 900 : 1,
          name: tag,
        }));
      }

      const variant = addVariableFont(proj.root, {
        file: tmpFile, family, axes, instances,
      });
      console.log(`added variable font "${variant.family}" (id=${variant.id}, ${variant.format})`);
      console.log(`  axes: ${axes.map((a) => a.tag).join(", ")}`);
      if (instances.length > 0) console.log(`  named instances: ${instances.length}`);
    } else {
      // Static: one variant per distinct font-weight in the CSS (the unicode
      // subsets share one file, deduped above into byWeight).
      let added = 0;
      for (const [weight, url] of [...byWeight.entries()].sort((a, b) => a[0] - b[0])) {
        const ext = (url.match(/\.(woff2|woff|ttf|otf)(\?|$)/i) || [, "woff2"])[1].toLowerCase();
        let buf;
        try {
          buf = await fetchWithTimeout(url, true);
        } catch (e) {
          console.error(`error: could not download font (${e.message})`);
          process.exit(1);
        }
        const tmpFile = path.join(tmpDir, `${family.replace(/\s+/g, "")}-${weight}.${ext}`);
        fs.writeFileSync(tmpFile, buf);
        const variant = addFont(proj.root, { file: tmpFile, family, weight, style: "normal" });
        console.log(`  added ${variant.family} ${variant.weight} ${variant.style} [${variant.format}] id=${variant.id}`);
        added++;
      }
      console.log(`added ${added} static variant(s) for "${family}"`);
    }
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

// ---------------------------------------------------------------------------
// fonts command — list added fonts and missing fonts in designs
// ---------------------------------------------------------------------------
async function cmdFonts(positional, flags) {
  const arg = positional[0];
  if (!arg) {
    console.error("Usage: pencilpot fonts <path.pencil|dir>");
    process.exit(1);
  }

  const { resolveProject } = await import("../store/project.mjs");
  const { readFonts } = await import("../store/fonts.mjs");

  let proj;
  try {
    proj = resolveProject(path.resolve(arg));
  } catch (e) {
    console.error(`Error resolving project: ${e.message}`);
    process.exit(1);
  }

  const variants = readFonts(proj.root);

  console.log(`Project: ${proj.name}  (${proj.root})`);

  if (variants.length === 0) {
    console.log("  (no custom fonts added — use 'pencilpot add-font <file>' to add one)");
  } else {
    console.log("Custom fonts:");
    for (const v of variants) {
      console.log(`  ${v.family} ${v.weight} ${v.style}  [${v.format}]  id=${v.id}`);
    }
  }

  // Scan design EDN files for font-family references and report missing ones.
  // Only heuristic scan — we look for :font-family "<name>" in the EDN text.
  const usedFamilies = new Set();
  for (const design of proj.designs) {
    const pagesDir = path.join(design.dir, "pages");
    if (!fs.existsSync(pagesDir)) continue;
    for (const f of fs.readdirSync(pagesDir)) {
      if (!f.endsWith(".edn")) continue;
      const edn = fs.readFileSync(path.join(pagesDir, f), "utf8");
      // Extract :font-family "..." values
      const re = /:font-family\s+"([^"]+)"/g;
      let m;
      while ((m = re.exec(edn)) !== null) usedFamilies.add(m[1]);
    }
  }

  const addedFamilies = new Set(variants.map((v) => v.family));
  // Built-in font families (bundled with Penpot) — not "missing"
  const builtins = new Set(["Source Sans Pro", "sourcesanspro"]);

  const missing = [...usedFamilies].filter((f) => !addedFamilies.has(f) && !builtins.has(f));
  if (missing.length > 0) {
    console.log("Missing fonts (referenced in designs but not yet added):");
    for (const f of missing) console.log(`  missing: ${f}`);
    console.log("  → use 'pencilpot add-font <file> --family \"<name>\"' to add them");
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const { cmd, flags, positional } = parseArgs(process.argv);

if (!cmd || cmd === "--help" || flags["help"]) {
  printHelp();
  process.exit(0);
}

switch (cmd) {
  case "new":
    await cmdNew(positional, flags);
    break;
  case "open":
    await cmdOpen(positional, flags);
    break;
  case "import":
    await cmdImport(positional, flags);
    break;
  case "designs":
    await cmdDesigns(positional, flags);
    break;
  case "set-default":
    await cmdSetDefault(positional, flags);
    break;
  case "add-font":
    await cmdAddFont(positional, flags);
    break;
  case "add-variable-font":
    await cmdAddVariableFont(positional, flags);
    break;
  case "add-google":
    await cmdAddGoogle(positional, flags);
    break;
  case "retarget-fonts":
    await cmdRetargetFonts(positional, flags);
    break;
  case "map-variable":
    await cmdMapVariable(positional, flags);
    break;
  case "fonts":
    await cmdFonts(positional, flags);
    break;
  case "install-desktop":
    cmdInstallDesktop();
    break;
  case "uninstall-desktop":
    cmdUninstallDesktop();
    break;
  default:
    console.error(`Unknown command: ${cmd}`);
    printHelp();
    process.exit(1);
}
