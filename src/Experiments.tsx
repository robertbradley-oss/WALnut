import type { RecordedStory, StoryScenario } from "./types";
import "./experiments.css";

export const scenarios: {
  id: StoryScenario;
  number: string;
  title: string;
  detail: string;
  lesson: string;
  from: string;
  to: string;
}[] = [
  {
    id: "split",
    number: "01",
    title: "A page splits",
    detail: "One leaf becomes a tree.",
    lesson:
      "Stage two puts, commit them as one transaction, then follow a lookup into the new leaf.",
    from: "3 records · 1 leaf · height 1",
    to: "5 records · 2 leaves · new root · height 2",
  },
  {
    id: "recovery",
    number: "02",
    title: "A commit survives",
    detail: "Stop the process. Keep the promise.",
    lesson:
      "Commit a batch, terminate the worker process, and reopen. Recovery replays the acknowledged transaction.",
    from: "commit acknowledged · WAL synced",
    to: "process terminated · 1 transaction replayed",
  },
  {
    id: "checkpoint",
    number: "03",
    title: "The file catches up",
    detail: "From the log into the main file.",
    lesson:
      "Move committed page images into the main database file, then reopen and verify the same records.",
    from: "log ahead of the file",
    to: "file at rest · log back to its 64-byte header",
  },
];

export function Experiments({
  story,
  scenario,
  setScenario,
  run,
  busy,
  connected,
  error,
  recorded = false,
}: {
  story: RecordedStory | null;
  scenario: StoryScenario;
  setScenario: (value: StoryScenario) => void;
  run: () => void;
  busy: boolean;
  connected: boolean;
  error: string;
  recorded?: boolean;
}) {
  const choice = scenarios.find((item) => item.id === scenario)!;
  return (
    <section className="experiments" aria-labelledby="experiments-title">
      <header className="experiments-head">
        <span className="kicker">Experiments</span>
        <h2 id="experiments-title">Three ways in</h2>
        <p>
          {recorded
            ? "Each one is a captured run of the real engine. Step through its operations and inspect any page."
            : "Each run drives the real engine against a fresh disposable database and captures every operation."}
        </p>
      </header>

      <div className="experiment-list" role="group" aria-label="Guided story">
        {scenarios.map((item) => (
          <button
            key={item.id}
            disabled={busy}
            aria-pressed={scenario === item.id}
            onClick={() => setScenario(item.id)}
          >
            <span className="experiment-number num">{item.number}</span>
            <span className="experiment-body">
              <strong>{item.title}</strong>
              <small>{item.detail}</small>
            </span>
            <i aria-hidden="true">↗</i>
          </button>
        ))}
      </div>

      <div className="experiment-brief">
        <p>{choice.lesson}</p>
        <dl>
          <div>
            <dt>Start</dt>
            <dd className="num">{choice.from}</dd>
          </div>
          <div data-outcome>
            <dt>Result</dt>
            <dd className="num">{choice.to}</dd>
          </div>
        </dl>
      </div>

      {!recorded && (
        <button
          className="experiment-run"
          disabled={busy || !connected}
          onClick={run}
        >
          {busy
            ? "Capturing engine run…"
            : story?.scenario === scenario
              ? "Run story again"
              : "Run story"}
          <i aria-hidden="true">↗</i>
        </button>
      )}

      <p className="experiment-scope">
        {recorded
          ? "Use the timeline below to step through this recording."
          : "Each run creates its own disposable database. Your live database is untouched."}
      </p>

      {error && (
        <p className="experiment-error" role="alert">
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
              Verified snapshots taken after observable operations. The
              stopped-process step holds the last capture taken before
              termination.
            </dd>
            {story.process && (
              <>
                <dt>Process exit</dt>
                <dd>{story.process.process_exit}</dd>
                <dt>Failure model</dt>
                <dd>
                  Process termination. Physical power loss is outside this
                  experiment.
                </dd>
              </>
            )}
          </dl>
        </details>
      )}
    </section>
  );
}
