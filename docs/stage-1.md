# Stage 1 — Foundation

Implemented locally on September 14, 2026, using the stage 1 scope in the roadmap.

## Delivered

- Rust workspace with a storage-engine crate and CLI/local bridge.
- Real 4 KB file storage: create, put/update, get, inspect, and reopen.
- Versioned page layout, CRC32, record bounds, generation tracking, sorted UTF-8 keys, and explicit errors.
- Exclusive file ownership and a storage interface exercised with partial-write, sync, read, and read-back corruption faults.
- A live React inspector: actual occupancy, selectable records, key/value byte highlighting, all-page hex navigation, session events, lookup, and reopen.
- Local fonts, warm dark visual tokens, responsive layout, keyboard controls, reduced motion, and visible error/disconnect states.
- Versioned toolchain files, dependency lockfiles, readable architecture/format notes, and Windows/Linux CI configuration.

## Observed verification

| Check                            | Result                                                                                |
| -------------------------------- | ------------------------------------------------------------------------------------- |
| Rust/core and CLI tests          | 13 passed on local Windows                                                            |
| Browser/API integration tests    | 6 passed in Chromium on local Windows                                                 |
| Static checks                    | TypeScript, Rust formatting, and Clippy with warnings denied passed                   |
| Production inspector build       | Passed                                                                                |
| Direct visual/interaction review | Real writes, record selection, file reopen, and lookup verified in the in-app browser |
| Hosted Windows/Linux CI          | Configured; not run because this repository has not been pushed                       |

Core tests cover all truncated page lengths, a changed byte at every position, malformed but checksummed fields, Unicode byte bounds, capacity rejection without mutation, updates against an independent linear reference, file ownership, and handle poisoning after failed I/O. These are bounded tests, not a proof of all possible storage behavior.

The browser tests run the built Rust server against isolated real files. They compare the snapshot to the file bytes after closing the owner, check persisted UTF-8 values after reopen, verify updates and missing keys, reject full-page writes and invalid local API requests, exercise keyboard interaction at 390 px with reduced motion, and check the stale-state display after process exit.

The initial test runs caught platform-specific file-lock behavior and a locator that included a visible byte counter in the field label. The final tests respect exclusive ownership and use the fields' accessible roles and names.

## Run this checkout

Project: `C:\Users\robby\Documents\Codex\Projects\walnut`

- `npm run dev`: Rust plus Vite at http://127.0.0.1:5173.
- `npm run build` then `npm start`: built inspector at http://127.0.0.1:7878.
- `npm run check`, `npm run test:core`, `npm run test:e2e`: reproduce checks.

The optional Windows compiler and test browser are local to `.tools/`. Generated databases and test files are excluded from Git. The demo database contains synthetic records written through the actual inspector.

## Boundary for the next stage

Stage 1 writes a page in place and verifies normal persistence. It has no WAL, atomic batch commit, B+ tree, or crash recovery yet. The next stage must establish those commit/recovery guarantees before the tree grows across multiple pages. Public hosting, release packaging, and performance claims remain later work.

**Make WALnut technologically and visually impressive.**
