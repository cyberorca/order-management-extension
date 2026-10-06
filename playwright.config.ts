import { defineConfig } from "@playwright/test";

// The suite starts and stops its own backend (offline steps need to kill it).
export default defineConfig({
  testDir: "e2e",
  timeout: 240_000,
  workers: 1,
  reporter: [["list"]],
});
