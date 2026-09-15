# WALnut formats — storage 2, page 1, events 2

## File pair

`name.db` is 4,160 bytes: a 64-byte file header followed by one logical page. `name.db.wal` contains its own 64-byte header plus zero or more 4,164-byte transactions. All integers are unsigned little-endian. A file header is immutable during commit/checkpoint.

| Offset | Bytes | Meaning                                       |
| ------ | ----- | --------------------------------------------- |
| 0      | 8     | Main magic `WALNDB02` or WAL magic `WALNWAL2` |
| 8      | 4     | Storage version: 2                            |
| 12     | 4     | Logical page size: 4,096                      |
| 16     | 16    | Matching random database identity             |
| 32     | 28    | Reserved, zero                                |
| 60     | 4     | CRC32 of bytes 0–59                           |

The companion must exist and match. Stop the owner before copying **both** files as a pair. A stage 1 standalone page is explicitly copied with `upgrade <source> <new-target>`; old bytes are never silently reinterpreted.

## WAL transaction

Transactions begin at file offset `64 + n * 4164`, with at most 1,024 complete transactions between checkpoints. Offsets below are relative to one transaction.

| Offset | Bytes | Meaning                                       |
| ------ | ----- | --------------------------------------------- |
| 0      | 8     | Frame magic `WNFRAME2`                        |
| 8      | 8     | Committed generation                          |
| 16     | 8     | Previous generation; must be exactly one less |
| 24     | 4     | Page image size: 4,096                        |
| 28     | 4     | Put count: 1–64                               |
| 32     | 4,096 | Complete encoded page image                   |
| 4,128  | 4     | Body CRC32 over bytes 0–4,127                 |
| 4,132  | 8     | Commit magic `WNCOMIT2`                       |
| 4,140  | 8     | Repeated generation                           |
| 4,148  | 4     | Repeated body CRC32                           |
| 4,152  | 8     | Reserved, zero                                |
| 4,160  | 4     | Marker CRC32 over bytes 4,132–4,159           |

The engine writes the 4,132-byte body and the 32-byte marker separately, syncs the WAL, and verifies the whole transaction before acknowledging. A complete transaction must validate all checksums, reserved bytes, generation links, operation bounds, and page structure. An incomplete trailing fragment is distinguished by its length. See the [recovery contract](recovery-contract.md) for when it can be discarded and how log reset works.

## Page

The logical page is exactly 4,096 bytes. These offsets are relative to the page, which starts at main-file offset 64 or transaction offset 32. The fixed page header occupies 32 bytes.

| Offset | Bytes | Meaning                                                        |
| ------ | ----- | -------------------------------------------------------------- |
| 0      | 8     | Magic: `57 41 4C 4E 55 54 00 00` (`WALNUT` plus two NULs)      |
| 8      | 2     | Format version: 1                                              |
| 10     | 2     | Header length: 32                                              |
| 12     | 4     | Page ID: 0                                                     |
| 16     | 8     | Generation: starts at 0; each atomic batch advances once       |
| 24     | 2     | Record count                                                   |
| 26     | 2     | Total used bytes, including the header                         |
| 28     | 4     | CRC32 of the entire page with these four bytes treated as zero |

CRC32 uses the standard IEEE polynomial as implemented by `crc32fast`; it detects accidental byte changes. The decoder additionally validates structure even when a checksum is valid.

Records start at offset 32. Each stores a two-byte key length, a two-byte value length, then the UTF-8 key and value. Keys contain 1–64 bytes; values contain 0–1,024 bytes. No Unicode normalization is performed. Records are strictly ordered by key bytes, without duplicates. Unused bytes must be zero. An empty value is different from an absent key.

`used_bytes = 32 + sum(4 + key_length + value_length)` and cannot exceed 4,096. Updating a key replaces its value and may change following offsets. A full-page rejection does not write anything. Generation overflow is rejected.

The decoder rejects wrong length, magic, version, header/page ID, checksum, count, record bounds, UTF-8, duplicate/out-of-order keys, inconsistent used bytes, and nonzero padding. An unsupported version receives a distinct `unsupported_format` error.

## Events and snapshots

JSON `schema_version` is 2; `format_version` is the logical page version, and `storage_format_version` is 2. An event is identified by `(session_id, sequence)`; sequences increase within an engine session. `operation` groups the events caused by one command. Generation means the last verified committed generation at that point. Session IDs and sequences are observation metadata, not disk format or transaction IDs.

| Event                                 | Meaning                                                     |
| ------------------------------------- | ----------------------------------------------------------- |
| `opened`                              | Both files validated and recovery completed                 |
| `created`                             | New pair initialized and verified                           |
| `batch_staged` / `batch_discarded`    | Pending memory changed; no persistence claimed              |
| `wal_frame_written`                   | Body append returned successfully                           |
| `commit_marker_written`               | Marker append returned; sync still pending                  |
| `wal_synced`                          | WAL sync and transaction read-back succeeded                |
| `transaction_committed`               | Verified cache advanced; whole batch visible                |
| `checkpoint_written`                  | Main page write returned; WAL retained                      |
| `checkpoint_complete`                 | Main page synced/verified, WAL truncated/synced             |
| `recovery_complete`                   | Replayed transactions or removed trailing/obsolete log data |
| `commit_failed` / `checkpoint_failed` | I/O or read-back failed; reopen required                    |
| `read_found` / `read_missing`         | Lookup against the verified page cache                      |

Tracing can be disabled through the core API. Its retained buffer is capped at 128 events. The inspector shows the latest 16; gaps due to retention do not imply missing database writes. A poisoned handle refuses normal snapshots, so a write failure is surfaced through the command error instead of presenting its retained events as a verified current snapshot.

Snapshots include committed dimensions, bytes, records and checksum, plus pending puts, checkpoint generation/bytes, WAL size/count and latest 32 frame descriptions, and recovery metadata. The bridge adds the database filename. The inspector rejects generations above JavaScript's exact integer range; core/CLI generations remain unsigned 64-bit integers.

## Error behavior

Input errors (`invalid_key`, `invalid_value`, `invalid_batch`, `page_full`, `generation_limit`) occur before persistence. `batch_pending` prevents implicit replacement of staged puts. `checkpoint_required` retains the pending batch until space is reclaimed. `database_locked` rejects competing owners. `missing_wal`, `identity_mismatch`, `wal_gap`, `page_mismatch`, `corrupt_wal`, and `unrecoverable_page` fail closed during recovery. A malformed or unsupported file header is rejected. `migration_required` identifies a legacy-sized file.

`io` and `verification_failed` during commit/checkpoint poison the handle; further commands receive `needs_reopen`. A complete valid transaction whose reply failed may recover whole. Acknowledged durability and atomicity are bounded by the [documented failure model](recovery-contract.md).
