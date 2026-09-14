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
  await page.getByRole("button", { name: "Write to page" }).click();
  await expect(page.getByTestId("generation")).toHaveText("01");
  const before = await (
    await page.request.get(`${database.url}/api/snapshot`)
  ).json();
  await expect(page.locator(".key-byte").first()).toHaveText("68");
  await page.getByRole("button", { name: "Reopen database" }).click();
  await expect(
    page.getByText("File reopened. Page format and checksum verified."),
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
  const actual = await readFile(database.path);
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
  await page.getByRole("button", { name: "Write to page" }).click();
  await expect(page.getByTestId("generation")).toHaveText("01");
  await page
    .getByRole("textbox", { name: "Value", exact: true })
    .fill("updated");
  await page.getByRole("button", { name: "Write to page" }).click();
  await expect(page.getByTestId("generation")).toHaveText("02");
  await expect(page.getByTestId("record-count")).toHaveText("01");
  await page.getByRole("button", { name: "GET Read" }).click();
  await page.getByRole("textbox", { name: "Key", exact: true }).fill("missing");
  await page.getByRole("button", { name: "Find this key" }).click();
  await expect(page.getByText("“missing” is not in this page.")).toBeVisible();
  await expect(page.getByLabel("Read value")).toHaveCount(0);
});

test("byte bounds and page-full errors do not change stored data", async ({
  page,
  database,
}) => {
  await page.goto(database.url);
  await page
    .getByRole("textbox", { name: "Key", exact: true })
    .fill("é".repeat(33));
  await expect(
    page.getByRole("button", { name: "Write to page" }),
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
  await page.getByRole("button", { name: "Write to page" }).click();
  await expect(page.getByRole("alert")).toContainText("This 4 KB page is full");
  const snapshot = await (
    await page.request.get(`${database.url}/api/snapshot`)
  ).json();
  expect(snapshot.generation).toBe(3);
  expect(snapshot.records).toHaveLength(3);
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
  await page.getByRole("button", { name: "Write to page" }).click();
  await expect(page.getByTestId("record-count")).toHaveText("01");
  database.process.kill();
  await expect(page.getByRole("status")).toHaveText("Engine offline", {
    timeout: 12_000,
  });
  await expect(page.getByRole("alert")).toContainText("last verified snapshot");
  await expect(
    page.getByRole("button", { name: "Write to page" }),
  ).toBeDisabled();
  await expect(page.getByTestId("record-count")).toHaveText("01");
});
