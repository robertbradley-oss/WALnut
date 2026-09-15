import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { root, binary, environment } from "./toolchain.mjs";
const env = environment();
const build = spawn("cargo", ["build", "--bin", "walnut", "--locked"], {
  cwd: root,
  env,
  stdio: "inherit",
  windowsHide: true,
});
build.on("error", (error) => {
  console.error(error.message);
  process.exit(1);
});
const code = await new Promise((resolve) => build.on("exit", resolve));
if (code !== 0) process.exit(code ?? 1);
mkdirSync(resolve(root, "data"), { recursive: true });
const db = process.env.WALNUT_DB || resolve(root, "data/walnut-v3.db");
const children = [];
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill();
  process.exitCode = code;
}
function launch(command, args) {
  const child = spawn(command, args, {
    cwd: root,
    env,
    stdio: "inherit",
    windowsHide: true,
  });
  children.push(child);
  child.on("error", (error) => {
    console.error(error.message);
    stop(1);
  });
  child.on("exit", (code) => {
    if (!stopping) stop(code ?? 1);
  });
}
launch(binary, ["serve", db, "--ui", resolve(root, "dist")]);
if (!process.argv.includes("--built"))
  launch(process.execPath, [resolve(root, "node_modules/vite/bin/vite.js")]);
process.on("SIGINT", () => stop());
process.on("SIGTERM", () => stop());
