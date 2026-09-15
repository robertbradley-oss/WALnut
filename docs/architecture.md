# Phase 3 architecture

## One owner, a paged tree, two files

The Rust engine owns an exclusively locked database/WAL pair. CLI commands own it for one invocation; the bridge owns it until stopped or reopened. Commands run serially. The complete bounded tree lives in memory. Its page table maps IDs to nodes; point reads navigate the B+ tree and range scans follow leaf links.

```text
React inspector ── same-origin JSON ── Rust bridge / CLI
                                           │
                                      Engine<D, W>
                                           │
                               metadata → root → branches
                                                   ↓
                                           linked leaf pages
                                       /                 \
                              checkpoint file        write-ahead log
                              identity + pages       identity + transactions
```

Page 0 contains root/allocation metadata and a checksum over the complete tree. Node pages have stable IDs beginning at 1. Leaves contain sorted records; internal pages contain separator keys and child IDs. Equality routes right. Every separator equals the minimum key in its right subtree. The storage and page formats are described in [file-format.md](file-format.md); correctness and failure assumptions are in the [tree contract](tree-contract.md).

## Insertion and growth

Insertion uses binary search to choose child pages and find a key in its leaf. A value update replaces the existing record. Overflow is measured in encoded bytes: 4,096 bytes per page, including a 64-byte header. There is no reduced fanout for the animation.

A leaf split divides records near the byte midpoint, keeps the old ID for the left side, and allocates a right sibling. Leaf links and the parent separator change in the same candidate transaction. An overflowing internal page promotes a separator and divides its children. If propagation reaches the root, the candidate allocates a new root and increments tree height. No deletion, page reclamation, minimum byte occupancy, or cache eviction is implemented.

Before any I/O, validation checks page structure, all allocated IDs, unique reachability, separators, key ranges, balanced depth, leaf-chain order, record count, and the complete state checksum. The limit is 1,024 node pages plus metadata. Validation and candidate copying inspect the whole bounded tree; indexed reads do not imply logarithmic transaction preparation or a tuned buffer manager.

## Three states

- **Staged:** 1–64 puts held in memory with a validated candidate tree. Reads and inspection still see the committed tree. Duplicate keys use the final value. Reopen discards staging.
- **Committed:** changed page images and metadata have passed WAL sync and exact read-back. One batch increments the generation once. A new root becomes visible with all its pages.
- **Checkpointed:** every node page and metadata have been synced and verified in the main file before the WAL is shortened and synced. A checkpoint preserves staging.

Immediate `put` and `batch` reject a pending staged batch. Either the transaction-count limit or the 32 MiB WAL limit returns `checkpoint_required` before writes and retains the candidate for checkpoint and retry. Failed I/O during commit/checkpoint poisons the handle; normal commands then require reopen.

The `Storage` boundary provides size, exact read, full write, sync, and truncate. A failed call may already have changed bytes. Tests separate live bytes from bytes retained after successful sync and discard unsynced changes for modeled power loss. Partial writes/truncations, failed reads/syncs, and read-back mismatches are injected independently.

## Recovery and reuse

Open validates both permanent file identities and every complete transaction. The WAL header's checksum and bounds are checked before trusting variable record lengths. An incomplete final record is discarded; a malformed complete record fails closed. Previous metadata descriptors connect transactions into a contiguous chain.

Recovery overlays the newest committed image for each changed page onto the checkpoint, then validates the resulting complete tree. Metadata includes a checksum of all node images, so a checkpoint containing individually valid pages from different generations cannot masquerade as a complete checkpoint. Missing allocated pages, broken leaf links, stale separators, and torn root metadata are detected or reconstructed from the retained WAL.

Checkpoint writes node pages in ID order and metadata last. After main-file sync and read-back, it truncates the log to its permanent header and syncs the new length. If an interrupted reset leaves an obsolete log prefix beside a newer valid checkpoint, recovery syncs that checkpoint and clears the prefix before accepting appends. Retained WAL bytes are synced before recovered state is served.

## Inspector fidelity

Snapshots include global tree dimensions plus summaries for every node. `records`, `bytes`, `used_bytes`, `checksum`, and `page_generation` describe the selected page. Its generation can be older than the tree generation when that page was unchanged. Page 0 can be inspected alongside leaves and internal routing tables. Checkpoint bytes are absent when the selected page has no valid checkpoint image.

The tree explorer shows the selected internal page (or the parent of a selected leaf) and up to three actual children. Ancestry controls, child pagination, the full page selector, and next-leaf links make every page reachable without laying out 1,024 cards at once. Highlights use actual search paths, changed page IDs, and committed split events. Root/branch/leaf roles have text labels as well as color.

The page map and hex view use exact byte spans. Range results include their source leaf IDs and a next-key cursor; scans use an inclusive start, an optional exclusive end, and a 1–256 result limit. A cursor resumes against the current committed tree, not a retained snapshot from an earlier request. The sample button commits 64 deterministic records with full-size keys and 1,000-byte values; it checks for collisions before inserting.

Snapshots perform no I/O and emit no events. The engine retains 128 events and returns the latest 32 WAL frame descriptions; the interface displays 16 events and six frames, with total counts labeled separately. Split events are emitted only after successful commit. Polling pauses during commands and rejects stale responses. Disconnect leaves a labeled last verified snapshot and disables writes. Full timeline playback, coordinated motion, and guided stories belong to phase 4.

## Split recovery lab

Each run creates a disposable pair under `recovery-lab/` beside the main database. The parent checkpoints deterministic keys of the form `item/00000/` followed by 53 `k` bytes, with 1,000-byte values. Two additional puts trigger the split:

| Workload     | Baseline                             | Whole committed result               |
| ------------ | ------------------------------------ | ------------------------------------ |
| `leaf_split` | 3 records, 1 node page, height 1     | 5 records, 3 node pages, height 2    |
| `root_split` | 116 records, 59 node pages, height 2 | 118 records, 62 node pages, height 3 |

The child opens that pair and pauses at an exact engine boundary. The parent waits for the boundary acknowledgment, terminates and reaps the child, then opens the files and checks every key/value and tree height. The receipt includes the process identity/exit, file path, baseline and recovered dimensions, attempted-record outcomes, and recovery metadata. The primary database is never supplied to the worker.

Four boundaries are available in the UI. CLI tests exercise 13 boundaries for each workload, including a metadata WAL image and an individual checkpoint page. Core fault tests cover every emitted page boundary with both process-loss and modeled power-loss semantics. Unknown boundaries/workloads are rejected before creating files; timeout or invariant failure is an error. A paused orphan worker exits after 20 seconds. Lab files remain available locally for inspection.

## Local API

The bridge binds to `127.0.0.1`; its database path is set at startup. Writes require `X-Walnut-Client: inspector-v1`, a request convention independent of snapshot version 3. Host and Origin checks reject unrelated websites. This is not authentication against other local programs.

Every route accepts `?page=<id>` to choose the returned snapshot page; the default is 1. Page selection is validated before mutations so an invalid selection cannot conceal a successful write. Reopen remains available when a failed operation has poisoned or closed the handle.

| Route                  | JSON body                       | Result                                          |
| ---------------------- | ------------------------------- | ----------------------------------------------- |
| `GET /api/snapshot`    | —                               | Current selected-page and tree snapshot         |
| `POST /api/put`        | `{key, value}`                  | Commit one put                                  |
| `POST /api/get`        | `{key}`                         | Committed value and actual search path          |
| `POST /api/range`      | `{start, end, limit}`           | Ordered records, leaf IDs, next key             |
| `POST /api/grow`       | `{}`                            | Commit 64 sample records                        |
| `POST /api/stage`      | `{key, value}`                  | Add to pending batch                            |
| `POST /api/batch`      | `{writes: [{key, value}, ...]}` | Validate and commit a batch                     |
| `POST /api/commit`     | `{}`                            | Commit pending batch                            |
| `POST /api/discard`    | `{}`                            | Discard pending batch                           |
| `POST /api/checkpoint` | `{}`                            | Checkpoint committed tree                       |
| `POST /api/reopen`     | `{}`                            | Close, recover, reset session                   |
| `POST /api/lab`        | `{boundary, scenario}`          | Disposable split scenario; default `root_split` |

Bodies are capped at 128 KB and unknown fields are rejected. Commands return a fresh snapshot with their result. The inspector rejects generations outside JavaScript's exact integer range; the Rust CLI retains the full unsigned 64-bit generation.

## Compatibility

`upgrade <source> <new-target>` validates format 1 or 2 in a private in-memory recovery copy, builds a format-3 tree, and creates a new pair with a new identity. Source files remain locked and unchanged, including an incomplete legacy WAL tail. Existing targets are never overwritten. The old implementation remains under `walnut_core::legacy` with its regression tests and [format reference](storage-format-2.md).
