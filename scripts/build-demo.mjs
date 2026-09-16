import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { root, environment } from "./toolchain.mjs";

const env = environment();
const run = (command, args, options = {}) =>
  execFileSync(command, args, {
    cwd: root,
    env,
    windowsHide: true,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    ...options,
  });
run(process.execPath, ["scripts/cargo.mjs", "build", "--release", "--locked"], {
  stdio: "inherit",
});
run(
  process.execPath,
  ["node_modules/vite/bin/vite.js", "build", "--mode", "replay"],
  { stdio: "inherit" },
);

const executable = resolve(
  root,
  `target/release/walnut${process.platform === "win32" ? ".exe" : ""}`,
);
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
mkdirSync(resolve(root, "work"), { recursive: true });
const scratch = mkdtempSync(resolve(root, "work/replay-export-"));
const stories = ["split", "recovery", "checkpoint"].map((scenario) => {
  const story = JSON.parse(run(executable, ["story", scratch, scenario]));
  // Paths are the only changed source fields. Captured pages, events and worker
  // receipts are retained exactly; no machine-specific path is distributed.
  story.source.database_path = `recordings/${scenario}/story.db`;
  return story;
});
const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
if (stories.some((story) => story.source.engine_version !== pkg.version))
  throw new Error("Engine and package versions disagree.");
const thirdParties = [
  "react",
  "react-dom",
  "scheduler",
  "@fontsource-variable/manrope",
  "@fontsource-variable/jetbrains-mono",
];
const notices = [
  readFileSync(resolve(root, "LICENSE"), "utf8"),
  ...thirdParties.map((name) => {
    const base = resolve(root, "node_modules", name);
    const version = JSON.parse(
      readFileSync(resolve(base, "package.json"), "utf8"),
    ).version;
    return `\n--- ${name} ${version} ---\n\n${readFileSync(resolve(base, "LICENSE"), "utf8")}`;
  }),
].join("\n");
const bundle = {
  schema_version: 1,
  source: {
    version: pkg.version,
    revision: run("git", ["rev-parse", "HEAD"]).trim(),
    dirty:
      run("git", ["status", "--porcelain", "--untracked-files=normal"]).trim()
        .length > 0,
    captured_at: new Date().toISOString(),
    platform: `${process.platform}/${process.arch}`,
    executable_sha256: digest(readFileSync(executable)),
    path_redaction:
      "Original local database paths are replaced with recording-relative labels. Pages, bytes, events, and process receipts are unchanged.",
  },
  stories,
  notices,
};
const css = readFileSync(resolve(root, "work/replay-build/replay.css"), "utf8");
const script = readFileSync(
  resolve(root, "work/replay-build/replay.js"),
  "utf8",
).replace(/<\/script/gi, "<\\/script");
const embedded = JSON.stringify(bundle).replace(/</g, "\\u003c");
const icon = `data:image/svg+xml,${encodeURIComponent(readFileSync(resolve(root, "public/brand/walnut-app-icon.svg"), "utf8"))}`;
const html = `<!doctype html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="theme-color" content="#121411"><meta name="description" content="Follow a write through a real Rust database. Three self-contained recordings of B+ tree splits, crash recovery, and checkpoints.">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'">
<link rel="icon" href="${icon}"><title>WALnut — A database, from the inside</title><style>${css}</style></head>
<body><div id="root"></div><noscript>This recording needs JavaScript to display its captured pages. No server or network connection is required.</noscript>
<script id="walnut-recordings" type="application/json">${embedded}</script><script>${script}</script></body></html>
`;
const destination = resolve(root, "dist-demo");
mkdirSync(destination, { recursive: true });
writeFileSync(resolve(destination, "index.html"), html);
writeFileSync(
  resolve(destination, "recordings.json"),
  `${JSON.stringify(bundle, null, 2)}\n`,
);
writeFileSync(resolve(destination, "THIRD-PARTY-NOTICES.txt"), notices);
writeFileSync(
  resolve(destination, "LICENSE"),
  readFileSync(resolve(root, "LICENSE")),
);
const manifest = { schema_version: 1, source: bundle.source, files: {} };
for (const name of [
  "index.html",
  "recordings.json",
  "THIRD-PARTY-NOTICES.txt",
  "LICENSE",
]) {
  const bytes = readFileSync(resolve(destination, name));
  manifest.files[name] = { bytes: bytes.length, sha256: digest(bytes) };
}
writeFileSync(
  resolve(destination, "manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
);
console.log(
  `Exported ${stories.length} real recordings to ${resolve(destination, "index.html")} (${(Buffer.byteLength(html) / 1024 / 1024).toFixed(2)} MiB).`,
);
console.log(
  `Source: ${bundle.source.revision}${bundle.source.dirty ? " (working tree changes)" : " (clean)"}. Raw local captures: ${scratch}`,
);
