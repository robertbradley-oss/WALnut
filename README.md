<h1>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="public/brand/walnut-lockup-dark.svg">
    <img src="public/brand/walnut-lockup-light.svg" alt="WALnut" width="320">
  </picture>
</h1>

**A tiny database with its internals on display.**

Follow two writes through a B+ tree split, a committed write-ahead log, and recovery after process termination. WALnut is a Rust key/value database with a live inspector and a portable replay of real engine runs. Every page, log entry, and hex byte comes from the engine.

[![A committed page split: the operation bar names the generation change and the new root, the B+ tree shows one leaf becoming two, and the durability rail shows the log holding one transaction the main file does not have](docs/media/walnut-demo.png?v=fa468f5)](https://robertbradley-oss.github.io/WALnut/walnut-demo.webm?v=fa468f5)

**[Explore the browser demo](https://robertbradley-oss.github.io/WALnut/?v=fa468f5)** · [Watch the 30-second recording](https://robertbradley-oss.github.io/WALnut/walnut-demo.webm?v=fa468f5) · [Engineering case study](docs/case-study.md) · [Measured performance](docs/performance.md)

Every screen answers four questions: what operation you are looking at, what it changed, what is durable right now, and what you can inspect next.

![The live workbench after a point lookup: the page map, tree, search path, record list and byte layout all highlight the same key](docs/media/walnut-live.png?v=fa468f5)

### Reading it

Surfaces are neutral. Colour is the whole state vocabulary, and it follows the data from hot to at rest:

| Colour    | Where the data is                                      |
| --------- | ------------------------------------------------------ |
| **Amber** | Staged in memory. Not durable, invisible to reads.     |
| **Green** | Committed. Synced and verified in the write-ahead log. |
| **Blue**  | Checkpointed. At rest in the main database file.       |
| **Cyan**  | The page, record or route you are inspecting.          |
| **Red**   | A stopped process, a rejected command, a broken file.  |

Selecting anything lights the same thing everywhere: the page map, the tree, the search route, the record list and the byte span in the page picture. A commit that changes a few pages is drawn loudly; one that rewrites most of the tree keeps a quiet edge marker instead, so the highlight always means something you can follow.

## Try it

**Just explore:** [open the current browser demo](https://robertbradley-oss.github.io/WALnut/?v=fa468f5). It includes the updated interface and three real engine recordings. The demo is recorded exploration; running the engine locally lets you write your own data.

**Explore offline:** [build the portable demo from the current source](docs/replay.md). The downloadable `walnut-0.1.0-demo.html` in the [v0.1.0 release](https://github.com/robertbradley-oss/WALnut/releases/tag/v0.1.0) is the original release snapshot and predates the latest UI changes.

**Run the engine:** install **Node 24.19.0** and **Rust 1.98.1**, plus a native linker (MSVC Build Tools on Windows; a C toolchain on Linux).

```sh
npm ci
npm run dev
```

Open **http://127.0.0.1:5173**. This starts the Rust engine and React inspector, creates `data/walnut-v3.db` and its companion WAL if absent, and preserves existing records. Stop both with Ctrl+C. One process owns a database at a time.

For the production build served by Rust:

```sh
npm run build
npm start
```

Open **http://127.0.0.1:7878**. [Full CLI and inspector guide →](docs/usage.md)

## Three ways inside

Choose **Guided stories** in the live inspector and **Run story**, or choose a scenario in the portable replay. Each scenario uses a synthetic, disposable database.

| Story                   | What to inspect                                                                                                      |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------- |
| **A page splits**       | Two staged puts turn one leaf into two leaves and a root, committed together.                                        |
| **A commit survives**   | A real child process is terminated after commit. A new engine restores the same five records and split from the WAL. |
| **The file catches up** | Checkpoint copies committed pages into the main file; the WAL returns to its 64-byte header.                         |

Use the timeline to step, play, pause, change speed, or reset. Select a tree page, then expand **Raw bytes** to compare its committed and checkpoint images. Recorded playback changes the view only; the live inspector accepts new operations through **Live database**.

## Under the hood

- **A B+ tree built here:** 4 KB pages, exact separators, linked leaves, byte-based splits, cascading root changes, point lookups, and ordered scans.
- **Atomic recovery:** complete changed-page images and root/allocation metadata in a checksummed redo log; sync and read-back before commit acknowledgment.
- **Failures you can reproduce:** short writes, failed syncs, interrupted checkpoint/reset, corrupt input, real process termination, and generated workloads checked against an independent ordered map.
- **An inspectable engine:** verified page bytes, actual search paths, write/log/checkpoint state, captured process receipts, and tracing you can turn off. A page map carries every allocated page — all 1,024 at the limit — in one tab stop.
- **Portable evidence:** one HTML replay with three real recordings, source revision, build hash, and retained license notices.

The subtle case: a successful checkpoint can leave an obsolete, valid WAL prefix after a failed reset. Recovery must make the _next_ commit safe too. [Read the worked example and regression test](docs/case-study.md).

### Bounds and guarantees

Keys are 1–64 UTF-8 bytes; values are 0–1,024 bytes. Batches contain 1–64 puts. The tree is bounded to 1,024 node pages plus metadata and stays in memory. Writes clone and validate a candidate tree; checkpoints are manual. There is no deletion, SQL, replication, or concurrent writer.

Acknowledged commits recover whole under the [documented failure contract](docs/tree-contract.md). A valid commit whose reply was interrupted may also survive. Tests cover process termination and modeled storage failures; they do not establish physical power-loss survival on every device/filesystem. CRC32 detects accidental corruption, not tampering.

### Measured, with context

At 1,792 records on the documented Windows machine, tracing-off median point reads were about **0.4 µs**, a durable single-record update **6.1 ms**, and a durable 16-update batch **6.7 ms**. Reads use the resident tree; writes include the normal sync/read-back path. These are different workloads, not a database comparison. [Method, latency distributions, hardware, raw samples, and tracing overhead →](docs/performance.md)

## Verify and reproduce

```sh
npm run browser:install
npm run check
npm run test:core
npm run test:e2e
npm run test:replay
```

Linux browser setup may need `node scripts/browser.mjs install --with-deps chromium`. Tests use disposable files under `work/`. The [release verification](docs/release-candidate.md) distinguishes current checks, earlier platform evidence, and visitor feedback.

```sh
npm run benchmark          # Engine measurements with raw samples
npm run profile:inspector  # Large-tree rendering and interaction profile
npm run build:demo         # Self-contained browser recording
npm run release:prepare    # Versioned local artifacts from clean source
```

## Read the implementation

| Start here                                          | Then inspect                                                                                                                                 |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| [Architecture](docs/architecture.md)                | [Storage boundary](crates/walnut-core/src/storage.rs), [engine](crates/walnut-core/src/engine.rs), [B+ tree](crates/walnut-core/src/tree.rs) |
| [Tree and recovery contract](docs/tree-contract.md) | [WAL](crates/walnut-core/src/wal.rs), [recovery tests](crates/walnut-core/tests/tree_recovery.rs)                                            |
| [File and event formats](docs/file-format.md)       | [Page codec](crates/walnut-core/src/page.rs), [CLI and local bridge](crates/walnut-cli/src/main.rs)                                          |
| [Portable replay](docs/replay.md)                   | [Story capture](crates/walnut-cli/src/story.rs), [viewer](src/ReplayApp.tsx), [browser checks](replay/replay.spec.ts)                        |
| [Gameplan](GAMEPLAN.md)                             | [Roadmap and Astra reasoning levels](ROADMAP.md), [release preparation](docs/release.md)                                                     |

MIT licensed. A local learning and portfolio project with explicit limits, real files, and inspectable failure behavior.
