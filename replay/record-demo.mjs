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
  // Clicking through the DOM keeps the viewport where it was put; Playwright's
  // own click scrolls the target into view and would pan the recording.
  const press = (pattern) =>
    page.evaluate((source) => {
      const match = new RegExp(source);
      const button = [...document.querySelectorAll("button")].find((element) =>
        match.test(element.getAttribute("aria-label") || element.textContent),
      );
      if (!button) throw new Error(`No button matching ${source}`);
      button.click();
    }, pattern.source);

  // 0-3s  the masthead states what this is
  await at(3);
  await page.evaluate(() =>
    window.scrollTo({
      top: document.getElementById("workspace").offsetTop - 62,
      behavior: "smooth",
    }),
  );
  // 4-10s  one leaf fills, two puts wait in memory, the split commits
  await at(4.5);
  await press(/^Step 2:/);
  await at(7.5);
  await press(/^Step 3:/);
  await at(9);
  await page.screenshot({ path: resolve(root, "docs/media/walnut-demo.png") });
  await at(11);
  // 11-13s  the new right-hand leaf, inspected
  await press(/^Inspect leaf page 2$/);
  await at(13);
  // 13-22s  an acknowledged commit, a terminated process, a recovered tree
  await press(/A commit survives/);
  await press(/^Step 2:/);
  await at(15);
  await press(/^Step 3:/);
  await at(18.5);
  await press(/^Step 4:/);
  await at(22);
  // 22-27s  the log drains into the main file
  await press(/The file catches up/);
  await press(/^Step 2:/);
  await at(24);
  await press(/^Step 3:/);
  // 27-31s  the bytes behind all of it
  await at(27);
  await page.locator(".inspect-hex > summary").click();
  await page.locator(".byte-view").scrollIntoViewIfNeeded();
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
