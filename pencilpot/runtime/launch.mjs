// Open a chromeless --app window at a URL. Usage: node launch.mjs "http://localhost:7777/..."
import { spawn } from "node:child_process";
const url = process.argv[2] ?? "http://localhost:7777/";
const browsers = ["vivaldi-stable", "microsoft-edge-stable", "google-chrome-stable", "chromium", "brave"];
for (const b of browsers) {
  try { spawn(b, [`--app=${url}`], { detached: true, stdio: "ignore" }).unref(); console.log("opened with", b); break; }
  catch {}
}
