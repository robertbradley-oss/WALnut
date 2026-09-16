import { useEffect, useRef, useState } from "react";
import type { Snapshot, StoredRecord, WalFrame } from "./types";
import "./inspector.css";

const hex = (value: number, digits = 2) =>
  value.toString(16).padStart(digits, "0").toUpperCase();
const pageName = (id: number) => `P${String(id).padStart(4, "0")}`;

/**
 * The selected page drawn to scale: header, every record span, free space.
 * Offsets and lengths come from the engine, so the picture and the hex view
 * below it describe the same bytes.
 */
function PageLayout({
  snapshot,
  selected,
  onSelect,
}: {
  snapshot: Snapshot;
  selected?: StoredRecord;
  onSelect: (key: string) => void;
}) {
  const width = 300;
  const height = 54;
  const scale = width / snapshot.page_size;
  const fill = snapshot.used_bytes / snapshot.page_size;
  return (
    <div className="page-map">
      <div className="page-map-head">
        <span className="num">
          {pageName(snapshot.page_id)} · {snapshot.page_kind.toUpperCase()}
        </span>
        <span className="num">{snapshot.page_size.toLocaleString()} BYTES</span>
      </div>
      <svg
        viewBox={`0 0 ${width + 4} ${height + 12}`}
        role="img"
        aria-label={`Page ${snapshot.page_id}: ${snapshot.used_bytes} of ${snapshot.page_size} bytes used`}
      >
        <defs>
          <pattern
            id="page-free"
            width="6"
            height="6"
            patternUnits="userSpaceOnUse"
          >
            <path d="M0 6 6 0" stroke="var(--line-strong)" strokeWidth=".6" />
          </pattern>
        </defs>
        <rect
          x="2"
          y="5"
          width={width}
          height={height}
          rx="2"
          fill="url(#page-free)"
          stroke="var(--line-strong)"
        />
        <rect
          className="span-header"
          x="2"
          y="5"
          width={snapshot.header_size * scale}
          height={height}
        />
        {snapshot.page_kind === "internal" && (
          <rect
            className="span-routing"
            x={2 + snapshot.header_size * scale}
            y="5"
            width={(snapshot.used_bytes - snapshot.header_size) * scale}
            height={height}
          />
        )}
        {snapshot.records.map((record, index) => (
          <rect
            key={record.key}
            className="span-record"
            data-selected={record.key === selected?.key || undefined}
            data-alt={index % 2 === 1 || undefined}
            x={2 + record.offset * scale}
            y="5"
            width={Math.max(0.6, record.length * scale)}
            height={height}
            onClick={() => onSelect(record.key)}
          >
            <title>
              {record.key} · {record.length.toLocaleString()} bytes
            </title>
          </rect>
        ))}
        <line
          className="span-watermark"
          x1={2 + snapshot.used_bytes * scale}
          x2={2 + snapshot.used_bytes * scale}
          y1="1"
          y2={height + 10}
        />
      </svg>
      <div className="page-map-foot">
        <strong className="num">
          {snapshot.used_bytes.toLocaleString()} B used
        </strong>
        <span className="num" data-tight={fill > 0.82 || undefined}>
          {Math.round(fill * 100)}% full
        </span>
        <span className="num">
          {(snapshot.page_size - snapshot.used_bytes).toLocaleString()} B free
        </span>
      </div>
      <div className="page-map-legend">
        <span data-span="header">Header</span>
        <span data-span="record">
          {snapshot.page_kind === "internal" ? "Routing" : "Records"}
        </span>
        <span data-span="free">Free</span>
      </div>
    </div>
  );
}

function ByteView({
  snapshot,
  selected,
  focusToken,
}: {
  snapshot: Snapshot;
  selected?: StoredRecord;
  focusToken: number;
}) {
  const [start, setStart] = useState(0);
  const [requested, setRequested] = useState<"committed" | "checkpoint">(
    "committed",
  );
  const source = snapshot.checkpoint_bytes ? requested : "committed";
  const checkpointGeneration = snapshot.checkpoint_bytes
    ? new DataView(Uint8Array.from(snapshot.checkpoint_bytes).buffer)
        .getBigUint64(16, true)
        .toString()
    : null;
  const bytes =
    source === "checkpoint" && snapshot.checkpoint_bytes
      ? snapshot.checkpoint_bytes
      : snapshot.bytes;
  useEffect(() => {
    setStart(selected ? Math.floor(selected.offset / 256) * 256 : 0);
    if (selected) setRequested("committed");
  }, [selected?.key, selected?.offset, snapshot.page_id, focusToken]);
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
    <section className="byte-view" aria-labelledby="bytes-heading">
      <div className="byte-head">
        <h3 id="bytes-heading" className="kicker">
          Encoded bytes
        </h3>
        <span className="num">16 B / row</span>
      </div>
      <div className="byte-source" role="group" aria-label="Page byte source">
        <button
          aria-pressed={source === "committed"}
          onClick={() => setRequested("committed")}
        >
          Committed page · gen {snapshot.page_generation}
        </button>
        <button
          aria-pressed={source === "checkpoint"}
          disabled={!snapshot.checkpoint_bytes}
          onClick={() => setRequested("checkpoint")}
        >
          Checkpoint page ·{" "}
          {snapshot.checkpoint_bytes === null
            ? "unavailable"
            : `gen ${checkpointGeneration}`}
        </button>
      </div>
      <p className="byte-note">
        {source === "committed"
          ? "Verified committed page image. Select a record to locate its key and value."
          : `Verified main-file page at its last checkpoint. File offset ${(snapshot.header_size + snapshot.page_id * snapshot.page_size).toLocaleString()}.`}
      </p>
      <div className="byte-scroll">
        <table className="hex-table" aria-label="Encoded page bytes">
          <thead>
            <tr>
              <th scope="col">OFF</th>
              {Array.from({ length: 16 }, (_, index) => (
                <th scope="col" key={index}>
                  {hex(index)}
                </th>
              ))}
              <th scope="col" className="ascii">
                TEXT
              </th>
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: 16 }, (_, row) => {
              const offset = start + row * 16;
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
      <div className="byte-foot">
        <div className="byte-legend">
          <span data-byte="header">Header</span>
          <span data-byte="key">Key</span>
          <span data-byte="value">Value</span>
        </div>
        <div className="byte-paging">
          <button
            aria-label="Previous 256 bytes"
            disabled={start === 0}
            onClick={() => setStart((value) => value - 256)}
          >
            ←
          </button>
          <span className="num">
            {hex(start, 4)}–{hex(start + 255, 4)}
          </span>
          <button
            aria-label="Next 256 bytes"
            disabled={start >= snapshot.page_size - 256}
            onClick={() => setStart((value) => value + 256)}
          >
            →
          </button>
        </div>
      </div>
    </section>
  );
}

function PageStructure({
  snapshot,
  select,
}: {
  snapshot: Snapshot;
  select: (id: number) => void;
}) {
  const page = snapshot.pages.find((item) => item.id === snapshot.page_id);
  if (!page)
    return (
      <section className="inspect-block" aria-label="Tree metadata">
        <h3 className="kicker">Tree metadata · page 0</h3>
        <dl className="inspect-pairs">
          <div>
            <dt>Root page</dt>
            <dd>
              <button
                className="inspect-link"
                onClick={() => select(snapshot.root_page_id)}
              >
                P{snapshot.root_page_id}
              </button>
            </dd>
          </div>
          <div>
            <dt>Next page ID</dt>
            <dd className="num">{snapshot.page_count + 1}</dd>
          </div>
          <div>
            <dt>Tree height</dt>
            <dd className="num">{snapshot.tree_height}</dd>
          </div>
          <div>
            <dt>Record count</dt>
            <dd className="num">{snapshot.record_count}</dd>
          </div>
          <div>
            <dt>Complete tree CRC32</dt>
            <dd className="num">{snapshot.state_checksum}</dd>
          </div>
        </dl>
        <p className="inspect-note">
          The root, allocation cursor, record count and whole-tree checksum are
          committed with every changed page. A checkpoint of individually valid
          pages from different generations cannot pass this checksum.
        </p>
      </section>
    );
  return (
    <section className="inspect-block" aria-label="Internal page routing">
      <h3 className="kicker">Routing · {page.children.length} children</h3>
      <p className="inspect-note">
        A key equal to a separator takes the right child.
      </p>
      <div className="routing-scroll">
        <table className="routing-table">
          <thead>
            <tr>
              <th scope="col">Lower bound (inclusive)</th>
              <th scope="col">Child</th>
            </tr>
          </thead>
          <tbody>
            {page.children.map((id, index) => (
              <tr key={id}>
                <td>
                  <code
                    title={index === 0 ? undefined : page.separators[index - 1]}
                  >
                    {index === 0
                      ? "below the first separator"
                      : page.separators[index - 1]}
                  </code>
                </td>
                <td>
                  <button className="inspect-link" onClick={() => select(id)}>
                    P{id} <i aria-hidden="true">→</i>
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export function Inspector({
  snapshot,
  selectedKey,
  onSelectKey,
  onSelectPage,
  mode,
  selectedFrame,
  onSelectFrame,
  disabled = false,
}: {
  snapshot: Snapshot;
  selectedKey: string;
  onSelectKey: (key: string) => void;
  onSelectPage: (id: number) => void;
  mode: "live" | "replay";
  selectedFrame?: WalFrame;
  onSelectFrame: (frame: WalFrame) => void;
  disabled?: boolean;
}) {
  const hexRef = useRef<HTMLDetailsElement>(null);
  const [byteFocus, setByteFocus] = useState(0);
  const selected = snapshot.records.find(
    (record) => record.key === selectedKey,
  );
  const page = snapshot.pages.find((item) => item.id === snapshot.page_id);
  const isRoot = snapshot.page_id === snapshot.root_page_id;
  const containingFrames = snapshot.wal_frames.filter((frame) =>
    frame.page_ids.includes(snapshot.page_id),
  );
  return (
    <aside className="inspector" aria-labelledby="inspect-title">
      <header className="inspect-head">
        <div>
          <span className="kicker">Page inspector</span>
          <h2 id="inspect-title" className="num">
            {pageName(snapshot.page_id)}
            <span>
              {snapshot.page_kind}
              {isRoot && snapshot.page_id !== 0 ? " · root" : ""}
            </span>
          </h2>
        </div>
        <span className="inspect-origin" data-mode={mode}>
          {mode === "replay" ? "CAPTURED" : "LIVE"}
        </span>
      </header>

      <label className="inspect-picker">
        <span className="kicker">Page explorer</span>
        <select
          aria-label="PAGE EXPLORER"
          value={snapshot.page_id}
          disabled={disabled}
          onChange={(event) => onSelectPage(Number(event.target.value))}
        >
          <option value="0">P0 · metadata</option>
          {snapshot.pages.map((item) => (
            <option key={item.id} value={item.id}>
              P{item.id} · {item.kind}
              {item.id === snapshot.root_page_id ? " · root" : ""}
            </option>
          ))}
        </select>
      </label>

      <section
        className="inspect-lineage"
        aria-label="Page and log relationship"
      >
        <span className="kicker">Page images in retained WAL</span>
        {containingFrames.length ? (
          <>
            <div className="inspect-log-links">
              {containingFrames.map((frame) => (
                <button
                  key={frame.generation}
                  disabled={disabled}
                  aria-pressed={selectedFrame?.generation === frame.generation}
                  onClick={() => onSelectFrame(frame)}
                >
                  WAL gen {frame.generation}
                </button>
              ))}
            </div>
            <p>
              Log entries contain images of this page. The inspector shows its
              current {mode === "replay" ? "captured" : "committed"} bytes.
            </p>
          </>
        ) : (
          <p>
            No image of this page in the retained log. Page generation{" "}
            {snapshot.page_generation}; main-file generation{" "}
            {snapshot.checkpoint_generation ?? "unavailable"}.
          </p>
        )}
      </section>

      <PageLayout
        snapshot={snapshot}
        selected={selected}
        onSelect={onSelectKey}
      />

      <dl className="inspect-facts">
        <div>
          <dt>Page generation</dt>
          <dd className="num">{snapshot.page_generation}</dd>
        </div>
        <div>
          <dt>CRC32</dt>
          <dd className="num">{snapshot.checksum}</dd>
        </div>
      </dl>

      {selected && (
        <div className="inspect-record-link" aria-label="Selected record bytes">
          <span className="num">
            {pageName(snapshot.page_id)} → bytes {selected.offset}–
            {selected.offset + selected.length - 1}
          </span>
          <button
            onClick={() => {
              if (!hexRef.current) return;
              setByteFocus((value) => value + 1);
              hexRef.current.open = true;
              hexRef.current.scrollIntoView({ block: "nearest" });
            }}
          >
            Show selected bytes ↓
          </button>
        </div>
      )}

      {snapshot.page_kind === "leaf" ? (
        <section className="inspect-block" aria-label="Page records">
          <h3 className="kicker">
            {snapshot.records.length} records
            <em>key / value</em>
          </h3>
          {snapshot.records.length ? (
            <div className="inspect-records">
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
                  <small className="num">
                    {record.length.toLocaleString()} B · offset {record.offset}
                  </small>
                </button>
              ))}
            </div>
          ) : (
            <p className="inspect-note">
              This leaf is empty. Commit a key and its bytes appear here.
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
              Next leaf <b className="num">P{page.next_leaf} →</b>
            </button>
          )}
        </section>
      ) : (
        <PageStructure snapshot={snapshot} select={onSelectPage} />
      )}

      <details className="inspect-hex" ref={hexRef}>
        <summary>
          Raw bytes
          <span className="num">{snapshot.page_size / 1024} KB · hex</span>
        </summary>
        <ByteView
          snapshot={snapshot}
          selected={selected}
          focusToken={byteFocus}
        />
      </details>
    </aside>
  );
}
