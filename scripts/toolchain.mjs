import { existsSync } from "node:fs";
import { resolve, dirname, delimiter } from "node:path";
import { fileURLToPath } from "node:url";
export const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export function environment() {
  const env = { ...process.env };
  const cargo = resolve(root, ".tools/cargo");
  if (existsSync(resolve(cargo, "bin/cargo.exe"))) {
    env.CARGO_HOME = cargo;
    env.RUSTUP_HOME = resolve(root, ".tools/rustup");
    const compiler = resolve(
      root,
      ".tools/llvm-mingw-20260908-ucrt-x86_64/bin",
    );
    env.PATH = [resolve(cargo, "bin"), compiler, env.PATH].join(delimiter);
    env.RUSTUP_TOOLCHAIN = "1.98.1-x86_64-pc-windows-gnullvm";
    env.CARGO_TARGET_X86_64_PC_WINDOWS_GNULLVM_LINKER = resolve(
      compiler,
      "x86_64-w64-mingw32-clang.exe",
    );
  }
  return env;
}
export const binary = resolve(
  root,
  `target/debug/walnut${process.platform === "win32" ? ".exe" : ""}`,
);
