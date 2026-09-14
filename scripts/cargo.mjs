import { spawn } from "node:child_process";
import { root, environment } from "./toolchain.mjs";
const child = spawn("cargo", process.argv.slice(2), {
  cwd: root,
  env: environment(),
  stdio: "inherit",
  windowsHide: true,
});
child.on("error", (error) => {
  console.error(
    `Cargo could not start: ${error.message}. Install Rust 1.98.1; see README.md.`,
  );
  process.exitCode = 1;
});
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
