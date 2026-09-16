import { useEffect, useMemo, useState } from "react";
import { validateStory } from "./protocol";
import type { RecordedStory, StoryScenario } from "./types";
import { StoryGuide, StoryPlayer } from "./StoryPlayer";
import { TreeCanvas } from "./TreeCanvas";
import { PageInspector } from "./PageInspector";
import { Journal } from "./Journal";
import logo from "../public/walnut.svg?raw";
import "./recovery.css";
import "./workbench.css";
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

const icon = `data:image/svg+xml,${encodeURIComponent(logo)}`;
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
  const selectPage = (id: number) => {
    setPlaying(false);
    setPage(id);
    setKey("");
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
    <div className="workbench replay-workbench">
      <a className="skip-link" href="#workspace">
        Skip to workspace
      </a>
      <header className="work-header">
        <a
          className="work-brand"
          href="#workspace"
          aria-label="WALnut workspace"
        >
          <img src={icon} alt="" />
          <span>
            WAL<span>nut</span>
          </span>
        </a>
        <span className="work-tagline">A database, from the inside.</span>
        <span className="replay-badge">RECORDED EXECUTION</span>
      </header>
      <section className="replay-intro" aria-labelledby="replay-title">
        <div>
          <p className="eyebrow">RUST ENGINE / B+ TREE / WRITE-AHEAD LOG</p>
          <h1 id="replay-title">
            Follow a write.
            <br />
            <span>Inspect what survives.</span>
          </h1>
        </div>
        <div>
          <p>
            A real key/value database with its internals on display. Follow a
            page split, a process crash after commit, and recovery from the
            write-ahead log.
          </p>
          <p className="replay-caption">
            Three captured engine runs. Every page and byte comes from the
            recording.
          </p>
        </div>
      </section>
      <main id="workspace">
        <div className="work-metrics" aria-label="Recorded frame statistics">
          <div>
            <span>RECORDS</span>
            <strong data-testid="record-count">
              {pad(snapshot.record_count)}
            </strong>
          </div>
          <div>
            <span>NODE PAGES</span>
            <strong data-testid="page-count">{pad(snapshot.page_count)}</strong>
          </div>
          <div>
            <span>TREE HEIGHT</span>
            <strong data-testid="tree-height">
              {snapshot.tree_height}{" "}
              {snapshot.tree_height === 1 ? "level" : "levels"}
            </strong>
          </div>
          <div>
            <span>ROOT</span>
            <strong data-testid="root-page">P{snapshot.root_page_id}</strong>
          </div>
          <div>
            <span>GENERATION</span>
            <strong data-testid="generation">{pad(snapshot.generation)}</strong>
          </div>
          <div className="work-metric-note">
            <b>
              {frame.kind === "crashed"
                ? "Process stopped."
                : "Captured engine state."}
            </b>
            <span>
              {frame.kind === "crashed"
                ? "Last verified pages before termination"
                : "Select a page to inspect its bytes"}
            </span>
          </div>
        </div>
        <div className="work-grid">
          <StoryGuide
            story={story}
            frame={frame}
            index={index}
            scenario={scenario}
            setScenario={choose}
            run={() => seek(0)}
            busy={false}
            connected={false}
            error=""
            recorded
          />
          <div className="work-center">
            <TreeCanvas
              snapshot={snapshot}
              selectedPageId={snapshot.page_id}
              onSelect={selectPage}
              disabled={false}
              mode="replay"
            />
            <Journal
              snapshot={snapshot}
              disabled={false}
              selectPage={selectPage}
            />
          </div>
          <PageInspector
            snapshot={snapshot}
            selectedKey={key}
            onSelectKey={(key) => {
              setKey(key);
              setPlaying(false);
            }}
            onSelectPage={selectPage}
            mode="replay"
          />
        </div>
        <StoryPlayer
          story={story}
          index={index}
          playing={playing}
          speed={speed}
          setIndex={seek}
          setPlaying={setPlaying}
          setSpeed={setSpeed}
        />
        <details className="replay-provenance">
          <summary>Source, guarantees, and licenses</summary>
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
                The Rust engine commits changed pages and metadata to a
                checksummed log, syncs and reads them back, then acknowledges
                the batch. Recovery restores whole committed transactions.
              </p>
              <p>
                The recovery recording uses a terminated child process. It does
                not establish hardware power-loss survival. This file replays
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
      <footer className="work-footer">
        <span>
          <img src={icon} alt="" /> A tiny database with its internals on
          display.
        </span>
        <span>
          REAL FILES <i /> CAPTURED BYTES <i /> WALnut
        </span>
      </footer>
    </div>
  );
}
