import {
  test as base,
  expect,
  type Page,
  type TestInfo,
} from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { resolve } from "node:path";
import type { RecordedStory, Snapshot, StoryFrame } from "../src/types";

const commandHeaders = { "X-Walnut-Client": "inspector-v1" };
const engineStatus = (page: Page) =>
  page.getByRole("status").filter({ hasText: /^Engine (connected|offline)$/ });

async function snapshot(page: Page, url: string): Promise<Snapshot> {
  return (await page.request.get(`${url}/api/snapshot`)).json();
}

async function revealBytes(page: Page) {
  const details = page.locator("details.inspect-hex");
  if (
    !(await details.evaluate((element) => (element as HTMLDetailsElement).open))
  )
    await details.locator("summary").click();
}

async function expectHex(page: Page, bytes: number[], offset = 0) {
  await expect(
    page
      .getByRole("table", { name: "Encoded page bytes" })
      .locator("tbody td:not(.ascii)"),
  ).toHaveText(
    bytes
      .slice(offset, offset + 256)
      .map((byte) => byte.toString(16).padStart(2, "0").toUpperCase()),
  );
}

async function captureReview(page: Page, testInfo: TestInfo, name: string) {
  for (const fullPage of [false, true]) {
    const label = `${name}-${fullPage ? "overview" : "viewport"}`;
    const path = testInfo.outputPath(`${label}.png`);
    await page.screenshot({ path, fullPage, animations: "disabled" });
    await testInfo.attach(label, { path, contentType: "image/png" });
  }
}

async function runStory(page: Page, title: string): Promise<RecordedStory> {
  await page
    .getByRole("group", { name: "Guided story", exact: true })
    .getByRole("button", { name: new RegExp(title) })
    .click();
  const result = page.waitForResponse(
    (response) =>
      response.url().includes("/api/story") &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: /^Run story/ }).click();
  const response = await result;
  expect(response.ok()).toBe(true);
  const body = await response.json();
  const story: RecordedStory = body.story;
  expect(story.schema_version).toBe(1);
  await expect(
    page.getByRole("region", { name: "Recorded playback" }),
  ).toBeVisible();
  return story;
}

async function expectFrame(page: Page, frame: StoryFrame, index: number) {
  const step = page.getByRole("button", {
    name: `Step ${index + 1}: ${frame.title}`,
    exact: true,
  });
  await step.click();
  await expect(step).toHaveAttribute("aria-current", "step");
  await expect(
    page.getByRole("region", { name: "Current story step" }),
  ).toContainText(frame.explanation);
  const state = frame.capture.snapshot;
  await expect(page.getByTestId("record-count")).toHaveText(
    String(state.record_count).padStart(2, "0"),
  );
  await expect(page.getByTestId("generation")).toHaveText(
    String(state.generation).padStart(2, "0"),
  );
  await expect(page.getByTestId("page-count")).toHaveText(
    String(state.page_count).padStart(2, "0"),
  );
  await expect(page.getByTestId("tree-height")).toHaveText(
    `${state.tree_height} ${state.tree_height === 1 ? "level" : "levels"}`,
  );
  await expect(page.getByTestId("staged-count")).toHaveText(
    String(state.staged.length),
  );
  await expect(page.getByTestId("checkpoint-generation")).toHaveText(
    String(state.checkpoint_generation),
  );
  await expect(page.getByTestId("wal-bytes")).toHaveText(
    `${state.wal_bytes.toLocaleString("en-US")} B on disk`,
  );
  await expect(
    page.getByRole("combobox", { name: "PAGE EXPLORER", exact: true }),
  ).toHaveValue(String(frame.focus_page_id));
}

async function terminate(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const stopped = new Promise<void>((done) => child.once("exit", () => done()));
  child.kill();
  await stopped;
}

const test = base.extend<{
  database: { url: string; path: string; process: ChildProcess };
}>({
  database: async ({}, use) => {
    await mkdir("work", { recursive: true });
    const dir = await mkdtemp(resolve("work/e2e-"));
    const db = resolve(dir, "inspector.db");
    const port = await new Promise<number>((done) => {
      const server = createServer();
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("No port");
        server.close(() => done(address.port));
      });
    });
    const child = spawn(
      resolve(
        `target/debug/walnut${process.platform === "win32" ? ".exe" : ""}`,
      ),
      ["serve", db, "--port", String(port), "--ui", resolve("dist")],
      { windowsHide: true },
    );
    let stderr = "";
    child.stderr?.on("data", (data) => {
      stderr += data;
    });
    await new Promise<void>((done, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Engine timeout: ${stderr}`)),
        10_000,
      );
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`Engine exited ${code}: ${stderr}`));
      });
      child.stdout?.on("data", (data) => {
        if (String(data).includes("WALnut inspector:")) {
          clearTimeout(timer);
          done();
        }
      });
    });
    try {
      await use({ url: `http://127.0.0.1:${port}`, path: db, process: child });
    } finally {
      await terminate(child);
    }
  },
});

test("slow polling keeps one request in flight, holds verified data and recovers", async ({
  page,
  database,
}, testInfo) => {
  await page.goto(`${database.url}/?mode=live`);
  await expect(engineStatus(page)).toHaveText("Engine connected");
  const original = await snapshot(page, database.url);
  let release!: () => void;
  const held = new Promise<void>((done) => {
    release = done;
  });
  let inFlight = 0;
  let maximum = 0;
  let intercepted = 0;
  await page.route("**/api/snapshot?*", async (route) => {
    intercepted++;
    inFlight++;
    maximum = Math.max(maximum, inFlight);
    await held;
    await route.continue();
    inFlight--;
  });
  try {
    await expect(page.getByText("Engine delayed", { exact: true })).toBeVisible(
      { timeout: 7000 },
    );
    await expect(
      page.getByRole("status").filter({ hasText: "Waiting for the engine." }),
    ).toContainText("last verified state");
    await expect(page.getByTestId("record-count")).toHaveText(
      String(original.record_count).padStart(2, "0"),
    );
    await expect(
      page.getByRole("button", { name: "Insert 64 sample records" }),
    ).toBeDisabled();
    await expect(
      page.getByText("Engine offline. Reopen to reconnect."),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Reopen database" }),
    ).toBeDisabled();
    await captureReview(page, testInfo, "delayed-engine");
    expect(intercepted).toBe(1);
    expect(maximum).toBe(1);
  } finally {
    release();
  }
  await expect(engineStatus(page)).toHaveText("Engine connected");
  await expect(
    page.getByRole("button", { name: "Insert 64 sample records" }),
  ).toBeEnabled();
});

test("timeline reports skipped events and a new session resets the gap", async ({
  page,
  database,
}, testInfo) => {
  await page.goto(`${database.url}/?mode=live`);
  await expect(engineStatus(page)).toHaveText("Engine connected");
  const initial = await snapshot(page, database.url);
  // Freeze browser polls while independent API reads outrun the retained 128-event window.
  let current = initial;
  await page.route("**/api/snapshot?*", (route) =>
    route.fulfill({ json: current }),
  );
  for (let i = 0; i < 80; i++) {
    const response = await page.request.post(`${database.url}/api/get`, {
      headers: commandHeaders,
      data: { key: "missing" },
    });
    expect(response.ok()).toBe(true);
  }
  current = await snapshot(page, database.url);
  const skipped =
    current.events[0].sequence - initial.events.at(-1)!.sequence - 1;
  expect(skipped).toBeGreaterThan(0);
  await expect(
    page.getByText(
      `Timeline gap: ${skipped} events passed outside the retained window. The current snapshot is complete.`,
    ),
  ).toBeVisible();
  await captureReview(page, testInfo, "timeline-gap");
  const response = await page.request.post(`${database.url}/api/reopen`, {
    headers: commandHeaders,
    data: {},
  });
  expect(response.ok()).toBe(true);
  current = (await response.json()).snapshot;
  await expect(page.locator(".work-stream-gap")).toHaveCount(0);
  await expect(engineStatus(page)).toHaveText("Engine connected");
});

test("out-of-order snapshots and discontinuous event windows retain verified state", async ({
  page,
  database,
}) => {
  await page.goto(`${database.url}/?mode=live`);
  await expect(engineStatus(page)).toHaveText("Engine connected");
  const earlier = await snapshot(page, database.url);
  await page.request.post(`${database.url}/api/put`, {
    headers: commandHeaders,
    data: { key: "verified", value: "latest" },
  });
  const latest = await snapshot(page, database.url);
  await expect(page.getByTestId("generation")).toHaveText(
    String(latest.generation).padStart(2, "0"),
  );
  await page.route("**/api/snapshot?*", (route) =>
    route.fulfill({ json: earlier }),
  );
  await expect(engineStatus(page)).toHaveText("Engine offline");
  await expect(page.getByTestId("generation")).toHaveText(
    String(latest.generation).padStart(2, "0"),
  );
  await page.unroute("**/api/snapshot?*");
  await page.getByRole("button", { name: "Reconnect", exact: true }).click();
  await expect(engineStatus(page)).toHaveText("Engine connected");
  const malformed = structuredClone(latest);
  malformed.events[1].sequence = malformed.events[0].sequence;
  await page.route("**/api/snapshot?*", (route) =>
    route.fulfill({ json: malformed }),
  );
  await expect(engineStatus(page)).toHaveText("Engine offline");
  await expect(page.getByTestId("generation")).toHaveText(
    String(latest.generation).padStart(2, "0"),
  );
});

test("writes real bytes, reads a value, and preserves it across file reopen", async ({
  page,
  database,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${database.url}/?mode=live`);
  await expect(engineStatus(page)).toHaveText("Engine connected");
  await expect(page.getByTestId("record-count")).toHaveText("00");
  await page.getByRole("textbox", { name: "Key", exact: true }).fill("hello");
  await page
    .getByRole("textbox", { name: "Value", exact: true })
    .fill("from the inside 🌰");
  await page.getByRole("button", { name: "Commit this put" }).click();
  await expect(page.getByTestId("generation")).toHaveText("01");
  const before = await (
    await page.request.get(`${database.url}/api/snapshot`)
  ).json();
  await revealBytes(page);
  await expect(page.locator(".key-byte").first()).toHaveText("68");
  await page.getByRole("button", { name: "Reopen database" }).click();
  await expect(
    page.getByText(
      "Database reopened. Committed state recovered and verified.",
    ),
  ).toBeVisible();
  const after = await (
    await page.request.get(`${database.url}/api/snapshot`)
  ).json();
  expect(after.session_id).not.toBe(before.session_id);
  expect(after.generation).toBe(1);
  expect(after.records).toEqual(before.records);
  await page.getByRole("button", { name: "GET Read" }).click();
  await page.getByRole("button", { name: "Find this key" }).click();
  await expect(page.getByLabel("Read value")).toHaveText("from the inside 🌰");
  expect(errors).toEqual([]);
  await terminate(database.process);
  const main = await readFile(database.path);
  const wal = await readFile(`${database.path}.wal`);
  expect(main.length).toBe(8256);
  expect(Array.from(main.subarray(64 + 4096))).toEqual(before.checkpoint_bytes);
  expect(before.checkpoint_generation).toBe(0);
  const actual = wal.subarray(64 + 64 + 4096, 64 + 64 + 8192);
  expect(Array.from(actual)).toEqual(before.bytes);
  expect(
    actual
      .subarray(before.records[0].key_offset, before.records[0].value_offset)
      .toString("utf8"),
  ).toBe("hello");
  expect(
    actual
      .subarray(
        before.records[0].value_offset,
        before.records[0].offset + before.records[0].length,
      )
      .toString("utf8"),
  ).toBe("from the inside 🌰");
});

test("updates keep one record and missing lookups are explicit", async ({
  page,
  database,
}) => {
  await page.goto(`${database.url}/?mode=live`);
  await page.getByRole("button", { name: "Commit this put" }).click();
  await expect(page.getByTestId("generation")).toHaveText("01");
  await page
    .getByRole("textbox", { name: "Value", exact: true })
    .fill("updated");
  await page.getByRole("button", { name: "Commit this put" }).click();
  await expect(page.getByTestId("generation")).toHaveText("02");
  await expect(page.getByTestId("record-count")).toHaveText("01");
  await page.getByRole("button", { name: "GET Read" }).click();
  await page.getByRole("textbox", { name: "Key", exact: true }).fill("missing");
  await page.getByRole("button", { name: "Find this key" }).click();
  await expect(page.getByText("“missing” is not in this tree.")).toBeVisible();
  await expect(page.getByLabel("Read value")).toHaveCount(0);
});

test("byte bounds hold while a physically full leaf splits", async ({
  page,
  database,
}) => {
  await page.goto(`${database.url}/?mode=live`);
  await page
    .getByRole("textbox", { name: "Key", exact: true })
    .fill("é".repeat(33));
  await expect(
    page.getByRole("button", { name: "Commit this put" }),
  ).toBeDisabled();
  const headers = {
    "Content-Type": "application/json",
    "X-Walnut-Client": "inspector-v1",
  };
  for (const key of ["a", "b", "c"])
    expect(
      (
        await page.request.post(`${database.url}/api/put`, {
          headers,
          data: { key, value: "x".repeat(1024) },
        })
      ).ok(),
    ).toBeTruthy();
  await page.getByRole("textbox", { name: "Key", exact: true }).fill("d");
  await page
    .getByRole("textbox", { name: "Value", exact: true })
    .fill("y".repeat(1024));
  await page.getByRole("button", { name: "Commit this put" }).click();
  await expect(page.getByTestId("record-count")).toHaveText("04");
  await expect(page.getByTestId("tree-height")).toHaveText("2 levels");
  const snapshot = await (
    await page.request.get(`${database.url}/api/snapshot`)
  ).json();
  expect(snapshot.generation).toBe(4);
  expect(snapshot.record_count).toBe(4);
  expect(snapshot.page_count).toBe(3);
  expect(snapshot.splits).toHaveLength(1);
  const invalid = await page.request.post(`${database.url}/api/put`, {
    headers,
    data: { key: "oversized", value: "x".repeat(1025) },
  });
  expect(invalid.status()).toBe(400);
  expect(
    (await (await page.request.get(`${database.url}/api/snapshot`)).json())
      .generation,
  ).toBe(4);
});

test("local API rejects cross-origin writes and malformed commands", async ({
  request,
  database,
}) => {
  const url = `${database.url}/api/put`;
  expect(
    (await request.post(url, { data: { key: "bad", value: "bad" } })).status(),
  ).toBe(403);
  expect(
    (
      await request.post(url, {
        headers: {
          "X-Walnut-Client": "inspector-v1",
          Origin: "https://example.com",
        },
        data: { key: "bad", value: "bad" },
      })
    ).status(),
  ).toBe(403);
  expect(
    (
      await request.post(url, {
        headers: { "X-Walnut-Client": "inspector-v1" },
        data: { key: "ok", value: "ok", extra: true },
      })
    ).status(),
  ).toBe(400);
  expect(
    (
      await request.get(`${database.url}/api/snapshot`, {
        headers: { Host: "attacker.example" },
      })
    ).status(),
  ).toBe(403);
  const snapshot = await (
    await request.get(`${database.url}/api/snapshot`)
  ).json();
  expect(snapshot.records).toHaveLength(0);
});

test("narrow layout and reduced motion retain keyboard access", async ({
  page,
  database,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(`${database.url}/?mode=live`);
  await page
    .getByRole("textbox", { name: "Key", exact: true })
    .fill("keyboard");
  await page.getByRole("textbox", { name: "Key", exact: true }).press("Enter");
  await expect(page.getByTestId("record-count")).toHaveText("01");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBeTruthy();
  await revealBytes(page);
  await page.getByRole("button", { name: "Next 256 bytes" }).click();
  await expect(page.locator(".byte-paging")).toContainText("0100–01FF");
  await expect(
    page.getByRole("button", { name: "Previous 256 bytes" }),
  ).toBeEnabled();
  expect(
    await page
      .locator(".page-map rect")
      .first()
      .evaluate((el) => getComputedStyle(el).transitionDuration),
  ).toBe("0s");
});

test("engine loss shows stale state and disables writes", async ({
  page,
  database,
}) => {
  await page.goto(`${database.url}/?mode=live`);
  await page.getByRole("button", { name: "Commit this put" }).click();
  await expect(page.getByTestId("record-count")).toHaveText("01");
  database.process.kill();
  await expect(engineStatus(page)).toHaveText("Engine offline", {
    timeout: 12_000,
  });
  await expect(page.getByRole("alert")).toContainText("last verified snapshot");
  await expect(
    page.getByRole("button", { name: "Commit this put" }),
  ).toBeDisabled();
  await expect(page.getByTestId("record-count")).toHaveText("01");
});

test("stages two puts, hides them from reads, commits atomically, and checkpoints real bytes", async ({
  page,
  database,
}) => {
  await page.goto(`${database.url}/?mode=live`);
  for (const [key, value] of [
    ["alpha", "one"],
    ["beta", "two"],
  ]) {
    await page.getByRole("textbox", { name: "Key", exact: true }).fill(key);
    await page.getByRole("textbox", { name: "Value", exact: true }).fill(value);
    await page.getByRole("button", { name: "Stage in batch" }).click();
    await expect(
      page.getByText(`Staged “${key}”. Reads still see committed data.`),
    ).toBeVisible();
  }
  await expect(page.getByTestId("staged-count")).toHaveText("2");
  await expect(page.getByTestId("record-count")).toHaveText("00");
  await expect(
    page.getByRole("button", { name: "Commit this put" }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "GET Read" }).click();
  await page.getByRole("button", { name: "Find this key" }).click();
  await expect(page.getByText("“beta” is not in this tree.")).toBeVisible();
  await page.getByRole("button", { name: "Commit batch", exact: true }).click();
  await expect(page.getByTestId("generation")).toHaveText("01");
  await expect(page.getByTestId("record-count")).toHaveText("02");
  await expect(
    page.getByRole("textbox", { name: "Key", exact: true }),
  ).toBeFocused();
  await expect(page.getByTestId("staged-count")).toHaveText("0");
  await expect(page.getByTestId("checkpoint-generation")).toHaveText("0");
  await expect(
    page.getByRole("button", { name: "GEN 01 2 puts COMMITTED" }),
  ).toBeVisible();
  await revealBytes(page);
  await page.getByRole("button", { name: "Checkpoint page · gen 0" }).click();
  await expect(
    page
      .getByRole("table", { name: "Encoded page bytes" })
      .locator("tbody tr")
      .nth(1)
      .locator("td")
      .first(),
  ).toHaveText("00");
  await page.getByRole("button", { name: "Committed page · gen 1" }).click();
  await expect(
    page
      .getByRole("table", { name: "Encoded page bytes" })
      .locator("tbody tr")
      .nth(1)
      .locator("td")
      .first(),
  ).toHaveText("01");
  await page.getByRole("button", { name: "Checkpoint", exact: true }).click();
  await expect(page.getByTestId("checkpoint-generation")).toHaveText("1");
  await expect(page.getByTestId("wal-bytes")).toHaveText("64 B on disk");
  const snapshot = await (
    await page.request.get(`${database.url}/api/snapshot`)
  ).json();
  await terminate(database.process);
  expect(
    Array.from((await readFile(database.path)).subarray(64 + 4096)),
  ).toEqual(snapshot.bytes);
  expect((await readFile(`${database.path}.wal`)).length).toBe(64);
});

test("discard and reopen remove pending puts, while checkpoint preserves them", async ({
  page,
  database,
}) => {
  await page.goto(`${database.url}/?mode=live`);
  await page.getByRole("button", { name: "Stage in batch" }).click();
  await expect(page.getByTestId("staged-count")).toHaveText("1");
  await page.getByRole("button", { name: "Checkpoint", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Checkpoint", exact: true }),
  ).toBeEnabled();
  expect((await snapshot(page, database.url)).wal_bytes).toBe(64);
  await expect(page.getByTestId("staged-count")).toHaveText("1");
  await page.getByRole("button", { name: "Discard", exact: true }).click();
  await expect(page.getByTestId("staged-count")).toHaveText("0");
  await page.getByRole("button", { name: "Stage in batch" }).click();
  await expect(page.getByTestId("staged-count")).toHaveText("1");
  await page.getByRole("button", { name: "Reopen database" }).click();
  await expect(page.getByTestId("staged-count")).toHaveText("0");
  await expect(page.getByTestId("generation")).toHaveText("00");
});

test("recovery lab reports actual child exits and leaves the open database untouched", async ({
  page,
  database,
}) => {
  await page.goto(`${database.url}/?mode=live`);
  await page.getByRole("button", { name: "Commit this put" }).click();
  await expect(page.getByTestId("generation")).toHaveText("01");
  const before = await (
    await page.request.get(`${database.url}/api/snapshot`)
  ).json();
  await page
    .locator("summary")
    .filter({ hasText: "Advanced crash lab" })
    .click();
  for (const scenario of [
    "Before commit",
    "After commit",
    "During checkpoint",
    "During log reset",
  ]) {
    await page
      .getByRole("group", { name: "Crash boundary" })
      .getByRole("button", { name: scenario })
      .click();
    const response = page.waitForResponse(
      (res) =>
        res.url().includes("/api/lab?") && res.request().method() === "POST",
    );
    await page.getByRole("button", { name: "Run crash & recover" }).click();
    const report = (await (await response).json()).lab;
    expect(report.process_terminated).toBe(true);
    expect(report.process_id).not.toBe(database.process.pid);
    expect(report.database_path).not.toBe(database.path);
    const absent = scenario === "Before commit";
    expect(report.baseline.record_count).toBe(116);
    expect(report.snapshot.record_count).toBe(absent ? 116 : 118);
    expect(report.snapshot.tree_height).toBe(absent ? 2 : 3);
    expect(report.snapshot.page_count).toBe(absent ? 59 : 62);
    expect(
      report.attempted.every((r: { found: boolean }) => r.found === !absent),
    ).toBe(true);
    await expect(
      page.getByRole("heading", {
        name: absent
          ? "No partial batch escaped."
          : "The whole batch survived.",
      }),
    ).toBeVisible();
    await expect(engineStatus(page)).toHaveText("Engine connected");
  }
  const after = await (
    await page.request.get(`${database.url}/api/snapshot`)
  ).json();
  expect(after.bytes).toEqual(before.bytes);
  expect(after.wal_bytes).toBe(before.wal_bytes);
  expect(after.session_id).toBe(before.session_id);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("grows a three-level tree, follows a lookup, inspects routing and scans linked leaves", async ({
  page,
  database,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${database.url}/?mode=live`);
  for (const count of [64, 128]) {
    await page
      .getByRole("button", { name: "Insert 64 sample records" })
      .click();
    await expect(page.getByTestId("record-count")).toHaveText(String(count));
  }
  await expect(page.getByTestId("tree-height")).toHaveText("3 levels");
  const state = await (
    await page.request.get(`${database.url}/api/snapshot`)
  ).json();
  expect(state.schema_version).toBe(3);
  expect(state.pages.length).toBe(state.page_count);
  await page
    .getByRole("combobox", { name: "PAGE EXPLORER", exact: true })
    .selectOption(String(state.root_page_id));
  await expect(
    page.getByRole("region", { name: "Internal page routing" }),
  ).toBeVisible();
  await expect(
    page.getByRole("img", { name: new RegExp(`Page ${state.root_page_id}:`) }),
  ).toBeVisible();
  await page
    .getByRole("combobox", { name: "PAGE EXPLORER", exact: true })
    .selectOption("0");
  await expect(
    page.getByRole("region", { name: "Tree metadata" }),
  ).toContainText(state.state_checksum);
  const all = (
    await (
      await page.request.post(`${database.url}/api/range`, {
        headers: { "X-Walnut-Client": "inspector-v1" },
        data: { start: "", end: null, limit: 256 },
      })
    ).json()
  ).range;
  const target = all.records[90];
  await page.getByRole("button", { name: "GET Read" }).click();
  await page
    .getByRole("textbox", { name: "Key", exact: true })
    .fill(target.key);
  await page.getByRole("button", { name: "Find this key" }).click();
  await expect(page.getByLabel("Read value")).toHaveText(target.value);
  await expect(
    page.getByRole("combobox", { name: "PAGE EXPLORER", exact: true }),
  ).toHaveValue(String(target.page_id));
  const read = await (
    await page.request.get(`${database.url}/api/snapshot`)
  ).json();
  expect(read.last_search_path).toHaveLength(3);
  await expect(page.getByTestId("search-path").getByRole("button")).toHaveText(
    read.last_search_path.map(
      (id: number) => `P${String(id).padStart(3, "0")}`,
    ),
  );
  const selected = await (
    await page.request.get(
      `${database.url}/api/snapshot?page=${target.page_id}`,
    )
  ).json();
  await expect(
    page.getByRole("img", {
      name: `Page ${target.page_id}: ${selected.used_bytes} of 4096 bytes used`,
    }),
  ).toBeVisible();
  await page.getByRole("button", { name: "SCAN Range" }).click();
  await page.getByLabel("Result limit").fill("17");
  await page.getByRole("button", { name: "Scan this range" }).click();
  const results = page.getByRole("region", { name: "Range results" });
  await expect(results.locator("li")).toHaveCount(17);
  await expect(results.locator("li button > span")).toHaveText(
    all.records.slice(0, 17).map((record: { key: string }) => record.key),
  );
  await expect(results.locator("li button > small")).toHaveText(
    all.records
      .slice(0, 17)
      .map((record: { page_id: number }) => `P${record.page_id} ↗`),
  );
  await results.getByRole("button", { name: "Next 17 records" }).click();
  await expect(page.getByLabel("Start key")).toHaveValue(all.records[17].key);
  await expect(results.locator("li button").first()).toContainText(
    all.records[17].key,
  );
  await results.locator("li button").first().click();
  await expect(
    page.getByRole("combobox", { name: "PAGE EXPLORER", exact: true }),
  ).toHaveValue(String(all.records[17].page_id));
  await page.getByLabel("End key").fill(all.records[20].key);
  await page.getByRole("button", { name: "Scan this range" }).click();
  await expect(results.locator("li")).toHaveCount(3);
  await expect(
    results.getByRole("button", { name: "Next 17 records" }),
  ).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page
    .getByRole("combobox", { name: "PAGE EXPLORER", exact: true })
    .selectOption(String(state.root_page_id));
  const rootPage = state.pages.find(
    (node: { id: number }) => node.id === state.root_page_id,
  );
  const branch = page.getByRole("button", {
    name: `Inspect internal page ${rootPage.children[0]}`,
    exact: true,
  });
  await branch.focus();
  await branch.press("Enter");
  await expect(
    page.getByRole("navigation", { name: "Tree ancestry" }).getByRole("button"),
  ).toHaveCount(2);
  await page.getByRole("button", { name: "Next child pages" }).click();
  await expect(page.locator(".canvas-pagination")).toContainText(
    "Children 4–6",
  );
  expect(errors).toEqual([]);
});

test("range and page requests validate before a write and preserve the selected inspector page", async ({
  request,
  database,
}) => {
  const headers = { "X-Walnut-Client": "inspector-v1" };
  for (const suffix of ["?page=999", "?page=-1", "?page=1&extra=1"]) {
    expect(
      (
        await request.post(`${database.url}/api/put${suffix}`, {
          headers,
          data: { key: "must-not-write", value: "x" },
        })
      ).status(),
    ).toBe(400);
  }
  for (const input of [
    { start: "z", end: "a", limit: 5 },
    { start: "", end: null, limit: 257 },
    { start: "é".repeat(33), limit: 5 },
  ]) {
    expect(
      (
        await request.post(`${database.url}/api/range`, {
          headers,
          data: input,
        })
      ).status(),
    ).toBe(400);
  }
  const state = await (
    await request.get(`${database.url}/api/snapshot`)
  ).json();
  expect(state.generation).toBe(0);
  const put = await (
    await request.post(`${database.url}/api/put?page=0`, {
      headers,
      data: { key: "meta-selected", value: "yes" },
    })
  ).json();
  expect(put.snapshot.page_id).toBe(0);
  expect(put.snapshot.record_count).toBe(1);
});

test("batch API validates before changing state and rejects unknown lab boundaries", async ({
  request,
  database,
}) => {
  const headers = { "X-Walnut-Client": "inspector-v1" };
  const before = await (
    await request.get(`${database.url}/api/snapshot`)
  ).json();
  const bad = await request.post(`${database.url}/api/batch`, {
    headers,
    data: {
      writes: [
        { key: "valid", value: "x" },
        { key: "", value: "bad" },
      ],
    },
  });
  expect(bad.status()).toBe(400);
  const lab = await request.post(`${database.url}/api/lab`, {
    headers,
    data: { boundary: "arbitrary-command" },
  });
  expect(lab.status()).toBe(400);
  const after = await (
    await request.get(`${database.url}/api/snapshot`)
  ).json();
  expect(after.bytes).toEqual(before.bytes);
  expect(after.wal_bytes).toBe(before.wal_bytes);
  expect(after.staged).toEqual([]);
});

for (const scenario of [
  {
    id: "split",
    title: "A page splits",
    kinds: ["baseline", "staged", "committed", "lookup"],
  },
  {
    id: "recovery",
    title: "A commit survives",
    kinds: ["baseline", "committed", "crashed", "recovered", "lookup"],
  },
  {
    id: "checkpoint",
    title: "The file catches up",
    kinds: ["baseline", "committed", "checkpointed", "reopened"],
  },
] as const) {
  test(`${scenario.id} story shows captured engine pages without changing the live database`, async ({
    page,
    database,
  }, testInfo) => {
    test.setTimeout(60_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${database.url}/?mode=live`);
    await page.getByRole("button", { name: "Commit this put" }).click();
    await expect(page.getByTestId("record-count")).toHaveText("01");
    const before = await snapshot(page, database.url);
    await page.getByRole("button", { name: /^Guided stories/ }).click();
    await expect(
      page.getByRole("region", { name: "Recorded playback" }),
    ).toHaveCount(0);
    if (scenario.id === "split")
      await captureReview(page, testInfo, "orientation-desktop");
    const story = await runStory(page, scenario.title);
    expect(story.scenario).toBe(scenario.id);
    expect(story.source.database_path).not.toBe(database.path);
    expect(story.frames.map((frame) => frame.kind)).toEqual(scenario.kinds);
    expect(story.source.workload).toHaveLength(5);
    const posts: string[] = [];
    page.on("request", (request) => {
      if (request.method() === "POST") posts.push(request.url());
    });
    await expect(
      page.getByRole("button", { name: "Commit this put" }),
    ).toHaveCount(0);
    for (const [index, frame] of story.frames.entries()) {
      await expectFrame(page, frame, index);
      if (
        (scenario.id === "split" && frame.kind === "committed") ||
        frame.kind === "recovered"
      ) {
        const hexPanel = page.locator("details.inspect-hex");
        if (
          await hexPanel.evaluate(
            (element) => (element as HTMLDetailsElement).open,
          )
        )
          await hexPanel.locator("summary").click();
        await page.evaluate(() => window.scrollTo(0, 0));
        await captureReview(page, testInfo, `${scenario.id}-${frame.kind}`);
      }
      expect(frame.capture.pages).toHaveLength(
        frame.capture.snapshot.page_count + 1,
      );
      const capturedRecords = frame.capture.pages.flatMap(
        (captured) => captured.records,
      );
      expect(capturedRecords).toHaveLength(frame.capture.snapshot.record_count);
      for (const captured of frame.capture.pages) {
        await page
          .getByRole("combobox", { name: "PAGE EXPLORER", exact: true })
          .selectOption(String(captured.page_id));
        await expect(
          page.getByRole("img", {
            name: `Page ${captured.page_id}: ${captured.used_bytes} of 4096 bytes used`,
          }),
        ).toBeVisible();
        await expect(page.locator(".inspect-facts")).toContainText(
          captured.checksum,
        );
        if (captured.page_kind === "leaf") {
          await expect(
            page
              .getByRole("region", { name: "Page records", exact: true })
              .locator(".inspect-record strong"),
          ).toHaveText(captured.records.map((record) => record.key));
        }
        await revealBytes(page);
        await page
          .getByRole("button", { name: /^Committed page · gen/ })
          .click();
        await expectHex(page, captured.bytes);
        const checkpoint = page.getByRole("button", {
          name: /^Checkpoint page ·/,
        });
        if (captured.checkpoint_bytes === null) {
          await expect(checkpoint).toBeDisabled();
        } else {
          await checkpoint.click();
          await expectHex(page, captured.checkpoint_bytes);
        }
      }
    }
    if (scenario.id === "recovery") {
      expect(story.source.failure_model).toBe("process_termination");
      expect(story.process?.process_terminated).toBe(true);
      expect(story.process?.process_id).not.toBe(database.process.pid);
      const committed = story.frames.find(
        (frame) => frame.kind === "committed",
      )!;
      const crashed = story.frames.find((frame) => frame.kind === "crashed")!;
      const recovered = story.frames.find(
        (frame) => frame.kind === "recovered",
      )!;
      expect(crashed.capture).toEqual(committed.capture);
      expect(recovered.capture.pages).toEqual(committed.capture.pages);
      expect(recovered.capture.snapshot.session_id).not.toBe(
        committed.capture.snapshot.session_id,
      );
      expect(recovered.capture.snapshot.recovery.replayed_transactions).toBe(1);
      await expectFrame(page, crashed, 2);
      await expect(
        page.getByRole("region", { name: "Current story step" }),
      ).toContainText("Process stopped · last captured state");
    } else {
      expect(story.source.failure_model).toBe("none");
    }
    const final = story.frames.at(-1)!;
    const main = await readFile(story.source.database_path);
    const wal = await readFile(`${story.source.database_path}.wal`);
    if (scenario.id === "checkpoint") {
      expect(wal.length).toBe(64);
      for (const captured of final.capture.pages) {
        expect(captured.checkpoint_bytes).toEqual(captured.bytes);
        const offset = 64 + captured.page_id * 4096;
        expect(Array.from(main.subarray(offset, offset + 4096))).toEqual(
          captured.bytes,
        );
      }
    } else {
      expect(main.length).toBe(8256);
      const imageCount = wal.readUInt32LE(64 + 12);
      expect(imageCount).toBe(final.capture.pages.length);
      for (let index = 0; index < imageCount; index++) {
        const offset = 64 + 64 + index * 4096;
        const pageId = wal.readUInt32LE(offset + 12);
        const captured = final.capture.pages.find(
          (candidate) => candidate.page_id === pageId,
        )!;
        expect(Array.from(wal.subarray(offset, offset + 4096))).toEqual(
          captured.bytes,
        );
      }
    }
    await page.getByRole("button", { name: "Reset recording" }).click();
    await expect(
      page.getByRole("button", {
        name: `Step 1: ${story.frames[0].title}`,
        exact: true,
      }),
    ).toHaveAttribute("aria-current", "step");
    expect(posts).toEqual([]);
    expect(await snapshot(page, database.url)).toEqual(before);
    await page
      .getByRole("button", { name: "Live database", exact: true })
      .click();
    await expect(page.getByTestId("record-count")).toHaveText("01");
    await expect(
      page.getByRole("button", { name: "Commit this put" }),
    ).toBeEnabled();
    expect(errors).toEqual([]);
  });
}

test("recorded playback keeps keyboard, timing, zoom and byte inspection available offline on mobile", async ({
  page,
  database,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(database.url);
  await expect(
    page.getByRole("button", { name: /^Guided stories/ }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    page.getByRole("region", { name: "Recorded playback" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Commit this put" }),
  ).toHaveCount(0);
  await captureReview(page, testInfo, "orientation-mobile");
  await page.getByRole("button", { name: /^Guided stories/ }).click();
  const story = await runStory(page, "A page splits");
  const playback = page.getByRole("region", { name: "Recorded playback" });
  const first = playback.getByRole("button", {
    name: `Step 1: ${story.frames[0].title}`,
    exact: true,
  });
  await expect(first).toHaveAttribute("aria-current", "step");
  await expect(
    playback.getByRole("button", { name: "Previous step" }),
  ).toBeDisabled();
  const next = playback.getByRole("button", { name: "Next step" });
  await next.focus();
  await page.keyboard.press("Enter");
  await expect(
    playback.getByRole("button", {
      name: `Step 2: ${story.frames[1].title}`,
      exact: true,
    }),
  ).toHaveAttribute("aria-current", "step");
  await playback.getByLabel("Speed").selectOption("2");
  await playback.getByRole("button", { name: "Play recording" }).click();
  await expect(
    playback.getByRole("button", { name: "Pause", exact: true }),
  ).toBeVisible();
  await playback.getByRole("button", { name: "Pause", exact: true }).click();
  await expect(
    playback.getByRole("button", { name: "Play recording" }),
  ).toBeVisible();
  await next.click();
  await expect(
    playback.getByRole("button", {
      name: `Step 3: ${story.frames[2].title}`,
      exact: true,
    }),
  ).toHaveAttribute("aria-current", "step");
  await page
    .getByRole("region", { name: "Interactive B+ tree canvas" })
    .scrollIntoViewIfNeeded();
  await captureReview(page, testInfo, "mobile-committed-split");
  await playback.getByRole("button", { name: "Play recording" }).click();
  const last = story.frames.at(-1)!;
  await expect(
    playback.getByRole("button", {
      name: `Step ${story.frames.length}: ${last.title}`,
      exact: true,
    }),
  ).toHaveAttribute("aria-current", "step", { timeout: 12_000 });
  await expect(next).toBeDisabled();
  await playback.getByRole("button", { name: "Reset recording" }).click();
  await expect(first).toHaveAttribute("aria-current", "step");
  await page.getByRole("button", { name: "Zoom in", exact: true }).click();
  await expect(page.getByLabel("Tree zoom")).toHaveText("125%");
  await page.getByRole("button", { name: "Fit", exact: true }).click();
  await expect(page.getByLabel("Tree zoom")).toHaveText("100%");
  await terminate(database.process);
  await expect(engineStatus(page)).toHaveText("Engine offline", {
    timeout: 12_000,
  });
  await expect(
    page.getByRole("button", { name: "Run story again" }),
  ).toBeDisabled();
  await expect(next).toBeEnabled();
  await expectFrame(page, last, story.frames.length - 1);
  await page
    .getByRole("combobox", { name: "PAGE EXPLORER", exact: true })
    .selectOption("0");
  await revealBytes(page);
  await expectHex(
    page,
    last.capture.pages.find((captured) => captured.page_id === 0)!.bytes,
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  expect(
    await page
      .locator(".canvas-page")
      .first()
      .evaluate((element) => getComputedStyle(element).transitionDuration),
  ).toBe("0s");
  await page
    .getByRole("button", { name: "Live database", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Commit this put" }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Reopen database" }),
  ).toBeEnabled();
  await page.getByRole("button", { name: /^Guided stories/ }).click();
  await expect(playback).toBeVisible();
  await expect(
    playback.getByRole("button", { name: "Reset recording" }),
  ).toBeEnabled();
});

test("command panel distinguishes empty values, validates range bounds, and clears results after commits", async ({
  page,
  database,
}) => {
  await page.goto(`${database.url}/?mode=live`);
  await page.getByRole("textbox", { name: "Key", exact: true }).fill("empty");
  await page.getByRole("textbox", { name: "Value", exact: true }).fill("");
  await page.getByRole("button", { name: "Commit this put" }).click();
  await expect(page.getByTestId("generation")).toHaveText("01");
  await page.getByRole("button", { name: "GET Read" }).click();
  await page.getByRole("button", { name: "Find this key" }).click();
  await expect(page.getByLabel("Read value")).toHaveText("(empty string)");
  await page.getByRole("button", { name: "SCAN Range" }).click();
  await page.getByLabel("Start key").fill("z");
  await page.getByLabel("End key").fill("a");
  await expect(
    page.getByRole("button", { name: "Scan this range" }),
  ).toBeDisabled();
  await expect(
    page.getByText("End key must follow or equal the start key."),
  ).toBeVisible();
  await page.getByLabel("Start key").fill("");
  await page.getByLabel("End key").fill("");
  await page.getByRole("button", { name: "Scan this range" }).click();
  const results = page.getByRole("region", { name: "Range results" });
  await expect(results.locator("li")).toHaveCount(1);
  await page.getByRole("button", { name: "Insert 64 sample records" }).click();
  await expect(page.getByTestId("record-count")).toHaveText("65");
  await expect(results).toHaveCount(0);
  const invalidStory = await page.request.post(`${database.url}/api/story`, {
    headers: commandHeaders,
    data: { scenario: "invented" },
  });
  expect(invalidStory.status()).toBe(400);
  expect((await snapshot(page, database.url)).record_count).toBe(65);
});

test("a failed story capture leaves the previous recording usable", async ({
  page,
  database,
}) => {
  await page.goto(database.url);
  await page.getByRole("button", { name: /^Guided stories/ }).click();
  const story = await runStory(page, "A page splits");
  const before = await snapshot(page, database.url);
  await expectFrame(page, story.frames[2], 2);
  let releaseCapture!: () => void;
  const capturePending = new Promise<void>((resolve) => {
    releaseCapture = resolve;
  });
  await page.route("**/api/story?*", async (route) => {
    await capturePending;
    return route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({
        error: {
          code: "story_failed",
          message: "The disposable capture could not complete.",
        },
      }),
    });
  });
  await page.getByRole("button", { name: "Run story again" }).click();
  try {
    await expect(
      page.getByRole("button", { name: "Capturing engine run…" }),
    ).toBeDisabled();
    await expect(
      page.getByRole("button", { name: "Play recording" }),
    ).toBeDisabled();
    await expect(
      page.getByRole("button", { name: "Live database", exact: true }),
    ).toBeDisabled();
    await expect(
      page.getByRole("combobox", { name: "Speed", exact: true }),
    ).toBeDisabled();
  } finally {
    releaseCapture();
  }
  await expect(page.getByRole("alert")).toContainText(
    "The disposable capture could not complete.",
  );
  await expect(page.getByRole("alert")).toContainText(
    "Your previous recording is still available.",
  );
  await expectFrame(page, story.frames[0], 0);
  await page.getByRole("button", { name: "Next step" }).click();
  await expect(page.getByTestId("staged-count")).toHaveText("2");
  expect(await snapshot(page, database.url)).toEqual(before);
  await page.unroute("**/api/story?*");
  await page.getByRole("button", { name: "Run story again" }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByTestId("staged-count")).toHaveText("0");
});

test("malformed live snapshots preserve the last verified page and allow reconnection", async ({
  page,
  database,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${database.url}/?mode=live`);
  await page.getByRole("button", { name: "Commit this put" }).click();
  await expect(page.getByTestId("generation")).toHaveText("01");
  const verified = await snapshot(page, database.url);
  await revealBytes(page);
  for (const corruption of [
    {
      mutate: (state: Snapshot) => {
        state.schema_version = 99;
      },
      error: "unsupported snapshot, storage, or page version",
    },
    {
      mutate: (state: Snapshot) => {
        state.bytes.pop();
      },
      error: "page bytes must contain exactly 4,096 bytes",
    },
  ]) {
    await page.route("**/api/snapshot?*", async (route) => {
      const response = await route.fetch();
      expect(response.ok()).toBe(true);
      const state: Snapshot = await response.json();
      expect(state.schema_version).toBe(3);
      expect(state.bytes).toHaveLength(4096);
      corruption.mutate(state);
      await route.fulfill({ response, json: state });
    });
    await expect(engineStatus(page)).toHaveText("Engine offline");
    await expect(page.getByRole("alert")).toContainText(corruption.error);
    await expect(page.getByRole("alert")).toContainText(
      "last verified snapshot",
    );
    await expect(page.getByTestId("generation")).toHaveText("01");
    await expect(page.getByTestId("record-count")).toHaveText("01");
    await expectHex(page, verified.bytes);
    await expect(
      page.getByRole("button", { name: "Commit this put" }),
    ).toBeDisabled();
    await page.unroute("**/api/snapshot?*");
    await page.getByRole("button", { name: "Reconnect", exact: true }).click();
    await expect(engineStatus(page)).toHaveText("Engine connected");
    await expect(page.getByRole("alert")).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Commit this put" }),
    ).toBeEnabled();
  }
  expect(await snapshot(page, database.url)).toEqual(verified);
  expect(errors).toEqual([]);
});

test("malformed recordings are rejected while the previous verified story remains inspectable", async ({
  page,
  database,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(database.url);
  await page.getByRole("button", { name: /^Guided stories/ }).click();
  const verified = await runStory(page, "A page splits");
  const primary = await snapshot(page, database.url);
  await expectFrame(page, verified.frames[2], 2);
  for (const corruption of [
    {
      mutate: (story: RecordedStory) => {
        story.schema_version = 99;
      },
      error: "unsupported story version",
    },
    {
      mutate: (story: RecordedStory) => {
        story.source.page_format_version = 99;
      },
      error: "unsupported recorded storage format",
    },
    {
      mutate: (story: RecordedStory) => {
        story.frames[2].capture.pages[1].bytes.pop();
      },
      error: "page bytes must contain exactly 4,096 bytes",
    },
  ]) {
    await page.route("**/api/story?*", async (route) => {
      const response = await route.fetch();
      expect(response.ok()).toBe(true);
      const body = await response.json();
      expect(body.story.schema_version).toBe(1);
      expect(body.story.frames[2].capture.pages[1].bytes).toHaveLength(4096);
      corruption.mutate(body.story);
      await route.fulfill({ response, json: body });
    });
    await page.getByRole("button", { name: "Run story again" }).click();
    await expect(page.getByRole("alert")).toContainText(corruption.error);
    await expect(page.getByRole("alert")).toContainText(
      "Your previous recording is still available.",
    );
    await expect(page.locator(".story-source")).toContainText(verified.run_id);
    await expectFrame(page, verified.frames[2], 2);
    await page
      .getByRole("combobox", { name: "PAGE EXPLORER", exact: true })
      .selectOption("1");
    await revealBytes(page);
    await page.getByRole("button", { name: /^Committed page · gen/ }).click();
    await expectHex(page, verified.frames[2].capture.pages[1].bytes);
    await page.getByRole("button", { name: "Next step" }).click();
    await expect(
      page.getByRole("button", {
        name: `Step 4: ${verified.frames[3].title}`,
        exact: true,
      }),
    ).toHaveAttribute("aria-current", "step");
    await page.unroute("**/api/story?*");
  }
  const retried = await runStory(page, "A page splits");
  expect(retried.run_id).not.toBe(verified.run_id);
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.locator(".story-source")).toContainText(retried.run_id);
  expect(await snapshot(page, database.url)).toEqual(primary);
  expect(errors).toEqual([]);
});
