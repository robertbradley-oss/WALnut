# Phase 2 verification — atomic commits and recovery

Date: 2026-09-14. Phase 2 is implemented locally. Recommended model setting: **GPT-6 Astra, Max (`max`)**, as recorded in the roadmap. This report does not claim to change the task's model settings.

## Delivered

- Atomic batches of 1–64 puts, committed reads, in-memory staging/discard, and one generation per batch.
- Storage format 2: matching immutable file identities, full-page redo transactions, checksummed commit markers, synchronized commits, and recoverable checkpoints.
- Explicit migration of a stage 1 file into a new pair while retaining the original.
- WAL lane, staged/committed/checkpointed states, committed/checkpoint byte views, and a live recovery lab driven by actual child-process termination.
- Documented failure assumptions, formats, API behavior, and reproduction commands.

The engine remains limited to one logical 4 KB page. B+ tree work is the next milestone.

## Observed checks

Run on Windows with Node 24.19.0, Rust 1.98.1, the local GNULLVM toolchain, and Chromium through the repository's pinned Playwright setup.

| Check                       | Result                                                                                   |
| --------------------------- | ---------------------------------------------------------------------------------------- |
| `npm run check`             | Passed: Prettier, TypeScript, rustfmt, Clippy with warnings denied                       |
| `npm run test:core`         | Passed: 31 tests — 11 storage/codec, 16 recovery, 4 CLI                                  |
| `npm run test:e2e`          | Passed: 10 browser/API tests against built Rust server and real files                    |
| Production inspector build  | Passed as part of E2E command                                                            |
| Manual browser review       | Desktop and 390 px width; real staging, commit, and subprocess recovery receipt observed |
| Process cleanup after tests | No WALnut child processes remained                                                       |

## Recovery evidence

The deterministic storage model separates current bytes/length from their state after successful sync. Its power-loss action discards unsynchronized changes. Separate process-loss cases retain the current file contents. These are explicit models, not a hardware power-loss test.

Tests cover:

- Ten commit/checkpoint boundaries under both modeled process loss and power loss, with an earlier acknowledged transaction still in the WAL. Reopen is repeated, then checkpoint and new appends are verified.
- Every incomplete transaction length: 0–4,163 bytes after a valid prefix. Recovery preserves the prefix and removes only the fragment.
- Each of 4,164 bytes in a complete transaction corrupted individually: recovery rejects the transaction and leaves the log untouched.
- Each byte in both 64-byte file headers corrupted individually, plus valid-checksum identity mismatch, duplicate generations, generation gaps, inconsistent same-generation pages, and a missing WAL.
- Partial body/marker writes, read and read-back failure, failed commit sync, partial checkpoint writes, failed checkpoint sync, interrupted truncation, and failed sync of the reset length.
- A truncated old prefix surviving checkpoint: recovery prevents rollback and permits a later append without creating a gap.
- Failed recovery reads/syncs/truncations, bounded WAL capacity, staging preservation through checkpoint, discarded staging on reopen, and explicit legacy migration.

CLI tests spawn and terminate an actual worker at all ten boundaries. Before the marker, the batch is absent; after a complete marker in the observed process-termination cases, both records survive. Cases after `commit` returns demonstrate recovery of an acknowledged batch before checkpoint. Every scenario is reopened again and accepts a further put and checkpoint.

## Engine/UI agreement

The browser suite verifies that staged puts remain invisible to reads, two puts commit as one generation, and checkpoint changes the main page before the WAL becomes header-only. It compares actual WAL/main-file bytes with the corresponding API images after releasing the file locks.

All four visible recovery scenarios return a distinct terminated child process and a disposable database path. The primary database's bytes, WAL size, and session remain unchanged. Additional checks cover invalid inputs, cross-origin requests, malformed commands, missing keys, record updates, reconnect/stale-state behavior, reduced motion, narrow-screen overflow, and keyboard focus after commit.

Manual review confirmed the journal beside the write controls and the recovery receipt at desktop and phone width. The demo retains the original two records and adds a two-put batch; the main-file generation remains behind the committed generation so the difference can be explored.

## Reproduce

```sh
npm run check
npm run test:core
npm run test:e2e
npm run walnut -- lab work/lab after_frame
npm run walnut -- lab work/lab after_commit_return
npm start
```

Open `http://127.0.0.1:7878`. The lab saves disposable pairs under `recovery-lab/` beside the open database, or under the supplied CLI lab directory. The receipt includes the exact path and boundary.

## Limits and next milestone

- Validation above is local Windows evidence. The Windows/Linux GitHub Actions matrix is configured but has not run for this checkpoint. Linux and the standard Windows MSVC setup still need hosted or clean-machine verification.
- Actual device power loss, hardware/filesystem sync violations, media corruption, and external file deletion/truncation are outside the tested durability guarantee. Windows new-directory-entry durability is not established. CRC32 is not tamper protection.
- The WAL is limited to 1,024 transactions and requires a manual checkpoint. The inspector displays six recent transactions; the snapshot contains the latest 32 descriptions plus the total count.
- The single page limits final stored data to 4,096 bytes including its header. There is no on-disk tree, range scan, deletion, or multiwriter support yet.
- Publication, performance benchmarking, recorded replay, and the finished portfolio presentation remain later work. Nothing has been pushed or deployed by this phase.

Next: **stage 3, B+ tree — Astra Max (`max`)**. Preserve the recovery contract while adding page allocation, root metadata, splits, and ordered scans. The project goal remains **make WALnut technologically and visually impressive**.
