import { useEffect, useId, useRef, useState } from "react";
import type { FormEvent } from "react";
import type {
  CommandResponse,
  CommandResult,
  RangeResult,
  Snapshot,
} from "./types";
import "./command-panel.css";

export type LiveCommand =
  | "put"
  | "get"
  | "range"
  | "stage"
  | "commit"
  | "discard"
  | "checkpoint"
  | "reopen"
  | "grow";

interface CommandPanelProps {
  snapshot: Snapshot | null;
  busy: boolean;
  connected: boolean;
  onCommand: (
    kind: LiveCommand,
    body?: unknown,
  ) => Promise<CommandResponse | undefined>;
  onSelectPage: (id: number, key?: string) => void;
}

interface Revision {
  session: string;
  generation: number;
}

interface ScanState extends Revision {
  result: RangeResult;
  start: string;
  end: string | null;
  limit: number;
}

const encoder = new TextEncoder();
const byteLength = (value: string) => encoder.encode(value).length;
const revision = (snapshot: Snapshot): Revision => ({
  session: snapshot.session_id,
  generation: snapshot.generation,
});
const current = (result: Revision | null, snapshot: Snapshot | null) =>
  result !== null &&
  result.session === snapshot?.session_id &&
  result.generation === snapshot.generation;

// JavaScript's UTF-16 comparison differs from the engine's UTF-8 ordering.
function before(left: string, right: string) {
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  for (let index = 0; index < Math.min(a.length, b.length); index++) {
    if (a[index] !== b[index]) return a[index] < b[index];
  }
  return a.length < b.length;
}

export function CommandPanel({
  snapshot,
  busy,
  connected,
  onCommand,
  onSelectPage,
}: CommandPanelProps) {
  const id = useId();
  const keyInput = useRef<HTMLInputElement>(null);
  const submitting = useRef(false);
  const focusAfter = useRef(false);
  const [pending, setPending] = useState(false);
  const [operation, setOperation] = useState<"put" | "get" | "range">("put");
  const [key, setKey] = useState("hello");
  const [value, setValue] = useState("from the inside");
  const [rangeStart, setRangeStart] = useState("");
  const [rangeEnd, setRangeEnd] = useState("");
  const [rangeLimit, setRangeLimit] = useState("32");
  const [read, setRead] = useState<
    (Revision & { result: CommandResult }) | null
  >(null);
  const [scan, setScan] = useState<ScanState | null>(null);
  const [feedback, setFeedback] = useState<{
    kind: "success" | "error";
    text: string;
  } | null>(null);

  const working = busy || pending;
  const disabled = working || !connected;
  const staged = snapshot?.staged ?? [];
  const keyBytes = byteLength(key);
  const valueBytes = byteLength(value);
  const startBytes = byteLength(rangeStart);
  const endBytes = byteLength(rangeEnd);
  const limit = Number(rangeLimit);
  const invalidKey = keyBytes === 0 || keyBytes > 64;
  const invalidValue = valueBytes > 1024;
  const invalidBounds = rangeEnd !== "" && before(rangeEnd, rangeStart);
  const invalidLimit = !Number.isInteger(limit) || limit < 1 || limit > 256;
  const invalidRange =
    startBytes > 64 || endBytes > 64 || invalidBounds || invalidLimit;
  const readResult = current(read, snapshot) ? read?.result : null;
  const scanResult = current(scan, snapshot) ? scan : null;

  useEffect(() => {
    if (!working && focusAfter.current) {
      focusAfter.current = false;
      keyInput.current?.focus();
    }
  }, [working]);

  useEffect(() => {
    setRead((previous) => (current(previous, snapshot) ? previous : null));
    setScan((previous) => (current(previous, snapshot) ? previous : null));
  }, [snapshot?.session_id, snapshot?.generation]);

  function changeOperation(next: typeof operation) {
    setOperation(next);
    setRead(null);
    setFeedback((previous) => (previous?.kind === "error" ? previous : null));
  }

  async function execute(kind: LiveCommand, continuation?: ScanState) {
    if (submitting.current || busy || (!connected && kind !== "reopen")) return;
    if ((kind === "put" || kind === "stage") && (invalidKey || invalidValue))
      return;
    if (kind === "get" && invalidKey) return;
    if (kind === "range" && !continuation && invalidRange) return;
    if (kind === "put" && staged.length > 0) return;
    if (kind === "stage" && staged.length >= 64) return;

    const bounds = {
      start: continuation?.result.next_key ?? rangeStart,
      end: continuation ? continuation.end : rangeEnd || null,
      limit: continuation?.limit ?? limit,
    };
    const body =
      kind === "range"
        ? bounds
        : kind === "get"
          ? { key }
          : kind === "put" || kind === "stage"
            ? { key, value }
            : {};
    submitting.current = true;
    setPending(true);
    setFeedback(null);
    setRead(null);
    if (kind === "range") setScan(null);
    try {
      const response = await onCommand(kind, body);
      if (!response) return;
      const next = response.snapshot;
      if (response.result) {
        const result = response.result;
        if (kind === "get") setRead({ ...revision(next), result });
        setFeedback({
          kind: "success",
          text:
            kind === "put"
              ? `Committed “${result.key}”. WAL synced and verified.`
              : result.found
                ? `Found “${result.key}”.`
                : `“${result.key}” is not in this tree.`,
        });
      } else if (kind === "range" && response.range) {
        setScan({ ...revision(next), ...bounds, result: response.range });
        if (continuation) setRangeStart(bounds.start);
        setFeedback({
          kind: "success",
          text: `Scanned ${response.range.records.length} records in key order.`,
        });
      } else {
        const messages: Partial<Record<LiveCommand, string>> = {
          put: `Committed “${key}”. WAL synced and verified.`,
          stage: `Staged “${key}”. Reads still see committed data.`,
          commit: "Batch committed. All puts are visible together.",
          discard: "Staged batch discarded. Committed data is unchanged.",
          reopen: "Database reopened. Committed state recovered and verified.",
          checkpoint: "Checkpoint complete. Main pages synced; WAL reset.",
          grow: "Sample records committed. Follow their pages in the tree.",
        };
        if (messages[kind])
          setFeedback({ kind: "success", text: messages[kind]! });
      }
      if (["put", "commit", "grow", "reopen"].includes(kind)) setScan(null);
      if (kind === "commit" || kind === "discard") focusAfter.current = true;
    } catch (error) {
      setFeedback({
        kind: "error",
        text: error instanceof Error ? error.message : "The command failed.",
      });
    } finally {
      submitting.current = false;
      setPending(false);
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    void execute(operation);
  }

  const invalid = operation === "range" ? invalidRange : invalidKey;
  return (
    <section className="live-command" aria-labelledby={`${id}-heading`}>
      <header className="command-heading">
        <div>
          <span className="command-eyebrow">LIVE DATABASE</span>
          <h2 id={`${id}-heading`}>Your next move</h2>
        </div>
        <span className="command-prompt" aria-hidden="true">
          &gt;_
        </span>
      </header>
      <p className="command-intro">Write a key. Follow it through the tree.</p>

      <div className="command-operations" role="group" aria-label="Operation">
        {(
          [
            ["put", "PUT", "Write"],
            ["get", "GET", "Read"],
            ["range", "SCAN", "Range"],
          ] as const
        ).map(([kind, label, description]) => (
          <button
            key={kind}
            type="button"
            aria-pressed={operation === kind}
            onClick={() => changeOperation(kind)}
            disabled={working}
          >
            {label} <span>{description}</span>
          </button>
        ))}
      </div>

      <form className="command-form" onSubmit={submit}>
        {operation === "range" ? (
          <>
            <label htmlFor={`${id}-start`}>
              Start key <span>INCLUSIVE</span>
            </label>
            <input
              id={`${id}-start`}
              value={rangeStart}
              onChange={(event) => {
                setRangeStart(event.target.value);
                setScan(null);
              }}
              autoComplete="off"
              spellCheck={false}
              disabled={working}
              aria-invalid={startBytes > 64}
              aria-describedby={`${id}-range-help`}
              placeholder="First key, or leave empty"
            />
            <label htmlFor={`${id}-end`}>
              End key <span>EXCLUSIVE</span>
            </label>
            <input
              id={`${id}-end`}
              value={rangeEnd}
              onChange={(event) => {
                setRangeEnd(event.target.value);
                setScan(null);
              }}
              autoComplete="off"
              spellCheck={false}
              disabled={working}
              aria-invalid={endBytes > 64 || invalidBounds}
              aria-describedby={`${id}-range-help`}
              placeholder="Last boundary, or leave empty"
            />
            <div className="command-limit-row">
              <label htmlFor={`${id}-limit`}>
                Result limit <span>1–256</span>
              </label>
              <input
                id={`${id}-limit`}
                type="number"
                min={1}
                max={256}
                step={1}
                value={rangeLimit}
                onChange={(event) => {
                  setRangeLimit(event.target.value);
                  setScan(null);
                }}
                disabled={working}
                aria-invalid={invalidLimit}
              />
            </div>
            <p
              className={`command-help ${invalidRange ? "command-invalid" : ""}`}
              id={`${id}-range-help`}
            >
              {invalidBounds
                ? "End key must follow or equal the start key."
                : startBytes > 64 || endBytes > 64
                  ? "Each boundary can contain at most 64 UTF-8 bytes."
                  : invalidLimit
                    ? "Choose a whole-number limit from 1 to 256."
                    : "Empty bounds scan all keys. Results follow leaf links in UTF-8 byte order."}
            </p>
          </>
        ) : (
          <>
            <label htmlFor={`${id}-key`}>
              Key{" "}
              <span
                aria-hidden="true"
                className={keyBytes > 64 ? "command-invalid" : ""}
              >
                {keyBytes} / 64 B
              </span>
            </label>
            <input
              ref={keyInput}
              id={`${id}-key`}
              autoComplete="off"
              spellCheck={false}
              value={key}
              disabled={working}
              onChange={(event) => {
                setKey(event.target.value);
                setRead(null);
              }}
              aria-invalid={keyBytes > 64}
              aria-describedby={`${id}-key-help`}
            />
            <span className="command-sr-only" id={`${id}-key-help`}>
              1 to 64 UTF-8 bytes. Keys are case-sensitive.
            </span>
          </>
        )}
        {operation === "put" && (
          <>
            <label htmlFor={`${id}-value`}>
              Value{" "}
              <span
                aria-hidden="true"
                className={invalidValue ? "command-invalid" : ""}
              >
                {valueBytes.toLocaleString()} / 1,024 B
              </span>
            </label>
            <textarea
              id={`${id}-value`}
              rows={3}
              spellCheck={false}
              value={value}
              disabled={working}
              onChange={(event) => setValue(event.target.value)}
              aria-invalid={invalidValue}
              aria-describedby={`${id}-value-help`}
            />
            <p className="command-help" id={`${id}-value-help`}>
              An existing key is updated. An empty value is valid.
            </p>
          </>
        )}

        <button
          type="submit"
          className="command-submit"
          disabled={
            disabled ||
            invalid ||
            (operation === "put" && (invalidValue || staged.length > 0))
          }
        >
          <span>
            {operation === "put"
              ? "Commit this put"
              : operation === "get"
                ? "Find this key"
                : "Scan this range"}
          </span>
          <span aria-hidden="true">{working ? "···" : "↗"}</span>
        </button>
        {operation === "put" && (
          <>
            <button
              className="command-stage"
              type="button"
              disabled={
                disabled || invalidKey || invalidValue || staged.length >= 64
              }
              onClick={() => void execute("stage")}
            >
              <span aria-hidden="true">＋</span> Stage in batch
            </button>
            {staged.length > 0 && (
              <p className="command-help">
                Commit or discard the pending batch before a single put.
              </p>
            )}
          </>
        )}
      </form>

      {staged.length > 0 && (
        <section className="command-batch" aria-label="Staged batch">
          <div className="command-batch-heading">
            <strong>
              {staged.length} {staged.length === 1 ? "put" : "puts"} in memory
            </strong>
            <span>{staged.length} / 64</span>
          </div>
          <p>{snapshot?.staged_page_count} candidate pages · uncommitted</p>
          <ol>
            {staged.map((put, index) => (
              <li key={index}>
                <span title={put.key}>{put.key}</span>
                <code title={put.value}>
                  {put.value === "" ? "(empty string)" : put.value}
                </code>
              </li>
            ))}
          </ol>
          <div className="command-batch-actions">
            <button
              type="button"
              disabled={disabled}
              onClick={() => void execute("commit")}
            >
              Commit batch
            </button>
            <button
              type="button"
              disabled={disabled}
              onClick={() => void execute("discard")}
            >
              Discard
            </button>
          </div>
        </section>
      )}

      <div
        className="command-feedback-area"
        aria-live="polite"
        aria-atomic="true"
      >
        {feedback ? (
          <p
            className={`command-${feedback.kind}`}
            role={feedback.kind === "error" ? "alert" : undefined}
          >
            {feedback.text}
          </p>
        ) : (
          <p className="command-idle">
            {working
              ? "Waiting for the engine…"
              : !connected
                ? "Engine offline. Reopen to reconnect."
                : "UTF-8 text · Case-sensitive keys"}
          </p>
        )}
        {operation === "get" && readResult?.found && (
          <output className="command-read" aria-label="Read value">
            {readResult.value === "" ? (
              <em>(empty string)</em>
            ) : (
              readResult.value
            )}
          </output>
        )}
      </div>

      {operation === "range" && scanResult && (
        <section className="command-results" aria-label="Range results">
          <h3>
            {scanResult.result.records.length} records <span>in key order</span>
          </h3>
          {scanResult.result.records.length === 0 ? (
            <p>No records in this range.</p>
          ) : (
            <ol>
              {scanResult.result.records.map((record) => (
                <li key={record.key}>
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() => onSelectPage(record.page_id, record.key)}
                  >
                    <span>{record.key}</span>
                    <small>P{record.page_id} ↗</small>
                  </button>
                  <code title={record.value}>
                    {record.value === "" ? "(empty string)" : record.value}
                  </code>
                </li>
              ))}
            </ol>
          )}
          {scanResult.result.next_key !== null ? (
            <button
              className="command-next"
              type="button"
              disabled={disabled}
              onClick={() => void execute("range", scanResult)}
            >
              Next {scanResult.limit} records →
            </button>
          ) : (
            scanResult.result.records.length > 0 && (
              <p className="command-range-end">End of range</p>
            )
          )}
        </section>
      )}

      <div className="command-reopen">
        <div>
          <strong>Pick up where you left off.</strong>
          <p>
            {staged.length
              ? "Reopen discards staged puts."
              : "Reopen and replay the WAL."}
          </p>
        </div>
        <button
          type="button"
          aria-label="Reopen database"
          disabled={working}
          onClick={() => void execute("reopen")}
        >
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <path d="M15.5 7A6 6 0 1 0 16 12M15.5 3v4h-4" />
          </svg>
        </button>
      </div>
    </section>
  );
}
