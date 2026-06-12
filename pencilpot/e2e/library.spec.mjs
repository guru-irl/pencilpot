/**
 * E2E: cross-file shared-library resolution
 *
 * Achievement level: (a) a design that links a shared library loads and renders
 * in the workspace without fatal errors, and (b) the get-file-libraries RPC was
 * served by pencilpot (x-pencilpot-source: disk) and returned the linked
 * library's metadata.  Full cross-file instance rendering is deferred: the
 * canvas renders the design file shapes; the linked library's components are
 * available to the SPA via the get-file chain but are not used in an instance
 * here (that requires a deeper SPA bootstrap step handled by Phase 3).
 */
import { test, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createSession } from "../../headless-core/target/headless/penpot.js";
import { writeDesign } from "../store/store.mjs";
import { initProject } from "../store/project.mjs";
import { expectCanvasLoaded, trackErrors } from "./helpers.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_SCRIPT = path.join(__dirname, "../runtime/server.mjs");

// Use a port distinct from the default 7777 so this spec can run alongside boot/edit.
const PORT = 7779;

let serverProcess = null;
let projectRoot = null;
let designId = null;

// Build a temp project with a shared library and seed the design dir.
function seedProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pp-e2e-lib-"));
  initProject(root);

  // Shared library: a Button component.
  const lib = createSession(JSON.stringify({ empty: true }));
  const lb = lib.addBoard(
    JSON.stringify({ x: 0, y: 0, width: 80, height: 40, name: "Button" })
  );
  lib.addRect(
    JSON.stringify({ x: 5, y: 5, width: 70, height: 30, parentId: lb })
  );
  lib.closeBoard();
  lib.createComponent(lb, JSON.stringify({ name: "Button" }));
  const libParts = JSON.parse(lib.serializeStore());
  const libId = JSON.parse(lib.getFileResponse()).meta.id;
  writeDesign(path.join(root, "shared", "brand.penpot"), libParts);

  // Design file that links the library.
  const design = createSession(JSON.stringify({ empty: true }));
  const bd = design.addBoard(
    JSON.stringify({ x: 0, y: 0, width: 400, height: 300, name: "Home" })
  );
  design.addRect(
    JSON.stringify({ x: 10, y: 10, width: 100, height: 60, parentId: bd })
  );
  design.closeBoard();
  const dParts = JSON.parse(design.serializeStore());
  dParts.manifest = dParts.manifest.replace(
    /:libraries\s+\[\]/,
    `:libraries [{:id #uuid "${libId}" :path "shared/brand.penpot"}]`
  );
  const did = JSON.parse(design.getFileResponse()).meta.id;
  writeDesign(path.join(root, "home.penpot"), dParts);
  return { root, designId: did };
}

// Spawn the pencilpot runtime server; resolve when it is ready.
function startServer(designDir) {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      process.execPath,
      [SERVER_SCRIPT],
      {
        env: {
          ...process.env,
          PENCILPOT_PORT: String(PORT),
          PENCILPOT_DESIGN: designDir,
        },
        stdio: ["ignore", "pipe", "pipe"],
      }
    );
    proc.stdout.on("data", (d) => {
      const line = d.toString();
      if (line.includes("pencilpot runtime on")) resolve(proc);
    });
    proc.stderr.on("data", (d) => process.stderr.write(d));
    proc.on("error", reject);
    proc.on("exit", (code) => {
      if (code !== 0 && code !== null) reject(new Error(`server exited with code ${code}`));
    });
    // Fallback: resolve after 3 s in case stdout line is missed.
    setTimeout(() => resolve(proc), 3000);
  });
}

test.beforeAll(async () => {
  const seeded = seedProject();
  projectRoot = seeded.root;
  designId = seeded.designId;
  const designDir = path.join(projectRoot, "home.penpot");
  serverProcess = await startServer(designDir);
});

test.afterAll(async () => {
  if (serverProcess) {
    serverProcess.kill("SIGTERM");
    serverProcess = null;
  }
  // Leave temp project on disk for post-mortem if needed.
});

test("library: canvas loads and get-file-libraries is served from disk", async ({ page }) => {
  // Hard-code stub UUIDs so the SPA workspace route is valid.
  // The team-id / file-id in the URL just need to be UUIDs; our runtime
  // serves the design regardless.  We use the actual design id for file-id
  // so the SPA's get-file?id= request matches our handler.
  const WS = `#/workspace?team-id=0398e5fc-95c9-80d6-8008-29071f0fdaed&file-id=${designId}`;

  const errors = trackErrors(page);

  // Wait for the disk-served get-file-libraries response.
  const libsResponse = page.waitForResponse(
    (r) =>
      r.url().includes("get-file-libraries") &&
      r.headers()["x-pencilpot-source"] === "disk",
    { timeout: 30_000 }
  );

  await page.goto(`http://localhost:${PORT}/${WS}`);

  // The workspace canvas must load without being bounced to login.
  await expectCanvasLoaded(page, expect);

  // Await and inspect the get-file-libraries response.
  const resp = await libsResponse;
  expect(resp.status()).toBe(200);
  const body = await resp.text();
  // The linked library should appear in the response (non-empty array).
  expect(body).not.toBe("[]");

  // No fatal JS errors.
  const fatal = errors.filter((e) =>
    /Cannot read|undefined is not|TypeError|failed to fetch/i.test(e)
  );
  expect(fatal, `fatal errors:\n${fatal.join("\n")}`).toHaveLength(0);
});
