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
        flags[key] = next;
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

function printHelp() {
  console.log(`
pencilpot <command> [args] [--flags]

Commands:
  new <name|dir> [--design <d>]          Scaffold a new .pencil project (starter design included)
  open <path.pencil|dir> [--no-window]   Start the runtime and open the editor
                          [--port N]
  import <file.penpot>                   Import a .penpot file as a design in a project
         [--project <dir>]               Project directory (default: cwd)
         [--name <design>]               Design name (default: file basename)
         [--instance <url>]              penpot-hl instance (default: http://localhost:9101)
         [--token <tok>]                 Auth token (default: from infra/penpot-hl/test-env.json)
  install-desktop                         Install as a desktop app (Task D3)
  uninstall-desktop                       Remove the desktop app entry (Task D3)
  --help, -h                              Show this help

Examples:
  pencilpot new my-design
  pencilpot open my-design/my-design.pencil
  pencilpot open my-design/ --port 8080 --no-window
  pencilpot import Wireframes.penpot --project my-design/ --name wireframes
`.trim());
}

// ---------------------------------------------------------------------------
// import command
// ---------------------------------------------------------------------------
async function cmdImport(positional, flags) {
  const filePath = positional[0];
  if (!filePath) {
    console.error("Usage: pencilpot import <file.penpot> [--project <dir>] [--name <design>] [--instance <url>] [--token <tok>]");
    process.exit(1);
  }

  const absFile = path.resolve(filePath);
  if (!fs.existsSync(absFile)) {
    console.error(`File not found: ${absFile}`);
    process.exit(1);
  }

  // Resolve project dir
  const projectArg = flags["project"] ? path.resolve(flags["project"]) : process.cwd();
  const { resolveProject, addDesign } = await import("../store/project.mjs");
  const { writeDesign } = await import("../store/store.mjs");

  let proj;
  try {
    proj = resolveProject(projectArg);
  } catch (e) {
    console.error(`Error resolving project: ${e.message}`);
    process.exit(1);
  }

  // Derive design name from flag or filename
  const baseName = path.basename(absFile, ".penpot");
  const designName = flags["name"] || baseName.toLowerCase().replace(/[^a-z0-9-_]/g, "-");

  // penpot-hl connection params
  const ENV_FILE = path.resolve(import.meta.dirname, "../../infra/penpot-hl/test-env.json");
  let envCfg = {};
  try { envCfg = JSON.parse(fs.readFileSync(ENV_FILE, "utf8")); } catch {}
  const instance = flags["instance"] || process.env.PENPOT_HL_BASE || "http://localhost:9101";
  const token    = flags["token"]    || envCfg.token || "";
  const projectId = envCfg.projectId || "";

  if (!token)     { console.error("No auth token — pass --token or ensure infra/penpot-hl/test-env.json exists"); process.exit(1); }
  if (!projectId) { console.error("No projectId — ensure infra/penpot-hl/test-env.json exists"); process.exit(1); }

  console.log(`importing ${absFile} → designs/${designName} (via ${instance})…`);

  // Step 1: POST to import-binfile, get new file-id
  const { importBinfile } = await import("../runtime/import-binfile.mjs");
  const newFileId = await importBinfile(absFile, { instance, token, projectId, name: designName });
  console.log(`  imported → file-id: ${newFileId}`);

  // Step 2: fetch the file from penpot-hl
  const { getFile } = await import("../../headless-core/sdk/rpc.mjs");
  const { dataTransit, raw } = await getFile(newFileId, token);

  // Step 3: hydrate + serialize via engine
  const { createSession } = await import("../../headless-core/target/headless/penpot.js");
  const s = createSession(JSON.stringify({ fromTransit: dataTransit, meta: raw }));
  const parts = JSON.parse(s.serializeStore());

  // Step 4: register + write to project
  const designDir = addDesign(proj.root, designName);
  writeDesign(designDir, parts);

  console.log(`imported ${path.basename(absFile)} → designs/${designName}`);
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
