import { test as base, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { resolve } from "node:path";

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

test("writes real bytes, reads a value, and preserves it across file reopen", async ({
  page,
  database,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(database.url);
  await expect(page.getByRole("status")).toHaveText("Engine connected");
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
  await page.goto(database.url);
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
  await page.goto(database.url);
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
  await page.goto(database.url);
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
  await page.goto(database.url);
  await page.getByRole("button", { name: "Commit this put" }).click();
  await expect(page.getByTestId("record-count")).toHaveText("01");
  database.process.kill();
  await expect(page.getByRole("status")).toHaveText("Engine offline", {
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
  await page.goto(database.url);
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
  await page.goto(database.url);
  await page.getByRole("button", { name: "Stage in batch" }).click();
  await expect(page.getByTestId("staged-count")).toHaveText("1");
  await page.getByRole("button", { name: "Checkpoint", exact: true }).click();
  await expect(
    page.getByText(
      "Checkpoint complete. Main pages synced; WAL reset and synced.",
    ),
  ).toBeVisible();
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
  await page.goto(database.url);
  await page.getByRole("button", { name: "Commit this put" }).click();
  await expect(page.getByTestId("generation")).toHaveText("01");
  const before = await (
    await page.request.get(`${database.url}/api/snapshot`)
  ).json();
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
    await expect(page.getByRole("status")).toHaveText("Engine connected");
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
  await page.goto(database.url);
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
    .getByLabel("PAGE EXPLORER", { exact: true })
    .selectOption(String(state.root_page_id));
  await expect(
    page.getByRole("region", { name: "Internal page routing" }),
  ).toBeVisible();
  await expect(
    page.getByRole("img", { name: new RegExp(`Page ${state.root_page_id}:`) }),
  ).toBeVisible();
  await page.getByLabel("PAGE EXPLORER", { exact: true }).selectOption("0");
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
  await expect(page.getByLabel("PAGE EXPLORER", { exact: true })).toHaveValue(
    String(target.page_id),
  );
  const read = await (
    await page.request.get(`${database.url}/api/snapshot`)
  ).json();
  expect(read.last_search_path).toHaveLength(3);
  await expect(page.getByTestId("search-path").getByRole("button")).toHaveText(
    read.last_search_path.map((id: number) => `P${id}`),
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
  expect(await results.locator("li button").allTextContents()).toEqual(
    all.records
      .slice(0, 17)
      .map(
        (r: { key: string; page_id: number }) => `${r.key} · P${r.page_id} ↗`,
      ),
  );
  await results.getByRole("button", { name: "Next 17 records" }).click();
  await expect(page.getByLabel("Start key")).toHaveValue(all.records[17].key);
  await expect(results.locator("li button").first()).toContainText(
    all.records[17].key,
  );
  await results.locator("li button").first().click();
  await expect(page.getByLabel("PAGE EXPLORER", { exact: true })).toHaveValue(
    String(all.records[17].page_id),
  );
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
    .getByLabel("PAGE EXPLORER", { exact: true })
    .selectOption(String(state.root_page_id));
  const branch = page.locator(".tree-children .tree-node").first();
  await branch.focus();
  await branch.press("Enter");
  await expect(page.locator(".tree-breadcrumbs button")).toHaveCount(2);
  await page.getByRole("button", { name: "Next child pages" }).click();
  await expect(page.locator(".tree-paging")).toContainText("Children 4–6");
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
