import { useEffect, useMemo, useState } from "react";
import { validateStory } from "./protocol";
import type { RecordedStory, StoryScenario, WalFrame } from "./types";
import { Experiments } from "./Experiments";
import { RecordedTimeline } from "./Timeline";
import { Structure } from "./Structure";
import { Inspector } from "./Inspector";
import { DurabilityRail } from "./DurabilityRail";
import { OperationBar, describeFrame, withChanges } from "./OperationBar";
import { useLogSelection } from "./inspection";
import { Brand, brandMark } from "./Brand";
import "./lab.css";
import "./replay.css";

export interface ReplayBundle {
  schema_version: 1;
  source: {
    version: string;
    revision: string;
    dirty: boolean;
    captured_at: string;
    platform: string;
    executable_sha256: string;
    path_redaction: string;
  };
  stories: RecordedStory[];
  notices: string;
}

export function readBundle(input: unknown): ReplayBundle {
  if (!input || typeof input !== "object")
    throw new Error("Recording bundle is missing.");
  const value = input as ReplayBundle;
  if (
    value.schema_version !== 1 ||
    !Array.isArray(value.stories) ||
    value.stories.length !== 3 ||
    !value.source ||
    typeof value.source.version !== "string" ||
    !/^[a-f0-9]{40}$/.test(value.source.revision) ||
    typeof value.source.dirty !== "boolean" ||
    !/^[a-f0-9]{64}$/.test(value.source.executable_sha256) ||
    typeof value.source.captured_at !== "string" ||
    !Number.isFinite(Date.parse(value.source.captured_at)) ||
    typeof value.source.platform !== "string" ||
    value.source.platform.length > 80 ||
    typeof value.source.path_redaction !== "string" ||
    value.source.path_redaction.length > 1000 ||
    typeof value.notices !== "string" ||
    value.notices.length > 100_000
  ) {
    throw new Error("Recording bundle metadata is invalid or unsupported.");
  }
  const scenarios = new Set<StoryScenario>();
  for (const input of value.stories) {
    const story = validateStory(input);
    if (
      scenarios.has(story.scenario) ||
      story.source.engine_version !== value.source.version
    )
      throw new Error("Recording sources are inconsistent.");
    scenarios.add(story.scenario);
  }
  return value;
}

const pad = (value: number) => String(value).padStart(2, "0");

export default function ReplayApp({ bundle }: { bundle: ReplayBundle }) {
  const [scenario, setScenario] = useState<StoryScenario>(() => {
    const selected = window.location.hash.slice(1);
    return selected === "recovery" || selected === "checkpoint"
      ? selected
      : "split";
  });
  const story = bundle.stories.find((story) => story.scenario === scenario)!;
  const [index, setIndex] = useState(0);
  const [page, setPage] = useState(story.frames[0].focus_page_id);
  const [key, setKey] = useState("");
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const frame = story.frames[index];
  const snapshot = useMemo(
    () => ({
      ...frame.capture.snapshot,
      ...(frame.capture.pages.find((item) => item.page_id === page) ??
        frame.capture.pages.find(
          (item) => item.page_id === frame.focus_page_id,
        )!),
    }),
    [frame, page],
  );
  const stopped = frame.kind === "crashed";
  const operation = withChanges(
    describeFrame(frame),
    snapshot,
    story.frames[index - 1]?.capture.snapshot,
  );
  const { frame: selectedLog, selectFrame: selectLogFrame } = useLogSelection(
    snapshot,
    `${story.run_id}:${frame.id}`,
  );

  const seek = (next: number) => {
    const at = Math.max(0, Math.min(next, story.frames.length - 1));
    setPlaying(false);
    setIndex(at);
    setPage(story.frames[at].focus_page_id);
    setKey("");
  };
  const choose = (next: StoryScenario) => {
    const selected = bundle.stories.find((story) => story.scenario === next)!;
    setPlaying(false);
    setScenario(next);
    setIndex(0);
    setPage(selected.frames[0].focus_page_id);
    setKey("");
    window.history.replaceState(null, "", `#${next}`);
  };
  const selectPage = (id: number, selectedKey = "") => {
    selectLogFrame(undefined);
    setPlaying(false);
    setPage(id);
    setKey(selectedKey);
  };
  const chooseLog = (transaction: WalFrame) => {
    const id = transaction.page_ids.includes(snapshot.page_id)
      ? snapshot.page_id
      : (transaction.page_ids.find((id) => id !== 0) ?? 0);
    selectPage(id, id === snapshot.page_id ? key : "");
    selectLogFrame(transaction);
  };
  const watchSplit = () => {
    choose("split");
    setPlaying(true);
    document.getElementById("workspace")?.scrollIntoView({ block: "start" });
  };

  useEffect(() => {
    if (!playing) return;
    if (index === story.frames.length - 1) {
      setPlaying(false);
      return;
    }
    const timer = setTimeout(() => {
      setIndex(index + 1);
      setPage(story.frames[index + 1].focus_page_id);
      setKey("");
    }, 2400 / speed);
    return () => clearTimeout(timer);
  }, [playing, story, index, speed]);

  useEffect(() => {
    const pause = () => {
      if (document.hidden) setPlaying(false);
    };
    document.addEventListener("visibilitychange", pause);
    return () => document.removeEventListener("visibilitychange", pause);
  }, []);

  return (
    <div className="lab replay-lab">
      <a className="skip-link" href="#workspace">
        Skip to workspace
      </a>

      <header className="lab-header">
        <Brand href="#workspace" label="WALnut workspace" />
        <span className="lab-tagline">A database with its internals open.</span>
        <div className="lab-status-chip">
          <button className="watch-split" onClick={watchSplit}>
            Watch a page split <span aria-hidden="true">↗</span>
          </button>
          <span className="lab-badge replay-badge">RECORDED EXECUTION</span>
          <span className="lab-stack">RUST · B+ TREE · WAL</span>
        </div>
      </header>

      <section className="replay-intro" aria-labelledby="replay-title">
        <div>
          <p className="kicker">Portable capture · no engine required</p>
          <h1 id="replay-title">
            Follow a write.
            <br />
            <span>Inspect what survives.</span>
          </h1>
        </div>
        <div>
          <p>
            A real Rust key/value database with its internals on display. Three
            captured engine runs: a page split, a process terminated after an
            acknowledged commit, and a checkpoint that moves the log into the
            main file.
          </p>
          <p className="replay-caption">
            Every page, byte and checksum on this page came out of the
            recording. Nothing here is a mock-up.
          </p>
        </div>
      </section>

      <main id="workspace">
        <div className="lab-strip">
          <div className="lab-identity">
            <strong>{story.title}</strong>
            <small>Recorded run {story.run_id.slice(0, 12)} · read only</small>
          </div>
          <dl className="lab-metrics" aria-label="Recorded frame statistics">
            <div>
              <dt>Records</dt>
              <dd data-testid="record-count">{pad(snapshot.record_count)}</dd>
            </div>
            <div>
              <dt>Node pages</dt>
              <dd data-testid="page-count">{pad(snapshot.page_count)}</dd>
            </div>
            <div>
              <dt>Height</dt>
              <dd data-testid="tree-height">
                {snapshot.tree_height}{" "}
                <em>{snapshot.tree_height === 1 ? "level" : "levels"}</em>
              </dd>
            </div>
            <div>
              <dt>Root</dt>
              <dd data-testid="root-page">P{snapshot.root_page_id}</dd>
            </div>
            <div>
              <dt>Generation</dt>
              <dd data-testid="generation">{pad(snapshot.generation)}</dd>
            </div>
          </dl>
        </div>

        <OperationBar
          operation={operation}
          label="Current story step"
          badge="RECORDED"
          badgeTone={stopped ? "failed" : "checkpointed"}
          badgeNote={
            stopped
              ? "process terminated"
              : `step ${index + 1} of ${story.frames.length}`
          }
          notice={
            stopped ? (
              <>
                <strong className="story-stopped">
                  Process stopped · last captured state
                </strong>
                {story.process && (
                  <small className="story-process">
                    Child PID {story.process.process_id} ·{" "}
                    {story.process.process_terminated
                      ? "terminated and reaped"
                      : "exit not confirmed"}
                  </small>
                )}
              </>
            ) : null
          }
        />

        <div className="lab-grid">
          <div className="lab-rail">
            <Experiments
              story={story}
              scenario={scenario}
              setScenario={choose}
              run={() => seek(0)}
              busy={false}
              connected={false}
              error=""
              recorded
            />
          </div>

          <div className="lab-stage">
            <Structure
              snapshot={snapshot}
              selectedPageId={snapshot.page_id}
              onSelect={selectPage}
              disabled={false}
              mode="replay"
              linkedFrame={selectedLog}
              selectedKey={key}
              clearLog={() => selectLogFrame(undefined)}
              operationKey={`${story.run_id}:${frame.id}`}
              pulseAllowed={!stopped}
            />
            <DurabilityRail
              snapshot={snapshot}
              disabled={false}
              selectPage={selectPage}
              selectedFrame={selectedLog}
              onSelectFrame={chooseLog}
            />
          </div>

          <Inspector
            snapshot={snapshot}
            selectedKey={key}
            onSelectKey={(value) => {
              selectLogFrame(undefined);
              setKey(value);
              setPlaying(false);
            }}
            onSelectPage={selectPage}
            mode="replay"
            selectedFrame={selectedLog}
            onSelectFrame={chooseLog}
          />
        </div>

        <RecordedTimeline
          story={story}
          index={index}
          playing={playing}
          speed={speed}
          setIndex={seek}
          setPlaying={setPlaying}
          setSpeed={setSpeed}
        />

        <details className="replay-provenance lab-advanced">
          <summary>
            Source, guarantees, and licenses
            <span>Where these bytes came from</span>
          </summary>
          <div className="replay-provenance-grid">
            <section>
              <h2>Captured from WALnut</h2>
              <dl>
                <dt>Version</dt>
                <dd>{bundle.source.version}</dd>
                <dt>Source revision</dt>
                <dd>
                  {bundle.source.revision}
                  {bundle.source.dirty
                    ? " · working tree changes"
                    : " · clean source"}
                </dd>
                <dt>Captured</dt>
                <dd>{bundle.source.captured_at}</dd>
                <dt>Platform</dt>
                <dd>{bundle.source.platform}</dd>
                <dt>Engine SHA256</dt>
                <dd>{bundle.source.executable_sha256}</dd>
              </dl>
              <p>{bundle.source.path_redaction}</p>
            </section>
            <section>
              <h2>What this demonstrates</h2>
              <p>
                The Rust engine writes changed pages and metadata into a
                checksummed log, syncs them, reads them back exactly, and only
                then acknowledges the batch. Recovery restores whole committed
                transactions and rejects incomplete ones.
              </p>
              <p>
                The recovery recording terminates a child process. It does not
                establish hardware power-loss survival. This file replays
                captured operations; it cannot accept database writes.
              </p>
            </section>
          </div>
          <details>
            <summary>Third-party notices</summary>
            <pre>{bundle.notices}</pre>
          </details>
        </details>
      </main>

      <footer className="lab-footer">
        <span>
          <img src={brandMark} alt="" />A tiny database with its internals on
          display.
        </span>
        <span>
          REAL FILES <i /> CAPTURED BYTES <i /> WALnut
        </span>
      </footer>
    </div>
  );
}
