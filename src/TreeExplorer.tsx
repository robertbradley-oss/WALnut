import type { Snapshot } from "./types";
import "./tree.css";

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
