import { useCallback, useEffect, useRef, useState } from "react";
import type {
  CommandResponse,
  LabResult,
  RecordedStory,
  Snapshot,
  StoryScenario,
} from "./types";
import { CommandPanel, type LiveCommand } from "./CommandPanel";
import { TreeCanvas } from "./TreeCanvas";
import { PageInspector } from "./PageInspector";
import { Journal } from "./Journal";
import { RecoveryLab } from "./RecoveryLab";
import { StoryGuide, StoryPlayer } from "./StoryPlayer";
import { Orientation } from "./Orientation";
import { validateSnapshot, validateStory } from "./protocol";
import { timed } from "./timing";
import "./recovery.css";
import "./workbench.css";

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

export default function App() {
  const [live, setLive] = useState<Snapshot | null>(null);
  const [connected, setConnected] = useState(false);
  const [connectionError, setConnectionError] = useState("");
  const [lagging, setLagging] = useState(false);
  const [missedEvents, setMissedEvents] = useState(0);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<"live" | "replay">(() =>
    new URLSearchParams(window.location.search).get("mode") === "live"
      ? "live"
      : "replay",
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
      if (kind === "checkpoint")
        setNotice(
          "Checkpoint complete. Main pages synced; WAL reset and synced.",
        );
      if (kind === "grow")
        setNotice(
          "64 sample records committed. Select a branch to follow the new pages.",
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
    setPlaying(false);
    setSelectedKey("");
    setCommandError("");
    setNotice("");
    if (next === "live") void refresh();
  };
  const runStory = async (selectedScenario: StoryScenario = scenario) => {
    if (busyRef.current || !available) return;
    begin();
    setStoryRunning(true);
    setStoryError("");
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
    } catch (error) {
      noteUnavailable(error);
      setStoryError(message(error));
    } finally {
      finish();
      setStoryRunning(false);
    }
  };
  const runLab = async (boundary: string, scenario: string) => {
    if (busyRef.current || !available) return;
    begin();
    setLabRunning(true);
    setLabError("");
    try {
      const response = await request<CommandResponse>(
        `lab?page=${livePage.current}`,
        { boundary, scenario },
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

  return (
    <div className="workbench">
      <a className="skip-link" href="#workspace">
        Skip to workspace
      </a>
      <header className="work-header">
        <a className="work-brand" href="/" aria-label="WALnut home">
          <img src="/walnut.svg" alt="" />
          <span>
            WAL<span>nut</span>
          </span>
        </a>
        <span className="work-tagline">A database, from the inside.</span>
        <div className="work-connection">
          <span className={available ? "is-connected" : ""} role="status">
            {connected
              ? lagging
                ? "Engine delayed"
                : "Engine connected"
              : connectionError
                ? "Engine offline"
                : "Connecting to engine…"}
          </span>
          <span className="work-version">RUST / B+ TREE</span>
        </div>
      </header>
      <main id="workspace">
        <div className="work-toolbar">
          <div className="work-modes" role="group" aria-label="Workspace mode">
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
              Guided stories <span>03</span>
            </button>
          </div>
          <div className="work-context">
            <span className={`mode-indicator ${mode}`}>
              {mode === "live" ? "LIVE" : story ? "RECORDED" : "GUIDED"}
            </span>
            <span title={snapshot?.database_name}>
              {mode === "live"
                ? (live?.database_name ?? "Waiting for engine")
                : (story?.title ?? "Choose an experiment")}
            </span>
          </div>
          {mode === "live" && (
            <button
              className="work-grow"
              disabled={busy || !available || !!live?.staged.length}
              onClick={() => void globalCommand("grow")}
              aria-label="Insert 64 sample records"
            >
              + 64 sample records
            </button>
          )}
        </div>
        {connectionError && (
          <div className="work-offline" role="alert">
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
          <div className="work-offline" role="status">
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
        <div
          className={`work-metrics ${mode === "replay" && !snapshot ? "is-empty" : ""}`}
          aria-label={
            mode === "live"
              ? "Live database statistics"
              : "Recorded frame statistics"
          }
        >
          <div>
            <span>RECORDS</span>
            <strong data-testid="record-count">
              {pad(snapshot?.record_count)}
            </strong>
          </div>
          <div>
            <span>NODE PAGES</span>
            <strong data-testid="page-count">
              {pad(snapshot?.page_count)}
            </strong>
          </div>
          <div>
            <span>TREE HEIGHT</span>
            <strong data-testid="tree-height">
              {snapshot
                ? `${snapshot.tree_height} ${snapshot.tree_height === 1 ? "level" : "levels"}`
                : "—"}
            </strong>
          </div>
          <div>
            <span>ROOT</span>
            <strong data-testid="root-page">
              {snapshot ? `P${snapshot.root_page_id}` : "—"}
            </strong>
          </div>
          <div>
            <span>GENERATION</span>
            <strong data-testid="generation">
              {pad(snapshot?.generation)}
            </strong>
          </div>
          <div className="work-metric-note">
            {mode === "live" ? (
              <>
                <b>Every page is real.</b>
                <span>4,096 bytes · inspect any node</span>
              </>
            ) : (
              <>
                <b>
                  {frame?.kind === "crashed"
                    ? "Process stopped."
                    : "Every step is captured."}
                </b>
                <span>
                  {frame?.kind === "crashed"
                    ? "Holding its last verified snapshot"
                    : "Explore without changing the live database"}
                </span>
              </>
            )}
          </div>
        </div>
        {(notice || commandError) && mode === "live" && (
          <p
            className={`work-notice ${commandError ? "work-error" : ""}`}
            role={commandError ? "alert" : undefined}
            aria-live="polite"
          >
            {commandError || notice}
          </p>
        )}
        <div className="work-grid">
          {mode === "live" ? (
            <CommandPanel
              snapshot={live}
              busy={busy}
              connected={connected}
              waiting={lagging}
              onCommand={execute}
              onSelectPage={(id, key) => void selectPage(id, key)}
            />
          ) : (
            <StoryGuide
              story={story}
              frame={frame}
              index={index}
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
          <div
            className={`work-center ${mode === "replay" && !snapshot ? "is-orientation" : ""}`}
          >
            {snapshot ? (
              <TreeCanvas
                snapshot={snapshot}
                selectedPageId={snapshot.page_id}
                onSelect={(id) => void selectPage(id)}
                disabled={snapshotDisabled}
                mode={mode}
              />
            ) : mode === "replay" ? (
              <Orientation
                disabled={busy || !available}
                onStart={() => {
                  setScenario("split");
                  void runStory("split");
                }}
              />
            ) : (
              <section className="work-empty">
                <div className="empty-tree" aria-hidden="true">
                  <i />
                  <span />
                  <div>
                    <i />
                    <i />
                  </div>
                </div>
                <span className="eyebrow">
                  SMALL ENGINE. VISIBLE CONSEQUENCES.
                </span>
                <h2>
                  {connectionError
                    ? "Waiting for the engine."
                    : "Opening the database…"}
                </h2>
                <p>
                  The workspace fills with verified pages when the local engine
                  connects.
                </p>
              </section>
            )}
            {snapshot && (
              <Journal
                snapshot={snapshot}
                disabled={snapshotDisabled}
                checkpoint={
                  mode === "live"
                    ? () => void globalCommand("checkpoint")
                    : undefined
                }
                selectPage={(id) => void selectPage(id)}
              />
            )}
          </div>
          {snapshot ? (
            <PageInspector
              snapshot={snapshot}
              selectedKey={selectedKey}
              onSelectKey={(key) => {
                setSelectedKey(key);
                setPlaying(false);
              }}
              onSelectPage={(id) => void selectPage(id)}
              mode={mode}
            />
          ) : mode === "live" ? (
            <aside className="inspect-placeholder">
              <span className="eyebrow">PAGE INSPECTOR</span>
              <p>
                Select any page to reveal its records, routing, and raw bytes.
              </p>
              <div aria-hidden="true">
                0000 <span>57 41 4C 4E 55 54</span>
                <br />
                0010 <span>·· ·· ·· ·· ·· ··</span>
                <br />
                0020 <span>·· ·· ·· ·· ·· ··</span>
              </div>
            </aside>
          ) : null}
        </div>
        {mode === "replay" && story && (
          <StoryPlayer
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
          <section className="work-events" aria-labelledby="events-title">
            <header>
              <div>
                <span className="eyebrow">ENGINE TIMELINE</span>
                <h2 id="events-title">The latest operation, in order.</h2>
              </div>
              <span>Page links inspect the current state.</span>
            </header>
            {missedEvents > 0 && (
              <p className="work-stream-gap" role="status">
                Timeline gap: {missedEvents} events passed outside the retained
                window. The current snapshot is complete.
              </p>
            )}
            <ol>
              {live.events.slice(-6).map((event) => (
                <li key={`${event.session_id}:${event.sequence}`}>
                  <span className="event-sequence">
                    {String(event.sequence).padStart(3, "0")}
                  </span>
                  <div>
                    <strong>{event.kind.replaceAll("_", " ")}</strong>
                    <p>{event.detail}</p>
                  </div>
                  <span className="event-generation">G{event.generation}</span>
                  {event.page_id !== null &&
                    (event.page_id === 0 ||
                      live.pages.some((page) => page.id === event.page_id)) && (
                      <button
                        disabled={snapshotDisabled}
                        onClick={() => void selectPage(event.page_id!)}
                      >
                        P{event.page_id} ↗
                      </button>
                    )}
                </li>
              ))}
            </ol>
            <details>
              <summary>All {live.events.length} retained events</summary>
              <ol>
                {live.events.map((event) => (
                  <li key={`${event.session_id}:${event.sequence}`}>
                    <span className="event-sequence">{event.sequence}</span>
                    <div>
                      <strong>{event.kind.replaceAll("_", " ")}</strong>
                      <p>{event.detail}</p>
                    </div>
                    <span className="event-generation">
                      G{event.generation}
                    </span>
                  </li>
                ))}
              </ol>
            </details>
          </section>
        )}
        <details className="work-advanced">
          <summary>
            Advanced crash lab <span>Choose an exact failure boundary</span>
          </summary>
          <RecoveryLab
            result={labResult}
            error={labError}
            disabled={busy || !available}
            running={labRunning}
            run={(boundary, scenario) => void runLab(boundary, scenario)}
          />
        </details>
      </main>
      <footer className="work-footer">
        <span>
          <img src="/walnut.svg" alt="" /> A tiny database with its internals on
          display.
        </span>
        <span>
          RUST ENGINE <i /> REAL FILES <i /> WALnut
        </span>
      </footer>
    </div>
  );
}
