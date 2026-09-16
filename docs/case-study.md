# The checkpoint succeeded. The next reopen still mattered.

An interrupted WAL reset can leave a perfectly valid **old transaction** behind a newer checkpoint. Opening that file successfully is only half the recovery problem. The engine also has to leave the log safe for the next commit.

This is a worked case from WALnut's existing recovery implementation and regression suite. The failure is injected by the storage model; it is not a claim about a production incident or a physical device test.

## The tempting mistake

Suppose generation 1 contains three records. A second transaction inserts two more records, splits the leaf, and advances the root metadata to generation 2. Checkpointing writes and verifies that complete tree in the main file.

The log reset then fails partway through truncation. Instead of its intended 64-byte identity header, the log retains the complete generation-1 transaction. All of that old transaction's checksums are valid.

| After the interruption        | Main file | WAL |
| ----------------------------- | --------- | --- |
| Latest complete generation    | 2         | 1   |
| Records represented           | 5         | 3   |
| Is its data internally valid? | Yes       | Yes |

A recovery routine can correctly choose the newer main file and return five records, yet still leave a trap. If it appends generation 3 after the obsolete generation-1 frame, the next scanner sees an invalid chain: the new transaction names generation 2 as its predecessor, while the preceding log frame ends at generation 1. Valid individual frames do not make a valid transaction history.

```mermaid
flowchart LR
  A[Main file: generation 2] --> B[Open chooses the checkpoint]
  B --> C[Sync the verified main file]
  C --> D[Discard obsolete WAL frames]
  D --> E[Sync WAL reset]
  E --> F[Next commit begins a valid chain]
```

## The recovery rule

[`Engine::open`](../crates/walnut-core/src/engine.rs) validates the checkpoint as a complete tree. If its generation is newer than the last committed WAL frame, recovery:

1. Synchronizes the verified main file before removing any remaining log evidence.
2. Clears the obsolete frame list and moves the valid WAL end back to the identity header.
3. Truncates and synchronizes the WAL before accepting another operation.
4. Reports `obsolete_frames_removed` in the recovery receipt.

The ordering matters. An I/O failure must propagate; recovery cannot announce a writable database before the retained state and the reusable log agree. [`wal::scan`](../crates/walnut-core/src/wal.rs) checks the full predecessor metadata between transactions, including the root, allocation boundary, record count, and tree checksum.

## Reproduce the edge case

```sh
npm run cargo -- test -p walnut-core --test tree_recovery log_reuse_with_an_obsolete_complete_prefix_does_not_create_a_metadata_gap -- --exact
```

The [regression](../crates/walnut-core/tests/tree_recovery.rs) saves the generation-1 WAL length, commits the split, and injects `Fault::Truncate(prefix.len())` during checkpoint. It then discards the old engine, reopens the damaged pair, verifies all five records and the removal receipt, writes `next → ok`, and reopens a second time to retrieve it.

That final write/reopen is the useful assertion. A test ending at the first successful recovery would miss the log-reuse problem entirely.

## What this says about the design

Recovery establishes a state from which future commits remain valid. It is more than reconstructing the last visible records. WALnut keeps that rule explicit through complete-tree validation, predecessor metadata, modeled storage failures, and tests that continue using the recovered database.

The case covers the injected truncation outcome. It does not establish every possible filesystem or hardware failure; the [recovery contract](tree-contract.md) states the supported boundary.
