import { useState } from "react";
import type { Snapshot } from "./types";
export function Journal({
  snapshot,
  disabled,
  checkpoint,
  selectPage,
}: {
  snapshot: Snapshot;
  disabled: boolean;
  checkpoint?: () => void;
  selectPage: (id: number) => void;
}) {
  const [selection, setSelection] = useState<{
    database: string;
    generation: number;
  }>();
  const frames = snapshot.wal_frames.slice(-6);
  const frame =
    (selection?.database === snapshot.database_id
      ? frames.find((frame) => frame.generation === selection.generation)
      : undefined) ?? frames.at(-1);
  const pending = snapshot.generation !== snapshot.checkpoint_generation;
  return (
    <section className="wal-panel" aria-labelledby="wal-title">
      <header>
        <div>
          <span className="eyebrow">DURABILITY</span>
          <h2 id="wal-title">Written ahead. Ready to recover.</h2>
        </div>
        {checkpoint && (
          <button disabled={disabled} onClick={checkpoint}>
            Checkpoint
          </button>
        )}
      </header>
      <div className="wal-states">
        <div>
          <span>01 MEMORY</span>
          <strong>
            <b data-testid="staged-count">{snapshot.staged.length}</b> staged
          </strong>
          <small>Invisible to reads</small>
        </div>
        <i aria-hidden="true">→</i>
        <div>
          <span>02 COMMITTED</span>
          <strong>
            Gen <b data-testid="committed-generation">{snapshot.generation}</b>
          </strong>
          <small>{pending ? "Synced WAL" : "Checkpointed"}</small>
        </div>
        <i aria-hidden="true">→</i>
        <div>
          <span>03 MAIN FILE</span>
          <strong>
            {snapshot.checkpoint_generation === null ? (
              "Needs repair"
            ) : (
              <>
                Gen{" "}
                <b data-testid="checkpoint-generation">
                  {snapshot.checkpoint_generation}
                </b>
              </>
            )}
          </strong>
          <small>{pending ? "Behind the commit" : "Up to date"}</small>
        </div>
      </div>
      <div className="wal-track-label">
        <h3>
          Write-ahead log <span>{snapshot.wal_frame_count} transactions</span>
        </h3>
        <strong data-testid="wal-bytes">
          {snapshot.wal_bytes.toLocaleString()} B on disk
        </strong>
      </div>
      <div className="wal-track" aria-label="Committed WAL transactions">
        <div className="wal-identity">
          <span>WAL</span>
          <strong>64 B</strong>
          <small>identity</small>
        </div>
        {snapshot.wal_frame_count > 6 && (
          <span className="wal-earlier">
            +{snapshot.wal_frame_count - 6}
            <small>earlier</small>
          </span>
        )}
        {frames.map((item) => (
          <button
            className="wal-transaction"
            key={item.generation}
            aria-pressed={item.generation === frame?.generation}
            onClick={() =>
              setSelection({
                database: snapshot.database_id,
                generation: item.generation,
              })
            }
          >
            <span>GEN {String(item.generation).padStart(2, "0")}</span>
            <strong>
              {item.operations} {item.operations === 1 ? "put" : "puts"}
            </strong>
            <small>
              COMMITTED <i aria-hidden="true">✓</i>
            </small>
          </button>
        ))}
        {!frames.length && (
          <p className="wal-no-frames">
            No transactions in the log.<span>The next commit begins here.</span>
          </p>
        )}
        <span className="wal-track-tail" aria-hidden="true" />
      </div>
      {frame ? (
        <div className="wal-inspection">
          <p>
            GEN {frame.generation} <span>·</span>{" "}
            {frame.length.toLocaleString()} B <span>·</span> CRC32{" "}
            {frame.checksum}
          </p>
          <details>
            <summary>
              {frame.page_ids.length} page images · root P{frame.root_page_id} ·
              height {frame.tree_height}
            </summary>
            <div className="wal-page-links">
              {frame.page_ids.map((id) => (
                <button
                  key={id}
                  disabled={disabled}
                  onClick={() => selectPage(id)}
                >
                  P{id} ↗
                </button>
              ))}
            </div>
            <p>
              Page links show the selected snapshot. Transaction offset{" "}
              {frame.offset.toLocaleString()} in the WAL.
            </p>
          </details>
        </div>
      ) : (
        <p className="wal-clean">
          Main pages and root metadata are checkpointed. The identity header
          stays.
        </p>
      )}
      {snapshot.recovery.replayed_transactions > 0 && (
        <p className="wal-recovered">
          ↳ On this reopen:{" "}
          <b>
            {snapshot.recovery.replayed_transactions}{" "}
            {snapshot.recovery.replayed_transactions === 1
              ? "transaction"
              : "transactions"}{" "}
            recovered
          </b>{" "}
          from the log.
        </p>
      )}
    </section>
  );
}
