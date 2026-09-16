import { chromium } from "playwright";
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { root } from "../scripts/toolchain.mjs";

const browserRoot =
  process.env.PLAYWRIGHT_BROWSERS_PATH || resolve(root, ".tools/browsers");
process.env.PLAYWRIGHT_BROWSERS_PATH = browserRoot;
const ffmpeg =
  process.env.FFMPEG ||
  resolve(
    browserRoot,
    readdirSync(browserRoot).find((name) => name.startsWith("ffmpeg-")),
    process.platform === "win32" ? "ffmpeg-win64.exe" : "ffmpeg-linux",
  );
mkdirSync(resolve(root, "docs/media"), { recursive: true });
const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1440, height: 1080 },
  deviceScaleFactor: 1,
  recordVideo: {
    dir: resolve(root, "work/demo-video"),
    size: { width: 1440, height: 1080 },
  },
});
const page = await context.newPage();
try {
  await page.goto(pathToFileURL(resolve(root, "dist-demo/index.html")).href);
  await page.evaluate(() => document.fonts.ready);
  const begin = Date.now();
  const at = async (seconds) => {
    const remaining = begin + seconds * 1000 - Date.now();
    if (remaining > 0) await page.waitForTimeout(remaining);
  };
  await at(3);
  await page.evaluate(() =>
    window.scrollTo({
      top: document.getElementById("workspace").offsetTop - 20,
      behavior: "smooth",
    }),
  );
  await at(4);
  await page.getByRole("button", { name: /^Step 2:/ }).click();
  await at(7);
  await page.getByRole("button", { name: /^Step 3:/ }).click();
  await at(8);
  await page.screenshot({ path: resolve(root, "docs/media/walnut-demo.png") });
  await at(10);
  await page
    .getByRole("button", { name: "Inspect leaf page 2", exact: true })
    .click();
  await at(12);
  await page.getByRole("button", { name: /02 A commit survives/ }).click();
  await page.getByRole("button", { name: /^Step 2:/ }).click();
  await at(14);
  await page.getByRole("button", { name: /^Step 3:/ }).click();
  await at(18);
  await page.getByRole("button", { name: /^Step 4:/ }).click();
  await at(22);
  await page.getByRole("button", { name: /03 The file catches up/ }).click();
  await page.getByRole("button", { name: /^Step 2:/ }).click();
  await at(24);
  await page.getByRole("button", { name: /^Step 3:/ }).click();
  await at(27);
  await page.locator(".inspect-hex summary").click();
  await page.locator(".byte-inspector").scrollIntoViewIfNeeded();
  await at(31);
} finally {
  await context.close();
  await browser.close();
}
const input = await page.video().path();
execFileSync(
  ffmpeg,
  [
    "-hide_banner",
    "-y",
    "-i",
    input,
    "-ss",
    "1",
    "-t",
    "30",
    "-c:v",
    "libvpx",
    "-b:v",
    "1800k",
    "-an",
    resolve(root, "docs/media/walnut-demo.webm"),
  ],
  { cwd: root, windowsHide: true, stdio: "inherit" },
);
console.log(
  "Recorded 30 seconds of the actual standalone UI to docs/media/walnut-demo.webm.",
);
