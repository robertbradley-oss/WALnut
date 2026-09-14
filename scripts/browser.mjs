import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { root, environment } from "./toolchain.mjs";
const env = {
  ...environment(),
  PLAYWRIGHT_BROWSERS_PATH:
    process.env.PLAYWRIGHT_BROWSERS_PATH || resolve(root, ".tools/browsers"),
};
const child = spawn(
  process.execPath,
  [resolve(root, "node_modules/playwright/cli.js"), ...process.argv.slice(2)],
  { cwd: root, env, stdio: "inherit", windowsHide: true },
);
child.on("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
