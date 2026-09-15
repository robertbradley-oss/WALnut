import { useState } from "react";
import type { Snapshot } from "./types";

export function Journal({
  snapshot,
  disabled,
  checkpoint,
}: {
  snapshot: Snapshot;
  disabled: boolean;
  checkpoint: () => void;
}) {
  const [selected, setSelected] = useState<number>();
  const frames = snapshot.wal_frames.slice(-6);
  const frame = frames.find((f) => f.generation === selected) ?? frames.at(-1);
  const pending = snapshot.generation !== snapshot.checkpoint_generation;
  return (
    <section className="journal" aria-labelledby="journal-heading">
      <div className="journal-heading">
        <div>
          <span className="eyebrow">FOLLOW THE COMMIT</span>
          <h2 id="journal-heading">A promise, written ahead.</h2>
        </div>
        <p>
          A batch becomes visible after the log is synced.
          <br />
          The main file catches up at checkpoint.
        </p>
      </div>
      <div className="durability-strip">
        <div
          className={`durability-state ${snapshot.staged.length ? "has-staged" : ""}`}
        >
          <span className="state-step">01 / MEMORY</span>
          <strong>
            <span data-testid="staged-count">{snapshot.staged.length}</span>{" "}
            staged{" "}
            <small>{snapshot.staged.length === 1 ? "put" : "puts"}</small>
          </strong>
          <span>Invisible to reads · lost on restart</span>
        </div>
        <div className="durability-state committed-state">
          <span className="state-step">02 / COMMITTED</span>
          <strong>
            Generation{" "}
            <b data-testid="committed-generation">{snapshot.generation}</b>
          </strong>
          <span>
            {pending ? "Synced WAL · recoverable" : "Matches the checkpoint"}
          </span>
        </div>
        <div className="durability-state checkpoint-state">
          <span className="state-step">03 / MAIN FILE</span>
          <strong>
            {snapshot.checkpoint_generation === null ? (
              "Needs repair"
            ) : (
              <>
                Generation{" "}
                <b data-testid="checkpoint-generation">
                  {snapshot.checkpoint_generation}
                </b>
              </>
            )}
          </strong>
          <span>
            {pending
              ? "Checkpoint to bring it up to date"
              : "Checkpointed · WAL ready for reuse"}
          </span>
        </div>
      </div>
      <div className="wal-heading">
        <h3>
          Write-ahead log{" "}
          <span className="mono">
            {snapshot.wal_frame_count} / {snapshot.wal_limit}
          </span>
        </h3>
        <button className="secondary" disabled={disabled} onClick={checkpoint}>
          Checkpoint
        </button>
      </div>
      <div className="wal-lane" aria-label="Committed WAL transactions">
        <div className="wal-origin">
          <span>WAL</span>
          <b>64 B</b>
          <small>identity</small>
        </div>
        {snapshot.wal_frame_count > 6 && (
          <span className="wal-ellipsis">
            +{snapshot.wal_frame_count - 6}
            <small>earlier</small>
          </span>
        )}
        {frames.length ? (
          frames.map((f) => (
            <button
              key={f.generation}
              className="wal-frame"
              aria-pressed={frame?.generation === f.generation}
              onClick={() => setSelected(f.generation)}
            >
              <span>GEN {String(f.generation).padStart(2, "0")}</span>
              <strong>
                {f.operations} {f.operations === 1 ? "put" : "puts"}
              </strong>
              <small>
                COMMITTED <i>✓</i>
              </small>
            </button>
          ))
        ) : (
          <div className="wal-empty">
            <strong>No transactions in the log.</strong>
            <span>
              Your next commit starts here. The identity header stays in place.
            </span>
          </div>
        )}
        <span className="wal-end" aria-hidden="true" />
      </div>
      <div className="wal-detail">
        {frame ? (
          <span>
            GEN {frame.generation} <i /> offset {frame.offset.toLocaleString()}{" "}
            <i /> {frame.length.toLocaleString()} B <i /> CRC32 {frame.checksum}
          </span>
        ) : (
          <span>Permanent header · matching database / WAL identity</span>
        )}
        <strong data-testid="wal-bytes">
          {snapshot.wal_bytes.toLocaleString()} B on disk
        </strong>
      </div>
      {frame && (
        <details className="split-details">
          <summary>
            {frame.page_ids.length} page images · root P{frame.root_page_id} ·
            height {frame.tree_height}
          </summary>
          <p className="mono">
            {frame.page_ids.map((id) => `P${id}`).join(" · ")}
          </p>
        </details>
      )}
      <p className="tree-caption">
        WAL capacity: {(snapshot.wal_byte_limit / 1024 / 1024).toFixed(0)} MiB
        or {snapshot.wal_limit.toLocaleString()} transactions. Checkpoint to
        reclaim log space.
      </p>
      {(snapshot.recovery.replayed_transactions > 0 ||
        snapshot.recovery.discarded_tail_bytes > 0 ||
        snapshot.recovery.repaired_page ||
        snapshot.recovery.obsolete_frames_removed > 0) && (
        <div className="recovery-note">
          <span>↳</span>
          <p>
            <strong>On this reopen:</strong>{" "}
            {snapshot.recovery.replayed_transactions}{" "}
            {snapshot.recovery.replayed_transactions === 1
              ? "transaction"
              : "transactions"}{" "}
            recovered · {snapshot.recovery.discarded_tail_bytes} incomplete tail
            bytes removed
            {snapshot.recovery.repaired_page
              ? " · main tree reconstructed from WAL"
              : ""}
            {snapshot.recovery.obsolete_frames_removed
              ? ` · ${snapshot.recovery.obsolete_frames_removed} obsolete frames removed`
              : ""}
            .
          </p>
        </div>
      )}
    </section>
  );
}
