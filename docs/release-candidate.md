# WALnut v0.1.0 — release verification

## What's in this release

A Rust key/value engine with a page-based B+ tree, atomic batches, redo WAL,
checkpointing, and recovery. The database lab connects operations, tree pages,
retained log entries, record spans, and verified bytes. Three portable recordings
show a split, an acknowledged commit surviving process termination, and a
checkpoint.

The final presentation pass includes the off-white walnut identity, the refreshed
30-second recording and screenshots, a README entry point for recorded exploration,
and a GitHub Pages deployment that waits for both Windows and Linux verification.
Storage formats and guarantees are unchanged.

## Current Windows verification

Run on September 15, 2026 with the pinned Node 24.19.0 and Rust 1.98.1 toolchains,
using Chromium through Playwright 1.63.0.

| Check                                           | Result                          |
| ----------------------------------------------- | ------------------------------- |
| Formatting, TypeScript, Rust fmt, strict Clippy | Passed                          |
| Rust tests                                      | 61 passed                       |
| Live browser/API tests                          | 24 passed                       |
| Portable replay tests                           | 7 passed                        |
| Production UI and portable replay builds        | Passed                          |
| Updated demo recording                          | 30 seconds, 1440 × 1080, 25 fps |

Tests and media captures use disposable databases. The everyday live database is
not part of the release. Logo/layout review covered 1440 px desktop and 375 px
mobile; replay tests additionally cover offline use and a nested static URL.

The same checks passed from a fresh clone of `ed13ef3`, with a new dependency
installation and build target. Clean-source release packaging also passed.
The clone reused the installed GNULLVM compiler and Chromium; this is not a
clean-machine MSVC check. [Machine-readable results](measurements/release-windows.json)
and [compressed command logs](measurements/release-windows.log.gz) retain the evidence.
The release evidence added afterward changes documentation only. A subsequent
presentation fix includes the existing walkthrough video in the export and release
so the README opens a playable hosted video; it does not change the engine or UI.

This table reports local Windows results. Hosted Windows/Linux results are
available in the [verification workflow runs](https://github.com/robertbradley-oss/WALnut/actions/workflows/ci.yml).
Earlier clean Windows/Linux evidence remains in [Phase 6](stage-6.md); it is not
presented as a fresh check of this interface revision.

## Visitor walkthrough

Three owner walkthroughs have shaped this interface. The first found it
uninterpretable and prompted the redesign. The second still found it difficult
to read. The third reported that the workspace had "a lot going on" while
clicking through the database, which produced the measured
[density pass](stage-7.md#density-pass): the tree dropped from 86 visible text
elements to 55, the command console from 25 to 14, and a commit that rewrites
most of the tree now reads quietly so the state colours stay informative. No
capability was removed.

Comprehension by a new technical reader remains unproven. Automated tests verify
state and interaction behavior; they cannot establish whether a visitor
understands it.

Use the browser demo or local preview and give a reader these tasks:

1. Run **Watch a page split**, then inspect one of its new leaves.
2. Open **A commit survives** and step through termination and recovery.
3. Explain what the commit made durable, what the main file still lacked, and
   which records recovery restored. Find one restored record's encoded bytes.

Record the reader's own explanation and any point where they needed help. Keep
this criterion open until that observation exists.

## Boundaries

The full bounded tree lives in memory; commands are serialized. Browser support
has been verified in Chromium. Process-termination and modeled-storage tests
support the [documented recovery contract](tree-contract.md), not a universal
physical power-loss guarantee. Recorded frames show completed engine operations,
not measured I/O timing.

The [release procedure](release.md) produces the source archive, portable demo,
recordings, license notices, and checksum manifest from one clean revision.
