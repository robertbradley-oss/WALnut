# Phase 2 architecture

## One owner, one logical page, two files

The Rust engine owns an exclusively locked database/WAL pair. CLI commands own it for one invocation; the bridge owns it until stopped or reopened. Commands run serially. Records use an in-memory ordered map; the on-disk B+ tree belongs to stage 3.

```text
React inspector ── same-origin JSON ── Rust bridge / CLI
                                           │
                                      Engine<D, W>
                                       /       \
                            checkpoint file    write-ahead log
                            identity + page    identity + transactions
```

Both files have permanent, checksummed identity headers. A commit appends a full-page redo image and a separate commit marker to the WAL. It synchronizes the WAL and verifies read-back before exposing the batch. The main page changes only during checkpoint. See the [recovery contract](recovery-contract.md) for the failure model and [file format](file-format.md) for the exact bytes.

## Three states

- **Staged:** 1–64 puts held in memory. Reads still see committed records. Reopen discards staging. Duplicate keys use the final value.
- **Committed:** the complete batch has passed WAL sync and verification. One batch increments the generation once. Even a single `put` uses this path.
- **Checkpointed:** the main file has been synced and verified before the log is shortened and synced. Checkpoint retains pending puts because it does not change the committed generation.

The core validates every key/value and the final page size before I/O. Immediate `put` and `batch` reject an existing staged batch. A full WAL returns `checkpoint_required` and retains pending puts. All I/O failures during commit/checkpoint poison the handle; reads, writes, staging, and snapshots then require reopen.

The `Storage` boundary provides size, exact read, full write, sync, and truncate. A failed call may already have changed bytes. The deterministic test implementation separates live bytes from bytes retained after successful sync; modeled power loss discards the unsynced changes. Fault tests also inject partial writes and truncations, failed reads/syncs, and read-back mismatches.

## Recovery and reuse

Open validates file identity, main-page structure, every complete WAL transaction, and the generation chain. A final incomplete fragment is removed. A malformed complete transaction fails closed. The latest full-page image can reconstruct committed state when a checkpoint write tore the main page; recovery leaves that image in the log until a later explicit checkpoint repairs the main file.

Recovery synchronizes the retained WAL before reporting success. A valid marker that survived an interrupted reply may therefore become a recovered whole transaction. This does not mean the original caller received an acknowledgment.

An interrupted checkpoint reset can leave a prefix older than the valid main page. Appending after that prefix would create a generation gap. Recovery first syncs the main page, then clears and syncs that obsolete prefix. It never rolls the main page backward. The permanent headers avoid a second protocol for renaming or rewriting log identities during reuse.

## Inspector fidelity

Snapshots contain committed records and bytes, checkpoint bytes/generation when valid, staged puts, WAL size and frame metadata, and the recovery report. Snapshots do not perform I/O or produce events. The engine retains 128 events and returns the latest 32 WAL frame descriptions; the interface displays 16 events and six frames, with the total frame count separately labeled.

The page map uses actual record byte spans. The hex view switches between the committed image and main-file checkpoint. A selected record highlights its actual key/value bytes in the committed view. The WAL lane exposes frame generation, operation count, offset, size, and checksum. Events describe steps that completed; there is no simulated playback clock in this phase.

The client pauses polling during commands, rejects older responses, and labels the retained snapshot on disconnect. A failed command does not become a success notice. The layout uses native controls, text state labels, local fonts, and reduced-motion support. The full coordinated tree/replay experience belongs to stage 4.

## Recovery lab

Each lab run creates a new disposable pair below `recovery-lab/` beside the main database. The parent seeds `seed=kept` and checkpoints. A child of the same executable opens that pair, stages `alpha=one` and `beta=two`, and pauses at the requested engine boundary. The parent waits for the exact boundary acknowledgment, terminates and reaps the child, opens the actual files, and returns a receipt with process identity/exit, recovered records, and recovery metadata. Unknown boundaries are rejected before creating files. A timeout or unexpected outcome is an error.

The bridge stays alive and retains its original database. The lab never sends its primary database path to the worker. Four boundaries appear in the UI; all ten are exercised by CLI tests. If the parent disappears, a paused worker exits on its own after 20 seconds. Receipts describe process termination, not physical power loss. Lab files remain available for inspection and are not committed to Git.

## Local API

The server binds to `127.0.0.1`. The database path is supplied at startup, not through the browser. JSON writes require `X-Walnut-Client: inspector-v1`; this is a request convention, independent of event schema version 2. Host and Origin checks reject unrelated websites. The local API is not authentication against programs running on the same computer.

| Route                  | JSON body                       | Result                             |
| ---------------------- | ------------------------------- | ---------------------------------- |
| `GET /api/snapshot`    | —                               | Current verified snapshot          |
| `POST /api/put`        | `{key, value}`                  | Commit one put                     |
| `POST /api/get`        | `{key}`                         | Read committed value               |
| `POST /api/stage`      | `{key, value}`                  | Add to pending batch               |
| `POST /api/batch`      | `{writes: [{key, value}, ...]}` | Validate and commit a batch        |
| `POST /api/commit`     | `{}`                            | Commit pending batch               |
| `POST /api/discard`    | `{}`                            | Discard pending batch              |
| `POST /api/checkpoint` | `{}`                            | Checkpoint committed state         |
| `POST /api/reopen`     | `{}`                            | Close, recover, reset session      |
| `POST /api/lab`        | `{boundary}`                    | Run disposable subprocess scenario |

Bodies are capped at 128 KB and unknown fields are rejected. Commands return a fresh snapshot with their result. Snapshot numbers above the browser's exact integer range are rejected by the inspector; the Rust CLI retains the full unsigned 64-bit generation.

## Next extension

Stage 3 replaces the single logical page with B+ tree pages and includes page allocation/root changes inside atomic transactions. That work must preserve these commit and recovery invariants. Historical [stage 1 results](stage-1.md) describe the original in-place write design; [stage 2 results](stage-2.md) describe this implementation.
