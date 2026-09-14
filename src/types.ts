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
}
