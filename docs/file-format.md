# WALnut formats — storage 3, page 2, events 3

All integers are unsigned little-endian. All checksums are IEEE CRC32. They detect accidental corruption; they do not authenticate data. The previous single-page layout is preserved in [storage-format-2.md](storage-format-2.md).

## File pair

`name.db` and `name.db.wal` each begin with an immutable, checksummed 64-byte identity header. The main file holds page 0 (metadata), then node pages 1 through `next_id - 1`. Physical page offset is `64 + page_id * 4096`. A new empty database has one leaf and one metadata page: 8,256 bytes plus the 64-byte WAL.

| Offset | Bytes | Meaning                                       |
| ------ | ----- | --------------------------------------------- |
| 0      | 8     | Main magic `WALNDB03` or WAL magic `WALNWAL3` |
| 8      | 4     | Storage version: 3                            |
| 12     | 4     | Page size: 4,096                              |
| 16     | 16    | Matching random database identity             |
| 32     | 28    | Reserved, zero                                |
| 60     | 4     | CRC32 of bytes 0–59                           |

Node IDs are allocated monotonically, at most 1,024. No pages are reclaimed. The main file grows at checkpoint; uncheckpointed new pages reside in the WAL. Keep both files together and stop the owner before copying. A missing/mismatched companion fails closed. Format 1/2 files require explicit upgrade into a new pair.

## Page header

Every page is exactly 4,096 bytes; the fixed header occupies 64. Offsets below are relative to the page.

| Offset | Bytes | Meaning                                                          |
| ------ | ----- | ---------------------------------------------------------------- |
| 0      | 8     | Magic `WALPAGE2`                                                 |
| 8      | 2     | Page version: 2                                                  |
| 10     | 1     | Kind: 0 metadata, 1 leaf, 2 internal                             |
| 11     | 1     | Level: leaf 0, internal 1–15, metadata 0                         |
| 12     | 4     | Page ID; metadata is 0                                           |
| 16     | 8     | Page generation                                                  |
| 24     | 2     | Record count (leaf), separator count (internal), or 0 (metadata) |
| 26     | 2     | Used bytes including the header                                  |
| 28     | 4     | CRC32 of all 4,096 bytes, treating this field as zero            |
| 32     | 32    | Kind-specific fields                                             |

Unused bytes after the used boundary must be zero. Node generations cannot exceed the tree generation. A page that was not changed in a batch can retain an older generation.

### Metadata, page 0

| Offset | Bytes | Meaning                                               |
| ------ | ----- | ----------------------------------------------------- |
| 32     | 4     | Root node ID                                          |
| 36     | 4     | Next unallocated node ID                              |
| 40     | 4     | Tree height, including leaf level                     |
| 44     | 4     | Reserved, zero                                        |
| 48     | 8     | Total record count                                    |
| 56     | 4     | CRC32 of all encoded node pages in ascending ID order |
| 60     | 4     | Reserved, zero                                        |

Metadata uses 64 bytes and has no payload. Its generation is the committed tree generation. The state checksum includes every node image with its own page CRC; it detects mixed checkpoints whose individual page checksums are all valid.

### Leaf pages

Bytes 32–35 hold the next leaf ID, or 0 at the end of the chain; bytes 36–63 are zero. Records begin at offset 64. Each stores `u16 key_length`, `u16 value_length`, then UTF-8 key and value bytes. Keys contain 1–64 bytes, values 0–1,024. Keys are strictly ordered by bytes, case-sensitive, unique, and not normalized. An empty value differs from an absent key.

`used = 64 + sum(4 + key_length + value_length)`. Overflow splits the page; value growth can cause a split even when record count is unchanged. Non-root leaves must contain records. The next-leaf chain exactly matches tree order.

### Internal pages

Bytes 32–35 hold the first child ID; bytes 36–63 are zero. Each entry from offset 64 contains `u16 key_length`, `u32 right_child_id`, then key bytes. Each separator is the minimum key in its right subtree; equality routes right. An internal node has at least one separator and one more child than separators. Children are exactly one level lower.

`used = 64 + sum(6 + key_length)`. With 64-byte keys, 57 separators fit; a 58th overflows. Splits promote one separator to the parent, and propagation may create a new root. Split points balance encoded bytes while retaining nonempty sides; minimum byte occupancy is not enforced.

## WAL transaction

The log holds a permanent header followed by variable-size transactions. It is bounded by 1,024 transactions and 32 MiB including the file header. Each transaction contains a 64-byte header, full changed-page images in ascending page-ID order, a body CRC, and a separate 32-byte marker. Page 0 comes first and every newly allocated node must be included.

### Transaction header

| Offset | Bytes | Meaning                                  |
| ------ | ----- | ---------------------------------------- |
| 0      | 8     | Magic `WNTX0003`                         |
| 8      | 4     | Body size: `64 + image_count * 4096 + 4` |
| 12     | 4     | Image count: 2–1,025                     |
| 16     | 8     | Committed generation                     |
| 24     | 8     | Previous generation, exactly one less    |
| 32     | 4     | Put count: 1–64                          |
| 36     | 4     | Previous next-page ID                    |
| 40     | 4     | Previous root ID                         |
| 44     | 4     | Previous height                          |
| 48     | 8     | Previous record count                    |
| 56     | 4     | Previous complete-tree checksum          |
| 60     | 4     | CRC32 of header bytes 0–59               |

Images begin at offset 64. The four bytes after the final image contain CRC32 of the header and all images. All included pages have the committed generation. Metadata descriptors form a contiguous chain across transactions, allocation and record count do not regress, and node IDs are ordered and unique.

### Commit marker

These offsets are relative to the marker, which starts at transaction offset `body_size`.

| Offset | Bytes | Meaning                       |
| ------ | ----- | ----------------------------- |
| 0      | 8     | Magic `WNCMIT03`              |
| 8      | 8     | Repeated committed generation |
| 16     | 4     | Repeated body CRC32           |
| 20     | 8     | Reserved, zero                |
| 28     | 4     | CRC32 of marker bytes 0–27    |

A transaction's total size is `100 + image_count * 4096`. The engine writes the header, each image, body CRC, and marker separately. It syncs and verifies the complete transaction before acknowledging. A complete header must validate before recovery trusts its length or allocates a body buffer. An incomplete final header/body/marker is discarded; corrupt complete data fails closed. See the [tree contract](tree-contract.md) for recovery, checkpoint ordering, and the failure model.

## Events and snapshots

JSON `schema_version` is 3, `format_version` is 2, and `storage_format_version` is 3. Event identity is `(session_id, sequence)`; `operation` groups events from one command. Events carry optional `page_id`, `related_page`, and `key`. Their generation is the visible committed generation at that event; earlier append/sync events precede the committed-state advance.

| Event                                                            | Meaning                                                     |
| ---------------------------------------------------------------- | ----------------------------------------------------------- |
| `opened` / `created`                                             | Validated existing tree or initialized new pair             |
| `batch_staged` / `batch_discarded`                               | Pending memory changed                                      |
| `wal_frame_written`                                              | Header and changed-page body appended                       |
| `commit_marker_written`                                          | Marker appended; sync pending                               |
| `wal_synced`                                                     | WAL sync and exact transaction read-back succeeded          |
| `page_allocated`, `leaf_split`, `internal_split`, `root_changed` | Committed structural changes, with page IDs                 |
| `search_step`                                                    | A page visited by a lookup, completed write path, or scan   |
| `read_found` / `read_missing` / `range_read`                     | Committed read result                                       |
| `transaction_committed`                                          | Whole candidate tree is visible                             |
| `checkpoint_written`                                             | Node pages and metadata written; WAL retained               |
| `checkpoint_complete`                                            | Main pages synced/verified, WAL truncated/synced            |
| `recovery_complete`                                              | Committed images replayed or trailing/obsolete data removed |
| `commit_failed` / `checkpoint_failed`                            | I/O failed; reopen required                                 |

The trace is optional and capped at 128 events. Snapshot frame descriptions are capped at the latest 32 transactions; counts still report the whole log. Snapshots include global tree generation, height/root/count/checksum, every node summary, last search path, changed-page IDs, split descriptions, staging, checkpoint generation, physical file sizes, and recovery details.

`page_id` selects the local `records`, `bytes`, `page_kind`, `page_generation`, `used_bytes`, and `checksum`; internal/metadata pages have no leaf records. `checkpoint_bytes` can be null for a newly allocated page or invalid checkpoint. `staged_used_bytes` totals used node bytes in the candidate tree; it is not the selected page's occupancy. The bridge adds the database filename.

## Portable recording bundle

The self-contained replay embeds bundle `schema_version: 1`. `source` contains the package version, 40-character Git revision, dirty-source flag, ISO capture time, platform, engine executable SHA256, and a description of path redaction. `stories` contains exactly one capture of each scenario (`split`, `recovery`, `checkpoint`); `notices` retains the embedded libraries' licenses.

Each story retains story schema 1 and its source engine/storage/page versions, workload, run ID, frames, and optional process receipt. A frame has its operation kind, command, explanation, focus page, global snapshot, and all captured page images. Snapshot/page validation uses the same protocol checks as the live workbench. No database format changes are introduced by this wrapper. [Export and reproduction details](replay.md).

## Errors

Input and allocation errors occur before persistence: `invalid_key`, `invalid_value`, `invalid_batch`, `invalid_range`, `database_full`, `generation_limit`, and `page_not_found`. `batch_pending` preserves staging; `checkpoint_required` retains the pending candidate for retry. `database_locked` rejects a second owner. `missing_wal`, `identity_mismatch`, `wal_gap`, `metadata_mismatch`, `corrupt_wal`, `corrupt_tree`, and `unrecoverable_tree` fail closed. Unsupported/invalid file headers are rejected.

Failed I/O or read-back during commit/checkpoint poisons the handle; subsequent commands receive `needs_reopen`. A valid complete transaction whose acknowledgment was interrupted may recover whole. Durability remains bounded by the documented sync model and established file-pair assumptions.
