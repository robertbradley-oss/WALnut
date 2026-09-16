import {
  memo,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import type { CSSProperties, KeyboardEvent } from "react";
import type { Snapshot, TreePage, WalFrame } from "./types";
import "./structure.css";

interface StructureProps {
  snapshot: Snapshot;
  selectedPageId: number;
  onSelect: (id: number) => void;
  disabled?: boolean;
  mode: "live" | "replay";
  linkedFrame?: WalFrame;
  selectedKey?: string;
  clearLog: () => void;
  operationKey: string;
  pulseAllowed?: boolean;
}

interface Placed {
  page: TreePage;
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Row {
  level: number;
  pages: TreePage[];
  before: number;
  after: number;
  beforeId: number | null;
  afterId: number | null;
}

const CARD_H = 118;
const ROW_GAP = 44;
const CARD_GAP = 20;
const PAD = 24;

const pageName = (id: number) => `P${String(id).padStart(3, "0")}`;
const plural = (count: number, noun: string) =>
  `${noun}${count === 1 ? "" : "s"}`;

/**
 * Shorten a key for a page card without losing what distinguishes it.
 *
 * Generated workloads pad keys to a fixed byte length, which buries the index
 * in a run of identical bytes. Collapsing runs first keeps that index visible;
 * anything still too long is trimmed from the middle. Every elision is marked
 * with an ellipsis, and the full key stays in the card's title and
 * accessible description.
 */
function shortKey(key: string | null, limit = 22) {
  if (key === null) return null;
  const condensed = key.replace(/(.)\1{4,}/gu, "$1…");
  const glyphs = Array.from(condensed);
  if (glyphs.length <= limit) return condensed;
  const head = Math.max(4, Math.ceil((limit - 1) * 0.6));
  const tail = Math.max(3, limit - 1 - head);
  return `${glyphs.slice(0, head).join("")}…${glyphs.slice(-tail).join("")}`;
}

function routeLabel(snapshot: Snapshot) {
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
  if (event?.kind === "transaction_committed") return "Write route";
  if (event?.kind === "read_found") return "Lookup · found";
  if (event?.kind === "read_missing") return "Lookup · missing";
  return "Search";
}

/**
 * The tree, drawn from real page relationships.
 *
 * Every allocated page appears in the page map. The stage below it draws a
 * contiguous, correctly ordered slice of each level around the selected page,
 * so edges are always real parent/child links and never invented shortcuts.
 */
export function Structure({
  snapshot,
  selectedPageId,
  onSelect,
  disabled = false,
  mode,
  linkedFrame,
  selectedKey,
  clearLog,
  operationKey,
  pulseAllowed = true,
}: StructureProps) {
  const titleId = useId();
  const legendId = useId();
  const arrowId = useId().replaceAll(":", "");
  const viewportRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(880);
  const [zoom, setZoom] = useState(1);
  const lastOperation = useRef(operationKey);
  const [recentOperation, setRecentOperation] = useState("");
  useEffect(() => {
    if (lastOperation.current === operationKey) return;
    lastOperation.current = operationKey;
    setRecentOperation(operationKey);
    const timer = setTimeout(() => setRecentOperation(""), 2000);
    return () => clearTimeout(timer);
  }, [operationKey]);
  const [anchor, setAnchor] = useState<{ key: string; id: number } | null>(
    null,
  );

  const model = useMemo(() => {
    const pages = new Map(snapshot.pages.map((page) => [page.id, page]));
    const parents = new Map<number, number>();
    const levels = new Map<number, TreePage[]>();
    const root = pages.get(snapshot.root_page_id);
    const seen = new Set<number>();
    // Depth-first from the root so each level is ordered by key, not by id.
    const walk = (page: TreePage) => {
      if (seen.has(page.id)) return;
      seen.add(page.id);
      const row = levels.get(page.level) ?? [];
      row.push(page);
      levels.set(page.level, row);
      for (const id of page.children) {
        const child = pages.get(id);
        if (!child) continue;
        parents.set(id, page.id);
        walk(child);
      }
    };
    if (root) walk(root);
    // Any page unreachable from the root still belongs in the map.
    for (const page of snapshot.pages)
      if (!seen.has(page.id)) {
        const row = levels.get(page.level) ?? [];
        row.push(page);
        levels.set(page.level, row);
      }
    return { pages, parents, levels };
  }, [
    snapshot.session_id,
    snapshot.database_id,
    snapshot.generation,
    snapshot.page_count,
    snapshot.root_page_id,
  ]);

  const { pages, parents, levels } = model;
  const selected = pages.get(selectedPageId);
  const anchorKey = `${snapshot.database_id}:${snapshot.generation}`;
  const held = anchor?.key === anchorKey ? pages.get(anchor.id) : undefined;
  // Metadata (P0) is not a tree node; keep the last tree selection on stage.
  const focus = selected ?? held ?? pages.get(snapshot.root_page_id);

  useEffect(() => {
    if (selected) setAnchor({ key: anchorKey, id: selected.id });
  }, [selected?.id, anchorKey]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const observer = new ResizeObserver(([entry]) =>
      setWidth(Math.max(260, Math.floor(entry.contentRect.width))),
    );
    observer.observe(viewport);
    return () => observer.disconnect();
  }, []);

  const spine = useMemo(() => {
    const chain = new Map<number, number>();
    let current = focus;
    while (current) {
      chain.set(current.level, current.id);
      const parent = parents.get(current.id);
      current = parent === undefined ? undefined : pages.get(parent);
    }
    return chain;
  }, [focus?.id, parents, pages]);

  const available = Math.max(260, width - PAD * 2);
  const perRow = Math.max(2, Math.min(9, Math.floor(available / 166)));
  const rows: Row[] = [];
  for (let level = snapshot.tree_height - 1; level >= 0; level--) {
    const all = levels.get(level) ?? [];
    let candidates = all;
    const above = rows.at(-1);
    if (above) {
      const drawn = new Set(above.pages.map((page) => page.id));
      const linked = all.filter((page) =>
        drawn.has(parents.get(page.id) ?? -1),
      );
      if (linked.length) candidates = linked;
    }
    let start = 0;
    if (candidates.length > perRow) {
      const target = candidates.findIndex(
        (page) => page.id === spine.get(level),
      );
      start = Math.max(
        0,
        Math.min(
          candidates.length - perRow,
          (target < 0 ? 0 : target) - Math.floor((perRow - 1) / 2),
        ),
      );
    }
    const slice = candidates.slice(start, start + perRow);
    rows.push({
      level,
      pages: slice,
      before: start,
      after: Math.max(0, candidates.length - start - slice.length),
      beforeId: start > 0 ? candidates[start - 1].id : null,
      afterId:
        candidates.length > start + slice.length
          ? candidates[start + slice.length].id
          : null,
    });
  }

  const widest = Math.max(1, ...rows.map((row) => row.pages.length));
  // Elision chips sit outside the card band, so reserve their gutters first.
  const gutter = rows.some((row) => row.before > 0 || row.after > 0) ? 52 : 0;
  const band = Math.max(200, available - gutter * 2);
  const cardW = Math.max(
    138,
    Math.min(268, (band - CARD_GAP * (widest - 1)) / widest),
  );
  const sceneW = Math.max(
    available,
    widest * cardW + CARD_GAP * (widest - 1) + Math.max(PAD, gutter) * 2,
  );
  const placed: Placed[] = [];
  rows.forEach((row, index) => {
    const span = row.pages.length * cardW + CARD_GAP * (row.pages.length - 1);
    const left = (sceneW - span) / 2;
    row.pages.forEach((page, column) => {
      placed.push({
        page,
        x: left + column * (cardW + CARD_GAP),
        y: PAD + index * (CARD_H + ROW_GAP),
        w: cardW,
        h: CARD_H,
      });
    });
  });
  const sceneH = PAD * 2 + rows.length * CARD_H + (rows.length - 1) * ROW_GAP;
  const coordinates = new Map(placed.map((item) => [item.page.id, item]));

  const path = snapshot.last_search_path;
  const onPath = new Set(path);
  const changed = new Set(snapshot.changed_pages);
  const linked = new Set(linkedFrame?.page_ids);
  const operation = snapshot.events.at(-1)?.operation;
  const kinds = new Set(
    snapshot.events
      .filter((event) => event.operation === operation)
      .map((event) => event.kind),
  );
  const affected = kinds.has("transaction_committed")
    ? changed
    : kinds.has("checkpoint_complete")
      ? new Set(snapshot.pages.map((page) => page.id))
      : kinds.has("read_found") ||
          kinds.has("read_missing") ||
          kinds.has("range_read")
        ? onPath
        : new Set<number>();
  const split = new Set(
    snapshot.splits.flatMap((item) => [item.left, item.right]),
  );
  const onPathEdge = (from: number, to: number) =>
    path.some((id, index) => id === from && path[index + 1] === to);

  const edges = placed.flatMap((item) => {
    const parent = coordinates.get(parents.get(item.page.id) ?? -1);
    return parent ? [{ from: parent, to: item }] : [];
  });
  const leafRow = rows.at(-1);
  const leafLinks = (leafRow?.pages ?? []).flatMap((page, index) => {
    const next = leafRow!.pages[index + 1];
    if (!next || page.next_leaf !== next.id) return [];
    const from = coordinates.get(page.id);
    const to = coordinates.get(next.id);
    return from && to ? [{ from, to }] : [];
  });

  // Identity-stable so the memoized page-map cells can skip re-rendering.
  const latest = useRef({ anchorKey, onSelect });
  latest.current = { anchorKey, onSelect };
  const select = useCallback((id: number) => {
    setAnchor({ key: latest.current.anchorKey, id });
    latest.current.onSelect(id);
  }, []);

  const fit = () => {
    setZoom(Math.min(1, available / sceneW));
    viewportRef.current?.scrollTo({ left: 0, top: 0 });
  };

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

  const trail: (number | null)[] =
    path.length > 7 ? [...path.slice(0, 3), null, ...path.slice(-3)] : path;

  function card({ page, x, y, w, h }: Placed) {
    const isRoot = page.id === snapshot.root_page_id;
    const route = onPath.has(page.id);
    const didSplit = split.has(page.id);
    const didChange = changed.has(page.id);
    const isSelected = selectedPageId === page.id;
    const fill = page.used_bytes / snapshot.page_size;
    const role = isRoot ? "ROOT" : page.kind === "internal" ? "BRANCH" : "LEAF";
    const unit = page.kind === "leaf" ? "record" : "separator";
    const description = [
      `${role} page ${page.id}, level ${page.level}`,
      `${page.count} ${plural(page.count, unit)}`,
      `${page.used_bytes.toLocaleString()} of ${snapshot.page_size.toLocaleString()} bytes, ${Math.round(fill * 100)} percent full`,
      ...(page.first_key === null
        ? []
        : [
            `${page.kind === "leaf" ? "First key" : "First separator"}: ${page.first_key}`,
          ]),
      ...(page.kind === "leaf" && page.last_key !== null
        ? [`Last key: ${page.last_key}`]
        : []),
      ...(route ? ["On the latest search path"] : []),
      ...(linked.has(page.id)
        ? [`Included in selected WAL generation ${linkedFrame?.generation}`]
        : []),
      ...(didSplit
        ? ["Split in the latest commit"]
        : didChange
          ? ["Changed in the latest commit"]
          : []),
    ].join(". ");
    return (
      <button
        key={page.id}
        type="button"
        className="canvas-page"
        style={{ left: x, top: y, width: w, height: h } as CSSProperties}
        onClick={() => select(page.id)}
        disabled={disabled}
        aria-label={`Inspect ${page.kind} page ${page.id}${isRoot ? ", root" : ""}`}
        aria-pressed={isSelected}
        aria-description={description}
        title={description}
        data-page-id={page.id}
        data-page-kind={page.kind}
        data-root={isRoot || undefined}
        data-selected={isSelected || undefined}
        data-route={route || undefined}
        data-write={didSplit ? "split" : didChange ? "changed" : undefined}
        data-log={linked.has(page.id) ? linkedFrame?.generation : undefined}
        data-recent={
          (pulseAllowed &&
            recentOperation === operationKey &&
            affected.has(page.id)) ||
          undefined
        }
        data-operation-tone={
          kinds.has("checkpoint_complete")
            ? "checkpointed"
            : kinds.has("transaction_committed")
              ? "committed"
              : "selected"
        }
      >
        <span className="canvas-page-top">
          <span className="canvas-page-role">{role}</span>
          <b className="num">{pageName(page.id)}</b>
        </span>
        <span className="canvas-page-body">
          <span className="canvas-page-count">
            <strong className="num">{page.count}</strong>
            <small>{plural(page.count, unit)}</small>
          </span>
          {page.first_key !== null && (
            <span className="canvas-page-key" title={page.first_key}>
              <i aria-hidden="true">{page.kind === "leaf" ? "from" : "sep"}</i>
              {shortKey(page.first_key, Math.max(12, Math.floor(cardW / 6.4)))}
            </span>
          )}
        </span>
        <span className="canvas-page-fill">
          <span
            className="canvas-page-bar"
            aria-hidden="true"
            data-tight={fill > 0.82 || undefined}
          >
            <i style={{ width: `${Math.min(100, fill * 100)}%` }} />
          </span>
          <span className="canvas-page-bytes num">
            {page.used_bytes.toLocaleString()} B
            {/* The search path already reads as a cyan edge and border; only
                the write state needs a word of its own here. */}
            {didSplit ? (
              <b data-flag="split">SPLIT</b>
            ) : didChange ? (
              <b data-flag="write">WRITE</b>
            ) : null}
            <em>{Math.round(fill * 100)}%</em>
          </span>
        </span>
      </button>
    );
  }

  return (
    <section className="structure" aria-labelledby={titleId} data-mode={mode}>
      <header className="structure-head">
        <div className="structure-title">
          <span className="kicker">Structure</span>
          <h2 id={titleId}>
            B+ tree <i aria-hidden="true">·</i>{" "}
            <b className="num" data-testid="canvas-page-count">
              {snapshot.page_count}
            </b>{" "}
            {plural(snapshot.page_count, "page")} <i aria-hidden="true">·</i>{" "}
            <b className="num" data-testid="canvas-tree-height">
              {snapshot.tree_height}
            </b>{" "}
            {snapshot.tree_height === 1 ? "level" : "levels"}
          </h2>
        </div>
        <nav className="structure-crumbs" aria-label="Tree ancestry">
          {[...lineage, ...(focus ? [focus] : [])].map((page, index) => (
            <span key={page.id}>
              {index > 0 && <i aria-hidden="true">/</i>}
              <button
                type="button"
                disabled={disabled}
                onClick={() => select(page.id)}
                aria-current={page.id === focus?.id ? "location" : undefined}
              >
                {page.id === snapshot.root_page_id ? "Root " : ""}
                {pageName(page.id)}
              </button>
            </span>
          ))}
        </nav>
        <div className="structure-zoom" aria-label="Tree view controls">
          <button
            type="button"
            aria-label="Zoom out"
            disabled={zoom <= 0.5}
            onClick={() => setZoom((value) => Math.max(0.5, value - 0.25))}
          >
            −
          </button>
          <output aria-label="Tree zoom" className="num">
            {Math.round(zoom * 100)}%
          </output>
          <button
            type="button"
            aria-label="Zoom in"
            disabled={zoom >= 1.75}
            onClick={() => setZoom((value) => Math.min(1.75, value + 0.25))}
          >
            +
          </button>
          <button type="button" className="structure-fit" onClick={fit}>
            Fit
          </button>
        </div>
      </header>

      {(linkedFrame || selectedKey) && (
        <div className="structure-selection" aria-label="Linked selection">
          {linkedFrame ? (
            <>
              <strong>WAL gen {linkedFrame.generation}</strong>
              <span>
                {linkedFrame.page_ids.filter((id) => id !== 0).length} tree
                pages linked
                {linkedFrame.page_ids.includes(0)
                  ? " · metadata P000 in log"
                  : ""}
              </span>
              <button onClick={clearLog}>Clear log selection</button>
            </>
          ) : (
            <>
              <strong>{pageName(selectedPageId)}</strong>
              <span title={selectedKey}>
                Record {shortKey(selectedKey ?? null, 36)}
              </span>
            </>
          )}
        </div>
      )}

      <PageMap
        snapshot={snapshot}
        levels={levels}
        selectedPageId={selectedPageId}
        onSelect={select}
        disabled={disabled}
        linked={linked}
      />

      <div
        className="structure-viewport"
        ref={viewportRef}
        tabIndex={0}
        role="region"
        aria-label="Interactive B+ tree canvas"
        aria-describedby={legendId}
      >
        <div
          className="structure-space"
          style={{ width: sceneW * zoom, height: sceneH * zoom }}
        >
          <div
            className="structure-scene"
            style={{
              width: sceneW,
              height: sceneH,
              transform: `scale(${zoom})`,
            }}
          >
            <svg
              className="structure-edges"
              viewBox={`0 0 ${sceneW} ${sceneH}`}
              width={sceneW}
              height={sceneH}
              aria-hidden="true"
            >
              <defs>
                <marker
                  id={`leaf-arrow-${arrowId}`}
                  markerWidth="7"
                  markerHeight="7"
                  refX="6"
                  refY="3.5"
                  orient="auto"
                >
                  <path d="M1 1.4 L5.6 3.5 L1 5.6" />
                </marker>
              </defs>
              {edges.map(({ from, to }) => {
                const x1 = from.x + from.w / 2;
                const y1 = from.y + from.h;
                const x2 = to.x + to.w / 2;
                const y2 = to.y;
                return (
                  <path
                    key={`${from.page.id}:${to.page.id}`}
                    className="structure-edge"
                    data-route={
                      onPathEdge(from.page.id, to.page.id) || undefined
                    }
                    d={`M${x1},${y1} C${x1},${y1 + ROW_GAP * 0.55} ${x2},${y2 - ROW_GAP * 0.55} ${x2},${y2}`}
                  />
                );
              })}
              {leafLinks.map(({ from, to }) => (
                <path
                  key={`leaf:${from.page.id}`}
                  className="structure-leaf-link"
                  markerEnd={`url(#leaf-arrow-${arrowId})`}
                  data-route={onPathEdge(from.page.id, to.page.id) || undefined}
                  d={`M${from.x + from.w + 3},${from.y + from.h / 2} H${to.x - 5}`}
                />
              ))}
            </svg>
            {placed.map(card)}
            {rows.map((row, index) => {
              const y = PAD + index * (CARD_H + ROW_GAP) + CARD_H / 2 - 13;
              return (
                <span key={`marks:${row.level}`}>
                  {row.before > 0 && row.beforeId !== null && (
                    <button
                      type="button"
                      className="structure-more"
                      style={{ left: 2, top: y } as CSSProperties}
                      disabled={disabled}
                      onClick={() => select(row.beforeId!)}
                      aria-label={`${row.before} earlier level ${row.level} ${plural(row.before, "page")}; open ${pageName(row.beforeId!)}`}
                      title={`${row.before} earlier pages on this level`}
                    >
                      <i aria-hidden="true">←</i>
                      <b className="num">{row.before}</b>
                    </button>
                  )}
                  {row.after > 0 && row.afterId !== null && (
                    <button
                      type="button"
                      className="structure-more"
                      style={{ left: sceneW - 48, top: y } as CSSProperties}
                      disabled={disabled}
                      onClick={() => select(row.afterId!)}
                      aria-label={`${row.after} later level ${row.level} ${plural(row.after, "page")}; open ${pageName(row.afterId!)}`}
                      title={`${row.after} later pages on this level`}
                    >
                      <b className="num">{row.after}</b>
                      <i aria-hidden="true">→</i>
                    </button>
                  )}
                </span>
              );
            })}
            {rows.map((row, index) => (
              <span
                key={`tag:${row.level}`}
                className="structure-level-tag"
                style={
                  {
                    top: PAD + index * (CARD_H + ROW_GAP) - 17,
                  } as CSSProperties
                }
                aria-hidden="true"
              >
                {row.level === snapshot.tree_height - 1
                  ? "ROOT"
                  : row.level === 0
                    ? "LEAVES"
                    : `LEVEL ${row.level}`}
                <em>
                  {(levels.get(row.level) ?? []).length}{" "}
                  {plural((levels.get(row.level) ?? []).length, "page")}
                </em>
              </span>
            ))}
            {rows.length > 1 && (
              <span
                className="structure-edge-tag"
                style={{ top: PAD + CARD_H + ROW_GAP / 2 - 8 } as CSSProperties}
                aria-hidden="true"
              >
                child pointers
              </span>
            )}
            {snapshot.tree_height === 1 && (
              <p
                className="structure-note"
                style={{ top: PAD + CARD_H + 20 } as CSSProperties}
              >
                {snapshot.record_count === 0
                  ? "One empty leaf. The first write lands here."
                  : "One leaf holds every record."}
                <span>
                  A page splits when its encoded contents pass{" "}
                  {snapshot.page_size.toLocaleString()} bytes.
                </span>
              </p>
            )}
          </div>
        </div>
      </div>

      <div className="structure-route">
        <span className="kicker">Search path</span>
        <div data-testid="search-path" title={path.map(pageName).join(" → ")}>
          {path.length ? (
            trail.map((id, index) => (
              <span key={`${index}:${id}`}>
                {id === null ? (
                  <small title={`${path.length - 6} intermediate pages`}>
                    ⋯
                  </small>
                ) : (
                  <>
                    {index > 0 && trail[index - 1] !== null && (
                      <i aria-hidden="true">→</i>
                    )}
                    <button
                      type="button"
                      disabled={disabled}
                      onClick={() => select(id)}
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
        {path.length > 0 && (
          <small className="structure-route-kind">
            {routeLabel(snapshot)}
            {path.length > 7 && ` · ${path.length} pages`}
          </small>
        )}
      </div>

      <p id={legendId} className="structure-legend">
        <span data-legend="route">Search path</span>
        <span data-legend="write">Changed by the last commit</span>
        <span data-legend="selected">Inspecting</span>
        <span className="structure-legend-note">
          Each node is one real {snapshot.page_size / 1024} KB page.
        </span>
      </p>
    </section>
  );
}

/**
 * Every allocated page at once. Bars are ordered by level and key, and their
 * fill is the page's real byte occupancy, so growth and splits are visible
 * even when the stage can only draw a slice.
 */
function PageMap({
  snapshot,
  levels,
  selectedPageId,
  onSelect,
  disabled,
  linked,
}: {
  snapshot: Snapshot;
  levels: Map<number, TreePage[]>;
  selectedPageId: number;
  onSelect: (id: number) => void;
  disabled: boolean;
  linked: Set<number>;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  // Selecting a live page disables the map while the engine answers, which
  // drops focus. Restore it once the new selection arrives and re-enables.
  const following = useRef(false);
  const changed = useMemo(
    () => new Set(snapshot.changed_pages),
    [snapshot.session_id, snapshot.generation],
  );
  const route = useMemo(
    () => new Set(snapshot.last_search_path),
    [snapshot.session_id, snapshot.last_search_path],
  );
  const { ordered, flat } = useMemo(() => {
    const ordered = [...levels.keys()].sort((a, b) => b - a);
    return {
      ordered,
      flat: ordered.flatMap((level) => levels.get(level) ?? []),
    };
  }, [levels]);

  useEffect(() => {
    if (!following.current || disabled) return;
    following.current = false;
    containerRef.current
      ?.querySelector<HTMLButtonElement>(`[data-map-page="${selectedPageId}"]`)
      ?.focus();
  }, [selectedPageId, disabled]);

  const step: Record<string, number> = {
    ArrowLeft: -1,
    ArrowUp: -1,
    ArrowRight: 1,
    ArrowDown: 1,
  };

  function move(event: KeyboardEvent<HTMLDivElement>) {
    if (disabled) return;
    const shift = step[event.key];
    if (shift === undefined && event.key !== "Home" && event.key !== "End")
      return;
    event.preventDefault();
    const index = flat.findIndex((page) => page.id === selectedPageId);
    const at = index < 0 ? 0 : index;
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? flat.length - 1
          : Math.max(0, Math.min(flat.length - 1, at + shift));
    const target = flat[next];
    if (!target || target.id === selectedPageId) return;
    following.current = true;
    onSelect(target.id);
  }

  if (snapshot.page_count <= 3) return null;
  return (
    <div
      className="page-map-strip"
      ref={containerRef}
      role="group"
      aria-label="Page map"
      onKeyDown={move}
    >
      <span className="kicker">
        Page map<em className="num">{snapshot.page_count}</em>
      </span>
      <div className="page-map-levels">
        {ordered.map((level) => {
          const row = levels.get(level) ?? [];
          return (
            <div key={level} className="page-map-row" data-level={level}>
              <span className="page-map-tag num" aria-hidden="true">
                L{level}
              </span>
              <div className="page-map-cells">
                {row.map((page) => (
                  <MapCell
                    key={page.id}
                    id={page.id}
                    kind={page.kind}
                    bytes={page.used_bytes}
                    pageSize={snapshot.page_size}
                    selected={page.id === selectedPageId}
                    changed={changed.has(page.id)}
                    route={route.has(page.id)}
                    linked={linked.has(page.id)}
                    disabled={disabled}
                    onSelect={onSelect}
                  />
                ))}
              </div>
            </div>
          );
        })}
      </div>
      <span className="page-map-hint">arrow keys walk every page</span>
    </div>
  );
}

/**
 * One bar in the page map. A large tree draws hundreds of these, and only a
 * few change between operations, so the cell takes primitive props and skips
 * its own re-render when none of them moved.
 */
const MapCell = memo(function MapCell({
  id,
  kind,
  bytes,
  pageSize,
  selected,
  changed,
  route,
  linked,
  disabled,
  onSelect,
}: {
  id: number;
  kind: TreePage["kind"];
  bytes: number;
  pageSize: number;
  selected: boolean;
  changed: boolean;
  route: boolean;
  linked: boolean;
  disabled: boolean;
  onSelect: (id: number) => void;
}) {
  return (
    <button
      type="button"
      data-map-page={id}
      className="page-map-cell"
      tabIndex={selected ? 0 : -1}
      disabled={disabled}
      data-selected={selected || undefined}
      data-write={changed || undefined}
      data-route={route || undefined}
      data-log={linked || undefined}
      onClick={() => onSelect(id)}
      aria-label={`Inspect ${kind} page ${id}, ${Math.round((bytes / pageSize) * 100)} percent full`}
      title={`${pageName(id)} · ${bytes.toLocaleString()} B`}
    >
      <i style={{ height: `${Math.max(8, (bytes / pageSize) * 100)}%` }} />
    </button>
  );
});
