# Phase 6 — Portfolio finish

## Delivered

- A self-contained HTML replay of three real release-engine runs. It carries source/build identity, complete captured pages and bytes, process receipts, and embedded runtime/font notices.
- A product-first README, 30-second recording, walkthrough, source map, and [checkpoint/log-reuse case study](case-study.md).
- Six replay tests covering offline use, every frame's metrics and page-byte windows, a nested static URL, keyboard controls, responsive layouts, and malformed recordings.
- A tablet layout repair: long values in the two-column page inspector no longer force horizontal document overflow.
- MIT project licensing, pinned dependencies, and versioned source/demo packaging with integrity manifests. The Windows/Linux CI definition includes replay verification and candidate artifacts.

The engine's commit, checkpoint, page, and WAL formats are unchanged in this phase.

## Verification record

Implementation and replay checks are complete in the development checkout. Clean-checkout Windows and Ubuntu verification and final artifact inspection are being recorded for this candidate.

The six new replay tests pass in Chromium. They compare the first 256 bytes of each page at every recorded frame against its captured committed image and checkpoint image where present. Existing engine tests establish the captures' source behavior; the UI tests establish fidelity to those captures. They are not physical power-loss tests.

Visual inspection covers desktop, a narrow mobile view, and tablet sizing. The responsive test reproduced the long-value overflow at 900 px before the grid fix and passes after it.

## Visitor walkthrough

The earlier owner walkthrough exposed insufficient context. The standalone replay now opens with the project's purpose, shows a real baseline immediately, and offers three named experiments with one shared timeline. Technical terms remain in place.

A follow-up walkthrough has been requested against the local portable preview. Its outcome is **pending**. The project does not yet claim the gameplan's observed-comprehension criterion is satisfied.

## Release state

Versioned artifacts are prepared locally by `npm run release:prepare` after clean-source verification. No remote repository, upload, release tag, or hosted deployment is implied by this report. [Release procedure](release.md).
