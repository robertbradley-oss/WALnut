# Release preparation

WALnut prepares a versioned **portable demo and source distribution** locally. Publishing, GitHub repository creation, hosting, and release tags are separate actions.

## Verify and package

Use the pinned Node/Rust toolchains from the README. On Linux, install Chromium's system dependencies with `node scripts/browser.mjs install --with-deps chromium`.

```sh
npm ci
npm run browser:install
npm run check
npm run test:core
npm run test:e2e
npm run test:replay
npm run release:prepare
```

Packaging requires a clean Git checkout and a demo generated from that exact revision. If changes were committed after export, run `npm run build:demo` again. The packager verifies export sizes and hashes before writing `release/walnut-<version>-<revision>/`:

- `walnut-<version>-demo.html`: directly openable, complete recorded viewer.
- `walnut-<version>-recordings.json`: readable evidence behind the viewer.
- `walnut-<version>-source.zip`: tracked source and documentation from the recorded revision.
- `LICENSE` and `THIRD-PARTY-NOTICES.txt`: project and embedded runtime/font notices.
- `release.json` and `SHA256SUMS.txt`: source identity, file sizes, and integrity hashes.

The source distribution builds the native engine locally. This release does not ship precompiled executables or require recipients to install the development checkout's optional Windows LLVM toolchain. Source ZIP users can run the engine and inspector; rebuilding provenance-stamped exports and release archives requires a Git checkout.

## Verification boundaries

See [current release verification](release-candidate.md) for current checks and walkthrough status, and [Phase 6 evidence](stage-6.md) for the earlier clean Windows/Linux checkouts. GitHub Actions defines Windows/Linux jobs with the same engine, live-browser, and replay checks, plus downloadable candidate artifacts. A workflow definition is not evidence that hosted CI ran.

Browser compatibility is claimed only for the recorded Chromium checks. OS builds, process-termination tests, modeled storage failures, and physical power-loss survival are separate claims. The supported recovery model is in [tree-contract.md](tree-contract.md).

## Repository hygiene

MIT covers WALnut's own code. React, React DOM, Scheduler, and the bundled font packages retain their upstream notices in the portable artifact. Rust dependencies keep their declared licenses in Cargo metadata and their upstream packages; the source archive contains lockfiles rather than vendored third-party code.

Development databases, toolchains, dependency installations, raw local crash captures, build output, and release output are ignored by Git. The public media uses synthetic data. Exported recordings replace absolute database paths and record that change in their provenance.

The two-minute visitor walkthrough remains an observed finish-line check: use the split and recovery stories, explain the committed changes and recovery result, then inspect a page independently. Automated checks establish state fidelity and interaction behavior; the walkthrough establishes whether someone understands the result.

## Browser demo publication

The intended repository is `robertbradley-oss/WALnut`. Its CI uploads the Linux
`dist-demo/` artifact and deploys it to GitHub Pages only after both platform jobs
pass, on `main` pushes or a manual run. Pull requests and forks do not deploy.
Enable GitHub Actions as the repository's Pages source before the first deployment.
The workflow follows [GitHub's custom Pages workflow guidance](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages).

The hosted artifact is the recorded viewer; it has no live engine or write API.
The README's browser-demo and v0.1.0 download links target that repository and
become available when publication completes. Local release preparation does not
create a remote repository, enable Pages, or publish a GitHub release.
