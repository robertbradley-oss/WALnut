import { useCallback, useEffect, useRef, useState } from "react";
import type {
  CommandResponse,
  LabResult,
  RecordedStory,
  Snapshot,
  StoryScenario,
  WalFrame,
} from "./types";
import { Console, type LiveCommand } from "./Console";
import { Structure } from "./Structure";
import { Inspector } from "./Inspector";
import { DurabilityRail } from "./DurabilityRail";
import { RecoveryLab } from "./RecoveryLab";
import { Experiments } from "./Experiments";
import { RecordedTimeline, EventTimeline } from "./Timeline";
import {
  OperationBar,
  describeFrame,
  describeOperation,
  withChanges,
  type Operation,
} from "./OperationBar";
import { operationId, useLogSelection } from "./inspection";
import { Brand, brandMark } from "./Brand";
import { validateSnapshot, validateStory } from "./protocol";
import { timed } from "./timing";
import "./lab.css";
import "./recovery.css";

class EngineError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

async function request<T>(path: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api/${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers:
        body === undefined
          ? undefined
          : {
              "Content-Type": "application/json",
              "X-Walnut-Client": "inspector-v1",
            },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(/^(lab|story)/.test(path) ? 20000 : 6000),
    });
  } catch {
    throw new EngineError(
      "The engine is unavailable. Start WALnut, then reconnect.",
    );
  }
  const data = await response.json().catch(() => {
    throw new EngineError(
      "The engine returned an unreadable response. Reconnect to try again.",
    );
  });
  if (!response.ok)
    throw new EngineError(
      data?.error?.message || "The command could not complete.",
      response.status,
    );
  if (!data || typeof data !== "object" || Array.isArray(data))
    throw new EngineError(
      "The engine returned an invalid response. Reconnect to try again.",
    );
  return data as T;
}

const message = (error: unknown) =>
  error instanceof Error ? error.message : "The command could not complete.";
const pad = (value?: number) =>
  value == null ? "—" : String(value).padStart(2, "0");

const waitingOperation: Operation = {
  command: "connect",
  headline: "Waiting for the engine.",
  tone: "neutral",
  facts: [],
};

const noRecording: Operation = {
  command: "select",
  headline: "Choose an experiment and run it.",
  tone: "neutral",
  facts: [],
  evidence:
    "Each run drives the real engine against its own disposable database and captures a snapshot after every observable operation.",
};

export default function App() {
  const [live, setLive] = useState<Snapshot | null>(null);
  const [previousLive, setPreviousLive] = useState<Snapshot | null>(null);
  const [connected, setConnected] = useState(false);
  const [connectionError, setConnectionError] = useState("");
  const [lagging, setLagging] = useState(false);
  const [missedEvents, setMissedEvents] = useState(0);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<"live" | "replay">(() =>
    new URLSearchParams(window.location.search).get("mode") === "replay"
      ? "replay"
      : "live",
  );
  const [selectedKey, setSelectedKey] = useState("");
  const [notice, setNotice] = useState("");
  const [commandError, setCommandError] = useState("");
  const [story, setStory] = useState<RecordedStory | null>(null);
  const [scenario, setScenario] = useState<StoryScenario>("split");
  const [storyError, setStoryError] = useState("");
  const [storyRunning, setStoryRunning] = useState(false);
  const [index, setIndex] = useState(0);
  const [recordedPage, setRecordedPage] = useState(1);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [labResult, setLabResult] = useState<LabResult | null>(null);
  const [labError, setLabError] = useState("");
  const [labRunning, setLabRunning] = useState(false);
  const livePage = useRef(1);
  const busyRef = useRef(false);
  const requestEpoch = useRef(0);
  const polling = useRef(false);
  const lastAccepted = useRef<Snapshot | null>(null);
  const available = connected && !lagging;

  const accept = useCallback((value: unknown) => {
    let snapshot: Snapshot;
    try {
      snapshot = timed("walnut:snapshot:validate", () =>
        validateSnapshot(value),
      );
      const previous = lastAccepted.current;
      if (previous?.session_id === snapshot.session_id) {
        const last = previous.events.at(-1)?.sequence ?? 0;
        const first = snapshot.events[0]?.sequence ?? 0;
        if (
          snapshot.database_id !== previous.database_id ||
          snapshot.generation < previous.generation ||
          (snapshot.events.at(-1)?.sequence ?? 0) < last
        ) {
          throw new Error(
            "The engine returned an older snapshot from the same session. Reconnect to refresh.",
          );
        }
        if (first > last + 1)
          setMissedEvents((count) => count + first - last - 1);
      } else setMissedEvents(0);
    } catch (error) {
      setConnected(false);
      setConnectionError(message(error));
      throw new EngineError(message(error));
    }
    const previous = lastAccepted.current;
    if (!previous || operationId(previous) !== operationId(snapshot)) {
      setPreviousLive(
        previous &&
          previous.database_id === snapshot.database_id &&
          previous.session_id === snapshot.session_id &&
          (previous.events.at(-1)?.operation ?? -2) + 1 ===
            snapshot.events.at(-1)?.operation
          ? previous
          : null,
      );
    }
    setLive(snapshot);
    lastAccepted.current = snapshot;
    livePage.current = snapshot.page_id;
    setConnected(true);
    setConnectionError("");
    setLagging(false);
  }, []);

  const refresh = useCallback(async () => {
    if (busyRef.current || polling.current) return;
    polling.current = true;
    const epoch = requestEpoch.current;
    const delay = setTimeout(() => {
      if (requestEpoch.current === epoch && !busyRef.current) setLagging(true);
    }, 2500);
    try {
      let snapshot: Snapshot;
      try {
        snapshot = await request<Snapshot>(`snapshot?page=${livePage.current}`);
      } catch (error) {
        // A restarted server may open a smaller database. Reconnect at its first leaf.
        if (
          !(error instanceof EngineError) ||
          error.status !== 400 ||
          livePage.current <= 1
        )
          throw error;
        snapshot = await request<Snapshot>("snapshot?page=1");
      }
      if (requestEpoch.current === epoch && !busyRef.current) accept(snapshot);
    } catch (error) {
      if (requestEpoch.current === epoch && !busyRef.current) {
        setConnected(false);
        setConnectionError(message(error));
      }
    } finally {
      clearTimeout(delay);
      setLagging(false);
      polling.current = false;
    }
  }, [accept]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 1500);
    return () => {
      clearInterval(timer);
      requestEpoch.current++;
    };
  }, [refresh]);

  const begin = () => {
    busyRef.current = true;
    requestEpoch.current++;
    setBusy(true);
    setPlaying(false);
  };
  const finish = () => {
    busyRef.current = false;
    setBusy(false);
  };
  const noteUnavailable = (error: unknown) => {
    if (error instanceof EngineError && error.status == null) {
      setConnected(false);
      setConnectionError(message(error));
    }
  };

  const execute = async (
    kind: LiveCommand,
    body: unknown = {},
  ): Promise<CommandResponse | undefined> => {
    if (busyRef.current || mode !== "live" || (!available && kind !== "reopen"))
      return;
    begin();
    setNotice("");
    selectLogFrame(undefined);
    setCommandError("");
    try {
      const response = await request<CommandResponse>(
        `${kind}?page=${livePage.current}`,
        body,
      );
      accept(response.snapshot);
      const target =
        kind === "grow"
          ? response.snapshot.root_page_id
          : ["put", "commit", "get"].includes(kind)
            ? response.snapshot.last_search_path.at(-1)
            : undefined;
      if (kind === "put" && typeof body === "object" && body && "key" in body)
        setSelectedKey(String(body.key));
      else if (kind === "get" && response.result?.found)
        setSelectedKey(response.result.key);
      else if (kind === "get" || kind === "grow" || kind === "commit")
        setSelectedKey("");
      if (target != null && target !== response.snapshot.page_id) {
        try {
          accept(await request<Snapshot>(`snapshot?page=${target}`));
        } catch {
          setNotice("Command completed. Select its page to retry inspection.");
        }
      }
      if (kind === "grow")
        setNotice(
          "64 sample records committed. Walk the page map to follow the new pages.",
        );
      return response;
    } catch (error) {
      noteUnavailable(error);
      throw error;
    } finally {
      finish();
    }
  };

  const globalCommand = async (kind: LiveCommand) => {
    try {
      await execute(kind);
    } catch (error) {
      noteUnavailable(error);
      setCommandError(message(error));
    }
  };

  const selectPage = async (id: number, key = "") => {
    if (busyRef.current) return;
    selectLogFrame(undefined);
    setPlaying(false);
    setSelectedKey(key);
    if (mode === "replay") {
      setRecordedPage(id);
      return;
    }
    if (!available) return;
    begin();
    try {
      accept(await request<Snapshot>(`snapshot?page=${id}`));
      setCommandError("");
    } catch (error) {
      noteUnavailable(error);
      setCommandError(message(error));
    } finally {
      finish();
    }
  };

  const seek = (next: number) => {
    if (!story) return;
    const bounded = Math.max(0, Math.min(next, story.frames.length - 1));
    setPlaying(false);
    setIndex(bounded);
    setRecordedPage(story.frames[bounded].focus_page_id);
    setSelectedKey("");
  };

  useEffect(() => {
    if (!playing || mode !== "replay" || !story || busy) return;
    if (index >= story.frames.length - 1) {
      setPlaying(false);
      return;
    }
    const timer = setTimeout(() => {
      const next = index + 1;
      setIndex(next);
      setRecordedPage(story.frames[next].focus_page_id);
      setSelectedKey("");
    }, 2400 / speed);
    return () => clearTimeout(timer);
  }, [playing, mode, story, busy, index, speed]);

  useEffect(() => {
    const pause = () => {
      if (document.hidden) setPlaying(false);
    };
    document.addEventListener("visibilitychange", pause);
    return () => document.removeEventListener("visibilitychange", pause);
  }, []);

  const switchMode = (next: "live" | "replay") => {
    if (busyRef.current) return;
    setMode(next);
    selectLogFrame(undefined);
    setPlaying(false);
    setSelectedKey("");
    setCommandError("");
    setNotice("");
    if (next === "live") void refresh();
  };

  const runStory = async (
    selectedScenario: StoryScenario = scenario,
    autoplay = false,
  ) => {
    if (busyRef.current || !available) return;
    begin();
    setStoryRunning(true);
    setStoryError("");
    setScenario(selectedScenario);
    try {
      const response = await request<CommandResponse>(
        `story?page=${livePage.current}`,
        { scenario: selectedScenario },
      );
      const recording = timed("walnut:story:validate", () =>
        validateStory(response.story),
      );
      accept(response.snapshot);
      setStory(recording);
      setIndex(0);
      setRecordedPage(recording.frames[0].focus_page_id);
      setSelectedKey("");
      setPlaying(autoplay);
    } catch (error) {
      noteUnavailable(error);
      setStoryError(message(error));
    } finally {
      finish();
      setStoryRunning(false);
    }
  };

  const watchSplit = () => {
    if (busyRef.current || !available) return;
    switchMode("replay");
    void runStory("split", true);
    document.getElementById("workspace")?.scrollIntoView({ block: "start" });
  };

  const runLab = async (boundary: string, labScenario: string) => {
    if (busyRef.current || !available) return;
    begin();
    setLabRunning(true);
    setLabError("");
    try {
      const response = await request<CommandResponse>(
        `lab?page=${livePage.current}`,
        { boundary, scenario: labScenario },
      );
      if (response.lab) validateSnapshot(response.lab.snapshot);
      accept(response.snapshot);
      setLabResult(response.lab ?? null);
    } catch (error) {
      noteUnavailable(error);
      setLabError(message(error));
    } finally {
      finish();
      setLabRunning(false);
    }
  };

  const frame = story?.frames[index];
  const captured =
    frame?.capture.pages.find((page) => page.page_id === recordedPage) ??
    frame?.capture.pages.find((page) => page.page_id === frame.focus_page_id);
  const snapshot =
    mode === "live"
      ? live
      : frame && captured
        ? { ...frame.capture.snapshot, ...captured }
        : null;
  const snapshotDisabled = busy || (mode === "live" && !available);
  const recorded = mode === "replay";
  const stopped = frame?.kind === "crashed";
  const { frame: selectedLog, selectFrame: selectLogFrame } = useLogSelection(
    snapshot,
    recorded
      ? `${story?.run_id}:${frame?.id}`
      : live
        ? operationId(live)
        : "waiting",
  );
  const chooseLog = (transaction: WalFrame) => {
    if (snapshotDisabled || !snapshot) return;
    const id = transaction.page_ids.includes(snapshot.page_id)
      ? snapshot.page_id
      : (transaction.page_ids.find((id) => id !== 0) ?? 0);
    void selectPage(id, id === snapshot.page_id ? selectedKey : "");
    selectLogFrame(transaction);
  };
  const operation = snapshot
    ? recorded && frame
      ? withChanges(
          describeFrame(frame),
          snapshot,
          story?.frames[index - 1]?.capture.snapshot,
        )
      : withChanges(describeOperation(snapshot), snapshot, previousLive)
    : recorded
      ? noRecording
      : waitingOperation;

  return (
    <div className="lab">
      <a className="skip-link" href="#workspace">
        Skip to workspace
      </a>

      <header className="lab-header">
        <Brand href="/" label="WALnut home" />
        <span className="lab-tagline">A database with its internals open.</span>
        <div className="lab-status-chip">
          <button
            className="watch-split"
            disabled={busy || !available}
            onClick={watchSplit}
            title="Play a captured engine run in its own disposable database"
          >
            {storyRunning ? "Capturing…" : "Watch a page split"}{" "}
            <span aria-hidden="true">↗</span>
          </button>
          <span className={available ? "is-connected" : ""} role="status">
            {connected
              ? lagging
                ? "Engine delayed"
                : "Engine connected"
              : connectionError
                ? "Engine offline"
                : "Connecting to engine…"}
          </span>
          <span className="lab-stack">RUST · B+ TREE · WAL</span>
        </div>
      </header>

      <main id="workspace">
        <div className="lab-strip">
          <div className="lab-modes" role="group" aria-label="Workspace mode">
            <button
              aria-pressed={mode === "live"}
              disabled={busy}
              onClick={() => switchMode("live")}
            >
              Live database
            </button>
            <button
              aria-pressed={mode === "replay"}
              disabled={busy}
              onClick={() => switchMode("replay")}
            >
              Guided stories <em>03</em>
            </button>
          </div>
          <div className="lab-identity">
            <strong title={snapshot?.database_name}>
              {mode === "live"
                ? (live?.database_name ?? "Waiting for engine")
                : (story?.title ?? "Choose an experiment")}
            </strong>
            <small>
              {mode === "live"
                ? "Owned by one engine process · serialized commands"
                : story
                  ? `Recorded run ${story.run_id.slice(0, 12)}`
                  : "Captured engine runs · read only"}
            </small>
          </div>
          <dl
            className="lab-metrics"
            aria-label={
              mode === "live"
                ? "Live database statistics"
                : "Recorded frame statistics"
            }
          >
            <div>
              <dt>Records</dt>
              <dd data-testid="record-count">{pad(snapshot?.record_count)}</dd>
            </div>
            <div>
              <dt>Node pages</dt>
              <dd data-testid="page-count">{pad(snapshot?.page_count)}</dd>
            </div>
            <div>
              <dt>Height</dt>
              <dd data-testid="tree-height">
                {snapshot ? (
                  <>
                    {snapshot.tree_height}{" "}
                    <em>{snapshot.tree_height === 1 ? "level" : "levels"}</em>
                  </>
                ) : (
                  "—"
                )}
              </dd>
            </div>
            <div>
              <dt>Root</dt>
              <dd data-testid="root-page">
                {snapshot ? `P${snapshot.root_page_id}` : "—"}
              </dd>
            </div>
            <div>
              <dt>Generation</dt>
              <dd data-testid="generation">{pad(snapshot?.generation)}</dd>
            </div>
          </dl>
        </div>

        {connectionError && (
          <div className="lab-alert" role="alert">
            <div>
              <strong>Engine offline.</strong>{" "}
              {live
                ? "Showing the last verified snapshot."
                : "Start the local engine to connect."}{" "}
              {mode === "replay" && story
                ? "Your recorded run is still available."
                : connectionError}
            </div>
            <button disabled={busy} onClick={() => void refresh()}>
              Reconnect
            </button>
          </div>
        )}
        {lagging && !connectionError && (
          <div className="lab-alert" data-kind="waiting" role="status">
            <div>
              <strong>Waiting for the engine.</strong> The snapshot request is
              taking longer than usual.
              {live
                ? " Showing the last verified state until it completes."
                : " Waiting for the first verified snapshot."}
              {mode === "replay" && story
                ? " Recorded playback remains available."
                : ""}
            </div>
          </div>
        )}

        <OperationBar
          operation={operation}
          label={recorded ? "Current story step" : "Current operation"}
          badge={recorded ? "RECORDED" : "LIVE"}
          badgeTone={
            recorded ? (stopped ? "failed" : "checkpointed") : "committed"
          }
          badgeNote={
            recorded
              ? !story
                ? "no recording yet"
                : stopped
                  ? "process terminated"
                  : `step ${index + 1} of ${story.frames.length}`
              : available
                ? "engine attached"
                : "no engine"
          }
          notice={
            stopped ? (
              <>
                <strong className="story-stopped">
                  Process stopped · last captured state
                </strong>
                {story?.process && (
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
        >
          {!recorded && live && (
            <NextAction
              snapshot={live}
              disabled={snapshotDisabled}
              onCheckpoint={() => void globalCommand("checkpoint")}
              onCommit={() => void globalCommand("commit")}
              onExperiments={() => switchMode("replay")}
            />
          )}
          {recorded && story && (
            <button disabled={busy} onClick={() => switchMode("live")}>
              Try it on the live database <i aria-hidden="true">→</i>
            </button>
          )}
        </OperationBar>

        {(notice || commandError) && mode === "live" && (
          <p
            className="lab-notice"
            data-kind={commandError ? "error" : undefined}
            role={commandError ? "alert" : undefined}
            aria-live="polite"
          >
            {commandError || notice}
          </p>
        )}

        <div className="lab-grid">
          <div className="lab-rail">
            {mode === "live" ? (
              <Console
                snapshot={live}
                busy={busy}
                connected={connected}
                waiting={lagging}
                onCommand={execute}
                onSelectPage={(id, key) => void selectPage(id, key)}
              />
            ) : (
              <Experiments
                story={story}
                scenario={scenario}
                setScenario={(value) => {
                  setScenario(value);
                  setPlaying(false);
                  setStoryError("");
                }}
                run={() => void runStory()}
                busy={storyRunning}
                connected={available}
                error={storyError}
              />
            )}
          </div>

          <div className="lab-stage">
            {snapshot ? (
              <>
                <Structure
                  snapshot={snapshot}
                  selectedPageId={snapshot.page_id}
                  onSelect={(id) => void selectPage(id)}
                  disabled={snapshotDisabled}
                  mode={mode}
                  linkedFrame={selectedLog}
                  selectedKey={selectedKey}
                  clearLog={() => selectLogFrame(undefined)}
                  operationKey={
                    recorded
                      ? `${story?.run_id}:${frame?.id}`
                      : operationId(snapshot)
                  }
                  pulseAllowed={!recorded || !stopped}
                />
                <DurabilityRail
                  snapshot={snapshot}
                  disabled={snapshotDisabled}
                  checkpoint={
                    mode === "live"
                      ? () => void globalCommand("checkpoint")
                      : undefined
                  }
                  selectPage={(id) => void selectPage(id)}
                  selectedFrame={selectedLog}
                  onSelectFrame={chooseLog}
                />
              </>
            ) : (
              <section className="lab-empty">
                <div className="lab-empty-figure" aria-hidden="true">
                  <i />
                  <span />
                  <div>
                    <i />
                    <i />
                  </div>
                </div>
                <h2>
                  {mode === "replay"
                    ? "Choose an experiment to begin."
                    : connectionError
                      ? "Waiting for the engine."
                      : "Opening the database…"}
                </h2>
                <p>
                  {mode === "replay"
                    ? "Each run drives the real Rust engine against a disposable database and captures every page it writes."
                    : "The stage fills with verified pages as soon as the local engine answers."}
                </p>
                {mode === "replay" && (
                  <button
                    className="watch-split"
                    disabled={busy || !available}
                    onClick={watchSplit}
                  >
                    {storyRunning ? "Capturing…" : "Watch a page split"}
                  </button>
                )}
              </section>
            )}
          </div>

          {snapshot ? (
            <Inspector
              snapshot={snapshot}
              selectedKey={selectedKey}
              onSelectKey={(key) => {
                selectLogFrame(undefined);
                setSelectedKey(key);
                setPlaying(false);
              }}
              onSelectPage={(id) => void selectPage(id)}
              mode={mode}
              selectedFrame={selectedLog}
              onSelectFrame={chooseLog}
              disabled={snapshotDisabled}
            />
          ) : (
            <aside className="inspect-placeholder">
              <span className="kicker">Page inspector</span>
              <p>
                Select any page to reveal its records, routing table and raw 4
                KB image.
              </p>
              <pre>
                {"0000  57 41 4C 4E 55 54  WALNUT\n"}
                <b>{"0010  ·· ·· ·· ·· ·· ··  ······\n"}</b>
                <b>{"0020  ·· ·· ·· ·· ·· ··  ······"}</b>
              </pre>
            </aside>
          )}
        </div>

        {mode === "replay" && story && (
          <RecordedTimeline
            story={story}
            index={index}
            playing={playing}
            speed={speed}
            disabled={busy}
            setIndex={seek}
            setPlaying={setPlaying}
            setSpeed={setSpeed}
          />
        )}

        {mode === "live" && live && (
          <EventTimeline
            events={live.events}
            missed={missedEvents}
            disabled={snapshotDisabled}
            knownPage={(id) =>
              id === 0 || live.pages.some((page) => page.id === id)
            }
            selectPage={(id) => void selectPage(id)}
          />
        )}

        <details className="lab-advanced">
          <summary>
            Advanced crash lab <span>Choose an exact failure boundary</span>
          </summary>
          <RecoveryLab
            result={labResult}
            error={labError}
            disabled={busy || !available}
            running={labRunning}
            run={(boundary, labScenario) => void runLab(boundary, labScenario)}
          />
        </details>
      </main>

      <footer className="lab-footer">
        <span>
          <img src={brandMark} alt="" />A tiny database with its internals on
          display.
        </span>
        <span>
          RUST ENGINE <i /> REAL FILES <i /> VERIFIED BYTES
        </span>
      </footer>
    </div>
  );
}

/** One obvious next move, derived from what the database is holding. */
function NextAction({
  snapshot,
  disabled,
  onCheckpoint,
  onCommit,
  onExperiments,
}: {
  snapshot: Snapshot;
  disabled: boolean;
  onCheckpoint: () => void;
  onCommit: () => void;
  onExperiments: () => void;
}) {
  if (snapshot.staged.length > 0)
    return (
      <button data-emphasis="strong" disabled={disabled} onClick={onCommit}>
        Commit {snapshot.staged.length}{" "}
        {snapshot.staged.length === 1 ? "put" : "puts"}{" "}
        <i aria-hidden="true">→</i>
      </button>
    );
  if (snapshot.wal_frame_count > 0)
    return (
      <button disabled={disabled} onClick={onCheckpoint}>
        Checkpoint the file <i aria-hidden="true">→</i>
      </button>
    );
  return (
    <button onClick={onExperiments}>
      Run an experiment <i aria-hidden="true">→</i>
    </button>
  );
}
