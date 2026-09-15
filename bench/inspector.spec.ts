import { test, expect } from "@playwright/test";
import { execFileSync, spawn } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { resolve } from "node:path";
import os from "node:os";

function distribution(values: number[]) {
  const raw = [...values].sort((a, b) => a - b);
  const p = (n: number) => raw[Math.ceil((raw.length * n) / 100) - 1];
  return {
    samples: raw.length,
    min_ms: raw[0],
    p50_ms: p(50),
    p95_ms: p(95),
    max_ms: raw.at(-1),
    raw_ms: raw,
  };
}

test("profile actual large captures and bounded playback", async ({
  browser,
}) => {
  await mkdir("work", { recursive: true });
  const directory = await mkdtemp(resolve("work/inspector-profile-"));
  const binary = resolve(
    `target/release/walnut${process.platform === "win32" ? ".exe" : ""}`,
  );
  const fixtureText = execFileSync(
    binary,
    ["profile-fixture", resolve(directory, "fixture")],
    { encoding: "utf8", maxBuffer: 32 * 1024 * 1024, windowsHide: true },
  );
  const fixture = JSON.parse(fixtureText);
  const port = await new Promise<number>((done) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const a = server.address();
      if (!a || typeof a === "string") throw new Error("No port");
      server.close(() => done(a.port));
    });
  });
  const child = spawn(
    binary,
    [
      "serve",
      resolve(directory, "fixture/large.db"),
      "--ui",
      resolve("dist"),
      "--port",
      String(port),
    ],
    { windowsHide: true },
  );
  const exit = new Promise<void>((done) => child.once("exit", () => done()));
  try {
    await new Promise<void>((done, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Engine start timed out")),
        10000,
      );
      child.once("error", reject);
      child.stdout.on("data", (data) => {
        if (String(data).includes("WALnut inspector:")) {
          clearTimeout(timer);
          done();
        }
      });
    });
    const results = [];
    for (const rate of [1, 4]) {
      const context = await browser.newContext({
        viewport: { width: 1440, height: 1080 },
      });
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      const cdp = await context.newCDPSession(page);
      await cdp.send("Emulation.setCPUThrottlingRate", { rate });
      await cdp.send("Performance.enable");
      // Captures were produced by the real engine above; route only supplies repeatable input.
      await page.route("**/api/snapshot*", (route) =>
        route.fulfill({ json: fixture.snapshot }),
      );
      await page.route("**/api/story*", (route) =>
        route.fulfill({ json: fixture }),
      );
      await page.addInitScript(() => {
        const samples: { name: string; duration: number }[] = [];
        Object.assign(window, { profileSamples: samples });
        new PerformanceObserver((list) => {
          for (const e of list.getEntries()) {
            samples.push({ name: e.name, duration: e.duration });
            if (samples.length > 512) samples.shift();
          }
        }).observe({ entryTypes: ["measure", "longtask"] });
      });
      await page.goto(`http://127.0.0.1:${port}/?mode=live`);
      await expect(page.getByTestId("record-count")).toHaveText("1792");
      expect(await page.locator(".canvas-page").count()).toBeLessThanOrEqual(6);
      await page.screenshot({
        path: resolve(directory, `live-${rate}x.png`),
        animations: "disabled",
      });
      await page.getByRole("button", { name: "Guided stories" }).click();
      await page.getByRole("button", { name: /^Run story/ }).click();
      await expect(
        page.getByRole("region", { name: "Recorded playback" }),
      ).toBeVisible();
      for (let capture = 1; capture < 5; capture++) {
        await page
          .getByRole("button", { name: "Run story again", exact: true })
          .click();
        await expect(
          page.getByRole("button", { name: "Run story again", exact: true }),
        ).toBeEnabled();
      }
      const initialMetrics = (await cdp.send("Performance.getMetrics")).metrics;
      const steps: number[] = [];
      for (let i = 0; i < 48; i++) {
        const target = fixture.story.frames[i % 4];
        const duration = await page.evaluate(
          async ({ index, title }) => {
            const button = document.querySelector<HTMLButtonElement>(
              `button[aria-label="Step ${index + 1}: ${title}"]`,
            )!;
            const start = performance.now();
            button.click();
            await new Promise<void>((done) =>
              requestAnimationFrame(() => requestAnimationFrame(() => done())),
            );
            return performance.now() - start;
          },
          { index: i % 4, title: target.title },
        );
        await expect(page.getByTestId("generation")).toHaveText(
          String(target.capture.snapshot.generation).padStart(2, "0"),
        );
        steps.push(duration);
      }
      const finalMetrics = (await cdp.send("Performance.getMetrics")).metrics;
      await cdp.send("HeapProfiler.collectGarbage");
      const retained = (await cdp.send("Performance.getMetrics")).metrics;
      const samples = await page.evaluate(
        () =>
          (
            window as unknown as {
              profileSamples: { name: string; duration: number }[];
            }
          ).profileSamples,
      );
      const durations = (name: string) =>
        samples.filter((s) => s.name === name).map((s) => s.duration);
      expect(errors).toEqual([]);
      expect(await page.locator(".canvas-page").count()).toBeLessThanOrEqual(6);
      expect(await page.locator(".player-steps > li").count()).toBe(4);
      expect(
        await page.evaluate(
          () => performance.getEntriesByType("measure").length,
        ),
      ).toBeLessThanOrEqual(2);
      await page.screenshot({
        path: resolve(directory, `replay-${rate}x.png`),
        animations: "disabled",
      });
      results.push({
        cpu_slowdown: rate,
        step_to_two_animation_frames: distribution(steps),
        snapshot_validation: distribution(
          durations("walnut:snapshot:validate"),
        ),
        story_validation: distribution(durations("walnut:story:validate")),
        long_tasks_ms: durations("self"),
        initial_metrics: initialMetrics,
        final_metrics: finalMetrics,
        after_gc: retained,
        rendered_nodes: await page.locator("*").count(),
        tree_cards: await page.locator(".canvas-page").count(),
      });
      await context.close();
    }
    const report = {
      recorded_at: new Date().toISOString(),
      revision: execFileSync("git", ["rev-parse", "HEAD"], {
        encoding: "utf8",
      }).trim(),
      dirty:
        execFileSync("git", ["status", "--porcelain"], {
          encoding: "utf8",
        }).trim().length > 0,
      cpu: os.cpus()[0].model,
      os: os.version(),
      browser: browser.version(),
      viewport: { width: 1440, height: 1080 },
      fixture: {
        records: fixture.snapshot.record_count,
        pages: fixture.snapshot.page_count,
        events: fixture.snapshot.events.length,
        frames: fixture.story.frames.length,
        recorded_pages: fixture.story.frames.at(-1).capture.snapshot.page_count,
        response_bytes: Buffer.byteLength(fixtureText),
      },
      results,
    };
    await writeFile(
      resolve(directory, "report.json"),
      JSON.stringify(report, null, 2) + "\n",
    );
    console.log(`Inspector profile: ${directory}`);
  } finally {
    child.kill();
    await exit;
  }
});
