# Phase 6 — Portfolio finish

## Delivered

- A self-contained HTML replay of three real release-engine runs. It carries source/build identity, complete captured pages and bytes, process receipts, and embedded runtime/font notices.
- A product-first README, 30-second recording, walkthrough, source map, and [checkpoint/log-reuse case study](case-study.md).
- Six replay tests covering offline use, every frame's metrics and page-byte windows, a nested static URL, keyboard controls, responsive layouts, and malformed recordings.
- A tablet layout repair: long values in the two-column page inspector no longer force horizontal document overflow.
- MIT project licensing, pinned dependencies, and versioned source/demo packaging with integrity manifests. The Windows/Linux CI definition includes replay verification and candidate artifacts.

The engine's commit, checkpoint, page, and WAL formats are unchanged in this phase.

## Verification record

Collected 2026-09-15 (local date) from fresh source clones and fresh dependency/target directories. [Machine-readable results](measurements/phase6-verification.json), [Windows command logs](measurements/phase6-windows.log.gz), and [Linux command logs](measurements/phase6-linux.log.gz) retain the evidence.

| Check                                           | Windows   | Linux     |
| ----------------------------------------------- | --------- | --------- |
| Locked dependency install                       | Passed    | Passed    |
| Formatting, TypeScript, Rust fmt, strict Clippy | Passed    | Passed    |
| Rust tests                                      | 61 passed | 61 passed |
| Live browser/API tests                          | 23 passed | 23 passed |
| Portable replay tests                           | 6 passed  | 6 passed  |
| Clean-source release packaging                  | Passed    | Passed    |

Windows used Windows 11 Home build 26200, NTFS, and the preinstalled Rust 1.98.1 GNULLVM toolchain outside the fresh checkout. Linux used a newly installed Ubuntu 24.04.5 WSL2 environment, an ext4 checkout, Rust 1.98.1 GNU, and a newly installed browser/toolchain. Both used Node 24.19.0, Playwright 1.63.0, and Chromium 153.0.8010.12. This establishes those environments; it is not a clean-machine MSVC test or a hosted GitHub Actions result.

The initial source was `6060fb1`. Linux's first browser pass found a keyboard-test readiness race: Enter arrived about 11 ms before the initial snapshot response, while commit was disabled. The trace contained no write request. Revision `d7666bc` waits for the commit control to be enabled before pressing Enter. All 23 Linux live tests then passed; the changed test also passed on Windows. That revision changes the test and documentation, with engine/UI code identical to the initial full Windows pass. Subsequent release-evidence edits are documentation only.

The six new replay tests pass in Chromium. They compare the first 256 bytes of each page at every recorded frame against its captured committed image and checkpoint image where present. Existing engine tests establish the captures' source behavior; the UI tests establish fidelity to those captures. They are not physical power-loss tests.

Visual inspection covers a 1440 × 1080 desktop, a 390 px mobile tree view, the 900 px tablet layout, and the recorded split/recovery/checkpoint/byte-inspection frames. Automated resize coverage also includes 1100 px. The responsive test reproduced the long-value overflow at 900 px before the grid fix and passes after it. Video review also caught missing base styling on the portable byte-source controls; the shared recovery styles are now included.

The recording is 30.00 seconds, 1440 × 1080 at 25 fps. The portable HTML is about 1.7 MiB before compression. Local documentation links were checked; tracked source excludes databases, WALs, dependency/toolchain directories, and test/build artifacts. The existing format-1 and format-2 demonstration files retain their prior SHA256 values.

## Visitor walkthrough

The earlier owner walkthrough exposed insufficient context. The standalone replay now opens with the project's purpose, shows a real baseline immediately, and offers three named experiments with one shared timeline. Technical terms remain in place.

A follow-up walkthrough has been requested against the local portable preview. Its outcome is **pending**. The project does not yet claim the gameplan's observed-comprehension criterion is satisfied.

## Release state

Versioned artifacts are prepared locally by `npm run release:prepare` after clean-source verification. The packager checks that the export is clean, matches the current Git revision/version, and retains its recorded lengths and hashes. No remote repository, upload, release tag, or hosted deployment is implied by this report. [Release procedure](release.md).

Phase 6's implementation and local platform checks are complete. The gameplan's final visitor-comprehension criterion remains open until the requested walkthrough feedback arrives.
