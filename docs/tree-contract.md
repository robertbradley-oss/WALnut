# Phase 3: paged tree and atomic recovery

The serialized owner and failure assumptions from phase 2 still apply. The Rust engine owns the complete bounded tree in memory, but reads navigate actual leaf/internal pages and range scans follow leaf links. The page table is not a key index. There is no cache eviction, deletion, reclamation, or concurrent writer in this phase.

## Tree

Storage format 3 contains an immutable 64-byte identity header and 4 KB pages. Page 0 is metadata; node IDs begin at 1 and grow monotonically, up to 1,024 node pages. Metadata contains generation, root ID, next page ID, height, record count, and a checksum over all encoded node pages. This state checksum distinguishes a complete checkpoint from individually valid pages belonging to different generations.

Page format 2 has a 64-byte header. Leaves hold sorted unique UTF-8 key/value records and a next-leaf ID. Internal nodes hold a first child plus sorted separator/right-child pairs. A separator is exactly the minimum key of its right subtree; equality routes right. Nodes split when their encoded bytes exceed 4,096, without an artificial demonstration fanout. Splits propagate upward and can allocate a new root. Variable-size values and updates permit partially occupied pages; no minimum byte occupancy is claimed.

Validation checks IDs and bounds, checksums, ordering, exact separators, child levels, uniform leaf depth, unique reachability of every allocated page, the complete leaf chain, record count, and the state checksum. Reads follow binary-searched separators; ordered scans use an inclusive start, exclusive optional end, and a limit of 1–256 records. A next-key cursor identifies the first result not returned.

## Transaction

A batch of 1–64 puts constructs a candidate tree and validates it before I/O. All changes, including leaf links, internal splits, allocated pages, root and allocation metadata, belong to one transaction. Only changed node images plus page 0 enter the WAL. One synchronized commit advances the generation once; staging is invisible to reads.

The variable-sized WAL record has a checksummed 64-byte header, full page images, a body checksum, and a separate 32-byte commit marker. The header bounds the image count and length before allocation and contains the previous metadata descriptor. Metadata and generation links form a contiguous chain. Every newly allocated ID must have an image in that transaction. A complete corrupt record fails closed; an incomplete final header/body/marker is discarded. A complete header with a bad checksum is corruption, not a guessed tail length.

The WAL is limited to 1,024 transactions or 32 MiB, whichever comes first. A rejected full-log commit keeps the staged batch for a manual checkpoint and retry. A successful acknowledgment follows WAL sync and exact read-back; failed I/O poisons the handle until reopen.

## Checkpoint and recovery

Checkpoint syncs the WAL, writes all committed node pages, writes metadata last, syncs the main file, and verifies every encoded image. Only then does it truncate the WAL to its permanent header and sync the new length. Per-page pause points allow tests to interrupt a checkpoint between individual page writes.

Recovery overlays all committed WAL images onto the main pages before validating the resulting tree against its metadata/state checksum. This repairs torn pages, incomplete allocation, mixed checkpoints, and root changes. If the valid main checkpoint is newer than an old log prefix left by interrupted truncation, recovery syncs it and clears that prefix before accepting appends. It never falls back to an older tree when newer valid metadata cannot be recovered.

Retained WAL contents are synced before recovered state is exposed. Repeated recovery must produce the same ordered records, root, allocation, and links. Previously acknowledged transactions survive within the stated sync model; a whole transaction whose reply was interrupted may also survive. Physical power-loss and new directory-entry durability limitations remain those documented in phase 2.

## Compatibility and evidence

Formats 1 and 2 require explicit upgrade into a new format-3 pair. Legacy source files stay locked while their bytes are validated in an in-memory recovery copy; migration does not truncate or sync a source WAL. The original pair remains untouched.

The inspector shows real tree pages, search paths, separators, leaf links, and changed-page IDs. Large child lists are navigable in labeled groups. The split lab uses deterministic 64-byte keys and 1,000-byte values to exercise physical page capacity. Both first-leaf and cascading-root splits are tested before/after commit and at checkpoint boundaries.

The tree follows the routing and leaf-chain concepts described in [CMU's B+ tree project](https://15445.courses.cs.cmu.edu/fall2025/project2/); WALnut implements its own page codec, insertion, transactions, and recovery.
