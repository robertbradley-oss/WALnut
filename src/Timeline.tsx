import type { EngineEvent, RecordedStory } from "./types";
import "./timeline.css";

const pageName = (id: number) => `P${String(id).padStart(3, "0")}`;

/** Recorded frames as a transport: one completed engine operation per stop. */
export function RecordedTimeline({
  story,
  index,
  playing,
  speed,
  disabled = false,
  setIndex,
  setPlaying,
  setSpeed,
}: {
  story: RecordedStory;
  index: number;
  playing: boolean;
  speed: number;
  disabled?: boolean;
  setIndex: (value: number) => void;
  setPlaying: (value: boolean) => void;
  setSpeed: (value: number) => void;
}) {
  const last = story.frames.length - 1;
  return (
    <section className="timeline" aria-label="Recorded playback">
      <div className="timeline-head">
        <div>
          <span className="kicker">Recorded timeline</span>
          <h2>{story.title}</h2>
        </div>
        <span className="player-state num">
          {playing ? "PLAYING" : index === last ? "COMPLETE" : "PAUSED"} ·{" "}
          {index + 1}/{story.frames.length}
        </span>
      </div>

      <ol
        className="timeline-steps"
        style={{ "--steps": story.frames.length } as never}
      >
        {story.frames.map((frame, position) => (
          <li
            key={frame.id}
            data-reached={position <= index || undefined}
            data-current={position === index || undefined}
            data-kind={frame.kind}
          >
            <button
              aria-label={`Step ${position + 1}: ${frame.title}`}
              aria-current={index === position ? "step" : undefined}
              disabled={disabled}
              onClick={() => setIndex(position)}
            >
              <span className="timeline-dot num" aria-hidden="true">
                {position < index ? "✓" : String(position + 1).padStart(2, "0")}
              </span>
              <strong>
                {frame.kind === "crashed" ? "Process stopped" : frame.kind}
              </strong>
              <small className="num">
                gen {frame.capture.snapshot.generation} ·{" "}
                {frame.capture.snapshot.page_count}{" "}
                {frame.capture.snapshot.page_count === 1 ? "page" : "pages"}
              </small>
            </button>
          </li>
        ))}
      </ol>

      <div className="timeline-controls">
        <div className="timeline-transport">
          <button
            aria-label="Reset recording"
            disabled={disabled}
            onClick={() => setIndex(0)}
          >
            ↺
          </button>
          <button
            aria-label="Previous step"
            disabled={disabled || index === 0}
            onClick={() => setIndex(index - 1)}
          >
            ←
          </button>
          <button
            className="timeline-play"
            disabled={disabled}
            onClick={() => {
              if (index === last && !playing) setIndex(0);
              setPlaying(!playing);
            }}
          >
            {playing ? "Pause" : "Play recording"}
          </button>
          <button
            aria-label="Next step"
            disabled={disabled || index === last}
            onClick={() => setIndex(index + 1)}
          >
            →
          </button>
        </div>
        <label className="timeline-speed">
          Speed
          <select
            value={speed}
            disabled={disabled}
            onChange={(event) => setSpeed(Number(event.target.value))}
          >
            <option value="0.5">0.5×</option>
            <option value="1">1×</option>
            <option value="2">2×</option>
          </select>
        </label>
        <span className="timeline-note">
          Playback moves between captured operations. It never writes to a
          database.
        </span>
      </div>
    </section>
  );
}

/** The engine's own event stream for the live database. */
export function EventTimeline({
  events,
  missed,
  disabled,
  knownPage,
  selectPage,
}: {
  events: EngineEvent[];
  missed: number;
  disabled: boolean;
  knownPage: (id: number) => boolean;
  selectPage: (id: number) => void;
}) {
  const recent = events.slice(-6);
  return (
    <section className="timeline" aria-labelledby="events-title">
      <div className="timeline-head">
        <div>
          <span className="kicker">Engine timeline</span>
          <h2 id="events-title">What the engine reported, in order</h2>
        </div>
        <span className="timeline-note">
          Page links open that page in the current snapshot.
        </span>
      </div>

      {missed > 0 && (
        <p className="work-stream-gap" role="status">
          Timeline gap: {missed} events passed outside the retained window. The
          current snapshot is complete.
        </p>
      )}

      <ol className="event-list">
        {recent.map((event) => (
          <li key={`${event.session_id}:${event.sequence}`}>
            <span className="event-sequence num">
              {String(event.sequence).padStart(3, "0")}
            </span>
            <div>
              <strong>{event.kind.replaceAll("_", " ")}</strong>
              <p>{event.detail}</p>
            </div>
            <span className="event-generation num">G{event.generation}</span>
            {event.page_id !== null && knownPage(event.page_id) && (
              <button
                disabled={disabled}
                onClick={() => selectPage(event.page_id!)}
              >
                {pageName(event.page_id)} <i aria-hidden="true">↗</i>
              </button>
            )}
          </li>
        ))}
      </ol>

      <details className="event-all">
        <summary>All {events.length} retained events</summary>
        <ol className="event-list">
          {events.map((event) => (
            <li key={`${event.session_id}:${event.sequence}`}>
              <span className="event-sequence num">{event.sequence}</span>
              <div>
                <strong>{event.kind.replaceAll("_", " ")}</strong>
                <p>{event.detail}</p>
              </div>
              <span className="event-generation num">G{event.generation}</span>
            </li>
          ))}
        </ol>
      </details>
    </section>
  );
}
