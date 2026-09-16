import type { Snapshot, WalFrame } from "./types";
import "./durability.css";

const pageName = (id: number) => `P${String(id).padStart(3, "0")}`;
const quantity = (count: number, noun: string) =>
  `${count} ${noun}${count === 1 ? "" : "s"}`;

/**
 * Where the data lives right now: memory, log, file.
 *
 * A checkpoint clears the retained frames, so every transaction still in the
 * log is by definition one the main file does not have. That is the whole
 * meaning of "write-ahead", and the rail states it directly.
 */
export function DurabilityRail({
  snapshot,
  disabled,
  checkpoint,
  selectPage,
  selectedFrame,
  onSelectFrame,
}: {
  snapshot: Snapshot;
  disabled: boolean;
  checkpoint?: () => void;
  selectPage: (id: number) => void;
  selectedFrame?: WalFrame;
  onSelectFrame: (frame: WalFrame) => void;
}) {
  const frames = snapshot.wal_frames.slice(-6);
  if (selectedFrame && !frames.includes(selectedFrame))
    frames.unshift(selectedFrame);
  const frame =
    selectedFrame ??
    [...snapshot.wal_frames]
      .reverse()
      .find((item) => item.page_ids.includes(snapshot.page_id)) ??
    frames.at(-1);
  const ahead = snapshot.wal_frame_count;
  const staged = snapshot.staged.length;
  const body = Math.max(1, snapshot.wal_bytes - snapshot.wal_header_bytes);

  return (
    <section className="rail" aria-labelledby="rail-title">
      <header className="rail-head">
        <div>
          <span className="kicker">Durability</span>
          <h2 id="rail-title">
            {ahead === 0
              ? "The main file matches the last commit."
              : `The log holds ${quantity(ahead, "transaction")} the main file does not have.`}
          </h2>
        </div>
        {checkpoint && (
          <button
            className="rail-checkpoint"
            disabled={disabled}
            onClick={checkpoint}
            data-ready={ahead > 0 || undefined}
          >
            Checkpoint
            <i aria-hidden="true">→</i>
          </button>
        )}
      </header>

      <div className="rail-track">
        {/* memory */}
        <div className="rail-zone" data-zone="memory" data-active={!!staged}>
          <span className="rail-zone-label">Memory</span>
          <div className="rail-zone-body">
            <strong className="num">
              <b data-testid="staged-count">{staged}</b> staged
            </strong>
            <span className="rail-bar" aria-hidden="true">
              {staged > 0 ? (
                Array.from({ length: Math.min(staged, 16) }, (_, index) => (
                  <i key={index} />
                ))
              ) : (
                <em />
              )}
            </span>
          </div>
          <small>
            {staged ? "Not durable · invisible to reads" : "Nothing pending"}
          </small>
        </div>

        <span className="rail-flow" aria-hidden="true">
          commit
        </span>

        {/* write-ahead log */}
        <div className="rail-zone rail-log" data-zone="log" data-active>
          <span className="rail-zone-label">
            Write-ahead log
            <em className="num" data-testid="wal-bytes">
              {snapshot.wal_bytes.toLocaleString("en-US")} B on disk
            </em>
          </span>
          <div className="rail-zone-body">
            <strong className="num">
              Gen{" "}
              <b data-testid="committed-generation">{snapshot.generation}</b>{" "}
              committed
            </strong>
            <div
              className="rail-frames"
              role="group"
              aria-label="Committed log transactions"
            >
              <span
                className="rail-identity"
                title="Permanent WAL identity header"
              >
                <b className="num">{snapshot.wal_header_bytes} B</b>
                <small>header</small>
              </span>
              {snapshot.wal_frame_count > frames.length && (
                <span className="rail-earlier num">
                  +{snapshot.wal_frame_count - frames.length}
                </span>
              )}
              {frames.map((item) => (
                <button
                  key={item.generation}
                  className="rail-frame"
                  style={{ flexGrow: Math.max(0.35, item.length / body) }}
                  aria-pressed={item.generation === frame?.generation}
                  data-linked={
                    item.page_ids.includes(snapshot.page_id) || undefined
                  }
                  aria-description={
                    item.page_ids.includes(snapshot.page_id)
                      ? `Contains an image of selected page ${snapshot.page_id}`
                      : undefined
                  }
                  aria-label={`Transaction generation ${item.generation}, ${quantity(item.operations, "put")}, committed and ahead of the main file`}
                  disabled={disabled}
                  onClick={() => onSelectFrame(item)}
                >
                  <span className="num">G{item.generation}</span>
                  <b className="num">{item.operations}</b>
                  {item.page_ids.includes(snapshot.page_id) && (
                    <small>{pageName(snapshot.page_id)}</small>
                  )}
                </button>
              ))}
              {!frames.length && (
                <p className="rail-empty">
                  Empty. The next commit starts here.
                </p>
              )}
            </div>
          </div>
          <small data-ahead={ahead > 0 || undefined}>
            {ahead > 0
              ? `${quantity(ahead, "transaction")} ahead of the file · recovery replays exactly these`
              : "Synced and verified · truncated to its header"}
          </small>
        </div>

        <span className="rail-flow" aria-hidden="true">
          checkpoint
        </span>

        {/* main file */}
        <div className="rail-zone" data-zone="file" data-active>
          <span className="rail-zone-label">Main file</span>
          <div className="rail-zone-body">
            <strong className="num">
              {snapshot.checkpoint_generation === null ? (
                "Needs repair"
              ) : (
                <>
                  Gen{" "}
                  <b data-testid="checkpoint-generation">
                    {snapshot.checkpoint_generation}
                  </b>{" "}
                  at rest
                </>
              )}
            </strong>
            <span className="rail-bar" aria-hidden="true">
              <em data-filled />
            </span>
          </div>
          <small>
            {snapshot.database_bytes.toLocaleString()} B ·{" "}
            {ahead > 0 ? "behind the commit" : "up to date"}
          </small>
        </div>
      </div>

      {frame ? (
        <details
          className="rail-detail"
          key={`${snapshot.database_id}:${frame.generation}:${!!selectedFrame}`}
          open={selectedFrame ? true : undefined}
        >
          <summary>
            <span className="num">Gen {frame.generation}</span>
            <i aria-hidden="true">·</i>
            <span className="num">{frame.length.toLocaleString()} B</span>
            <i aria-hidden="true">·</i>
            <span className="num">CRC32 {frame.checksum}</span>
            <i aria-hidden="true">·</i>
            <span>
              {quantity(frame.page_ids.length, "page image")}, root{" "}
              {pageName(frame.root_page_id)}, height {frame.tree_height}
            </span>
          </summary>
          <div className="rail-detail-body">
            <div className="rail-page-links">
              {frame.page_ids.map((id) => (
                <button
                  key={id}
                  disabled={disabled}
                  aria-pressed={id === snapshot.page_id}
                  onClick={() => selectPage(id)}
                  title={`Inspect ${pageName(id)} in the current snapshot`}
                >
                  {pageName(id)} <i aria-hidden="true">↗</i>
                </button>
              ))}
            </div>
            <p>
              Written at log offset {frame.offset.toLocaleString()}. Page links
              open the page in the snapshot on screen; they do not rewind the
              engine to this transaction.
            </p>
          </div>
        </details>
      ) : (
        <p className="rail-clean">
          Every node page and the root metadata are checkpointed. Only the
          permanent identity header remains in the log.
        </p>
      )}

      {snapshot.recovery.replayed_transactions > 0 && (
        <p className="rail-recovered">
          <span aria-hidden="true">↳</span> This open replayed{" "}
          <b>
            {quantity(snapshot.recovery.replayed_transactions, "transaction")}
          </b>{" "}
          from the log and discarded{" "}
          {snapshot.recovery.discarded_tail_bytes.toLocaleString()} incomplete
          tail bytes.
        </p>
      )}
    </section>
  );
}
