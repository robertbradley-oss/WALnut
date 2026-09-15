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
  generation: number;
  page_size: number;
  header_size: number;
  used_bytes: number;
  key_limit: number;
  value_limit: number;
  checksum: string;
  records: StoredRecord[];
  bytes: number[];
  staged: { key: string; value: string }[];
  staged_used_bytes: number | null;
  checkpoint_generation: number | null;
  checkpoint_bytes: number[] | null;
  wal_bytes: number;
  wal_header_bytes: number;
  wal_frames: WalFrame[];
  wal_frame_count: number;
  wal_limit: number;
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
}
export interface WalFrame {
  generation: number;
  previous_generation: number;
  operations: number;
  offset: number;
  length: number;
  checksum: string;
}
export interface LabResult {
  run_id: string;
  boundary: string;
  process_id: number;
  process_terminated: boolean;
  process_exit: string;
  outcome: "batch_absent" | "batch_recovered";
  database_path: string;
  failure_model: "process_termination";
  commit_returned: boolean;
  snapshot: Snapshot;
}
