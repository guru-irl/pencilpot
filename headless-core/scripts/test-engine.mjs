// Run Penpot's own common geometry + changes suite headlessly as a parity gate.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const common = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../common");

const run = (cmd, args) => execFileSync(cmd, args, { cwd: common, stdio: "inherit" });

// Namespaces verified against common/test/common_tests/runner.cljc test-namespaces vector.
// All names match exactly — no corrections needed.
const NS = [
  "common-tests.geom-rect-test",
  "common-tests.geom-point-test",
  "common-tests.geom-shapes-test",
  "common-tests.geom-shapes-constraints-test",
  "common-tests.geom-shapes-corners-test",
  "common-tests.geom-shapes-intersect-test",
  "common-tests.geom-modifiers-test",
  "common-tests.files-changes-test",
  "common-tests.files.validate-test",
  "common-tests.types.shape-decode-encode-test",
  "common-tests.types.shape-layout-test",
];

run("corepack", ["pnpm", "install"]);           // ensure date-fns etc.
run("corepack", ["pnpm", "run", "build:test"]); // -> target/tests/test.js

for (const ns of NS) {
  console.log(`\n=== ${ns} ===`);
  run("node", ["target/tests/test.js", "--focus", ns]);
}

console.log("\nengine gate OK");
