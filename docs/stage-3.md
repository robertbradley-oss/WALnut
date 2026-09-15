# Phase 3 verification — paged B+ tree

Date: 2026-09-14. Phase 3 is implemented locally. Recommended model setting: **GPT-6 Astra, Max (`max`)**, as recorded in the roadmap. This recommendation does not change the task's runtime settings.

## Delivered

- Physical 4 KB leaf and internal pages; byte-based splits, cascading internal splits, new roots, updates, indexed point reads, and ordered scans across linked leaves.
- Atomic WAL transactions containing changed pages and root/allocation metadata. Checkpoint recovery validates a checksum over the complete tree, including mixed-generation page cases.
- Explicit format-1/2 upgrades into a new format-3 pair with the original source bytes preserved.
- Tree explorer with actual page IDs, ancestry, search paths, changed/split markers, page selection, internal routing tables, metadata and exact byte inspection.
- Range controls with inclusive start, exclusive end, result limit, next-key cursor, and navigation to source leaves.
- Reproducible first-leaf and cascading-root split labs using actual subprocess termination and recovered-file receipts.

## Observed checks

Run on Windows with Node 24.19.0, Rust 1.98.1, the local GNULLVM toolchain, and Chromium through the pinned Playwright setup.

| Check                      | Result                                                                                      |
| -------------------------- | ------------------------------------------------------------------------------------------- |
| `npm run check`            | Passed: Prettier, TypeScript, rustfmt, Clippy with warnings denied                          |
| `npm run test:core`        | Passed: 52 Rust tests — 20 new tree/recovery, 27 retained legacy regressions, 5 current CLI |
| `npm run test:e2e`         | Passed: 12 browser/API tests against the built inspector and actual Rust server             |
| Production inspector build | Passed as part of E2E                                                                       |
| Manual browser review      | Tree growth, root/branch layout, actual checkpoint interruption receipt, and 390 px layout  |
| Demo migration             | Original standalone file and format-2 pair retained with identical SHA256 hashes            |

No remote is configured; hosted CI has not run. Test counts describe test functions, while exhaustive cases and subprocess cuts run inside those functions.

## Tree evidence

The deterministic sequence test applies 90 batches of 17 puts, with updates, Unicode keys, and variable value lengths. After each batch it compares all ordered results against an independent `BTreeMap` reference, samples point lookups, and validates tree structure. Separate cases cover value growth that splits without increasing record count, duplicate-key last-write behavior, empty values, byte bounds, range endpoints/cursors, and the 1,024-page allocation limit.

Codec tests round-trip leaves, internal nodes, and metadata; flip each of 4,096 bytes and truncate every node image length. Valid-checksum structural mutations check routing, allocation, depth, and leaf links. Fixed workloads exercise physical capacity:

| Case                 | Before                               | After                                |
| -------------------- | ------------------------------------ | ------------------------------------ |
| First leaf split     | 3 records, 1 node page, height 1     | 5 records, 3 node pages, height 2    |
| Cascading root split | 116 records, 59 node pages, height 2 | 118 records, 62 node pages, height 3 |

These workloads use 64-byte keys and 1,000-byte values. Internal pages fit 57 full-size separators; an overflowing parent divides and creates a new root. There is no artificial branching limit used only for the demonstration.

## Recovery evidence

The core collects every emitted commit and checkpoint boundary from the cascading-root workload, including each WAL page image, each checkpoint node, and root metadata. It interrupts at each boundary under two models: process loss retains current file contents; modeled power loss retains only bytes and lengths established by successful sync. Every case checks the whole prior or committed record set, validates height/root, reopens again, checkpoints, and accepts a further durable write.

The first-split transaction contains four page images and is 16,484 bytes. Every incomplete length from 0 through 16,483 is tested after a valid committed prefix. Every byte in a complete transaction is separately corrupted; recovery rejects it without shortening the log.

Additional cases inject partial header/image/marker writes, failed WAL sync/read-back, torn node and metadata writes, mixed checkpoints, interrupted reset, and failed recovery I/O. A regression checks that individually valid pages from another commit fail the complete-tree checksum. Obsolete-prefix recovery permits later appends without creating a metadata gap. Both the transaction-count and 32 MiB byte limits preserve a rejected pending batch for checkpoint and retry. File ownership, missing WAL, identity mismatch, and legacy recovery-copy migration are checked with actual files.

CLI tests terminate an actual child at **13 boundaries for each of two workloads: 26 process kills**. Before the complete commit marker, both new records and the split are absent. After the marker in these observed process-loss cases, both records and the complete split survive. Cuts after commit returns establish acknowledged recovery within the stated model. Every resulting database is reopened, written, checkpointed, and read again.

## Inspector agreement and visual review

The browser suite grows a three-level tree with two sample batches. It compares displayed counts, root/page IDs, point-search paths, ordered range results, cursor continuation, and selected-page occupancy with engine responses. It navigates internal routing and metadata, follows scan results back to leaves, and checks keyboard access and child pagination at 390 px with reduced motion.

Existing staging, commit, checkpoint, input/error, missing-key, disconnect, and local-origin checks remain active. Main-file and WAL page images are compared with actual bytes after releasing file locks. Invalid page selections are rejected before a write can occur. All four visible crash boundaries return a terminated worker and leave the primary database's bytes, WAL length, and session unchanged.

Manual review observed the upgraded demo grow from four retained records to **132 records, 67 node pages, height 3, root P62**. The two sample batches are generations 4 and 5; the checkpoint remains generation 3 so the WAL/main-file difference stays inspectable. A checkpoint interruption after page 3 recovered the lab's full 118-record, 62-page tree. The receipt was reviewed at desktop and 390 px width; the narrow document did not exceed its viewport.

The narrow scan view initially overflowed with long sample keys. The side column and responsive grid now allow their contents to shrink, and the browser regression passes with full-length keys and values.

## Reproduce

```sh
npm run check
npm run test:core
npm run test:e2e
npm run walnut -- create data/tree-example.db
npm run walnut -- grow data/tree-example.db
npm run walnut -- grow data/tree-example.db
npm run walnut -- range data/tree-example.db "" --limit 20
npm run walnut -- inspect data/tree-example.db 0
npm run walnut -- lab work/lab after_frame leaf_split
npm run walnut -- lab work/lab after_commit_return root_split
npm run walnut -- lab work/lab after_checkpoint_page:3 root_split
npm start
```

Open `http://127.0.0.1:7878`. Use a new example filename on repeated runs; creation never overwrites. Stop the server before inspecting its owned database with the CLI. Lab receipts identify the disposable pair and exact fault boundary.

## Limits and next stage

- Evidence is local Windows verification. Linux and standard Windows MSVC support still need hosted or clean-machine checks.
- Actual device power loss, broken sync guarantees, spontaneous media corruption, and external deletion/truncation are outside the tested durability guarantee. Windows creation of new directory entries is not claimed power-loss durable. CRC32 does not prevent tampering.
- The tree is bounded to 1,024 node pages plus metadata and remains fully in memory. Candidate copying, full structural validation, tree checksums, and full-tree checkpoints favor inspectability and correctness; performance has not been benchmarked.
- Scans return up to 256 records and resume against current committed data. There is no concurrent snapshot retention, deletion, reclamation, SQL, or multiwriter support.
- Event retention and recent WAL displays are bounded. Coordinated timeline playback, stepping, guided stories, benchmark results, a shareable recorded demo, and the portfolio release remain later stages.

Next: **Phase 4 — visual experience, Astra Ultra (`ultra`)**, selected by the project owner. Build on the actual tree and split recovery to make the whole story clear and visually impressive. Phase 4 has not started, and this phase does not publish or deploy WALnut.
