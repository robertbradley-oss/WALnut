import { spawn, execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import os from "node:os";
import { environment, root } from "./toolchain.mjs";

const env = environment();
const revision = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: root,
  encoding: "utf8",
}).trim();
const dirty =
  execFileSync("git", ["status", "--porcelain"], {
    cwd: root,
    encoding: "utf8",
  }).trim().length > 0;
const args = process.argv.slice(2);
if (args.length > 1 || (args[0] && !/^[a-zA-Z0-9_-]+$/.test(args[0]))) {
  throw new Error("Use: npm run benchmark -- [label]");
}
await mkdir(resolve(root, "work"), { recursive: true });
const label = args[0] ?? new Date().toISOString().replaceAll(/[:.]/g, "-");
const directory = resolve(root, `work/benchmark-${label}`);
const binary = resolve(
  root,
  `target/release/walnut${process.platform === "win32" ? ".exe" : ""}`,
);
const child = spawn(binary, ["benchmark", directory], {
  cwd: root,
  env,
  windowsHide: true,
  stdio: ["ignore", "pipe", "inherit"],
});
let stdout = "";
child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  stdout += chunk;
});
await new Promise((done, reject) => {
  child.on("error", reject);
  child.on("exit", (code) =>
    code === 0 ? done() : reject(new Error(`Benchmark exited ${code}`)),
  );
});
const result = JSON.parse(stdout);
const report = {
  recorded_at: new Date().toISOString(),
  revision,
  dirty,
  source_sha256: Object.fromEntries(
    await Promise.all(
      [
        "crates/walnut-core/src/engine.rs",
        "crates/walnut-cli/src/benchmark.rs",
      ].map(async (path) => [
        path,
        createHash("sha256")
          .update(await readFile(resolve(root, path)))
          .digest("hex"),
      ]),
    ),
  ),
  environment: {
    platform: process.platform,
    release: os.release(),
    version: os.version(),
    arch: os.arch(),
    cpu: os.cpus()[0]?.model,
    logical_cpus: os.cpus().length,
    memory_bytes: os.totalmem(),
    node: process.version,
    rust: execFileSync("rustc", ["-Vv"], { env, encoding: "utf8" }).trim(),
    build: "cargo build --release --locked; thin LTO; default target CPU",
    storage_note:
      process.env.WALNUT_BENCH_STORAGE ??
      "Not supplied; record drive and filesystem before sharing comparisons.",
  },
  ...result,
};
const output = resolve(directory, "report.json");
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
console.log(`Verified all workloads. Report: ${output}`);
