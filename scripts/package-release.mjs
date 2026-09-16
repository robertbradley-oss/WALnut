import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { root } from "./toolchain.mjs";

const git = (...args) =>
  execFileSync("git", args, {
    cwd: root,
    windowsHide: true,
    maxBuffer: 128 * 1024 * 1024,
  });
const revision = git("rev-parse", "HEAD").toString().trim();
if (git("status", "--porcelain").toString().trim())
  throw new Error(
    "Commit or discard working tree changes before packaging a release.",
  );
const version = JSON.parse(
  readFileSync(resolve(root, "package.json"), "utf8"),
).version;
const demo = JSON.parse(
  readFileSync(resolve(root, "dist-demo/manifest.json"), "utf8"),
);
if (
  demo.source.revision !== revision ||
  demo.source.dirty ||
  demo.source.version !== version
)
  throw new Error(
    "Rebuild the demo from the current clean revision before packaging.",
  );
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
for (const [name, entry] of Object.entries(demo.files)) {
  const bytes = readFileSync(resolve(root, "dist-demo", name));
  if (hash(bytes) !== entry.sha256 || bytes.length !== entry.bytes)
    throw new Error(`Export no longer matches its manifest: ${name}`);
}
const base = `walnut-${version}`;
const directory = resolve(root, "release", `${base}-${revision.slice(0, 8)}`);
mkdirSync(directory, { recursive: true });
const artifacts = {
  [`${base}-demo.html`]: readFileSync(resolve(root, "dist-demo/index.html")),
  [`${base}-demo.webm`]: readFileSync(
    resolve(root, "dist-demo/walnut-demo.webm"),
  ),
  [`${base}-recordings.json`]: readFileSync(
    resolve(root, "dist-demo/recordings.json"),
  ),
  [`${base}-source.zip`]: git(
    "archive",
    "--format=zip",
    `--prefix=${base}/`,
    "HEAD",
  ),
  LICENSE: readFileSync(resolve(root, "LICENSE")),
  "THIRD-PARTY-NOTICES.txt": readFileSync(
    resolve(root, "dist-demo/THIRD-PARTY-NOTICES.txt"),
  ),
};
const files = {};
for (const [name, bytes] of Object.entries(artifacts)) {
  writeFileSync(resolve(directory, name), bytes);
  files[name] = { bytes: bytes.length, sha256: hash(bytes) };
}
const release = {
  schema_version: 1,
  version,
  revision,
  prepared_at: new Date().toISOString(),
  distribution:
    "Portable recorded demo and source. Build the native engine using the documented toolchains.",
  demo_source: demo.source,
  files,
};
writeFileSync(
  resolve(directory, "release.json"),
  `${JSON.stringify(release, null, 2)}\n`,
);
const checksums = {
  ...files,
  "release.json": {
    sha256: hash(readFileSync(resolve(directory, "release.json"))),
  },
};
writeFileSync(
  resolve(directory, "SHA256SUMS.txt"),
  Object.entries(checksums)
    .map(([name, item]) => `${item.sha256}  ${name}`)
    .join("\n") + "\n",
);
console.log(`Prepared ${directory}. No upload or publication was performed.`);
