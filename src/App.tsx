import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import type {
  CommandResponse,
  CommandResult,
  EngineEvent,
  Snapshot,
  StoredRecord,
  LabResult,
  RangeResult,
} from "./types";
import { Journal } from "./Journal";
import { RecoveryLab } from "./RecoveryLab";
import { TreeExplorer, PageContents } from "./TreeExplorer";
import "./recovery.css";

const byteLength = (value: string) => new TextEncoder().encode(value).length;
const hex = (value: number, digits = 2) =>
  value.toString(16).padStart(digits, "0").toUpperCase();
const eventLabels: Record<string, string> = {
  opened: "Database opened",
  created: "Database created",
  write_started: "Page encoded",
  page_written: "Page written",
  file_synced: "File synced",
  page_verified: "Read-back verified",
  read_found: "Key found",
  read_missing: "Key not found",
  write_failed: "Write failed",
  batch_staged: "Put staged in memory",
  batch_discarded: "Batch discarded",
  wal_frame_written: "Page image appended",
  commit_marker_written: "Commit marker appended",
  wal_synced: "WAL synced & verified",
  transaction_committed: "Batch committed",
  checkpoint_written: "Checkpoint page written",
  checkpoint_complete: "Checkpoint complete",
  recovery_complete: "Recovery complete",
  commit_failed: "Commit failed",
  checkpoint_failed: "Checkpoint failed",
  search_step: "Search visited a page",
  range_read: "Range scan complete",
  page_allocated: "Page allocated",
  leaf_split: "Leaf split",
  internal_split: "Branch split",
  root_changed: "New root",
};

function Arrow({ reverse = false }: { reverse?: boolean }) {
  return (
    <svg
      className={reverse ? "arrow reverse" : "arrow"}
      viewBox="0 0 20 20"
      aria-hidden="true"
    >
      <path d="M4 10h12m-5-5 5 5-5 5" />
    </svg>
  );
}

async function request<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api/${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers:
      body === undefined
        ? undefined
        : {
            "Content-Type": "application/json",
            "X-Walnut-Client": "inspector-v1",
          },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(path.startsWith("lab") ? 15000 : 6000),
  });
  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("The engine is unavailable. Start WALnut, then reconnect.");
  }
  if (!response.ok)
    throw new Error(data.error?.message || "The command could not complete.");
  return data as T;
}

function PageMap({
  snapshot,
  selected,
  onSelect,
}: {
  snapshot: Snapshot;
  selected?: StoredRecord;
  onSelect: (key: string) => void;
}) {
  const x = 34,
    y = 34,
    width = 612,
    height = 116;
  const usedWidth = (snapshot.used_bytes / snapshot.page_size) * width;
  return (
    <div className="page-map">
      <div className="map-label">
        <span>
          <span className="tiny-square" /> PAGE{" "}
          {String(snapshot.page_id).padStart(4, "0")} ·{" "}
          {snapshot.page_kind.toUpperCase()}
        </span>
        <span>{snapshot.page_size.toLocaleString()} BYTES</span>
      </div>
      <svg
        viewBox="0 0 680 188"
        role="img"
        aria-label={`Page ${snapshot.page_id}: ${snapshot.used_bytes} of 4096 bytes used`}
      >
        <defs>
          <pattern
            id="free-space"
            width="8"
            height="8"
            patternUnits="userSpaceOnUse"
          >
            <path d="M0 8 8 0" stroke="var(--line)" strokeWidth=".55" />
          </pattern>
        </defs>
        <rect
          x={x}
          y={y}
          width={width}
          height={height}
          rx="6"
          fill="url(#free-space)"
          stroke="var(--line-bright)"
        />
        <rect
          x={x}
          y={y}
          width={(snapshot.header_size / snapshot.page_size) * width}
          height={height}
          fill="#8d9fac"
        />
        {snapshot.page_kind === "internal" && (
          <rect
            x={x + (snapshot.header_size / 4096) * width}
            y={y}
            width={
              ((snapshot.used_bytes - snapshot.header_size) / 4096) * width
            }
            height={height}
            fill="var(--accent-dim)"
          />
        )}
        {snapshot.records.map((record, index) => (
          <rect
            key={record.key}
            x={x + (record.offset / 4096) * width}
            y={y}
            width={(record.length / snapshot.page_size) * width}
            height={height}
            fill={
              record.key === selected?.key
                ? "var(--accent)"
                : index % 2
                  ? "#bd9361"
                  : "#8c7351"
            }
            opacity={record.key === selected?.key ? 1 : 0.75}
            onClick={() => onSelect(record.key)}
          >
            <title>
              {record.key}: {record.length} bytes
            </title>
          </rect>
        ))}
        <line
          x1={x + usedWidth}
          x2={x + usedWidth}
          y1={y - 9}
          y2={y + height + 9}
          stroke="var(--accent)"
          strokeWidth="1"
        />
        <text x={x} y={y - 16} fill="var(--muted)" fontSize="10">
          0x0000
        </text>
        <text
          x={x + width}
          y={y - 16}
          textAnchor="end"
          fill="var(--muted)"
          fontSize="10"
        >
          0x0FFF
        </text>
        {usedWidth < width * 0.7 && (
          <>
            <text
              x={x + usedWidth + (width - usedWidth) / 2}
              y="88"
              textAnchor="middle"
              fill="var(--muted)"
              fontSize="12"
            >
              ROOM TO GROW
            </text>
            <text
              x={x + usedWidth + (width - usedWidth) / 2}
              y="110"
              textAnchor="middle"
              fill="var(--quiet)"
              fontSize="11"
            >
              {(4096 - snapshot.used_bytes).toLocaleString()} bytes free
            </text>
          </>
        )}
        <text x={x} y="177" fill="var(--accent)" fontSize="10">
          {snapshot.used_bytes} bytes used
        </text>
        <text
          x={x + width}
          y="177"
          textAnchor="end"
          fill="var(--quiet)"
          fontSize="10"
        >
          PAGE FORMAT V2
        </text>
      </svg>
      <div className="map-legend">
        <span>
          <i className="header-dot" /> Header <b>{snapshot.header_size} B</b>
        </span>
        <span>
          <i className="record-dot" />{" "}
          {snapshot.page_kind === "internal" ? "Routing" : "Records"}{" "}
          <b>{snapshot.used_bytes - snapshot.header_size} B</b>
        </span>
        <span>
          <i className="free-dot" /> Free <b>{4096 - snapshot.used_bytes} B</b>
        </span>
      </div>
    </div>
  );
}

function ByteInspector({
  snapshot,
  selected,
}: {
  snapshot: Snapshot;
  selected?: StoredRecord;
}) {
  const [windowStart, setWindowStart] = useState(0);
  const [requestedSource, setSource] = useState<"committed" | "checkpoint">(
    "committed",
  );
  const source = snapshot.checkpoint_bytes ? requestedSource : "committed";
  const bytes =
    source === "checkpoint" && snapshot.checkpoint_bytes
      ? snapshot.checkpoint_bytes
      : snapshot.bytes;
  useEffect(() => {
    setWindowStart(selected ? Math.floor(selected.offset / 256) * 256 : 0);
  }, [selected?.key, selected?.offset, snapshot.page_id]);
  const group = (offset: number) => {
    if (offset < snapshot.header_size) return "header-byte";
    if (
      source === "committed" &&
      selected &&
      offset >= selected.offset &&
      offset < selected.offset + selected.length
    ) {
      if (offset < selected.key_offset) return "length-byte";
      return offset < selected.value_offset ? "key-byte" : "value-byte";
    }
    return bytes[offset] ? "stored-byte" : "empty-byte";
  };
  return (
    <section className="byte-inspector" aria-labelledby="bytes-heading">
      <div className="section-heading">
        <h2 id="bytes-heading">
          Under the hood <span>HEX VIEW</span>
        </h2>
        <span className="muted mono">16 bytes / row</span>
      </div>
      <p className="section-note">
        {source === "committed"
          ? "Verified committed page image. Select a record to locate its key and value."
          : `Verified main-file page at its last checkpoint. File offset: ${(64 + snapshot.page_id * 4096).toLocaleString()} bytes.`}
      </p>
      <div className="byte-source" role="group" aria-label="Page byte source">
        <button
          aria-pressed={source === "committed"}
          onClick={() => setSource("committed")}
        >
          Committed page · gen {snapshot.page_generation}
        </button>
        <button
          aria-pressed={source === "checkpoint"}
          disabled={!snapshot.checkpoint_bytes}
          onClick={() => setSource("checkpoint")}
        >
          Checkpoint page ·{" "}
          {snapshot.checkpoint_bytes === null
            ? "unavailable"
            : `gen ${snapshot.checkpoint_generation}`}
        </button>
      </div>
      <div className="hex-scroll">
        <table className="hex-table" aria-label="Encoded page bytes">
          <thead>
            <tr>
              <th scope="col">OFFSET</th>
              {Array.from({ length: 16 }, (_, i) => (
                <th scope="col" key={i}>
                  {hex(i)}
                </th>
              ))}
              <th scope="col" className="ascii">
                TEXT
              </th>
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: 16 }, (_, row) => {
              const offset = windowStart + row * 16;
              return (
                <tr key={offset}>
                  <th scope="row">{hex(offset, 4)}</th>
                  {bytes.slice(offset, offset + 16).map((byte, column) => (
                    <td
                      key={column}
                      className={group(offset + column)}
                      title={`Offset ${offset + column} · ${byte} decimal`}
                    >
                      {hex(byte)}
                    </td>
                  ))}
                  <td className="ascii">
                    {bytes
                      .slice(offset, offset + 16)
                      .map((byte) =>
                        byte >= 32 && byte <= 126
                          ? String.fromCharCode(byte)
                          : "·",
                      )
                      .join("")}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="byte-footer">
        <div className="byte-legend">
          <span>
            <i className="header-dot" /> Header
          </span>
          <span>
            <i className="key-dot" /> Key
          </span>
          <span>
            <i className="record-dot" /> Value
          </span>
        </div>
        <div className="byte-paging">
          <button
            aria-label="Previous 256 bytes"
            disabled={windowStart === 0}
            onClick={() => setWindowStart((s) => s - 256)}
          >
            <Arrow reverse />
          </button>
          <span>
            {hex(windowStart, 4)}–{hex(windowStart + 255, 4)}
          </span>
          <button
            aria-label="Next 256 bytes"
            disabled={windowStart >= 3840}
            onClick={() => setWindowStart((s) => s + 256)}
          >
            <Arrow />
          </button>
        </div>
      </div>
    </section>
  );
}

function EventLog({ events }: { events: EngineEvent[] }) {
  const [expanded, setExpanded] = useState<string | null>(null);
  return (
    <section className="events-panel" aria-labelledby="events-heading">
      <div className="section-heading">
        <h2 id="events-heading">Engine activity</h2>
        <span className="live-tag">
          <i /> LIVE
        </span>
      </div>
      <p className="section-note">Real events from this engine session.</p>
      <ol className="event-list">
        {[...events]
          .reverse()
          .slice(0, 16)
          .map((event) => {
            const id = `${event.session_id}:${event.sequence}`;
            return (
              <li
                key={id}
                className={
                  [
                    "transaction_committed",
                    "checkpoint_complete",
                    "recovery_complete",
                  ].includes(event.kind)
                    ? "verified"
                    : ""
                }
              >
                <button
                  aria-expanded={expanded === id}
                  onClick={() => setExpanded(expanded === id ? null : id)}
                >
                  <span className="event-dot" />
                  <span className="event-text">
                    <strong>{eventLabels[event.kind] || event.kind}</strong>
                    <small>
                      {event.page_id === null
                        ? (event.key ?? "transaction")
                        : `Page ${event.page_id}${event.related_page === null ? "" : ` → ${event.related_page}`}`}
                    </small>
                  </span>
                  <span className="event-number">
                    {String(event.sequence).padStart(3, "0")}
                  </span>
                </button>
                {expanded === id && (
                  <p className="event-detail">
                    {event.detail}
                    <span>
                      Operation {event.operation} · generation{" "}
                      {event.generation}
                    </span>
                  </p>
                )}
              </li>
            );
          })}
      </ol>
      <p className="activity-foot">Latest 16 events · resets on reopen</p>
    </section>
  );
}

export default function App() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const requestId = useRef(0);
  const [connectionError, setConnectionError] = useState("");
  const [commandError, setCommandError] = useState("");
  const [notice, setNotice] = useState("");
  const [operation, setOperation] = useState<"put" | "get" | "range">("put");
  const [key, setKey] = useState("hello");
  const [value, setValue] = useState("from the inside");
  const [selectedKey, setSelectedKey] = useState<string>();
  const [selectedPage, setSelectedPage] = useState(1);
  const [rangeStart, setRangeStart] = useState("");
  const [rangeEnd, setRangeEnd] = useState("");
  const [rangeLimit, setRangeLimit] = useState(32);
  const [rangeResult, setRangeResult] = useState<RangeResult | null>(null);
  const [result, setResult] = useState<CommandResult | null>(null);
  const [labResult, setLabResult] = useState<LabResult | null>(null);
  const [labRunning, setLabRunning] = useState(false);
  const [labError, setLabError] = useState("");
  const keyInput = useRef<HTMLInputElement>(null);

  const accept = useCallback((next: Snapshot) => {
    if (
      next.schema_version !== 3 ||
      next.storage_format_version !== 3 ||
      next.format_version !== 2 ||
      next.bytes.length !== 4096
    )
      throw new Error(
        "This inspector needs storage and event version 3 with page format 2.",
      );
    if (
      !Number.isSafeInteger(next.generation) ||
      (next.checkpoint_generation !== null &&
        !Number.isSafeInteger(next.checkpoint_generation))
    )
      throw new Error(
        "This generation exceeds the inspector's exact integer range. Use the Rust CLI to inspect it.",
      );
    setSnapshot(next);
    setConnected(true);
    setConnectionError("");
  }, []);

  const refresh = useCallback(async () => {
    if (busyRef.current) return;
    const id = ++requestId.current;
    try {
      const next = await request<Snapshot>(`snapshot?page=${selectedPage}`);
      if (requestId.current === id) accept(next);
    } catch (error) {
      if (requestId.current === id) {
        setConnected(false);
        setConnectionError(
          error instanceof Error ? error.message : "Cannot reach the engine.",
        );
      }
    }
  }, [accept, selectedPage]);
  useEffect(() => {
    void refresh();
    const interval = setInterval(() => void refresh(), 1500);
    return () => {
      clearInterval(interval);
      requestId.current++;
    };
  }, [refresh]);

  function selectPage(id: number, key?: string) {
    ++requestId.current;
    setSelectedKey(key);
    setSelectedPage(id);
  }

  async function execute(
    kind:
      | "put"
      | "get"
      | "reopen"
      | "stage"
      | "commit"
      | "discard"
      | "checkpoint"
      | "lab"
      | "range"
      | "grow",
    boundary?: string,
    scenario?: string,
    cursor?: string,
  ) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    ++requestId.current;
    setCommandError("");
    setNotice("");
    setResult(null);
    if (kind === "lab") {
      setLabRunning(true);
      setLabResult(null);
      setLabError("");
    }
    try {
      const next = await request<CommandResponse>(
        `${kind}?page=${selectedPage}`,
        kind === "lab"
          ? { boundary, scenario }
          : kind === "range"
            ? {
                start: cursor ?? rangeStart,
                end: rangeEnd || null,
                limit: rangeLimit,
              }
            : kind === "get"
              ? { key }
              : ["put", "stage"].includes(kind)
                ? { key, value }
                : {},
      );
      accept(next.snapshot);
      if (kind === "grow") selectPage(next.snapshot.root_page_id);
      if (next.range) {
        setRangeResult(next.range);
        setNotice(`Scanned ${next.range.records.length} records in key order.`);
        if (cursor !== undefined) setRangeStart(cursor);
      } else if (["put", "commit", "grow", "reopen"].includes(kind))
        setRangeResult(null);
      if (next.lab) setLabResult(next.lab);
      if (next.result) {
        setResult(next.result);
        if (next.result.found || kind === "get")
          selectPage(
            next.snapshot.last_search_path.at(-1) ?? selectedPage,
            next.result.found ? next.result.key : undefined,
          );
        setNotice(
          kind === "put"
            ? `Committed “${key}”. WAL synced and read-back verified.`
            : next.result.found
              ? `Found “${key}”.`
              : `“${key}” is not in this tree.`,
        );
      } else if (!next.range) {
        const notices: Record<string, string> = {
          reopen: "Database reopened. Committed state recovered and verified.",
          stage: `Staged “${key}”. Reads still see committed data.`,
          commit: "Batch committed. All puts are visible together.",
          discard: "Staged batch discarded. Committed data is unchanged.",
          checkpoint:
            "Checkpoint complete. Main pages synced; WAL reset and synced.",
          lab: "Recovery lab complete. Inspect the receipt below.",
          grow: "Committed 64 sample records. Inspect the new pages and split events.",
        };
        setNotice(notices[kind] || "Done.");
      }
      if (kind === "commit" || kind === "discard") keyInput.current?.focus();
    } catch (error) {
      setCommandError(
        error instanceof Error ? error.message : "The command failed.",
      );
      if (kind === "lab")
        setLabError(
          error instanceof Error ? error.message : "The recovery test failed.",
        );
    } finally {
      busyRef.current = false;
      setBusy(false);
      setLabRunning(false);
    }
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    void execute(operation);
  }
  const selected = snapshot?.records.find(
    (record) => record.key === selectedKey,
  );
  const invalidKey = byteLength(key) === 0 || byteLength(key) > 64;
  const invalidValue = operation === "put" && byteLength(value) > 1024;
  const invalidRange =
    byteLength(rangeStart) > 64 ||
    byteLength(rangeEnd) > 64 ||
    !Number.isInteger(rangeLimit) ||
    rangeLimit < 1 ||
    rangeLimit > 256;
  const currentPage = snapshot?.pages.find((p) => p.id === snapshot.page_id);

  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="/" aria-label="WALnut home">
          <img src="/walnut.svg" alt="" />
          <span>
            WAL<span className="brand-light">nut</span>
            <sup>α</sup>
          </span>
        </a>
        <div className="topbar-center">
          <span className="stage-number">03</span> THE B+ TREE
        </div>
        <span
          className={`connection ${connected ? "online" : ""}`}
          role="status"
        >
          <i />
          {connected ? "Engine connected" : "Engine offline"}
        </span>
      </header>
      <main>
        <section className="intro">
          <div>
            <p className="eyebrow">THE DATABASE, OPENED UP</p>
            <h1>
              Small database.
              <br />
              <span>Nothing hidden.</span>
            </h1>
            <p className="intro-copy">
              Grow a tree. Follow a key. Break a commit.
              <br />A real storage engine, with the lid off.
            </p>
          </div>
          <div className="file-card">
            <div className="file-symbol">
              <span />
              <span />
              <span />
            </div>
            <div>
              <span className="eyebrow">YOUR DATABASE</span>
              <strong>{snapshot?.database_name || "Connecting…"}</strong>
              <small>
                <i /> Local file <span>·</span>{" "}
                {snapshot
                  ? `${snapshot.database_bytes.toLocaleString()} B + ${snapshot.wal_bytes.toLocaleString()} B WAL`
                  : "Waiting for engine"}
              </small>
            </div>
          </div>
        </section>

        {connectionError && (
          <div className="connection-banner" role="alert">
            <div>
              <strong>Connection needs attention</strong>
              <p>
                {connectionError}
                {snapshot
                  ? " The page below is the last verified snapshot."
                  : ""}
              </p>
            </div>
            <button
              className="secondary"
              onClick={() => void refresh()}
              disabled={busy}
            >
              Reconnect
            </button>
          </div>
        )}

        <div className="workspace-heading">
          <div>
            <span className="section-index">01 /</span>
            <h2>Inside the engine</h2>
          </div>
          <span className="muted">
            Linked leaves. Atomic splits. Every byte accounted for.
          </span>
        </div>
        <div className={`workspace ${!connected ? "is-offline" : ""}`}>
          <div className="primary-column">
            {snapshot && (
              <TreeExplorer
                snapshot={snapshot}
                select={selectPage}
                grow={() => void execute("grow")}
                disabled={busy || !connected}
              />
            )}
            {snapshot && (
              <Journal
                snapshot={snapshot}
                disabled={busy || !connected}
                checkpoint={() => void execute("checkpoint")}
              />
            )}
            <div className="engine-panel">
              <div className="panel-topline">
                <div className="page-select">
                  <label className="mono" htmlFor="page-select">
                    PAGE EXPLORER
                  </label>
                  {snapshot && (
                    <select
                      id="page-select"
                      value={selectedPage}
                      disabled={busy || !connected}
                      onChange={(e) => selectPage(Number(e.target.value))}
                    >
                      <option value={0}>P000 · metadata</option>
                      {snapshot.pages.map((p) => (
                        <option key={p.id} value={p.id}>
                          P{String(p.id).padStart(3, "0")} · {p.kind}
                          {p.id === snapshot.root_page_id ? " · root" : ""}
                        </option>
                      ))}
                    </select>
                  )}
                </div>
                <div className="checksum">
                  <i />
                  {snapshot
                    ? `CRC32 ${snapshot.checksum}`
                    : "Awaiting checksum"}
                </div>
              </div>
              {snapshot ? (
                <>
                  <div className="stats">
                    <div>
                      <span>
                        {snapshot.page_kind === "internal"
                          ? "Separators"
                          : snapshot.page_kind === "metadata"
                            ? "Metadata page"
                            : "Page records"}
                      </span>
                      <strong>
                        {(snapshot.page_kind === "metadata"
                          ? 0
                          : (currentPage?.count ?? 0)
                        )
                          .toString()
                          .padStart(2, "0")}
                      </strong>
                    </div>
                    <div>
                      <span>Space used</span>
                      <strong>
                        {((snapshot.used_bytes / 4096) * 100).toFixed(1)}
                        <small>%</small>
                      </strong>
                    </div>
                    <div>
                      <span>Generation</span>
                      <strong data-testid="generation">
                        {snapshot.generation.toString().padStart(2, "0")}
                      </strong>
                    </div>
                    <div>
                      <span>Page size</span>
                      <strong>
                        4<small>KB</small>
                      </strong>
                    </div>
                  </div>
                  <PageMap
                    snapshot={snapshot}
                    selected={selected}
                    onSelect={setSelectedKey}
                  />
                  {snapshot.page_kind !== "leaf" ? (
                    <PageContents snapshot={snapshot} select={selectPage} />
                  ) : (
                    <section
                      className="records-section"
                      aria-labelledby="records-heading"
                    >
                      <div className="section-heading">
                        <h2 id="records-heading">
                          Stored records <span>{snapshot.records.length}</span>
                        </h2>
                        <span className="muted">Ordered by key</span>
                      </div>
                      {snapshot.records.length ? (
                        <div className="records-scroll">
                          <table className="records-table">
                            <thead>
                              <tr>
                                <th>KEY</th>
                                <th>VALUE</th>
                                <th>BYTES</th>
                                <th>OFFSET</th>
                              </tr>
                            </thead>
                            <tbody>
                              {snapshot.records.map((record) => (
                                <tr
                                  key={record.key}
                                  className={
                                    selectedKey === record.key
                                      ? "selected-row"
                                      : ""
                                  }
                                >
                                  <td>
                                    <button
                                      className="record-key"
                                      aria-pressed={selectedKey === record.key}
                                      onClick={() => setSelectedKey(record.key)}
                                    >
                                      <span className="record-icon">⌑</span>
                                      {record.key}
                                    </button>
                                  </td>
                                  <td title={record.value}>
                                    {record.value === "" ? (
                                      <em>empty string</em>
                                    ) : (
                                      record.value
                                    )}
                                  </td>
                                  <td>{record.length}</td>
                                  <td>{hex(record.offset, 4)}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      ) : (
                        <div className="empty-records">
                          <span className="empty-icon">{"{ }"}</span>
                          <div>
                            <strong>An empty page is a good beginning.</strong>
                            <p>
                              Run your first write to give these bytes a little
                              meaning.
                            </p>
                          </div>
                          <button
                            className="text-button"
                            onClick={() => keyInput.current?.focus()}
                          >
                            Write a record <Arrow />
                          </button>
                        </div>
                      )}
                    </section>
                  )}
                  {snapshot.page_kind === "leaf" && (
                    <div className="leaf-link">
                      <span>LEAF CHAIN</span>
                      {currentPage?.next_leaf ? (
                        <button
                          onClick={() => selectPage(currentPage.next_leaf!)}
                          disabled={busy || !connected}
                        >
                          Next leaf P{currentPage.next_leaf} →
                        </button>
                      ) : (
                        <span>End of chain</span>
                      )}
                    </div>
                  )}
                  {selected && (
                    <div className="selection-detail">
                      <span>
                        INSPECTING <strong>{selected.key}</strong>
                      </span>
                      <span>
                        Key {selected.key_length} B <i /> Value{" "}
                        {selected.value_length} B <i /> Length fields 4 B
                      </span>
                    </div>
                  )}
                  <ByteInspector snapshot={snapshot} selected={selected} />
                </>
              ) : (
                <div className="waiting-state">
                  <span className="empty-icon">⌑</span>
                  <h2>Waiting for your page</h2>
                  <p>
                    WALnut will show the file as soon as the engine connects.
                  </p>
                </div>
              )}
            </div>
          </div>
          <aside className="side-column">
            <section
              className="command-panel"
              aria-labelledby="command-heading"
            >
              <div className="section-heading">
                <h2 id="command-heading">Give it a command</h2>
                <span className="command-symbol">&gt;_</span>
              </div>
              <p className="section-note">Small input. Real changes on disk.</p>
              <div
                className="operation-switch"
                role="group"
                aria-label="Operation"
              >
                <button
                  aria-pressed={operation === "put"}
                  onClick={() => {
                    setOperation("put");
                    setResult(null);
                    setNotice("");
                  }}
                >
                  PUT <span>Write</span>
                </button>
                <button
                  aria-pressed={operation === "get"}
                  onClick={() => {
                    setOperation("get");
                    setResult(null);
                    setNotice("");
                  }}
                >
                  GET <span>Read</span>
                </button>
                <button
                  aria-pressed={operation === "range"}
                  onClick={() => {
                    setOperation("range");
                    setResult(null);
                    setNotice("");
                  }}
                >
                  SCAN <span>Range</span>
                </button>
              </div>
              <form onSubmit={submit}>
                {operation === "range" ? (
                  <>
                    <label htmlFor="range-start">
                      Start key <span>INCLUSIVE</span>
                    </label>
                    <input
                      id="range-start"
                      autoComplete="off"
                      spellCheck={false}
                      value={rangeStart}
                      onChange={(e) => setRangeStart(e.target.value)}
                    />
                    <label htmlFor="range-end">
                      End key <span>EXCLUSIVE</span>
                    </label>
                    <input
                      id="range-end"
                      autoComplete="off"
                      spellCheck={false}
                      value={rangeEnd}
                      onChange={(e) => setRangeEnd(e.target.value)}
                    />
                    <label htmlFor="range-limit">
                      Result limit <span>1–256</span>
                    </label>
                    <input
                      id="range-limit"
                      type="number"
                      min={1}
                      max={256}
                      value={rangeLimit}
                      onChange={(e) => setRangeLimit(e.target.valueAsNumber)}
                    />
                    <p className="range-hint">
                      Leave bounds empty to scan all keys. Results follow the
                      leaf links in UTF-8 byte order.
                    </p>
                  </>
                ) : (
                  <>
                    <label htmlFor="record-key">
                      Key{" "}
                      <span
                        aria-hidden="true"
                        className={
                          invalidKey && key.length ? "invalid-count" : ""
                        }
                      >
                        {byteLength(key)} / 64 B
                      </span>
                    </label>
                    <input
                      ref={keyInput}
                      id="record-key"
                      autoComplete="off"
                      spellCheck={false}
                      value={key}
                      onChange={(event) => setKey(event.target.value)}
                      aria-invalid={invalidKey && key.length > 0}
                      aria-describedby="key-limit"
                    />
                    <span className="sr-only" id="key-limit">
                      1 to 64 UTF-8 bytes.
                    </span>
                  </>
                )}
                {operation === "put" && (
                  <>
                    <label htmlFor="record-value">
                      Value{" "}
                      <span
                        aria-hidden="true"
                        className={invalidValue ? "invalid-count" : ""}
                      >
                        {byteLength(value)} / 1,024 B
                      </span>
                    </label>
                    <textarea
                      id="record-value"
                      spellCheck={false}
                      value={value}
                      onChange={(event) => setValue(event.target.value)}
                      aria-invalid={invalidValue}
                      aria-describedby="value-limit"
                      rows={3}
                    />
                    <span className="sr-only" id="value-limit">
                      At most 1,024 UTF-8 bytes. Full pages split automatically.
                    </span>
                  </>
                )}
                <button
                  className="run-button"
                  disabled={
                    busy ||
                    !connected ||
                    (operation === "range" ? invalidRange : invalidKey) ||
                    invalidValue ||
                    (operation === "put" && !!snapshot?.staged.length)
                  }
                  type="submit"
                >
                  <span>
                    {busy
                      ? "Working…"
                      : operation === "put"
                        ? "Commit this put"
                        : operation === "get"
                          ? "Find this key"
                          : "Scan this range"}
                  </span>
                  <Arrow />
                </button>
                {operation === "put" && (
                  <button
                    type="button"
                    className="stage-button"
                    disabled={
                      busy ||
                      !connected ||
                      invalidKey ||
                      invalidValue ||
                      (snapshot?.staged.length ?? 0) >= 64
                    }
                    onClick={() => void execute("stage")}
                  >
                    + Stage in batch
                  </button>
                )}
              </form>
              {!!snapshot?.staged.length && (
                <section className="staged-batch" aria-label="Staged batch">
                  <div className="staged-heading">
                    <strong>
                      {snapshot.staged.length}{" "}
                      {snapshot.staged.length === 1 ? "put" : "puts"} in memory
                    </strong>
                    <span>{snapshot.staged_page_count} candidate pages</span>
                  </div>
                  <ol>
                    {snapshot.staged.map((op, index) => (
                      <li key={index}>
                        <span>{op.key}</span>
                        <code title={op.value}>{op.value || "(empty)"}</code>
                      </li>
                    ))}
                  </ol>
                  <div className="batch-actions">
                    <button
                      className="secondary"
                      disabled={busy || !connected}
                      onClick={() => void execute("commit")}
                    >
                      Commit batch
                    </button>
                    <button
                      className="text-button"
                      disabled={busy || !connected}
                      onClick={() => void execute("discard")}
                    >
                      Discard
                    </button>
                  </div>
                </section>
              )}
              <div className="command-feedback" aria-live="polite">
                {commandError ? (
                  <p className="error-text" role="alert">
                    {commandError}
                  </p>
                ) : notice ? (
                  <p className="success-text">{notice}</p>
                ) : (
                  <p>UTF-8 text · Case-sensitive keys</p>
                )}
                {operation === "get" && result?.found && (
                  <output className="read-result" aria-label="Read value">
                    {result.value === "" ? "(empty string)" : result.value}
                  </output>
                )}
              </div>
              {operation === "range" && rangeResult && (
                <section className="scan-results" aria-label="Range results">
                  <h3>{rangeResult.records.length} records · ordered by key</h3>
                  <ol>
                    {rangeResult.records.map((record) => (
                      <li key={record.key}>
                        <button
                          onClick={() => selectPage(record.page_id, record.key)}
                          disabled={busy || !connected}
                        >
                          {record.key} <span>· P{record.page_id} ↗</span>
                        </button>
                        <code title={record.value}>
                          {record.value || "(empty string)"}
                        </code>
                      </li>
                    ))}
                  </ol>
                  {rangeResult.next_key && (
                    <button
                      className="secondary"
                      disabled={busy || !connected}
                      onClick={() =>
                        void execute(
                          "range",
                          undefined,
                          undefined,
                          rangeResult.next_key!,
                        )
                      }
                    >
                      Next {rangeLimit} records →
                    </button>
                  )}
                </section>
              )}
              <div className="reopen-row">
                <div>
                  <strong>Still there?</strong>
                  <span>
                    {snapshot?.staged.length
                      ? "Reopen discards staged puts."
                      : "Reopen and replay the WAL."}
                  </span>
                </div>
                <button
                  className="reopen-button"
                  onClick={() => void execute("reopen")}
                  disabled={busy}
                  aria-label="Reopen database"
                >
                  <svg viewBox="0 0 20 20" aria-hidden="true">
                    <path d="M15.5 7A6 6 0 1 0 16 12M15.5 3v4h-4" />
                  </svg>
                </button>
              </div>
            </section>
            {snapshot && <EventLog events={snapshot.events} />}
            <div className="foundation-note">
              <span className="note-mark">i</span>
              <p>
                <strong>One tree. Atomic batches.</strong>Records live in linked
                leaves. Branch pages route searches. Every split commits its
                pages and root metadata together.
              </p>
            </div>
          </aside>
        </div>
        <RecoveryLab
          result={labResult}
          error={labError}
          disabled={busy || !connected}
          running={labRunning}
          run={(boundary, scenario) => void execute("lab", boundary, scenario)}
        />
      </main>
      <footer>
        <span>
          <img src="/walnut.svg" alt="" /> A tiny database with its internals on
          display.
        </span>
        <span>
          RUST ENGINE <i /> REAL FILES <i /> NO MAGIC
        </span>
      </footer>
    </div>
  );
}
