import type { CapturedPage, RecordedStory, Snapshot, TreePage } from "./types";

const PAGE_SIZE = 4096;
const HEADER_SIZE = 64;
const PAGE_LIMIT = 1024;
const WAL_LIMIT = 32 * 1024 * 1024;
const encoder = new TextEncoder();

function assertProtocol(condition: unknown, detail: string): asserts condition {
  if (!condition)
    throw new Error(
      `The engine returned an invalid recording or snapshot: ${detail}.`,
    );
}
function object(value: unknown, field: string): Record<string, unknown> {
  assertProtocol(
    value !== null && typeof value === "object" && !Array.isArray(value),
    `${field} must be an object`,
  );
  return value as Record<string, unknown>;
}
function integer(
  value: unknown,
  field: string,
  min = 0,
  max = Number.MAX_SAFE_INTEGER,
): number {
  assertProtocol(
    typeof value === "number" &&
      Number.isSafeInteger(value) &&
      value >= min &&
      value <= max,
    `${field} is out of bounds`,
  );
  return value;
}
function text(
  value: unknown,
  field: string,
  max: number,
  empty = true,
): string {
  assertProtocol(
    typeof value === "string" &&
      value.length <= max &&
      (empty || value.length > 0),
    `${field} must be bounded text`,
  );
  return value;
}
function array(value: unknown, field: string, max: number): unknown[] {
  assertProtocol(
    Array.isArray(value) && value.length <= max,
    `${field} must be a bounded array`,
  );
  return value;
}
function key(value: unknown, field: string): string {
  const result = text(value, field, 64, false);
  assertProtocol(
    encoder.encode(result).length <= 64,
    `${field} exceeds 64 UTF-8 bytes`,
  );
  return result;
}
function valueText(value: unknown, field: string): string {
  const result = text(value, field, 1024);
  assertProtocol(
    encoder.encode(result).length <= 1024,
    `${field} exceeds 1,024 UTF-8 bytes`,
  );
  return result;
}
function checksum(value: unknown, field: string): string {
  const result = text(value, field, 8, false);
  assertProtocol(
    /^[0-9a-f]{8}$/i.test(result),
    `${field} must be a CRC32 label`,
  );
  return result;
}
function boolean(value: unknown, field: string) {
  assertProtocol(typeof value === "boolean", `${field} must be a boolean`);
}
function bytes(value: unknown, field: string): number[] {
  const result = array(value, field, PAGE_SIZE);
  assertProtocol(
    result.length === PAGE_SIZE,
    `${field} must contain exactly 4,096 bytes`,
  );
  for (const byte of result) integer(byte, field, 0, 255);
  return result as number[];
}
function unsigned(bytes: number[], offset: number, length: number): number {
  let value = 0;
  for (let index = length - 1; index >= 0; index--)
    value = value * 256 + bytes[offset + index];
  return value;
}
function sameBytes(left: number[] | null, right: number[] | null): boolean {
  return left === null || right === null
    ? left === right
    : left.length === right.length &&
        left.every((byte, index) => byte === right[index]);
}
function pageHeader(
  image: number[],
  id: number,
  kind: unknown,
  generation: number,
) {
  assertProtocol(
    String.fromCharCode(...image.slice(0, 8)) === "WALPAGE2" &&
      unsigned(image, 8, 2) === 2,
    "page bytes use an unsupported format",
  );
  assertProtocol(
    unsigned(image, 12, 4) === id && unsigned(image, 16, 8) === generation,
    "page bytes disagree with their identity or generation",
  );
  assertProtocol(
    image[10] === ["metadata", "leaf", "internal"].indexOf(kind as string),
    "page bytes disagree with their kind",
  );
}

function capturedPage(
  input: unknown,
  generation: number,
  checkpointGeneration: number | null,
): CapturedPage {
  const page = object(input, "page");
  const id = integer(page.page_id, "page ID", 0, PAGE_LIMIT);
  const pageGeneration = integer(
    page.page_generation,
    "page generation",
    0,
    generation,
  );
  assertProtocol(
    ["metadata", "leaf", "internal"].includes(page.page_kind as string),
    "unknown page kind",
  );
  assertProtocol(
    (id === 0) === (page.page_kind === "metadata"),
    "metadata must be page 0",
  );
  const used = integer(page.used_bytes, "used bytes", HEADER_SIZE, PAGE_SIZE);
  const image = bytes(page.bytes, "page bytes");
  pageHeader(image, id, page.page_kind, pageGeneration);
  assertProtocol(
    unsigned(image, 26, 2) === used,
    "page bytes disagree with their used boundary",
  );
  assertProtocol(
    unsigned(image, 28, 4) ===
      Number.parseInt(checksum(page.checksum, "page checksum"), 16),
    "page checksum label disagrees with its header",
  );
  if (page.checkpoint_bytes !== null) {
    assertProtocol(
      checkpointGeneration !== null,
      "checkpoint bytes require a checkpoint generation",
    );
    const checkpoint = bytes(page.checkpoint_bytes, "checkpoint bytes");
    const oldGeneration = unsigned(checkpoint, 16, 8);
    integer(
      oldGeneration,
      "checkpoint page generation",
      0,
      checkpointGeneration,
    );
    pageHeader(checkpoint, id, page.page_kind, oldGeneration);
  }
  const records = array(page.records, "page records", 806);
  assertProtocol(
    page.page_kind === "leaf" || records.length === 0,
    "only leaf pages contain records",
  );
  let offset = HEADER_SIZE;
  for (const item of records) {
    const record = object(item, "record");
    const encodedKey = encoder.encode(key(record.key, "record key"));
    const encodedValue = encoder.encode(
      valueText(record.value, "record value"),
    );
    const length = 4 + encodedKey.length + encodedValue.length;
    assertProtocol(
      record.offset === offset &&
        record.length === length &&
        record.key_offset === offset + 4 &&
        record.key_length === encodedKey.length &&
        record.value_offset === offset + 4 + encodedKey.length &&
        record.value_length === encodedValue.length &&
        offset + length <= used,
      "record byte ranges are inconsistent",
    );
    assertProtocol(
      unsigned(image, offset, 2) === encodedKey.length &&
        unsigned(image, offset + 2, 2) === encodedValue.length &&
        encodedKey.every((byte, index) => image[offset + 4 + index] === byte) &&
        encodedValue.every(
          (byte, index) =>
            image[offset + 4 + encodedKey.length + index] === byte,
        ),
      "record text disagrees with its page bytes",
    );
    offset += length;
  }
  if (page.page_kind === "leaf")
    assertProtocol(
      offset === used && unsigned(image, 24, 2) === records.length,
      "leaf records disagree with their encoded count",
    );
  return page as unknown as CapturedPage;
}

function pageMatchesSummary(page: CapturedPage, snapshot: Snapshot) {
  if (page.page_id === 0) {
    assertProtocol(
      page.page_generation === snapshot.generation &&
        page.used_bytes === HEADER_SIZE &&
        unsigned(page.bytes, 24, 2) === 0 &&
        unsigned(page.bytes, 32, 4) === snapshot.root_page_id &&
        unsigned(page.bytes, 36, 4) === snapshot.page_count + 1 &&
        unsigned(page.bytes, 40, 4) === snapshot.tree_height &&
        unsigned(page.bytes, 48, 8) === snapshot.record_count &&
        unsigned(page.bytes, 56, 4) ===
          Number.parseInt(snapshot.state_checksum, 16),
      "metadata bytes disagree with the tree snapshot",
    );
    return;
  }
  const summary = snapshot.pages[page.page_id - 1];
  assertProtocol(
    summary?.id === page.page_id &&
      summary.kind === page.page_kind &&
      summary.generation === page.page_generation &&
      summary.used_bytes === page.used_bytes &&
      summary.level === page.bytes[11] &&
      summary.count === unsigned(page.bytes, 24, 2),
    "selected page disagrees with its tree summary",
  );
  if (summary.kind === "leaf") {
    assertProtocol(
      (summary.next_leaf ?? 0) === unsigned(page.bytes, 32, 4) &&
        (page.records[0]?.key ?? null) === summary.first_key &&
        (page.records.at(-1)?.key ?? null) === summary.last_key,
      "leaf links or bounds disagree with their page bytes",
    );
  } else {
    assertProtocol(
      unsigned(page.bytes, 32, 4) === summary.children[0],
      "internal first child disagrees with its page bytes",
    );
    let offset = HEADER_SIZE;
    summary.separators.forEach((separator, index) => {
      const encoded = encoder.encode(separator);
      assertProtocol(
        unsigned(page.bytes, offset, 2) === encoded.length &&
          unsigned(page.bytes, offset + 2, 4) === summary.children[index + 1] &&
          encoded.every((byte, i) => page.bytes[offset + 6 + i] === byte),
        "internal routing disagrees with its page bytes",
      );
      offset += 6 + encoded.length;
    });
    assertProtocol(
      offset === page.used_bytes,
      "internal routing exceeds its page boundary",
    );
  }
}

/** Validate the bridge contract and bounded geometry; CRC verification stays in Rust. */
export function validateSnapshot(input: unknown): Snapshot {
  const value = object(input, "snapshot");
  assertProtocol(
    value.schema_version === 3 &&
      value.storage_format_version === 3 &&
      value.format_version === 2,
    "unsupported snapshot, storage, or page version",
  );
  assertProtocol(
    value.page_size === PAGE_SIZE &&
      value.header_size === HEADER_SIZE &&
      value.page_limit === PAGE_LIMIT &&
      value.key_limit === 64 &&
      value.value_limit === 1024 &&
      value.wal_header_bytes === 64 &&
      value.wal_limit === 1024 &&
      value.wal_byte_limit === WAL_LIMIT,
    "unsupported storage bounds",
  );
  text(value.session_id, "session ID", 256, false);
  assertProtocol(
    /^[0-9a-f]{32}$/i.test(text(value.database_id, "database ID", 32, false)),
    "invalid database identity",
  );
  text(value.database_name, "database name", 32768, false);
  const generation = integer(value.generation, "generation");
  const checkpointGeneration =
    value.checkpoint_generation === null
      ? null
      : integer(
          value.checkpoint_generation,
          "checkpoint generation",
          0,
          generation,
        );
  const count = integer(value.page_count, "page count", 1, PAGE_LIMIT);
  const root = integer(value.root_page_id, "root page", 1, count);
  const height = integer(value.tree_height, "tree height", 1, 16);
  const records = integer(value.record_count, "record count", 0, count * 806);
  checksum(value.state_checksum, "tree checksum");
  const pages = array(value.pages, "tree pages", PAGE_LIMIT);
  assertProtocol(
    pages.length === count,
    "page count differs from its summaries",
  );
  const parents = new Map<number, number>();
  let leafRecords = 0;
  for (const [index, item] of pages.entries()) {
    const page = object(item, "tree page");
    assertProtocol(
      page.id === index + 1,
      "page summaries must contain unique allocated IDs in order",
    );
    const level = integer(page.level, "page level", 0, height - 1);
    assertProtocol(
      page.kind === (level === 0 ? "leaf" : "internal"),
      "page kind disagrees with its level",
    );
    integer(page.generation, "node generation", 0, generation);
    integer(page.used_bytes, "node used bytes", HEADER_SIZE, PAGE_SIZE);
    const entries = integer(page.count, "node entry count", 0, 806);
    if (page.first_key !== null) key(page.first_key, "first key");
    if (page.last_key !== null) key(page.last_key, "last key");
    assertProtocol(
      (entries === 0) === (page.first_key === null) &&
        (entries === 0) === (page.last_key === null),
      "node key bounds disagree with its count",
    );
    const children = array(page.children, "child pages", PAGE_LIMIT);
    const separators = array(page.separators, "separators", 576);
    if (level === 0) {
      leafRecords += entries;
      assertProtocol(
        children.length === 0 && separators.length === 0,
        "leaf pages cannot have child routes",
      );
      if (page.next_leaf !== null)
        integer(page.next_leaf, "next leaf", 1, count);
    } else {
      assertProtocol(
        entries > 0 &&
          children.length === entries + 1 &&
          separators.length === entries &&
          page.next_leaf === null,
        "internal routing count is inconsistent",
      );
      separators.forEach((separator) => key(separator, "separator"));
      assertProtocol(
        page.first_key === separators[0] && page.last_key === separators.at(-1),
        "internal bounds disagree with their separators",
      );
      for (const child of children) {
        const id = integer(child, "child page", 1, count);
        assertProtocol(
          !parents.has(id) && id !== root,
          "a tree page has duplicate parents or points back to the root",
        );
        parents.set(id, index + 1);
      }
    }
  }
  const summaries = pages as unknown as TreePage[];
  assertProtocol(
    leafRecords === records &&
      parents.size === count - 1 &&
      summaries[root - 1].level === height - 1,
    "tree totals or root level are inconsistent",
  );
  for (const page of summaries) {
    if (page.id !== root)
      assertProtocol(parents.has(page.id), "an allocated page is unreachable");
    for (const child of page.children)
      assertProtocol(
        summaries[child - 1].level === page.level - 1,
        "child levels are inconsistent",
      );
    if (page.next_leaf !== null)
      assertProtocol(
        summaries[page.next_leaf - 1].kind === "leaf" &&
          page.next_leaf !== page.id,
        "leaf link points to an invalid page",
      );
  }
  const ids = (
    input: unknown,
    name: string,
    max: number,
    metadata: boolean,
  ) => {
    for (const id of array(input, name, max))
      integer(id, name, metadata ? 0 : 1, count);
  };
  ids(value.last_search_path, "search path", PAGE_LIMIT + 16, false);
  ids(value.changed_pages, "changed pages", PAGE_LIMIT + 1, true);
  for (const input of array(value.splits, "splits", PAGE_LIMIT)) {
    const split = object(input, "split");
    integer(split.left, "left split page", 1, count);
    integer(split.right, "right split page", 1, count);
    integer(split.level, "split level", 0, height - 1);
    key(split.separator, "split separator");
  }
  const staged = array(value.staged, "staged writes", 64);
  for (const input of staged) {
    const write = object(input, "staged write");
    key(write.key, "staged key");
    valueText(write.value, "staged value");
  }
  if (staged.length) {
    integer(value.staged_page_count, "candidate page count", count, PAGE_LIMIT);
    integer(
      value.staged_used_bytes,
      "candidate used bytes",
      HEADER_SIZE,
      PAGE_LIMIT * PAGE_SIZE,
    );
  } else
    assertProtocol(
      value.staged_page_count === null && value.staged_used_bytes === null,
      "an empty staged batch has candidate pages",
    );
  integer(
    value.database_bytes,
    "main file length",
    64,
    64 + (PAGE_LIMIT + 1) * PAGE_SIZE,
  );
  const walBytes = integer(value.wal_bytes, "WAL length", 64, WAL_LIMIT);
  const walCount = integer(
    value.wal_frame_count,
    "WAL transaction count",
    0,
    1024,
  );
  const walFrames = array(value.wal_frames, "WAL transactions", 32);
  assertProtocol(
    walFrames.length === Math.min(walCount, 32),
    "WAL frame count is inconsistent",
  );
  let previousEnd: number | null = null;
  let previousGeneration: number | null = null;
  for (const input of walFrames) {
    const frame = object(input, "WAL transaction");
    const next = integer(frame.generation, "WAL generation", 1, generation);
    assertProtocol(
      frame.previous_generation === next - 1 &&
        (previousGeneration === null || previousGeneration === next - 1),
      "WAL generations are discontinuous",
    );
    integer(frame.operations, "transaction operation count", 1, 64);
    const offset = integer(frame.offset, "transaction offset", 64, walBytes);
    const length = integer(
      frame.length,
      "transaction length",
      64 + 2 * PAGE_SIZE + 4 + 32,
      WAL_LIMIT,
    );
    const pageIds = array(frame.page_ids, "transaction pages", PAGE_LIMIT + 1);
    ids(pageIds, "transaction page", PAGE_LIMIT + 1, true);
    assertProtocol(
      pageIds.length >= 2 &&
        pageIds[0] === 0 &&
        new Set(pageIds).size === pageIds.length &&
        length === 64 + pageIds.length * PAGE_SIZE + 4 + 32 &&
        offset + length <= walBytes &&
        (previousEnd === null || previousEnd === offset),
      "transaction byte ranges are inconsistent",
    );
    integer(frame.root_page_id, "transaction root", 1, count);
    integer(frame.tree_height, "transaction tree height", 1, height);
    checksum(frame.checksum, "transaction checksum");
    previousEnd = offset + length;
    previousGeneration = next;
  }
  assertProtocol(
    walCount === 0 ? walBytes === 64 : previousEnd === walBytes,
    "WAL length differs from its committed transaction boundary",
  );
  const recovery = object(value.recovery, "recovery");
  for (const name of [
    "scanned_transactions",
    "replayed_transactions",
    "obsolete_frames_removed",
  ])
    integer(recovery[name], name, 0, 1024);
  integer(recovery.discarded_tail_bytes, "discarded WAL tail", 0, WAL_LIMIT);
  boolean(recovery.repaired_page, "checkpoint repair state");
  let previousSequence: number | undefined;
  for (const input of array(value.events, "engine events", 128)) {
    const event = object(input, "event");
    assertProtocol(
      event.schema_version === 3 && event.session_id === value.session_id,
      "event source or schema is inconsistent",
    );
    const sequence = integer(event.sequence, "event sequence", 1);
    assertProtocol(
      previousSequence === undefined || sequence === previousSequence + 1,
      "retained event sequence is discontinuous",
    );
    previousSequence = sequence;
    integer(event.operation, "event operation");
    integer(event.generation, "event generation", 0, generation);
    text(event.kind, "event kind", 128, false);
    text(event.detail, "event detail", 4096);
    if (event.key !== null) text(event.key, "event key", 64);
    if (event.page_id !== null) integer(event.page_id, "event page", 0, count);
    if (event.related_page !== null)
      integer(event.related_page, "related event page", 0, count);
  }
  integer(value.successful_writes, "write count");
  integer(value.reads, "read count");
  boolean(value.tracing, "tracing");
  const snapshot = value as unknown as Snapshot;
  pageMatchesSummary(
    capturedPage(value, generation, checkpointGeneration),
    snapshot,
  );
  return snapshot;
}

/** Story schema 1 records the three bounded Rust scenarios, never arbitrary UI state. */
export function validateStory(input: unknown): RecordedStory {
  const value = object(input, "story");
  assertProtocol(value.schema_version === 1, "unsupported story version");
  assertProtocol(
    ["split", "recovery", "checkpoint"].includes(value.scenario as string),
    "unknown recorded scenario",
  );
  text(value.run_id, "recording ID", 256, false);
  text(value.title, "story title", 512, false);
  const source = object(value.source, "story source");
  text(source.engine_version, "engine version", 128, false);
  text(source.database_path, "recorded database path", 32768, false);
  assertProtocol(
    source.storage_format_version === 3 && source.page_format_version === 2,
    "unsupported recorded storage format",
  );
  assertProtocol(
    source.failure_model ===
      (value.scenario === "recovery" ? "process_termination" : "none"),
    "scenario failure model is inconsistent",
  );
  for (const input of array(source.workload, "source workload", 64)) {
    const write = object(input, "source write");
    key(write.key, "source key");
    valueText(write.value, "source value");
  }
  const expectedKinds =
    value.scenario === "split"
      ? ["baseline", "staged", "committed", "lookup"]
      : value.scenario === "recovery"
        ? ["baseline", "committed", "crashed", "recovered", "lookup"]
        : ["baseline", "committed", "checkpointed", "reopened"];
  const frames = array(value.frames, "recorded frames", 5);
  assertProtocol(
    frames.length === expectedKinds.length,
    "recording is missing operation checkpoints",
  );
  const frameIds = new Set<string>();
  let databaseId: string | undefined;
  for (const [index, input] of frames.entries()) {
    const frame = object(input, "story frame");
    const id = text(frame.id, "frame ID", 256, false);
    assertProtocol(!frameIds.has(id), "frame IDs must be unique");
    frameIds.add(id);
    assertProtocol(
      frame.kind === expectedKinds[index],
      "recorded operation order is inconsistent",
    );
    text(frame.title, "frame title", 512, false);
    text(frame.explanation, "frame explanation", 4096, false);
    text(frame.command, "recorded command", 4096, false);
    const capture = object(frame.capture, "frame capture");
    const snapshot = validateSnapshot(capture.snapshot);
    assertProtocol(
      snapshot.page_count <= 64,
      "recorded scenario exceeds its bounded page capture",
    );
    assertProtocol(
      databaseId === undefined || databaseId === snapshot.database_id,
      "a recording mixes database identities",
    );
    databaseId = snapshot.database_id;
    const pages = array(capture.pages, "captured pages", 65);
    assertProtocol(
      pages.length === snapshot.page_count + 1 &&
        frame.focus_page_id === snapshot.page_id,
      "recorded focus or page count is inconsistent",
    );
    for (const [id, input] of pages.entries()) {
      const page = capturedPage(
        input,
        snapshot.generation,
        snapshot.checkpoint_generation,
      );
      assertProtocol(
        page.page_id === id,
        "captured pages must include every allocated ID exactly once",
      );
      pageMatchesSummary(page, snapshot);
      if (id === snapshot.page_id)
        assertProtocol(
          sameBytes(page.bytes, snapshot.bytes) &&
            sameBytes(page.checkpoint_bytes, snapshot.checkpoint_bytes),
          "focused snapshot bytes differ from their captured page",
        );
    }
  }
  if (value.scenario === "recovery") {
    const process = object(value.process, "terminated worker");
    integer(process.process_id, "worker process ID", 1);
    assertProtocol(
      process.process_terminated === true,
      "worker termination was not confirmed",
    );
    text(process.process_exit, "worker exit", 512, false);
    const committed = object(frames[1], "committed frame");
    const crashed = object(frames[2], "crashed frame");
    assertProtocol(
      JSON.stringify(committed.capture) === JSON.stringify(crashed.capture),
      "crashed frame must preserve the last-known committed capture",
    );
  } else
    assertProtocol(
      value.process === undefined || value.process === null,
      "a non-crash story contains worker termination evidence",
    );
  return value as unknown as RecordedStory;
}
