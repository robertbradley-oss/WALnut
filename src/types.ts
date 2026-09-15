export interface StoredRecord {
  key: string;
  value: string;
  offset: number;
  length: number;
  key_offset: number;
  key_length: number;
  value_offset: number;
  value_length: number;
}
export interface EngineEvent {
  schema_version: number;
  session_id: string;
  sequence: number;
  operation: number;
  kind: string;
  generation: number;
  key: string | null;
  page_id: number | null;
  related_page: number | null;
  detail: string;
}
export interface Snapshot {
  schema_version: number;
  session_id: string;
  format_version: number;
  storage_format_version: number;
  database_id: string;
  database_name: string;
  page_id: number;
  page_kind: "metadata" | "leaf" | "internal";
  page_generation: number;
  generation: number;
  page_size: number;
  header_size: number;
  used_bytes: number;
  key_limit: number;
  value_limit: number;
  checksum: string;
  record_count: number;
  page_count: number;
  page_limit: number;
  tree_height: number;
  root_page_id: number;
  state_checksum: string;
  pages: TreePage[];
  last_search_path: number[];
  changed_pages: number[];
  splits: { left: number; right: number; level: number; separator: string }[];
  records: StoredRecord[];
  bytes: number[];
  staged: { key: string; value: string }[];
  staged_used_bytes: number | null;
  staged_page_count: number | null;
  checkpoint_generation: number | null;
  checkpoint_bytes: number[] | null;
  database_bytes: number;
  wal_bytes: number;
  wal_header_bytes: number;
  wal_frames: WalFrame[];
  wal_frame_count: number;
  wal_limit: number;
  wal_byte_limit: number;
  recovery: {
    scanned_transactions: number;
    replayed_transactions: number;
    discarded_tail_bytes: number;
    repaired_page: boolean;
    obsolete_frames_removed: number;
  };
  events: EngineEvent[];
  successful_writes: number;
  reads: number;
  tracing: boolean;
}
export interface CommandResult {
  key: string;
  value: string | null;
  found: boolean;
}
export interface CommandResponse {
  snapshot: Snapshot;
  result?: CommandResult;
  lab?: LabResult;
  range?: RangeResult;
}
export interface WalFrame {
  generation: number;
  previous_generation: number;
  operations: number;
  offset: number;
  length: number;
  checksum: string;
  page_ids: number[];
  root_page_id: number;
  tree_height: number;
}
export interface LabResult {
  run_id: string;
  boundary: string;
  scenario: "leaf_split" | "root_split";
  baseline: {
    record_count: number;
    page_count: number;
    tree_height: number;
    root_page_id: number;
    generation: number;
  };
  attempted: {
    key: string;
    found: boolean;
    value_bytes: number | null;
    page_id: number | null;
  }[];
  verified_records: number;
  process_id: number;
  process_terminated: boolean;
  process_exit: string;
  outcome: "batch_absent" | "batch_recovered";
  database_path: string;
  failure_model: "process_termination";
  commit_returned: boolean;
  snapshot: Snapshot;
}

export interface TreePage {
  id: number;
  kind: "leaf" | "internal";
  level: number;
  generation: number;
  used_bytes: number;
  count: number;
  first_key: string | null;
  last_key: string | null;
  children: number[];
  separators: string[];
  next_leaf: number | null;
}

export interface RangeResult {
  records: { key: string; value: string; page_id: number }[];
  next_key: string | null;
  path: number[];
}
