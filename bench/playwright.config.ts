import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: ".",
  timeout: 120_000,
  workers: 1,
  reporter: "list",
  outputDir: "../work/inspector-profile-tests",
  use: {
    browserName: "chromium",
    viewport: { width: 1440, height: 1080 },
    headless: true,
  },
});
