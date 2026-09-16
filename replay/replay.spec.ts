import { test, expect } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { ReplayBundle } from "../src/ReplayApp";

const file = resolve("dist-demo/index.html");
const html = readFileSync(file, "utf8");
const bundle: ReplayBundle = JSON.parse(
  readFileSync(resolve("dist-demo/recordings.json"), "utf8"),
);
const hex = (bytes: number[]) =>
  bytes.map((byte) => byte.toString(16).padStart(2, "0").toUpperCase());

for (const story of bundle.stories) {
  test(`${story.scenario}: offline frames, metadata and page bytes match engine captures`, async ({
    page,
    context,
  }) => {
    const requests: string[] = [],
      errors: string[] = [];
    page.on("request", (request) => {
      if (/^https?:/.test(request.url())) requests.push(request.url());
    });
    page.on("pageerror", (error) => errors.push(error.message));
    await context.setOffline(true);
    await page.goto(`${pathToFileURL(file).href}#${story.scenario}`);
    await expect(
      page.getByRole("button", { name: "Run story", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Commit batch", exact: true }),
    ).toHaveCount(0);
    for (let i = 0; i < story.frames.length; i++) {
      const frame = story.frames[i],
        state = frame.capture.snapshot;
      await page
        .getByRole("button", {
          name: `Step ${i + 1}: ${frame.title}`,
          exact: true,
        })
        .click();
      await expect(page.getByTestId("record-count")).toHaveText(
        String(state.record_count).padStart(2, "0"),
      );
      await expect(page.getByTestId("page-count")).toHaveText(
        String(state.page_count).padStart(2, "0"),
      );
      await expect(page.getByTestId("generation")).toHaveText(
        String(state.generation).padStart(2, "0"),
      );
      await expect(page.getByTestId("staged-count")).toHaveText(
        String(state.staged.length),
      );
      await expect(page.getByTestId("checkpoint-generation")).toHaveText(
        String(state.checkpoint_generation),
      );
      await expect(
        page.getByRole("region", { name: "Current story step" }),
      ).toContainText(frame.explanation);
      if (frame.kind === "crashed")
        await expect(page.locator(".story-stopped")).toHaveText(
          "Process stopped · last captured state",
        );
      const disclosure = page.locator(".inspect-hex");
      if ((await disclosure.getAttribute("open")) === null)
        await disclosure.locator("summary").click();
      for (const captured of frame.capture.pages) {
        await page
          .getByRole("combobox", { name: "PAGE EXPLORER", exact: true })
          .selectOption(String(captured.page_id));
        await page
          .getByRole("button", { name: /^Committed page · gen/ })
          .click();
        const cells = page
          .getByRole("table", { name: "Encoded page bytes" })
          .locator("tbody td:not(.ascii)");
        await expect(cells).toHaveText(hex(captured.bytes.slice(0, 256)));
        const checkpoint = page.getByRole("button", {
          name: /^Checkpoint page ·/,
        });
        if (captured.checkpoint_bytes) {
          await checkpoint.click();
          await expect(cells).toHaveText(
            hex(captured.checkpoint_bytes.slice(0, 256)),
          );
        } else await expect(checkpoint).toBeDisabled();
      }
    }
    await page
      .getByText("Source, guarantees, and licenses", { exact: true })
      .click();
    await expect(page.locator(".replay-provenance")).toContainText(
      bundle.source.revision,
    );
    expect(requests).toEqual([]);
    expect(errors).toEqual([]);
  });
}

test("portable routes, keyboard playback and responsive page exploration", async ({
  page,
}) => {
  await page.goto(pathToFileURL(file).href);
  await page.getByRole("button", { name: /02 A commit survives/ }).click();
  await expect(page).toHaveURL(/#recovery$/);
  await expect(
    page.getByRole("button", { name: "Previous step" }),
  ).toBeDisabled();
  await page
    .getByRole("combobox", { name: "Speed", exact: true })
    .selectOption("2");
  const play = page.getByRole("button", {
    name: "Play recording",
    exact: true,
  });
  await play.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(".player-state")).toContainText("2/5", {
    timeout: 5000,
  });
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await expect(page.locator(".player-state")).toContainText("PAUSED");
  await page.getByRole("button", { name: "Next step" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(".story-stopped")).toBeVisible();
  await page.getByRole("button", { name: "Reset recording" }).click();
  await expect(page.locator(".player-state")).toContainText("1/5");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.getByRole("button", { name: /01 A page splits/ }).click();
  await page.getByRole("button", { name: /^Step 3:/ }).click();
  for (const width of [1440, 1100, 900, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await expect
      .poll(() =>
        page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      )
      .toBe(true);
    await page.getByRole("button", { name: "Fit", exact: true }).click();
    const leaf = page.getByRole("button", {
      name: "Inspect leaf page 2",
      exact: true,
    });
    await leaf.focus();
    await page.keyboard.press("Enter");
    await expect(
      page.getByRole("combobox", { name: "PAGE EXPLORER", exact: true }),
    ).toHaveValue("2");
    await page.getByRole("button", { name: "Zoom in", exact: true }).click();
    await expect(
      page.getByRole("status", { name: "Tree zoom" }),
    ).not.toHaveText("100%");
    await page.getByRole("button", { name: "Fit", exact: true }).click();
  }
});

test("self-contained export works at a nested static URL", async ({ page }) => {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(req.url!);
    if (req.url !== "/projects/walnut/demo.html") {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(html);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await page.goto(
      `http://127.0.0.1:${(server.address() as AddressInfo).port}/projects/walnut/demo.html`,
    );
    await page.getByRole("button", { name: /03 The file catches up/ }).click();
    await page.getByRole("button", { name: /^Step 3:/ }).click();
    await expect(page.getByTestId("wal-bytes")).toHaveText("64 B on disk");
    expect(requests).toEqual(["/projects/walnut/demo.html"]);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("damaged and unsupported embedded recordings fail visibly without network fallback", async ({
  page,
}, info) => {
  const requests: string[] = [];
  page.on("request", (request) => {
    if (/^https?:/.test(request.url())) requests.push(request.url());
  });
  for (const [name, data] of [
    ["unsupported", { ...bundle, schema_version: 99 }],
    [
      "missing-page",
      {
        ...bundle,
        stories: bundle.stories.map((story, i) =>
          i
            ? story
            : {
                ...story,
                frames: story.frames.map((frame, j) =>
                  j
                    ? frame
                    : { ...frame, capture: { ...frame.capture, pages: [] } },
                ),
              },
        ),
      },
    ],
    [
      "duplicate-story",
      {
        ...bundle,
        stories: [bundle.stories[0], bundle.stories[0], bundle.stories[2]],
      },
    ],
  ] as const) {
    const path = info.outputPath(`${name}.html`);
    writeFileSync(
      path,
      html.replace(
        /(<script id="walnut-recordings" type="application\/json">)[\s\S]*?(<\/script>)/,
        (_match, start, end) =>
          `${start}${JSON.stringify(data).replace(/</g, "\\u003c")}${end}`,
      ),
    );
    await page.goto(pathToFileURL(path).href);
    await expect(page.getByRole("alert")).toContainText(
      "This recording could not be loaded.",
    );
    await expect(page.getByRole("button")).toHaveCount(0);
  }
  expect(requests).toEqual([]);
});
