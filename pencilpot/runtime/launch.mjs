// Open a chromeless --app window at a URL. Usage: node launch.mjs "http://localhost:7777/..."
import { spawn } from "node:child_process";
const url = process.argv[2] ?? "http://localhost:7777/";
const browsers = ["vivaldi-stable", "microsoft-edge-stable", "google-chrome-stable", "chromium", "brave"];

// This machine auto-injects MangoHud into every GL/Vulkan app (MANGOHUD=1 in
// ~/.config/environment.d/gaming.conf + a Vulkan implicit layer). MangoHud hooks
// GPU presentation (vkQueuePresent / GL swap). The SVG renderer creates no WebGL
// context so it was unaffected, but the wasm renderer drives a continuous WebGL2
// canvas that MangoHud overlays every frame -> stutter / flicker / instability
// that only appears in wasm mode. Disable MangoHud for the editor's browser
// process only; the global gaming config is left untouched.
const env = {
  ...process.env,
  MANGOHUD: "0",
  DISABLE_MANGOHUD: "1",
  VK_LOADER_LAYERS_DISABLE: "*MangoHud*",
};

for (const b of browsers) {
  try { spawn(b, [`--app=${url}`], { detached: true, stdio: "ignore", env }).unref(); console.log("opened with", b); break; }
  catch {}
}
