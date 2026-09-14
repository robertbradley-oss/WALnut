# WALnut

**A tiny database with its internals on display.**

Write a key and value, follow the engine's actual events, and inspect the bytes read back from the file. Close and reopen the database to see the data persist.

WALnut is a local learning and portfolio project. **Stage 1 is a real single-page store and live inspector.** Write-ahead logging, crash recovery, and B+ tree splits are planned in later stages.

## Run locally

Requirements: **Node 24.19.0** and **Rust 1.98.1**. A standard Rust installation needs its platform's linker (MSVC Build Tools on Windows, a C toolchain on Linux). Package and Cargo lockfiles pin dependencies. Rust and Node version files pin toolchains.

```sh
npm ci
npm run dev
```

Open **http://127.0.0.1:5173**. The command starts the Rust bridge and Vite, creates `data/walnut.db` if missing, and keeps existing data. Stop both with Ctrl+C.

For the built inspector, served directly by Rust:

```sh
npm run build
npm start
```

Open **http://127.0.0.1:7878**. Only run one mode against this database at a time. The second owner is rejected by a file lock.

This development checkout also supports an optional local Windows LLVM/Rust installation under `.tools/`, detected by the Node wrappers. It does not modify the user's PATH. A fresh checkout can use the standard toolchains above; `.tools/` is not part of the repository.

## Try the complete slice

1. In **PUT**, write `hello` → `from the inside`.
2. Select the stored record. Its key and value are highlighted in the hex view; the page shows its actual byte occupancy.
3. Expand **Read-back verified** in Engine activity to inspect the event.
4. Use **Reopen database**, switch to **GET**, and retrieve `hello`.

The command-line interface uses the same engine. Stop the inspector before opening its file through the CLI, or use a separate file:

```sh
npm run walnut -- create data/example.db
npm run walnut -- put data/example.db greeting "hello, storage"
npm run walnut -- get data/example.db greeting
npm run walnut -- inspect data/example.db
```

`create` never overwrites an existing file. CLI results and errors are JSON. `get` represents absence with `found: false` and `value: null`.

## What's implemented

- A 4,096-byte page with a versioned header, sorted UTF-8 records, generation counter, and CRC32 checksum.
- Keys of 1–64 UTF-8 bytes; values of 0–1,024 bytes, subject to total page capacity. Keys are case-sensitive and ordered by bytes, without normalization.
- Insert/update, lookup, validation, file synchronization, read-back verification, and reopen.
- Exclusive database ownership, serialized commands, optional tracing, and an injectable storage boundary.
- A React inspector with actual page occupancy, record selection, paginated hex bytes, commands, reopen, and live session events.

**Persistence boundary:** each write replaces the page in place. A successful reply follows file synchronization and read-back, but stage 1 does not provide crash-atomic updates or recovery. A write or sync failure can leave uncertain file contents; the engine then refuses further reads and writes until reopened. CRC32 detects accidental corruption; it is not a security guarantee.

## Verify

```sh
npm run browser:install
npm run check
npm run test:core
npm run test:e2e
```

Linux browser setup may also need `node scripts/browser.mjs install --with-deps chromium`. Browser files stay in `.tools/browsers` by default. End-to-end tests create isolated real databases in `work/` and run the built Rust server and inspector.

The GitHub Actions workflow defines the same checks for Windows and Linux. A configured workflow is not evidence that hosted CI has run; see [stage 1 verification](docs/stage-1.md) for observed results.

## Read the implementation

- [Architecture and the initial decision](docs/architecture.md)
- [Page and event formats](docs/file-format.md)
- [GamePlan](GAMEPLAN.md) · [Roadmap and Astra reasoning levels](ROADMAP.md)
- `crates/walnut-core`: page codec, engine, storage boundary, and tests
- `crates/walnut-cli`: CLI and local HTTP bridge
- `src`: live inspector
- `tests`: browser and API integration checks

The next milestone adds atomic commits and recovery. The goal remains: **make WALnut technologically and visually impressive.**
