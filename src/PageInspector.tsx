import { useEffect, useState } from "react";
import type { Snapshot, StoredRecord } from "./types";
import { PageContents } from "./TreeExplorer";
const hex = (value: number, digits = 2) =>
  value.toString(16).padStart(digits, "0").toUpperCase();
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

function PageMap({
  snapshot,
  selected,
  onSelect,
}: {
  snapshot: Snapshot;
  selected?: StoredRecord;
  onSelect: (key: string) => void;
}) {
  const width = 256,
    height = 48;
  const x = 2,
    y = 5;
  const scale = width / snapshot.page_size;
  return (
    <div className="page-map">
      <div className="map-label">
        <span>
          PAGE {String(snapshot.page_id).padStart(4, "0")} ·{" "}
          {snapshot.page_kind.toUpperCase()}
        </span>
        <span>4,096 BYTES</span>
      </div>
      <svg
        viewBox="0 0 260 62"
        role="img"
        aria-label={`Page ${snapshot.page_id}: ${snapshot.used_bytes} of 4096 bytes used`}
      >
        <defs>
          <pattern
            id="free-space"
            width="7"
            height="7"
            patternUnits="userSpaceOnUse"
          >
            <path d="M0 7 7 0" stroke="#494336" strokeWidth=".5" />
          </pattern>
        </defs>
        <rect
          x={x}
          y={y}
          width={width}
          height={height}
          rx="3"
          fill="url(#free-space)"
          stroke="var(--line-bright)"
        />
        <rect
          x={x}
          y={y}
          width={snapshot.header_size * scale}
          height={height}
          fill="#8d9fac"
        />
        {snapshot.page_kind === "internal" && (
          <rect
            x={x + snapshot.header_size * scale}
            y={y}
            width={(snapshot.used_bytes - snapshot.header_size) * scale}
            height={height}
            fill="var(--accent-dim)"
          />
        )}
        {snapshot.records.map((record, i) => (
          <rect
            key={record.key}
            x={x + record.offset * scale}
            y={y}
            width={record.length * scale}
            height={height}
            fill={
              record.key === selected?.key
                ? "var(--accent)"
                : i % 2
                  ? "#a08357"
                  : "#746141"
            }
            stroke="#1d1c16"
            strokeWidth=".5"
            onClick={() => onSelect(record.key)}
          >
            <title>
              {record.key}: {record.length} bytes
            </title>
          </rect>
        ))}
        <line
          x1={x + snapshot.used_bytes * scale}
          x2={x + snapshot.used_bytes * scale}
          y1={1}
          y2={height + 9}
          stroke="var(--accent)"
          strokeWidth="1"
        />
      </svg>
      <div className="map-utilization">
        <strong>{snapshot.used_bytes.toLocaleString()} B used</strong>
        <span>{(4096 - snapshot.used_bytes).toLocaleString()} B free</span>
      </div>
      <div className="map-legend">
        <span>
          <i className="header-dot" />
          Header
        </span>
        <span>
          <i className="record-dot" />
          {snapshot.page_kind === "internal" ? "Routing" : "Records"}
        </span>
        <span>
          <i className="free-dot" />
          Free
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
  const checkpointPageGeneration = snapshot.checkpoint_bytes
    ? new DataView(Uint8Array.from(snapshot.checkpoint_bytes).buffer)
        .getBigUint64(16, true)
        .toString()
    : null;
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
            : `gen ${checkpointPageGeneration}`}
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

export function PageInspector({
  snapshot,
  selectedKey,
  onSelectKey,
  onSelectPage,
  mode,
}: {
  snapshot: Snapshot;
  selectedKey: string;
  onSelectKey: (key: string) => void;
  onSelectPage: (id: number) => void;
  mode: "live" | "replay";
}) {
  const selected = snapshot.records.find(
    (record) => record.key === selectedKey,
  );
  const page = snapshot.pages.find((page) => page.id === snapshot.page_id);
  return (
    <section className="inspect-panel" aria-labelledby="inspect-title">
      <header className="inspect-heading">
        <div>
          <span className="eyebrow">PAGE INSPECTOR</span>
          <h2 id="inspect-title">
            P{String(snapshot.page_id).padStart(4, "0")}{" "}
            <span>{snapshot.page_kind}</span>
          </h2>
        </div>
        <span className="inspect-origin">
          {mode === "replay" ? "CAPTURED" : "LIVE"}
        </span>
      </header>
      <label className="inspect-picker">
        PAGE EXPLORER
        <select
          value={snapshot.page_id}
          onChange={(event) => onSelectPage(Number(event.target.value))}
        >
          <option value="0">P0 · metadata</option>
          {snapshot.pages.map((page) => (
            <option key={page.id} value={page.id}>
              P{page.id} · {page.kind}
              {page.id === snapshot.root_page_id ? " · root" : ""}
            </option>
          ))}
        </select>
      </label>
      <PageMap snapshot={snapshot} selected={selected} onSelect={onSelectKey} />
      <dl className="inspect-facts">
        <div>
          <dt>Page generation</dt>
          <dd>{snapshot.page_generation}</dd>
        </div>
        <div>
          <dt>CRC32</dt>
          <dd>{snapshot.checksum}</dd>
        </div>
      </dl>
      {snapshot.page_kind === "leaf" ? (
        <section className="inspect-records" aria-label="Page records">
          <h3>
            {snapshot.records.length} records <span>KEY / VALUE</span>
          </h3>
          {snapshot.records.length ? (
            <div className="inspect-record-list">
              {snapshot.records.map((record) => (
                <button
                  key={record.key}
                  className="inspect-record"
                  aria-pressed={record.key === selectedKey}
                  onClick={() => onSelectKey(record.key)}
                >
                  <strong title={record.key}>{record.key}</strong>
                  <span title={record.value}>
                    {record.value || "(empty string)"}
                  </span>
                  <small>
                    {record.length.toLocaleString()} B · offset {record.offset}
                  </small>
                </button>
              ))}
            </div>
          ) : (
            <p className="inspect-empty">
              This leaf is empty. Commit a key and watch its bytes appear.
            </p>
          )}
          {selected && (
            <details className="inspect-value">
              <summary>
                Full value · {selected.value_length.toLocaleString()} bytes
              </summary>
              <pre>{selected.value || "(empty string)"}</pre>
            </details>
          )}
          {page?.next_leaf != null && (
            <button
              className="inspect-next"
              onClick={() => onSelectPage(page.next_leaf!)}
            >
              Next leaf <b>P{page.next_leaf} →</b>
            </button>
          )}
        </section>
      ) : (
        <PageContents snapshot={snapshot} select={onSelectPage} />
      )}
      <details className="inspect-hex">
        <summary>
          Inspect raw bytes <span>4 KB · HEX</span>
        </summary>
        <ByteInspector snapshot={snapshot} selected={selected} />
      </details>
    </section>
  );
}
