# Stage 1 architecture

## Decision: one owned file, one page, serialized commands

Start with a complete path from command to disk to inspector. One Rust engine owns the database file for its lifetime. CLI commands own it for one process invocation; the bridge owns it until stopped or reopened. OS file locking rejects competing WALnut owners. Uncooperative external file editors remain outside the contract.

The engine maintains one decoded page plus its last verified encoded image. Records use Rust's in-memory ordered map in this foundation; it is not an on-disk B+ tree. Page capacity bounds memory and removes eviction and overflow policies from the first slice.

```text
React inspector ── same-origin JSON ── Rust bridge / CLI
                                           │
                                      Engine<S>
                                           │
                            Page codec + Storage interface
                                           │
                           owned file / fault-test storage
```

The bridge processes commands serially. Reads observe the verified cache. Snapshots do not cause extra reads, change counters, or generate events. The inspector polls snapshots every 1.5 seconds and receives the updated snapshot directly after a command. Snapshot responses contain only one bounded page and the last 128 events.

## Write lifecycle

1. Validate key/value limits and build the next complete page in memory. Reject overflow before I/O.
2. Encode the page, including the next generation and checksum.
3. Write all 4,096 bytes at offset zero.
4. Call file synchronization and propagate errors.
5. Read the page back, validate it, and compare it with the requested image.
6. Replace the verified cache, record success, and reply.

The storage interface exposes size, exact read, full write, and sync. A full-write error may follow a partial write. Once I/O begins, any failure poisons the handle: get, put, and snapshot refuse to serve it. Reopening rereads and validates the file; it may succeed if the bytes form a valid page or fail with corruption. There is no rollback or crash recovery in this stage.

File read-back can be satisfied by the operating system's cache; it is not a measurement of physical media or proof of power-loss survival. File creation and directory durability need explicit treatment with the recovery design.

This boundary follows the distinctions in [Rust's file synchronization documentation](https://doc.rust-lang.org/std/fs/struct.File.html#method.sync_all). The future WAL/checkpoint design is a separate step, informed by [SQLite's WAL explanation](https://www.sqlite.org/wal.html).

## Inspector fidelity

The bytes and decoded records come from the same verified engine image. The page map scales record spans to actual byte length. Selecting a record reveals its length fields, key bytes, and value bytes. The hex inspector pages through all 4,096 bytes in 256-byte windows.

Events describe completed steps, not invented animation stages. Their order is deterministic for an operation; session IDs distinguish reopen cycles. Read-back verification advances the generation; preceding write events still report the last verified generation. Reopening clears session events and counters but preserves the generation stored in the page.

The client pauses polling while a command is in flight and discards older snapshot responses. On disconnect it labels the retained snapshot as stale and disables writes. Errors remain next to the command; status does not rely on a transient toast or color alone.

Native form controls serve the two-command workflow. Custom SVG and CSS provide the page view without a graph/editor dependency. Fonts are bundled locally. Reduced-motion preferences remove transitions.

## Local bridge

The server binds only to `127.0.0.1`. It accepts an explicit database path at startup, not through the browser. API writes require JSON and a custom client header. Host and Origin checks prevent an unrelated website from silently using the local API through normal browser requests. No permissive CORS is provided. The API is a local development interface, not a remotely deployed service or an authentication boundary against local programs.

Routes: `GET /api/snapshot`, `POST /api/put`, `POST /api/get`, `POST /api/reopen`. Input is bounded to 8 KB; unknown fields on get/put are rejected. The server can serve the built inspector, while Vite proxies the API during development.

## Extension boundary

Stage 2 can replace in-place persistence with WAL-backed commits while keeping the command and event boundary. Stage 3 replaces the single-page layout with a real paged B+ tree. Format changes require a new version and explicit compatibility behavior; never silently reinterpret old files.
