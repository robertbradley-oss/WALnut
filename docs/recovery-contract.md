# Phase 2: commit and recovery contract

Historical single-page contract. The failure model below also applies to phase 3; use the [tree contract](tree-contract.md) for current multi-page behavior and [storage-format-2.md](storage-format-2.md) for these legacy bytes.

## Observable guarantees

One owner serializes operations on one logical 4 KB page. A batch contains 1–64 puts and advances the generation once. Validation happens before I/O; duplicate keys within a batch use the last value. Staged changes exist only in memory. Reads and the main inspector show committed data until commit succeeds.

A commit appends a complete page image and a separate checksummed commit marker to the WAL, synchronizes the WAL, verifies the encoded transaction, and only then acknowledges success. It never writes the main database page. Within the failure model below, every acknowledged commit survives reopening; a transaction never becomes partially visible. A complete valid commit whose reply was interrupted may survive as a whole. A failed I/O operation poisons the handle until reopen.

## Failure model

Supported: abrupt process termination; injected short/failed writes and reads; failed synchronization; interrupted checkpoint or log truncation; and modeled power loss that discards unsynchronized changes to already-established files. A successful sync makes the preceding bytes and length stable in that model. Previously synced bytes do not spontaneously change. A failed operation may already have changed some bytes; no rollback is inferred from an error.

Physical power-loss survival across every device/filesystem is not established by these tests. File read-back can come from OS cache. Windows creation of new directory entries is not claimed power-loss durable; model tests begin with an established pair. Unix creation additionally syncs the containing directory. Broken sync guarantees, spontaneous media corruption, external truncation/deletion, malicious changes, and mixing backups are outside the durability guarantee. CRC32 detects accidental corruption, not tampering.

## Files and identity

Storage format 2 uses `name.db` and `name.db.wal`. Both start with a checksummed, immutable 64-byte header carrying the same random 128-bit identity. The main file's page starts at offset 64. The WAL's header is never replaced or shortened during normal operations. Missing or mismatched companion files fail closed.

The logical page retains page format 1. Stage 1's standalone 4 KB files require explicit `upgrade <source> <new-target>`; this copies validated data into a new pair and leaves the source intact. Interrupted initial creation may leave an unusable new pair and is not treated as a successful database creation.

## Log layout and recovery

A transaction has a fixed 4,132-byte body (32-byte frame header, 4,096-byte page image, four-byte CRC32), followed by a 32-byte commit marker. The body includes generation, previous generation, and operation count. The marker repeats the generation and body checksum and has its own checksum. Committed generations must form a contiguous chain; the first frame can start after an earlier checkpoint.

Recovery validates identities, scans complete transactions, and rejects malformed complete transactions. A final fragment shorter than a whole transaction is an incomplete tail, discarded and truncated only after all complete records validate. Previously synced log prefixes are assumed stable; arbitrary deletion of an acknowledged tail is outside this model.

The newest valid full-page image can reconstruct a page torn by an interrupted checkpoint. A valid main page is used when it is at least as new as the WAL. A log starting beyond a valid main page's generation is a gap and is rejected. Full page images make repeated replay idempotent. Recovery synchronizes retained WAL contents before reporting recovered commits and does not checkpoint automatically: the UI can distinguish recovered committed state from the main file.

## Checkpoint and reuse

1. Synchronize the WAL again.
2. Write the latest committed page at main-file offset 64.
3. Synchronize the main file, read it back, and verify the complete page.
4. Truncate the WAL to its permanent 64-byte header.
5. Synchronize the WAL's shortened length before allowing further appends.

Before step 3 succeeds, the complete WAL remains available. After step 3, the main page is a complete recovery copy. An interrupted truncation can leave the old log, a prefix, or just its header; committed generations already in the main file do not roll it backward. No header rewrite or rename is part of checkpoint reuse. Checkpoints can preserve an in-memory staged batch because the committed generation does not change.

The WAL is bounded to 1,024 transactions between checkpoints. Further commits return `checkpoint_required` before writing; checkpointing allows the pending batch to be committed afterward.

## Evidence and inspector

The inspector distinguishes staged (memory), committed (synced WAL), and checkpointed (main file) state. WAL entries, byte counts, generation counters, recovery reports, and events come from the engine. A recovery lab uses separate disposable databases, pauses a child process at a known boundary, kills it, and opens the actual files. It reports the observed state and process exit, without treating a selected outcome as a simulated success.

Test both deterministic storage faults and real process termination. Include append/commit sync, checkpoint write/sync, truncation/reset sync, truncated tails, required committed corruption, identity mismatches, missing WALs, and repeated recovery.

The synchronization order follows the safety distinction described in [SQLite's WAL documentation](https://www.sqlite.org/wal.html). File synchronization behavior is bounded by [Rust's `File::sync_all`](https://doc.rust-lang.org/std/fs/struct.File.html#method.sync_all).
