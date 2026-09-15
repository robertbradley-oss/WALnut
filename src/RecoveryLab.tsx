import { useState } from "react";
import type { LabResult } from "./types";

const scenarios = [
  {
    boundary: "after_frame",
    name: "Before commit",
    detail:
      "Kill after the page image is written, before its commit marker. The staged batch should be absent.",
  },
  {
    boundary: "after_commit_return",
    name: "After commit",
    detail:
      "Kill after commit returns, before checkpoint. Both puts should recover from the synced log.",
  },
  {
    boundary: "after_checkpoint_write",
    name: "During checkpoint",
    detail:
      "Kill after the main page write, before its sync. The WAL still holds the complete batch.",
  },
  {
    boundary: "after_wal_truncate",
    name: "During log reset",
    detail:
      "Kill after truncation, before syncing the shorter log. The main page is already synced.",
  },
];

export function RecoveryLab({
  result,
  error,
  disabled,
  running,
  run,
}: {
  result: LabResult | null;
  error: string;
  disabled: boolean;
  running: boolean;
  run: (boundary: string) => void;
}) {
  const [boundary, setBoundary] = useState("after_commit_return");
  const scenario = scenarios.find((s) => s.boundary === boundary)!;
  return (
    <section className="recovery-lab" aria-labelledby="lab-heading">
      <div className="lab-intro">
        <p className="eyebrow">THE RECOVERY LAB</p>
        <h2 id="lab-heading">
          Pull the plug.
          <br />
          <span>Read what survived.</span>
        </h2>
        <p>
          A real child process. A disposable database. Two puts in one batch.
          Choose the exact point where the process stops.
        </p>
        <div className="lab-scenarios" role="group" aria-label="Crash boundary">
          {scenarios.map((s, i) => (
            <button
              key={s.boundary}
              aria-pressed={boundary === s.boundary}
              disabled={running}
              onClick={() => setBoundary(s.boundary)}
            >
              <span>0{i + 1}</span>
              {s.name}
            </button>
          ))}
        </div>
        <p className="scenario-description">{scenario.detail}</p>
        <button
          className="lab-run"
          disabled={disabled}
          onClick={() => run(boundary)}
        >
          {running ? "Terminating and recovering…" : "Run crash & recover"}
          <span aria-hidden="true">↗</span>
        </button>
        {error && (
          <p className="error-text" role="alert">
            {error}
          </p>
        )}
        <small className="lab-limit">
          Process termination test. Physical power-loss testing is separate.
        </small>
      </div>
      <div className="lab-console" aria-live="polite" aria-busy={running}>
        <div className="console-bar">
          <span className="console-lights" aria-hidden="true">
            ● ● ●
          </span>
          <span>RECOVERY RECEIPT</span>
          <span>{running ? "RUNNING" : result ? "VERIFIED" : "READY"}</span>
        </div>
        {result ? (
          <div className="lab-result" key={result.run_id}>
            <div className="receipt-status">
              <span>✓</span>
              <div>
                <small>
                  {scenarios
                    .find((s) => s.boundary === result.boundary)
                    ?.name.toUpperCase()}
                </small>
                <h3>
                  {result.outcome === "batch_recovered"
                    ? "The whole batch survived."
                    : "No partial batch escaped."}
                </h3>
              </div>
            </div>
            <dl className="receipt-facts">
              <div>
                <dt>PROCESS</dt>
                <dd>PID {result.process_id} · terminated</dd>
              </div>
              <div>
                <dt>COMMIT RETURNED</dt>
                <dd>{result.commit_returned ? "Yes" : "No"}</dd>
              </div>
              <div>
                <dt>TAIL DISCARDED</dt>
                <dd>
                  {result.snapshot.recovery.discarded_tail_bytes.toLocaleString()}{" "}
                  bytes
                </dd>
              </div>
              <div>
                <dt>RECOVERED STATE</dt>
                <dd>Generation {result.snapshot.generation}</dd>
              </div>
            </dl>
            <div className="receipt-records">
              <div>
                <span>KEY</span>
                <span>VALUE AFTER REOPEN</span>
              </div>
              {result.snapshot.records.map((r) => (
                <div key={r.key}>
                  <strong>{r.key}</strong>
                  <code>{r.value}</code>
                </div>
              ))}
            </div>
            <p className="receipt-foot">
              {result.outcome === "batch_recovered"
                ? "alpha + beta recovered together."
                : "alpha + beta are both absent."}{" "}
              The baseline record survived.
            </p>
            <details>
              <summary>Inspect the evidence</summary>
              <p className="evidence-path">{result.database_path}</p>
              <pre>
                {JSON.stringify(
                  {
                    run: result.run_id,
                    boundary: result.boundary,
                    exit: result.process_exit,
                    recovery: result.snapshot.recovery,
                  },
                  null,
                  2,
                )}
              </pre>
            </details>
          </div>
        ) : (
          <div className="lab-ready">
            <div className="terminal-prompt">$ walnut lab</div>
            <p>Start with one saved record.</p>
            <p>
              Stage <b>alpha → one</b> and <b>beta → two</b>.
            </p>
            <p>Stop the worker. Reopen the files.</p>
            <span>The result here comes from the recovered database.</span>
          </div>
        )}
      </div>
    </section>
  );
}
