import { useState } from "react";
import type { Snapshot, TreePage } from "./types";
import "./tree.css";

export function TreeExplorer({
  snapshot,
  select,
  grow,
  disabled,
}: {
  snapshot: Snapshot;
  select: (id: number) => void;
  grow: () => void;
  disabled: boolean;
}) {
  const pages = new Map(snapshot.pages.map((p) => [p.id, p]));
  const parents = new Map<number, number>();
  for (const page of snapshot.pages)
    for (const child of page.children) parents.set(child, page.id);
  const selected = pages.get(snapshot.page_id);
  const focus =
    selected?.kind === "internal"
      ? selected
      : pages.get(parents.get(snapshot.page_id) ?? snapshot.root_page_id)!;
  const [window, setWindow] = useState({ selection: -1, start: 0 });
  const start =
    window.selection === snapshot.page_id
      ? window.start
      : Math.floor(Math.max(0, focus.children.indexOf(snapshot.page_id)) / 3) *
        3;
  const children = focus.children
    .slice(start, start + 3)
    .map((id) => pages.get(id)!);
  const ancestors = [focus.id];
  while (parents.has(ancestors[0]))
    ancestors.unshift(parents.get(ancestors[0])!);
  const splitIds = new Set(snapshot.splits.flatMap((s) => [s.left, s.right]));
  function node(page: TreePage, isRoot = false) {
    const onPath = snapshot.last_search_path.includes(page.id);
    return (
      <button
        key={page.id}
        className={`tree-node ${page.kind} ${onPath ? "on-path" : ""}`}
        aria-label={`Inspect ${page.kind} page ${page.id}`}
        aria-pressed={snapshot.page_id === page.id}
        onClick={() => select(page.id)}
        disabled={disabled}
      >
        <span className="node-top">
          <b>{page.kind === "internal" ? "BRANCH" : "LEAF"}</b>
          <span>
            {isRoot ? "ROOT · " : ""}P{page.id.toString().padStart(3, "0")}
          </span>
        </span>
        <strong>
          {page.count}{" "}
          <small>
            {page.kind === "internal"
              ? page.count === 1
                ? "separator"
                : "separators"
              : page.count === 1
                ? "record"
                : "records"}
          </small>
        </strong>
        <span className="node-key" title={page.first_key ?? undefined}>
          {page.first_key ?? "Ready for its first record"}
        </span>
        <span className="node-meter" aria-hidden="true">
          <i style={{ width: `${(page.used_bytes / 4096) * 100}%` }} />
        </span>
        <span className="node-foot">
          <span>{page.used_bytes.toLocaleString()} / 4,096 B</span>
          <b>
            {onPath
              ? "PATH"
              : splitIds.has(page.id)
                ? "SPLIT"
                : snapshot.changed_pages.includes(page.id)
                  ? "CHANGED"
                  : `L${page.level}`}
          </b>
        </span>
      </button>
    );
  }
  return (
    <section className="tree-explorer" aria-labelledby="tree-heading">
      <div className="tree-heading">
        <div>
          <p className="eyebrow">THE SHAPE OF YOUR DATA</p>
          <h2 id="tree-heading">A little room. A new branch.</h2>
        </div>
        <button
          className="secondary"
          disabled={disabled || !!snapshot.staged.length}
          onClick={grow}
        >
          + Insert 64 sample records
        </button>
      </div>
      <div className="tree-metrics">
        <div>
          <span>RECORDS</span>
          <strong data-testid="record-count">
            {String(snapshot.record_count).padStart(2, "0")}
          </strong>
        </div>
        <div>
          <span>NODE PAGES</span>
          <strong data-testid="page-count">
            {snapshot.page_count}
            <small> / {snapshot.page_limit}</small>
          </strong>
        </div>
        <div>
          <span>TREE HEIGHT</span>
          <strong data-testid="tree-height">
            {snapshot.tree_height}
            <small> {snapshot.tree_height === 1 ? "level" : "levels"}</small>
          </strong>
        </div>
        <div>
          <span>ROOT</span>
          <strong data-testid="root-page">
            P{snapshot.root_page_id.toString().padStart(3, "0")}
          </strong>
        </div>
      </div>
      <div className="tree-canvas">
        <nav className="tree-breadcrumbs" aria-label="Tree ancestry">
          {ancestors.map((id, i) => (
            <span key={id}>
              {i > 0 && <i aria-hidden="true">/</i>}
              <button onClick={() => select(id)} disabled={disabled}>
                {i === 0 ? "Root" : "Branch"} P{id}
              </button>
            </span>
          ))}
        </nav>
        <div className="tree-parent">
          {node(focus, focus.id === snapshot.root_page_id)}
        </div>
        {children.length > 0 ? (
          <>
            <svg
              className="tree-connectors"
              viewBox="0 0 600 48"
              preserveAspectRatio="none"
              aria-hidden="true"
            >
              {children.map((child, i) => (
                <path
                  key={child.id}
                  d={`M300 0 V20 H${((i + 0.5) * 600) / children.length} V48`}
                  className={
                    snapshot.last_search_path.includes(child.id)
                      ? "path-edge"
                      : ""
                  }
                />
              ))}
            </svg>
            <div
              className="tree-children"
              style={{
                gridTemplateColumns: `repeat(${children.length}, minmax(0, 1fr))`,
              }}
            >
              {children.map((child) => node(child))}
            </div>
            <div className="tree-paging">
              <span>
                Children {start + 1}–
                {Math.min(start + 3, focus.children.length)} of{" "}
                {focus.children.length} · select a branch to explore
              </span>
              <div>
                <button
                  aria-label="Previous child pages"
                  disabled={disabled || start === 0}
                  onClick={() =>
                    setWindow({ selection: snapshot.page_id, start: start - 3 })
                  }
                >
                  ←
                </button>
                <button
                  aria-label="Next child pages"
                  disabled={disabled || start + 3 >= focus.children.length}
                  onClick={() =>
                    setWindow({ selection: snapshot.page_id, start: start + 3 })
                  }
                >
                  →
                </button>
              </div>
            </div>
          </>
        ) : (
          <p className="tree-empty">
            One leaf holds everything so far. A full page splits when its
            encoded records exceed 4,096 bytes.
          </p>
        )}
      </div>
      <div className="search-path">
        <span>LATEST SEARCH</span>
        <div data-testid="search-path">
          {snapshot.last_search_path.length ? (
            snapshot.last_search_path.map((id, i) => (
              <span key={`${i}:${id}`}>
                {i > 0 && <i aria-hidden="true">→</i>}
                <button disabled={disabled} onClick={() => select(id)}>
                  P{id}
                </button>
              </span>
            ))
          ) : (
            <small>Run a lookup or scan to follow the pages.</small>
          )}
        </div>
      </div>
      {!!snapshot.splits.length && (
        <details className="split-details">
          <summary>
            {snapshot.splits.length}{" "}
            {snapshot.splits.length === 1 ? "split" : "splits"} in the latest
            commit
          </summary>
          <ul>
            {snapshot.splits.map((s, i) => (
              <li key={i}>
                P{s.left} → P{s.left} + P{s.right}{" "}
                <span>· {s.level === 0 ? "leaf" : "branch"} · separator</span>{" "}
                <code>{s.separator}</code>
              </li>
            ))}
          </ul>
        </details>
      )}
      <p className="tree-caption">
        Each card is a real 4 KB page. Samples use 64-byte keys and 1,000-byte
        values so two batches can grow a three-level tree.
      </p>
    </section>
  );
}

export function PageContents({
  snapshot,
  select,
}: {
  snapshot: Snapshot;
  select: (id: number) => void;
}) {
  const page = snapshot.pages.find((p) => p.id === snapshot.page_id);
  if (!page)
    return (
      <section className="page-structure" aria-label="Tree metadata">
        <h3>Tree metadata · page 0</h3>
        <dl>
          <div>
            <dt>Root page</dt>
            <dd>
              <button onClick={() => select(snapshot.root_page_id)}>
                P{snapshot.root_page_id}
              </button>
            </dd>
          </div>
          <div>
            <dt>Next page ID</dt>
            <dd>{snapshot.page_count + 1}</dd>
          </div>
          <div>
            <dt>Tree height</dt>
            <dd>{snapshot.tree_height}</dd>
          </div>
          <div>
            <dt>Record count</dt>
            <dd>{snapshot.record_count}</dd>
          </div>
          <div>
            <dt>Complete tree CRC32</dt>
            <dd>{snapshot.state_checksum}</dd>
          </div>
        </dl>
        <p>
          The root, allocation, record count, and tree checksum are committed
          with every changed page.
        </p>
      </section>
    );
  return (
    <section className="page-structure" aria-label="Internal page routing">
      <h3>Search routing · {page.children.length} children</h3>
      <p>Take the right child when a key equals its separator.</p>
      <div className="routing-scroll">
        <table>
          <thead>
            <tr>
              <th>LOWER BOUND (INCLUSIVE)</th>
              <th>CHILD PAGE</th>
            </tr>
          </thead>
          <tbody>
            {page.children.map((id, i) => (
              <tr key={id}>
                <td>
                  <code>
                    {i === 0
                      ? "Below the first separator"
                      : page.separators[i - 1]}
                  </code>
                </td>
                <td>
                  <button onClick={() => select(id)}>P{id} →</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
