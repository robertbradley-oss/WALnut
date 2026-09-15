import { useState } from "react";
import type { LabResult } from "./types";

const scenarios = [
  {
    boundary: "after_frame",
    name: "Before commit",
    detail:
      "Kill after all page images are written, before their commit marker. Both puts and the entire split should be absent.",
  },
  {
    boundary: "after_commit_return",
    name: "After commit",
    detail:
      "Kill after commit returns, before checkpoint. Both puts should recover from the synced log.",
  },
  {
    boundary: "after_checkpoint_page:3",
    name: "During checkpoint",
    detail:
      "Kill after checkpoint writes page 3, while other pages and the root metadata still need updating. The WAL holds the complete split.",
  },
  {
    boundary: "after_wal_truncate",
    name: "During log reset",
    detail:
      "Kill after truncation, before syncing the shorter log. All main pages and metadata are already synced.",
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
  run: (boundary: string, scenario: string) => void;
}) {
  const [boundary, setBoundary] = useState("after_commit_return");
  const [workload, setWorkload] = useState("root_split");
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
          Enough to split a leaf—or create a new root.
        </p>
        <label className="lab-workload" htmlFor="lab-workload">
          Workload
          <select
            id="lab-workload"
            value={workload}
            disabled={running}
            onChange={(e) => setWorkload(e.target.value)}
          >
            <option value="root_split">Root split · 116 → 118 records</option>
            <option value="leaf_split">First split · 3 → 5 records</option>
          </select>
        </label>
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
          onClick={() => run(boundary, workload)}
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
              <div>
                <dt>TREE HEIGHT</dt>
                <dd>
                  {result.baseline.tree_height} → {result.snapshot.tree_height}{" "}
                  levels
                </dd>
              </div>
              <div>
                <dt>NODE PAGES</dt>
                <dd>
                  {result.baseline.page_count} → {result.snapshot.page_count}
                </dd>
              </div>
              <div>
                <dt>ROOT PAGE</dt>
                <dd>
                  P{result.baseline.root_page_id} → P
                  {result.snapshot.root_page_id}
                </dd>
              </div>
              <div>
                <dt>VERIFIED RECORDS</dt>
                <dd>{result.verified_records} · every key and value</dd>
              </div>
            </dl>
            <div className="receipt-records">
              <div>
                <span>KEY</span>
                <span>AFTER REOPEN</span>
              </div>
              {result.attempted.map((r) => (
                <div key={r.key}>
                  <strong title={r.key}>{r.key.slice(0, 11)}…</strong>
                  <code>
                    {r.found
                      ? `${r.value_bytes?.toLocaleString()} B · P${r.page_id}`
                      : "Absent"}
                  </code>
                </div>
              ))}
            </div>
            <p className="receipt-foot">
              {result.outcome === "batch_recovered"
                ? "Both records and every page in the split recovered together."
                : "Both attempted records are absent. The original tree is intact."}{" "}
              All {result.baseline.record_count} baseline records survived.
            </p>
            <details>
              <summary>Inspect the evidence</summary>
              <p className="evidence-path">{result.database_path}</p>
              <pre>
                {JSON.stringify(
                  {
                    run: result.run_id,
                    boundary: result.boundary,
                    scenario: result.scenario,
                    baseline: result.baseline,
                    attempted: result.attempted,
                    state_crc32: result.snapshot.state_checksum,
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
            <p>
              Start with{" "}
              {workload === "root_split"
                ? "116 saved records across 59 pages"
                : "3 saved records in one leaf"}
              .
            </p>
            <p>
              Insert <b>two 1,000-byte values</b>. Trigger{" "}
              {workload === "root_split"
                ? "a leaf split, a branch split, and a new root"
                : "a leaf split and a new root"}
              .
            </p>
            <p>Stop the worker. Reopen the files.</p>
            <span>The result here comes from the recovered database.</span>
          </div>
        )}
      </div>
    </section>
  );
}
