import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  // Run tests sequentially: they share a single runtime server and the live-update
  // watcher can cause cross-test reload interference if tests run in parallel.
  workers: 1,
  use: { baseURL: `http://localhost:${process.env.PENCILPOT_PORT ?? 7777}`, headless: true },
  reporter: [["list"]],
});
