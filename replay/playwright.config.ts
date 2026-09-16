import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: ".",
  testMatch: "replay.spec.ts",
  timeout: 45_000,
  fullyParallel: true,
  workers: 2,
  forbidOnly: !!process.env.CI,
  retries: 0,
  outputDir: "../work/replay-tests",
  reporter: [
    ["list"],
    ["html", { outputFolder: "../work/replay-report", open: "never" }],
  ],
  use: {
    browserName: "chromium",
    viewport: { width: 1440, height: 1080 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});
