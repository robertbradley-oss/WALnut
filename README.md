# WALnut

**A tiny database with its internals on display.**

Stage a batch, follow it into the write-ahead log, then kill a process and inspect what recovery brings back. The records, log entries, and hex bytes come from a real Rust engine.

WALnut is a local learning and portfolio project. **Phase 2 includes atomic batches, WAL recovery, checkpoints, and a live recovery lab.** The engine still has one logical 4 KB page. B+ tree pages and splits come next.

## Run locally

Requirements: **Node 24.19.0** and **Rust 1.98.1**. A standard Rust installation needs its platform's linker (MSVC Build Tools on Windows, a C toolchain on Linux). Package and Cargo lockfiles pin dependencies. Rust and Node version files pin toolchains.

```sh
npm ci
npm run dev
```

Open **http://127.0.0.1:5173**. The command starts the Rust bridge and Vite, creates `data/walnut-v2.db` and its `.wal` companion if missing, and keeps existing data. Stop both with Ctrl+C.

For the built inspector, served directly by Rust:

```sh
npm run build
npm start
```

Open **http://127.0.0.1:7878**. Only run one mode against this database at a time. The second owner is rejected by a file lock.

This development checkout also supports an optional local Windows LLVM/Rust installation under `.tools/`, detected by the Node wrappers. It does not modify the user's PATH. A fresh checkout can use the standard toolchains above; `.tools/` is not part of the repository.

## Follow a commit, then break the process

1. In **PUT**, stage `alpha` → `one` and `beta` → `two` with **Stage in batch**. The record table and GET still show committed data.
2. **Commit batch.** Both records appear in one generation. The log lane shows one transaction containing two puts.
3. Select a record and compare **Committed page** with **Checkpoint page** in the hex view. **Checkpoint** brings the main file up to date and resets the WAL to its permanent header.
4. In **Recovery lab**, run **Before commit**: the child is terminated before the marker, and both new keys are absent after recovery.
5. Run **After commit**: the child is terminated after commit returns, and both keys recover from the log. Expand the receipt for its real process exit, file path, and recovery report.

The lab uses a new disposable database for each run. Your open database stays available. Checkpoint and log-reset interruption scenarios are also selectable.

The command-line interface uses the same engine. Stop the inspector before opening its file through the CLI, or use a separate file:

```sh
npm run walnut -- create data/example.db
npm run walnut -- put data/example.db greeting "hello, storage"
npm run walnut -- get data/example.db greeting
npm run walnut -- inspect data/example.db
npm run walnut -- checkpoint data/example.db
npm run walnut -- lab work/lab after_commit_return
```

`create` never overwrites an existing file. CLI results and errors are JSON. `get` represents absence with `found: false` and `value: null`.

`batch <file> <json-array>` commits an array of `{"key":"...","value":"..."}` puts. The lab also accepts `before_frame`, `after_frame`, `after_commit_marker`, `after_wal_sync`, `before_checkpoint_write`, `after_checkpoint_write`, `after_checkpoint_sync`, `after_wal_truncate`, and `after_reset_sync`.

To retain a stage 1 database, stop its owner and copy it into a **new** format-2 pair:

```sh
npm run walnut -- upgrade data/walnut.db data/migrated.db
```

The original stays intact. Set `WALNUT_DB` to the new database path to inspect it. Keep both files together; a missing or mismatched WAL is an error.

## What's implemented

- A 4,096-byte page with a versioned header, sorted UTF-8 records, generation counter, and CRC32 checksum.
- Keys of 1–64 UTF-8 bytes; values of 0–1,024 bytes, subject to total page capacity. Keys are case-sensitive and ordered by bytes, without normalization.
- Atomic batches of 1–64 puts, in-memory staging, committed reads, redo WAL, restart recovery, and manual checkpoints.
- Matching file identities, checksummed full-page transactions and commit markers, and safe bounded log reuse.
- Exclusive database ownership, serialized commands, optional tracing, and an injectable storage boundary.
- A React inspector with a WAL lane, explicit staged/committed/checkpointed state, page and hex views, and a real subprocess recovery lab.

**Persistence boundary:** a commit returns after WAL synchronization and read-back. Within the [failure model](docs/recovery-contract.md), acknowledged commits survive recovery and batches appear whole. A complete valid commit whose reply was interrupted may also survive. Tests cover process termination and modeled storage failures; they do not establish physical power-loss survival across all devices/filesystems. Failed I/O requires reopen. CRC32 detects accidental corruption, not tampering.

## Verify

```sh
npm run browser:install
npm run check
npm run test:core
npm run test:e2e
```

Linux browser setup may also need `node scripts/browser.mjs install --with-deps chromium`. Browser files stay in `.tools/browsers` by default. End-to-end tests create isolated real databases in `work/` and run the built Rust server and inspector.

The GitHub Actions workflow defines the same checks for Windows and Linux. Hosted CI has not run for this local checkpoint; see [phase 2 verification](docs/stage-2.md) for observed results.

## Read the implementation

- [Architecture](docs/architecture.md) · [Commit and recovery contract](docs/recovery-contract.md)
- [File, page, WAL, and event formats](docs/file-format.md)
- [GamePlan](GAMEPLAN.md) · [Roadmap and Astra reasoning levels](ROADMAP.md)
- `crates/walnut-core`: page codec, engine, storage boundary, and tests
- `crates/walnut-cli`: CLI and local HTTP bridge
- `src`: live inspector
- `tests`: browser and API integration checks

Next: build the B+ tree and preserve these recovery guarantees across page splits. The goal remains: **make WALnut technologically and visually impressive.**
