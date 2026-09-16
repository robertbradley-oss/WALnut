# Local inspector and CLI guide

**A tiny database with its internals on display.**

Grow a B+ tree, follow a key through its pages, then interrupt a split and inspect what recovery brings back. The tree, log entries, records, and hex bytes come from a real Rust engine.

See the [project overview](../README.md) for the portable demo and current release status.

## Run locally

Requirements: **Node 24.19.0** and **Rust 1.98.1**. A standard Rust installation needs its platform's linker (MSVC Build Tools on Windows, a C toolchain on Linux). Package and Cargo lockfiles pin dependencies. Rust and Node version files pin toolchains.

```sh
npm ci
npm run dev
```

Open **http://127.0.0.1:5173**. The command starts the Rust bridge and Vite, creates `data/walnut-v3.db` and its `.wal` companion if missing, and keeps existing data. Stop both with Ctrl+C.

For the built inspector, served directly by Rust:

```sh
npm run build
npm start
```

Open **http://127.0.0.1:7878**. Only run one mode against this database at a time. The second owner is rejected by a file lock.

This development checkout also supports an optional local Windows LLVM/Rust installation under `.tools/`, detected by the Node wrappers. It does not modify the user's PATH. A fresh checkout can use the standard toolchains above; `.tools/` is not part of the repository.

## Follow three real engine stories

Open **Guided stories**, choose a scenario, and click **Run story**. Each run creates a disposable database and captures its verified pages after observable operations.

- **A page splits:** three full-size records fit in one leaf. Stage two more puts, commit, and inspect the resulting root and two leaves.
- **A commit survives:** commit the split, terminate its process, and recover the exact acknowledged tree from the WAL.
- **The file catches up:** checkpoint the committed pages, see the log shrink to its header, and reopen the database.

Use **Play recording**, **Pause**, **Previous/Next step**, **Speed**, or a timeline step. **Reset recording** returns to the first capture; **Run story again** creates a fresh engine run. Tree zoom and **Fit** change the view. Select any page — on the stage, in the page map, or through **PAGE EXPLORER** — to inspect its records, routing table, or **Raw bytes**.

Recorded playback stays available when the engine disconnects. It changes only the view; **Live database** returns to the actual open database. The stopped-process frame explicitly holds the last pre-termination capture. The recording contains operation snapshots, not invented intermediate disk states. Reloading the browser clears the in-memory recording; saved scenario files remain available at the path under **Recorded run evidence**.

## Grow the tree, then interrupt a split

1. Click **Insert 64 sample records** twice. Real 64-byte keys and 1,000-byte values fill 4 KB pages, split leaves and branches, and produce a three-level tree.
2. Walk the **PAGE MAP** with the arrow keys, or select a branch on the stage to descend into its children. The level chips at each row's edge jump to the pages the stage cannot draw at this width. **PAGE EXPLORER** reaches any leaf, internal routing page, or page 0 metadata directly.
3. Run **GET** for a stored key. The search path shows the actual pages visited. **SCAN** returns ordered records across leaf links; select a result to inspect its source page.
4. Expand **Advanced crash lab**, choose **Root split** and **After commit**. A real child is killed after acknowledging two puts that split a leaf, split its parent, and create a new root.
5. Inspect the receipt: 116 → 118 records, 59 → 62 node pages, height 2 → 3. Every key and value is checked after reopening. **Before commit** keeps the original tree intact.

The lab creates a new disposable database for each run. It also offers first-leaf splits and interruption during checkpoint or log reset. It retains the files and reports their path for CLI inspection.

## Follow a batch into the log

1. In **PUT**, stage `alpha` → `one` and `beta` → `two` with **Stage in batch**. The record table and GET still show committed data.
2. **Commit batch.** Both records appear in one generation. The operation bar names the generation change, the page images written, and the bytes appended; the durability rail shows the transaction and every changed page ID, including metadata.
3. Select a record, expand **Raw bytes**, and compare **Committed page** with **Checkpoint page**. Each label reports that individual page's generation. **Checkpoint** brings the main file up to date and resets the WAL to its permanent header.

The command-line interface uses the same engine. Stop the inspector before opening its file through the CLI, or use a separate file:

```sh
npm run walnut -- create data/example.db
npm run walnut -- put data/example.db greeting "hello, storage"
npm run walnut -- get data/example.db greeting
npm run walnut -- inspect data/example.db
npm run walnut -- grow data/example.db
npm run walnut -- grow data/example.db
npm run walnut -- range data/example.db "" --limit 20
npm run walnut -- inspect data/example.db 0
npm run walnut -- checkpoint data/example.db
npm run walnut -- lab work/lab after_commit_return root_split
npm run walnut -- story work/stories split
npm run walnut -- story work/stories recovery
npm run walnut -- story work/stories checkpoint
```

`create` never overwrites an existing file. CLI results and errors are JSON. `get` represents absence with `found: false` and `value: null`.

`batch <file> <json-array>` commits an array of `{"key":"...","value":"..."}` puts. `range` accepts `--end <exclusive-key>` and `--limit <1–256>`; its `next_key` resumes the scan inclusively against current committed data. Empty start includes all keys. `inspect <file> [page-id]` defaults to leaf page 1.

The lab accepts `before_frame`, `after_wal_header`, `after_wal_page:0`, `after_frame`, `after_commit_marker`, `after_wal_sync`, `after_commit_return`, `before_checkpoint_write`, `after_checkpoint_page:3`, `after_checkpoint_write`, `after_checkpoint_sync`, `after_wal_truncate`, and `after_reset_sync`. Its optional workload is `leaf_split` or `root_split` (default). `story <directory> <split|recovery|checkpoint>` returns a complete JSON recording with source metadata, snapshots, every page's captured bytes, and the recovery worker's exit evidence where applicable.

To retain a format-1 standalone page or format-2 pair, stop its owner and upgrade into a **new** format-3 pair:

```sh
npm run walnut -- upgrade data/walnut-v2.db data/migrated.db
```

The original stays intact, including any source WAL tail. Migration recovers a memory copy before creating the new pair. Set `WALNUT_DB` to the new database path to inspect it. Keep both current files together; a missing or mismatched WAL is an error.

## What's implemented

- A B+ tree with 4,096-byte leaf/internal pages, exact separators, linked leaves, byte-based splits, cascading root changes, and a dedicated metadata page.
- Keys of 1–64 UTF-8 bytes; values of 0–1,024 bytes. Keys are case-sensitive and ordered by bytes, without normalization. Updates can grow or shrink values.
- Point lookups and ordered range scans; structural validation checks ordering, reachability, balanced depth, links, and the complete tree checksum.
- Atomic batches of 1–64 puts, in-memory staging, committed reads, redo WAL, restart recovery, and manual checkpoints.
- Matching file identities, transactions containing every changed page and root/allocation metadata, checksummed commit markers, and bounded log reuse.
- Exclusive database ownership, serialized commands, optional tracing, and an injectable storage boundary.
- A React workbench with navigable tree pages, search paths, range results, leaf links, WAL lane, staged/committed/checkpointed states, exact hex views, and real subprocess split recovery.
- Three deterministic recorded stories with playback, stepping, speed, reset, zoom, keyboard controls, reduced motion, and offline inspection of captured pages.

**Bounds:** 1,024 node pages plus metadata; 1–64 puts per batch; 1–256 results per range request; manual checkpoint after 1,024 transactions or 32 MiB of WAL. The complete tree is held in memory and candidate validation examines the whole tree. There is no deletion, space reclamation, SQL, or concurrent writer.

**Persistence boundary:** a commit returns after WAL synchronization and read-back. Within the [tree and failure contract](tree-contract.md), acknowledged commits survive recovery and batches appear whole, including every page in a split. A complete valid commit whose reply was interrupted may also survive. Tests cover process termination and modeled storage failures; they do not establish physical power-loss survival across all devices/filesystems. Failed I/O requires reopen. CRC32 detects accidental corruption, not tampering.

## Verify

```sh
npm run browser:install
npm run check
npm run test:core
npm run test:e2e
```

Linux browser setup may also need `node scripts/browser.mjs install --with-deps chromium`. Browser files stay in `.tools/browsers` by default. End-to-end tests create isolated real databases in `work/` and run the built Rust server and inspector.

The GitHub Actions workflow runs the same checks for Windows and Linux before deploying the portable demo. See [release verification](release-candidate.md) for observed results and remaining review.

## Measure it

```sh
npm run benchmark
npm run profile:inspector
```

The release benchmark checks deterministic datasets of 128, 512, and 1,792 records, with tracing off/on, indexed versus sequential reads, scans, durable updates/batches, checkpoints, and recovery. It records latency distributions, source/environment metadata, and file growth in a fresh `work/` directory. The separate inspector profile uses real 927-page live and 62-page recorded captures. See [results, workload definitions, and reproduction](performance.md).

Live polling reports delayed responses and events skipped outside the retained 128-event window. It keeps the last verified state and rejects snapshots that move backward within the same engine session.

## Read the implementation

- [Architecture](architecture.md) · [Tree and recovery contract](tree-contract.md)
- [File, page, WAL, and event formats](file-format.md)
- [GamePlan](../GAMEPLAN.md) · [Roadmap and Astra reasoning levels](../ROADMAP.md)
- `crates/walnut-core`: page codec, B+ tree, WAL, storage boundary, and tests; historical engine under `legacy`
- `crates/walnut-cli`: CLI and local HTTP bridge
- `src`: live inspector
- `tests`: browser and API integration checks

See [release verification](release-candidate.md) for the current release and walkthrough evidence.
