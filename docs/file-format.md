# WALnut formats — version 1

## Page

The database is exactly 4,096 bytes. All integers are unsigned little-endian. The fixed header occupies 32 bytes.

| Offset | Bytes | Meaning                                                           |
| ------ | ----- | ----------------------------------------------------------------- |
| 0      | 8     | Magic: `57 41 4C 4E 55 54 00 00` (`WALNUT` plus two NULs)         |
| 8      | 2     | Format version: 1                                                 |
| 10     | 2     | Header length: 32                                                 |
| 12     | 4     | Page ID: 0                                                        |
| 16     | 8     | Generation: starts at 0; each put proposes the next page revision |
| 24     | 2     | Record count                                                      |
| 26     | 2     | Total used bytes, including the header                            |
| 28     | 4     | CRC32 of the entire page with these four bytes treated as zero    |

CRC32 uses the standard IEEE polynomial as implemented by `crc32fast`; it detects accidental byte changes. The decoder additionally validates structure even when a checksum is valid.

Records start at offset 32. Each stores a two-byte key length, a two-byte value length, then the UTF-8 key and value. Keys contain 1–64 bytes; values contain 0–1,024 bytes. No Unicode normalization is performed. Records are strictly ordered by key bytes, without duplicates. Unused bytes must be zero. An empty value is different from an absent key.

`used_bytes = 32 + sum(4 + key_length + value_length)` and cannot exceed 4,096. Updating a key replaces its value and may change following offsets. A full-page rejection does not write anything. Generation overflow is rejected.

The decoder rejects wrong length, magic, version, header/page ID, checksum, count, record bounds, UTF-8, duplicate/out-of-order keys, inconsistent used bytes, and nonzero padding. An unsupported version receives a distinct `unsupported_format` error.

## Events and snapshots

JSON `schema_version` is 1. An event is identified by `(session_id, sequence)`; sequences increase within an engine session. `operation` groups the events caused by one command. Generation means the last verified page generation at that point. Session IDs and sequences are observation metadata, not disk format or transaction IDs.

| Event                         | Meaning                                                  |
| ----------------------------- | -------------------------------------------------------- |
| `opened`                      | File read, page parsed, checksum verified                |
| `created`                     | New page initialized and verified                        |
| `write_started`               | Candidate page encoded; no successful disk write claimed |
| `page_written`                | Full file-write operation returned success               |
| `file_synced`                 | OS synchronization returned success                      |
| `page_verified`               | Read-back matched; verified cache and generation updated |
| `write_failed`                | I/O or read-back failed; handle requires reopen          |
| `read_found` / `read_missing` | Lookup against the verified page cache                   |

Tracing can be disabled through the core API. Its retained buffer is capped at 128 events. The inspector shows the latest 16; gaps due to retention do not imply missing database writes. A poisoned handle refuses normal snapshots, so a write failure is surfaced through the command error instead of presenting its retained events as a verified current snapshot.

Snapshots include page dimensions, limits, generation, checksum, bytes, decoded record spans, counters, and retained events. The bridge adds the database filename. JSON numbers represent counters in this first inspector; use string counters before supporting values beyond JavaScript's exact integer range.

## Error behavior

`invalid_key`, `invalid_value`, `page_full`, and `generation_limit` reject input before writing. `database_locked` rejects a competing owner. `corrupt_page` and `unsupported_format` reject unreadable data. `io` and `verification_failed` during writes poison the handle; subsequent operations receive `needs_reopen`. A reopen may validate a complete write even if its earlier reply failed. This stage makes no atomicity guarantee for interrupted writes.
