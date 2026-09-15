import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { Snapshot, TreePage } from "./types";
import "./tree-canvas.css";

interface TreeCanvasProps {
  snapshot: Snapshot;
  selectedPageId: number;
  onSelect: (id: number) => void;
  disabled?: boolean;
  mode: "live" | "replay";
}

interface PositionedPage {
  page: TreePage;
  x: number;
  y: number;
  width: number;
  height: number;
  compact: boolean;
}

const CHILD_WINDOW = 3;
const pageName = (id: number) => `P${String(id).padStart(3, "0")}`;
const countNoun = (count: number, noun: string) =>
  count === 1 ? noun : `${noun}s`;

function shortKey(key: string | null) {
  if (key === null) return "No records yet";
  // Synthetic workloads pad keys with repeated characters. Condense padding
  // first so the generation and record index remain distinguishable.
  const characters = Array.from(key.replace(/(.)\1{5,}/gu, "$1…"));
  return characters.length > 25
    ? `${characters.slice(0, 18).join("")}…${characters.slice(-4).join("")}`
    : characters.join("");
}

function searchLabel(snapshot: Snapshot) {
  const event = [...snapshot.events]
    .reverse()
    .find((item) =>
      [
        "read_found",
        "read_missing",
        "range_read",
        "transaction_committed",
      ].includes(item.kind),
    );
  if (event?.kind === "range_read") return "Range scan";
  if (event?.kind === "transaction_committed") return "Write routing";
  if (event?.kind === "read_found" || event?.kind === "read_missing")
    return "Lookup";
  return "Search";
}

/** A bounded view of actual page relationships, shared by live and recorded state. */
export function TreeCanvas({
  snapshot,
  selectedPageId,
  onSelect,
  disabled = false,
  mode,
}: TreeCanvasProps) {
  const titleId = useId();
  const helpId = useId();
  const clipId = useId().replaceAll(":", "");
  const viewportRef = useRef<HTMLDivElement>(null);
  const [viewportWidth, setViewportWidth] = useState(720);
  const [zoom, setZoom] = useState(1);
  const [lastFocus, setLastFocus] = useState(snapshot.root_page_id);
  const [childWindow, setChildWindow] = useState({ key: "", start: 0 });

  const { pages, parents } = useMemo(() => {
    const pages = new Map(snapshot.pages.map((page) => [page.id, page]));
    const parents = new Map<number, number>();
    for (const page of snapshot.pages)
      for (const child of page.children) parents.set(child, page.id);
    return { pages, parents };
  }, [snapshot.pages]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const observer = new ResizeObserver(([entry]) => {
      setViewportWidth(Math.max(240, Math.floor(entry.contentRect.width)));
    });
    observer.observe(viewport);
    return () => observer.disconnect();
  }, []);

  const selected = pages.get(selectedPageId);
  const focus =
    (selected?.kind === "internal"
      ? selected
      : selected
        ? pages.get(parents.get(selected.id) ?? selected.id)
        : pages.get(lastFocus)) ?? pages.get(snapshot.root_page_id);

  // Metadata selection leaves the last inspected subtree on the stage.
  useEffect(() => {
    if (focus) setLastFocus(focus.id);
  }, [focus?.id]);

  const lineage: TreePage[] = [];
  if (focus) {
    let ancestor = parents.get(focus.id);
    while (ancestor !== undefined && lineage.length < snapshot.tree_height) {
      const page = pages.get(ancestor);
      if (!page) break;
      lineage.unshift(page);
      ancestor = parents.get(page.id);
    }
  }

  const windowKey = `${snapshot.database_id}:${focus?.id}:${selectedPageId}`;
  const selectedIndex = focus?.children.indexOf(selectedPageId) ?? -1;
  const requestedStart =
    childWindow.key === windowKey
      ? childWindow.start
      : Math.floor(Math.max(0, selectedIndex) / CHILD_WINDOW) * CHILD_WINDOW;
  const start = Math.min(
    requestedStart,
    Math.floor(Math.max(0, (focus?.children.length ?? 1) - 1) / CHILD_WINDOW) *
      CHILD_WINDOW,
  );
  const children = (focus?.children.slice(start, start + CHILD_WINDOW) ?? [])
    .map((id) => pages.get(id))
    .filter((page): page is TreePage => page !== undefined);

  // At most two ancestors, the focused page, and three children are drawn.
  // Breadcrumbs keep access to deeper ancestry without inventing skipped edges.
  const drawnAncestors = lineage.slice(-2);
  const sceneWidth = Math.max(
    viewportWidth,
    children.length === 3 ? 536 : children.length === 2 ? 350 : 310,
  );
  const childWidth = Math.min(
    202,
    (sceneWidth - 48) / Math.max(1, children.length) - 16,
  );
  const parentWidth = Math.min(242, sceneWidth - 48);
  const focusY = 24 + drawnAncestors.length * 62;
  const childY = focusY + 148;
  const sceneHeight = children.length ? childY + 146 : focusY + 208;
  const positioned: PositionedPage[] = [];
  for (let i = 0; i < drawnAncestors.length; i++) {
    positioned.push({
      page: drawnAncestors[i],
      x: (sceneWidth - 204) / 2,
      y: 24 + i * 62,
      width: 204,
      height: 42,
      compact: true,
    });
  }
  if (focus)
    positioned.push({
      page: focus,
      x: (sceneWidth - parentWidth) / 2,
      y: focusY,
      width: parentWidth,
      height: 110,
      compact: false,
    });
  for (let i = 0; i < children.length; i++) {
    positioned.push({
      page: children[i],
      x: ((i + 0.5) * sceneWidth) / children.length - childWidth / 2,
      y: childY,
      width: childWidth,
      height: 110,
      compact: false,
    });
  }
  const coordinates = new Map(positioned.map((item) => [item.page.id, item]));
  const edges = positioned.flatMap((item) => {
    const parent = coordinates.get(parents.get(item.page.id) ?? -1);
    return parent ? [{ from: parent, to: item }] : [];
  });
  const pathPages = new Set(snapshot.last_search_path);
  const searchTrail: (number | null)[] =
    snapshot.last_search_path.length > 7
      ? [
          ...snapshot.last_search_path.slice(0, 3),
          null,
          ...snapshot.last_search_path.slice(-3),
        ]
      : snapshot.last_search_path;
  const splitPages = new Set(
    snapshot.splits.flatMap((split) => [split.left, split.right]),
  );
  const changedPages = new Set(snapshot.changed_pages);
  const leaves =
    focus?.kind === "leaf"
      ? [focus]
      : children.filter((page) => page.kind === "leaf");
  const onPathEdge = (from: number, to: number) =>
    snapshot.last_search_path.some(
      (id, index) => id === from && snapshot.last_search_path[index + 1] === to,
    );

  function selectPage(id: number) {
    const page = pages.get(id);
    if (page) {
      const nextFocus = page.kind === "internal" ? id : (parents.get(id) ?? id);
      const childIndex = pages.get(nextFocus)?.children.indexOf(id) ?? -1;
      setLastFocus(nextFocus);
      setChildWindow({
        key: `${snapshot.database_id}:${nextFocus}:${id}`,
        start:
          Math.floor(Math.max(0, childIndex) / CHILD_WINDOW) * CHILD_WINDOW,
      });
    }
    onSelect(id);
  }

  function resetView() {
    setZoom(Math.min(1, viewportWidth / sceneWidth, 405 / sceneHeight));
    viewportRef.current?.scrollTo({ left: 0, top: 0 });
  }

  function node({ page, x, y, width, height, compact }: PositionedPage) {
    const isRoot = page.id === snapshot.root_page_id;
    const onPath = pathPages.has(page.id);
    const split = splitPages.has(page.id);
    const changed = changedPages.has(page.id);
    const selectedNode = selectedPageId === page.id;
    const keyLabel = page.kind === "internal" ? "First separator" : "First key";
    const nodeTitle = [
      `${isRoot ? "Root, " : ""}${page.kind} page ${page.id}, level ${page.level}`,
      `${page.count} ${countNoun(page.count, page.kind === "leaf" ? "record" : "separator")}, ${page.used_bytes} of ${snapshot.page_size} bytes`,
      ...(page.first_key === null ? [] : [`${keyLabel}: ${page.first_key}`]),
      ...(page.kind === "leaf" && page.last_key !== null
        ? [`Last key: ${page.last_key}`]
        : []),
      ...(onPath ? ["On the latest search path"] : []),
      ...(split
        ? ["Split in the latest commit"]
        : changed
          ? ["Changed in the latest commit"]
          : []),
    ].join(". ");
    return (
      <button
        key={page.id}
        type="button"
        className={`canvas-page canvas-page-${page.kind}${compact ? " canvas-page-ancestor" : ""}${onPath ? " canvas-page-path" : ""}${split ? " canvas-page-split" : ""}${selectedNode ? " canvas-page-selected" : ""}`}
        style={{ left: x, top: y, width, height } as CSSProperties}
        onClick={() => selectPage(page.id)}
        disabled={disabled}
        aria-label={`Inspect ${page.kind} page ${page.id}${isRoot ? ", root" : ""}`}
        aria-pressed={selectedNode}
        aria-description={nodeTitle}
        title={nodeTitle}
        data-page-id={page.id}
        data-page-kind={page.kind}
        data-search-path={onPath}
        data-write-state={split ? "split" : changed ? "changed" : "unchanged"}
      >
        <span className="canvas-page-head">
          <span className="canvas-page-kind">
            <i aria-hidden="true" />
            {isRoot ? "ROOT" : page.kind === "internal" ? "BRANCH" : "LEAF"}
          </span>
          <b>{pageName(page.id)}</b>
        </span>
        {compact ? (
          <span className="canvas-ancestor-detail">
            {page.children.length} children
            <span className="canvas-page-cues">
              {onPath && <b className="canvas-cue-path">PATH</b>}
              {split ? (
                <b className="canvas-cue-write">SPLIT</b>
              ) : changed ? (
                <b className="canvas-cue-write">WRITE</b>
              ) : null}
              {!onPath && !changed && <span>level {page.level}</span>}
            </span>
          </span>
        ) : (
          <>
            <span className="canvas-page-count">
              <strong>{page.count}</strong>{" "}
              {countNoun(
                page.count,
                page.kind === "internal" ? "separator" : "record",
              )}
              <small>L{page.level}</small>
            </span>
            <span
              className="canvas-page-key"
              title={page.first_key ?? undefined}
            >
              <span>{page.kind === "internal" ? "SEP" : "KEY"}</span>{" "}
              {shortKey(page.first_key)}
            </span>
            <span className="canvas-page-meter" aria-hidden="true">
              <i
                style={{
                  width: `${(page.used_bytes / snapshot.page_size) * 100}%`,
                }}
              />
            </span>
            <span className="canvas-page-foot">
              <span>
                {Math.round((page.used_bytes / snapshot.page_size) * 100)}% full
              </span>
              <span className="canvas-page-cues">
                {onPath && <b className="canvas-cue-path">PATH</b>}
                {split ? (
                  <b className="canvas-cue-write">SPLIT</b>
                ) : changed ? (
                  <b className="canvas-cue-write">WRITE</b>
                ) : null}
              </span>
            </span>
          </>
        )}
      </button>
    );
  }

  return (
    <section className="tree-stage" aria-labelledby={titleId} data-mode={mode}>
      <header className="canvas-toolbar">
        <div className="canvas-title">
          <h2 id={titleId}>The B+ tree</h2>
          <span>
            <b data-testid="canvas-page-count">{snapshot.page_count}</b>{" "}
            {countNoun(snapshot.page_count, "page")} <i>·</i>{" "}
            <b data-testid="canvas-tree-height">{snapshot.tree_height}</b>{" "}
            {snapshot.tree_height === 1 ? "level" : "levels"}
          </span>
        </div>
        <div className="canvas-view-controls" aria-label="Tree view controls">
          <button
            type="button"
            aria-label="Zoom out"
            disabled={zoom <= 0.5}
            onClick={() => setZoom((value) => Math.max(0.5, value - 0.25))}
          >
            −
          </button>
          <output aria-label="Tree zoom">{Math.round(zoom * 100)}%</output>
          <button
            type="button"
            aria-label="Zoom in"
            disabled={zoom >= 1.75}
            onClick={() => setZoom((value) => Math.min(1.75, value + 0.25))}
          >
            +
          </button>
          <button
            type="button"
            className="canvas-fit"
            onClick={resetView}
            title="Fit visible pages to the canvas and reset scroll position"
          >
            Fit
          </button>
        </div>
      </header>
      <div className="canvas-navigation">
        <nav aria-label="Tree ancestry">
          {[...lineage, ...(focus ? [focus] : [])].map((page, index) => (
            <span key={page.id}>
              {index > 0 && <i aria-hidden="true">/</i>}
              <button
                type="button"
                disabled={disabled}
                onClick={() => selectPage(page.id)}
                aria-current={page.id === focus?.id ? "location" : undefined}
              >
                {page.id === snapshot.root_page_id ? "Root " : ""}
                {pageName(page.id)}
              </button>
            </span>
          ))}
        </nav>
        {selectedPageId === 0 && (
          <span className="canvas-metadata-note">
            Inspecting metadata · P000
          </span>
        )}
        {focus?.id !== snapshot.root_page_id && (
          <button
            type="button"
            className="canvas-root-return"
            disabled={disabled}
            onClick={() => selectPage(snapshot.root_page_id)}
          >
            ↑ Root
          </button>
        )}
      </div>
      <div
        className="canvas-viewport"
        ref={viewportRef}
        tabIndex={0}
        role="region"
        aria-label="Interactive B+ tree canvas"
        aria-describedby={helpId}
      >
        <div
          className="canvas-scroll-space"
          style={{ width: sceneWidth * zoom, height: sceneHeight * zoom }}
        >
          <div
            className="canvas-scene"
            style={{
              width: sceneWidth,
              height: sceneHeight,
              transform: `scale(${zoom})`,
            }}
          >
            <svg
              className="canvas-edges"
              viewBox={`0 0 ${sceneWidth} ${sceneHeight}`}
              width={sceneWidth}
              height={sceneHeight}
              aria-hidden="true"
            >
              <defs>
                <marker
                  id={`leaf-arrow-${clipId}`}
                  markerWidth="6"
                  markerHeight="6"
                  refX="5"
                  refY="3"
                  orient="auto"
                >
                  <path d="M1 1 L5 3 L1 5" />
                </marker>
              </defs>
              {edges.map(({ from, to }) => {
                const x1 = from.x + from.width / 2;
                const y1 = from.y + from.height;
                const x2 = to.x + to.width / 2;
                const y2 = to.y;
                return (
                  <path
                    key={`${from.page.id}:${to.page.id}`}
                    className={`canvas-branch-edge${onPathEdge(from.page.id, to.page.id) ? " canvas-branch-edge-path" : ""}`}
                    d={`M${x1},${y1} C${x1},${y1 + 18} ${x2},${y2 - 18} ${x2},${y2}`}
                  />
                );
              })}
              {leaves.slice(0, -1).map((page, index) => {
                const from = coordinates.get(page.id);
                const to = coordinates.get(leaves[index + 1].id);
                if (!from || !to || page.next_leaf !== to.page.id) return null;
                return (
                  <path
                    key={`leaf:${page.id}`}
                    className={`canvas-leaf-edge${onPathEdge(page.id, to.page.id) ? " canvas-leaf-edge-path" : ""}`}
                    markerEnd={`url(#leaf-arrow-${clipId})`}
                    d={`M${from.x + from.width + 3},${from.y + 66} H${to.x - 4}`}
                  />
                );
              })}
            </svg>
            {positioned.map(node)}
            {children.length > 0 && (
              <span className="canvas-edge-label" style={{ top: focusY + 121 }}>
                CHILD POINTERS
              </span>
            )}
            {focus?.kind === "leaf" && (
              <p className="canvas-single-note" style={{ top: focusY + 127 }}>
                {snapshot.record_count === 0
                  ? "An empty leaf. The first write starts here."
                  : "One leaf holds every record."}
                <span>
                  Pages split when their encoded contents exceed 4 KB.
                </span>
              </p>
            )}
            {leaves.length > 0 && (
              <div
                className="canvas-leaf-chain"
                style={{ top: children.length ? childY + 123 : focusY + 185 }}
              >
                <span>LEAF LINKS</span>
                {leaves.map((page, index) => (
                  <span key={page.id}>
                    {index > 0 && <i aria-hidden="true">→</i>}
                    <button
                      type="button"
                      disabled={disabled}
                      onClick={() => selectPage(page.id)}
                      title={`Inspect leaf page ${page.id}`}
                    >
                      {pageName(page.id)}
                    </button>
                  </span>
                ))}
                <i aria-hidden="true">→</i>
                {leaves[leaves.length - 1].next_leaf === null ? (
                  <small>end</small>
                ) : (
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() =>
                      selectPage(leaves[leaves.length - 1].next_leaf!)
                    }
                    title="Follow the next leaf outside this view"
                  >
                    {pageName(leaves[leaves.length - 1].next_leaf!)} ↗
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
      {focus && focus.children.length > 0 && (
        <div className="canvas-pagination">
          <span>
            Children{" "}
            <b>
              {start + 1}–{start + children.length}
            </b>{" "}
            of {focus.children.length}
            <small> · select a branch to descend</small>
          </span>
          <div>
            <button
              type="button"
              aria-label="Previous child pages"
              disabled={disabled || start === 0}
              onClick={() =>
                setChildWindow({
                  key: windowKey,
                  start: Math.max(0, start - CHILD_WINDOW),
                })
              }
            >
              ←
            </button>
            <button
              type="button"
              aria-label="Next child pages"
              disabled={
                disabled || start + CHILD_WINDOW >= focus.children.length
              }
              onClick={() =>
                setChildWindow({ key: windowKey, start: start + CHILD_WINDOW })
              }
            >
              →
            </button>
          </div>
        </div>
      )}
      <div className="canvas-path-strip">
        <span>LATEST SEARCH PATH</span>
        <div
          data-testid="search-path"
          title={snapshot.last_search_path.map(pageName).join(" → ")}
        >
          {snapshot.last_search_path.length ? (
            searchTrail.map((id, index) => (
              <span key={`${index}:${id}`}>
                {id === null ? (
                  <small
                    title={`${snapshot.last_search_path.length - 6} intermediate pages`}
                  >
                    …
                  </small>
                ) : (
                  <>
                    {index > 0 && searchTrail[index - 1] !== null && (
                      <i aria-hidden="true">→</i>
                    )}
                    <button
                      type="button"
                      disabled={disabled}
                      onClick={() => selectPage(id)}
                    >
                      {pageName(id)}
                    </button>
                  </>
                )}
              </span>
            ))
          ) : (
            <small>A lookup or scan reveals its route.</small>
          )}
        </div>
        {snapshot.last_search_path.length > 0 && (
          <small className="canvas-path-kind">
            {searchLabel(snapshot)}
            {snapshot.last_search_path.length > 7 &&
              ` · ${snapshot.last_search_path.length} pages`}
          </small>
        )}
      </div>
      <p id={helpId} className="canvas-help">
        <span>
          <i className="canvas-legend-path" /> Search path
        </span>
        <span>
          <i className="canvas-legend-write" /> WRITE / SPLIT: latest commit
        </span>
        <span>Each node is a real {snapshot.page_size / 1024} KB page.</span>
      </p>
    </section>
  );
}
