import type { RecordedStory, StoryFrame, StoryScenario } from "./types";

export const scenarios: {
  id: StoryScenario;
  number: string;
  title: string;
  detail: string;
  lesson: string;
}[] = [
  {
    id: "split",
    number: "01",
    title: "A page splits",
    detail: "One leaf becomes a tree.",
    lesson:
      "Stage two puts, commit a split, then follow a lookup to its new leaf.",
  },
  {
    id: "recovery",
    number: "02",
    title: "A commit survives",
    detail: "Stop the process. Keep the promise.",
    lesson:
      "Commit a batch, terminate its process, and recover the exact tree from the log.",
  },
  {
    id: "checkpoint",
    number: "03",
    title: "The file catches up",
    detail: "From the log to the main file.",
    lesson:
      "Follow committed page images into the main file, then reopen and verify.",
  },
];

export function StoryGuide({
  story,
  frame,
  index,
  scenario,
  setScenario,
  run,
  busy,
  connected,
  error,
}: {
  story: RecordedStory | null;
  frame?: StoryFrame;
  index: number;
  scenario: StoryScenario;
  setScenario: (value: StoryScenario) => void;
  run: () => void;
  busy: boolean;
  connected: boolean;
  error: string;
}) {
  const choice = scenarios.find((item) => item.id === scenario)!;
  return (
    <aside className="story-guide" aria-labelledby="story-heading">
      <span className="eyebrow">THREE WAYS INSIDE</span>
      <h2 id="story-heading">Follow the bytes.</h2>
      <p className="story-intro">
        Run a real experiment. Explore every captured step at your own pace.
      </p>
      {frame && story && (
        <section
          className={`story-step-copy ${frame.kind === "crashed" ? "story-crashed" : ""}`}
          aria-label="Current story step"
          aria-live="polite"
        >
          <div className="story-step-kicker">
            <span>
              STEP {String(index + 1).padStart(2, "0")} /{" "}
              {String(story.frames.length).padStart(2, "0")}
            </span>
            <span>{frame.kind.toUpperCase()}</span>
          </div>
          <h3>{frame.title}</h3>
          <code className="story-command">{frame.command}</code>
          <p>{frame.explanation}</p>
          {frame.kind === "crashed" && (
            <strong className="story-stopped">
              Process stopped · last captured state
            </strong>
          )}
          {story.process &&
            ["crashed", "recovered", "lookup"].includes(frame.kind) && (
              <small className="story-process">
                Child PID {story.process.process_id} ·{" "}
                {story.process.process_terminated
                  ? "terminated and reaped"
                  : "exit not confirmed"}
              </small>
            )}
        </section>
      )}
      <div className="story-choices" role="group" aria-label="Guided story">
        {scenarios.map((item) => (
          <button
            key={item.id}
            disabled={busy}
            aria-pressed={scenario === item.id}
            onClick={() => setScenario(item.id)}
          >
            <span>{item.number}</span>
            <div>
              <strong>{item.title}</strong>
              <small>{item.detail}</small>
            </div>
            <i aria-hidden="true">↗</i>
          </button>
        ))}
      </div>
      <p className="story-lesson">{choice.lesson}</p>
      <button className="story-run" disabled={busy || !connected} onClick={run}>
        {busy
          ? "Capturing engine run…"
          : story?.scenario === scenario
            ? "Run story again"
            : "Run story"}
        <span aria-hidden="true">↗</span>
      </button>
      <p className="story-scope">Each run uses a fresh disposable database.</p>
      {error && (
        <p className="work-error" role="alert">
          {error}
          {story
            ? " Your previous recording is still available."
            : " Try running the story again."}
        </p>
      )}
      {story && (
        <details className="story-source">
          <summary>Recorded run evidence</summary>
          <dl>
            <dt>Run</dt>
            <dd>{story.run_id}</dd>
            <dt>Engine</dt>
            <dd>
              {story.source.engine_version} · storage v
              {story.source.storage_format_version} · page v
              {story.source.page_format_version}
            </dd>
            <dt>Database</dt>
            <dd>{story.source.database_path}</dd>
            <dt>Capture</dt>
            <dd>
              Verified snapshots after observable operations. The
              stopped-process step holds the last captured snapshot.
            </dd>
            {story.process && (
              <>
                <dt>Process exit</dt>
                <dd>{story.process.process_exit}</dd>
                <dt>Failure model</dt>
                <dd>
                  Process termination; physical power loss is outside this
                  experiment.
                </dd>
              </>
            )}
          </dl>
        </details>
      )}
    </aside>
  );
}

export function StoryPlayer({
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
    <section className="story-player" aria-label="Recorded playback">
      <div className="player-heading">
        <div>
          <span className="eyebrow">RECORDED TIMELINE</span>
          <h2>{story.title}</h2>
        </div>
        <span className="player-state">
          {playing ? "PLAYING" : index === last ? "COMPLETE" : "PAUSED"} ·{" "}
          {index + 1}/{story.frames.length}
        </span>
      </div>
      <ol className="player-steps">
        {story.frames.map((frame, i) => (
          <li key={frame.id} className={i <= index ? "player-reached" : ""}>
            <button
              aria-label={`Step ${i + 1}: ${frame.title}`}
              aria-current={index === i ? "step" : undefined}
              disabled={disabled}
              onClick={() => setIndex(i)}
            >
              <span className="player-dot">
                {i < index ? "✓" : String(i + 1).padStart(2, "0")}
              </span>
              <strong>
                {frame.kind === "crashed" ? "Process stopped" : frame.kind}
              </strong>
              <small>
                GEN {frame.capture.snapshot.generation} ·{" "}
                {frame.capture.snapshot.page_count}{" "}
                {frame.capture.snapshot.page_count === 1 ? "page" : "pages"}
              </small>
            </button>
          </li>
        ))}
      </ol>
      <div className="player-controls">
        <div className="player-transport">
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
            className="player-play"
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
        <label className="player-speed">
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
        <span className="player-note">Playback changes this view only.</span>
      </div>
    </section>
  );
}
