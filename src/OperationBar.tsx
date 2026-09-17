import type { ReactNode } from "react";
import type { EngineEvent, Snapshot, StoryFrame } from "./types";
import "./operation.css";

export type Tone =
  "neutral" | "staged" | "committed" | "checkpointed" | "failed";

export interface Operation {
  /** Short engine-language name for the command, shown as a code chip. */
  command: string;
  /** One sentence naming the result and what it changed. */
  headline: string;
  tone: Tone;
  facts: { label: string; value: string; tone?: Tone }[];
  /** Verbatim engine detail for the operation's decisive event. */
  evidence?: string;
  changes?: { label: string; value: string }[];
}

/** Compare verified counters, including zero for updates or staged writes. */
export function withChanges(
  operation: Operation,
  current: Snapshot,
  previous?: Snapshot | null,
): Operation {
  if (!previous || previous.database_id !== current.database_id)
    return operation;
  const signed = (value: number) => `${value >= 0 ? "+" : ""}${value}`;
  return {
    ...operation,
    // The delta line now carries the generation, so drop the fact that repeats it.
    facts: operation.facts.filter((fact) => fact.label !== "Generation"),
    changes: [
      {
        label: "Records",
        value: signed(current.record_count - previous.record_count),
      },
      {
        label: "Pages",
        value: signed(current.page_count - previous.page_count),
      },
      {
        label: "Gen",
        value:
          current.generation === previous.generation
            ? `${current.generation} unchanged`
            : `${previous.generation} → ${current.generation}`,
      },
    ],
  };
}

const pageName = (id: number) => `P${String(id).padStart(3, "0")}`;
const list = (items: string[]) =>
  items.length <= 1
    ? (items[0] ?? "")
    : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
const quantity = (count: number, noun: string) =>
  `${count} ${noun}${count === 1 ? "" : "s"}`;

/**
 * Keys run to 64 bytes and are often padded, which would swamp a headline.
 * Collapse repeated runs, then trim the middle, and keep the quotes so the
 * value still reads as one literal key.
 */
function keyLabel(key: string, limit = 30) {
  const condensed = key.replace(/(.)\1{4,}/gu, "$1…");
  const glyphs = Array.from(condensed);
  const shown =
    glyphs.length <= limit
      ? condensed
      : `${glyphs.slice(0, limit - 9).join("")}…${glyphs.slice(-8).join("")}`;
  return JSON.stringify(shown);
}

/** Events carry an operation number; one command is one group. */
function latestGroup(events: EngineEvent[]): EngineEvent[] {
  const last = events.at(-1);
  if (!last) return [];
  return events.filter((event) => event.operation === last.operation);
}

/**
 * Describe the engine's most recent completed operation from its own events.
 *
 * Every sentence below is assembled from event kinds, engine details and
 * snapshot counters. Nothing here is inferred about timing or about disk
 * states the engine did not report.
 */
export function describeOperation(snapshot: Snapshot): Operation {
  const group = latestGroup(snapshot.events);
  const has = (kind: string) => group.some((event) => event.kind === kind);
  const find = (kind: string) => group.find((event) => event.kind === kind);
  const frame = snapshot.wal_frames.at(-1);
  const ahead = snapshot.checkpoint_generation !== snapshot.generation;

  const durability = {
    label: "Durable in",
    value: ahead ? "WAL" : "main file",
    tone: (ahead ? "committed" : "checkpointed") as Tone,
  };

  if (has("commit_failed") || has("checkpoint_failed")) {
    const failure = find("commit_failed") ?? find("checkpoint_failed")!;
    return {
      command: failure.kind === "commit_failed" ? "commit" : "checkpoint",
      headline: "The operation failed before it could be acknowledged.",
      tone: "failed",
      facts: [
        { label: "Generation", value: String(snapshot.generation) },
        durability,
      ],
      evidence: failure.detail,
    };
  }

  if (has("transaction_committed")) {
    const splits = group.filter((event) =>
      ["leaf_split", "internal_split"].includes(event.kind),
    );
    const rooted = find("root_changed");
    const allocated = group.filter(
      (event) => event.kind === "page_allocated",
    ).length;
    const writes = frame?.operations ?? 1;
    // A bulk insert can split dozens of pages; name a couple, count the rest.
    const named =
      splits.length > 2
        ? [`${quantity(splits.length, "page")} split`]
        : splits.map(
            (event) =>
              `${pageName(event.page_id ?? 0)} split into ${pageName(event.page_id ?? 0)} and ${pageName(event.related_page ?? 0)}`,
          );
    const clauses = [
      ...named,
      ...(rooted
        ? [`${pageName(rooted.page_id ?? 0)} became the new root`]
        : []),
    ];
    return {
      command: writes === 1 ? "put" : `commit ${writes} puts`,
      headline: clauses.length
        ? `Committed ${quantity(writes, "put")}. ${list(clauses)}.`
        : `Committed ${quantity(writes, "put")} into ${pageName(snapshot.last_search_path.at(-1) ?? snapshot.root_page_id)}.`,
      tone: "committed",
      facts: [
        {
          label: "Generation",
          value:
            frame && frame.previous_generation !== frame.generation
              ? `${frame.previous_generation} → ${frame.generation}`
              : String(snapshot.generation),
          tone: "committed",
        },
        {
          label: "Page images",
          value: String(
            frame?.page_ids.length ?? snapshot.changed_pages.length,
          ),
        },
        ...(allocated ? [{ label: "Allocated", value: `+${allocated}` }] : []),
        {
          label: "To the log",
          value: `${(frame?.length ?? 0).toLocaleString()} B`,
          tone: "committed" as Tone,
        },
        durability,
      ],
      evidence: find("transaction_committed")?.detail,
    };
  }

  if (has("checkpoint_complete")) {
    return {
      command: "checkpoint",
      headline: `Generation ${snapshot.generation} is now in the main file. The log is back to its ${snapshot.wal_header_bytes}-byte identity header.`,
      tone: "checkpointed",
      facts: [
        {
          label: "Main file",
          value: `gen ${snapshot.checkpoint_generation}`,
          tone: "checkpointed",
        },
        {
          label: "Main file size",
          value: `${snapshot.database_bytes.toLocaleString()} B`,
        },
        { label: "Log", value: `${snapshot.wal_bytes.toLocaleString()} B` },
        durability,
      ],
      evidence: find("checkpoint_complete")?.detail,
    };
  }

  if (has("batch_staged")) {
    const staged = snapshot.staged.length;
    return {
      command: `stage ${keyLabel(find("batch_staged")?.key ?? "")}`,
      headline: `${quantity(staged, "put")} held in memory. Reads still see generation ${snapshot.generation}.`,
      tone: "staged",
      facts: [
        { label: "Staged", value: String(staged), tone: "staged" },
        {
          label: "Candidate pages",
          value: String(snapshot.staged_page_count ?? snapshot.page_count),
          tone: "staged",
        },
        { label: "Committed", value: `gen ${snapshot.generation}` },
        durability,
      ],
      evidence: find("batch_staged")?.detail,
    };
  }

  if (has("batch_discarded")) {
    return {
      command: "discard",
      headline: `Pending batch discarded. Generation ${snapshot.generation} is unchanged.`,
      tone: "neutral",
      facts: [
        { label: "Staged", value: "0" },
        { label: "Committed", value: `gen ${snapshot.generation}` },
        durability,
      ],
      evidence: find("batch_discarded")?.detail,
    };
  }

  if (has("read_found") || has("read_missing")) {
    const read = find("read_found") ?? find("read_missing")!;
    const hit = read.kind === "read_found";
    const path = snapshot.last_search_path;
    return {
      command: `get ${keyLabel(read.key ?? "")}`,
      headline: hit
        ? `Found ${keyLabel(read.key ?? "")} in ${pageName(path.at(-1) ?? 0)} after ${quantity(path.length, "page")}.`
        : `${keyLabel(read.key ?? "")} is not in this tree. The route ended at ${pageName(path.at(-1) ?? 0)}.`,
      tone: hit ? "neutral" : "failed",
      facts: [
        { label: "Route", value: path.map(pageName).join(" → ") || "—" },
        { label: "Tree height", value: String(snapshot.tree_height) },
        durability,
      ],
      evidence: read.detail,
    };
  }

  if (has("range_read")) {
    return {
      command: "scan",
      headline: `${find("range_read")?.detail ?? "Scanned the tree in key order."}`,
      tone: "neutral",
      facts: [
        {
          label: "Route",
          value: snapshot.last_search_path.map(pageName).join(" → ") || "—",
        },
        { label: "Leaves", value: String(snapshot.page_count) },
        durability,
      ],
      evidence: "Ordered reads follow leaf links after one descent.",
    };
  }

  if (has("recovery_complete") || has("opened") || has("created")) {
    const replayed = snapshot.recovery.replayed_transactions;
    return {
      command: has("created") ? "create" : "open",
      headline: replayed
        ? `Reopened and replayed ${quantity(replayed, "transaction")} from the log. Generation ${snapshot.generation} is intact.`
        : snapshot.record_count === 0
          ? "Opened an empty database. One leaf page, no records yet."
          : `Opened at generation ${snapshot.generation} with ${quantity(snapshot.record_count, "record")} across ${quantity(snapshot.page_count, "page")}.`,
      tone: "neutral",
      facts: [
        {
          label: "Replayed",
          value: String(replayed),
          tone: replayed ? "committed" : undefined,
        },
        {
          label: "Discarded tail",
          value: `${snapshot.recovery.discarded_tail_bytes} B`,
        },
        {
          label: "Scanned",
          value: String(snapshot.recovery.scanned_transactions),
        },
        durability,
      ],
      evidence: (find("recovery_complete") ?? find("opened") ?? find("created"))
        ?.detail,
    };
  }

  return {
    command: "idle",
    headline: `Generation ${snapshot.generation} · ${quantity(snapshot.record_count, "record")} across ${quantity(snapshot.page_count, "page")}.`,
    tone: "neutral",
    facts: [
      { label: "Tree height", value: String(snapshot.tree_height) },
      { label: "Root", value: pageName(snapshot.root_page_id) },
      durability,
    ],
  };
}

/**
 * A recorded frame carries the engine's own title and explanation; its facts
 * and colour still come from the captured snapshot's events, so a frame never
 * claims a state the capture does not show.
 */
export function describeFrame(frame: StoryFrame): Operation {
  const live = describeOperation(frame.capture.snapshot);
  return {
    command: frame.command,
    headline: frame.title,
    // The stopped-process frame repeats the pre-termination capture, so its
    // events still read as a successful commit. The frame kind is the truth.
    tone:
      frame.kind === "crashed"
        ? "failed"
        : frame.kind === "recovered"
          ? "committed"
          : live.tone,
    facts: live.facts,
    evidence: frame.explanation,
  };
}

export function OperationBar({
  operation,
  label,
  badge,
  badgeTone,
  badgeNote,
  notice,
  children,
}: {
  operation: Operation;
  /** "Current operation" when live, "Current story step" during playback. */
  label: string;
  badge: string;
  badgeTone: Tone;
  badgeNote: string;
  notice?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <section
      className="operation"
      data-tone={operation.tone}
      role="region"
      aria-label={label}
      aria-live="polite"
    >
      <div className="operation-badge" data-tone={badgeTone}>
        <span className="operation-badge-dot" aria-hidden="true" />
        <div>
          <strong>{badge}</strong>
          <small>{badgeNote}</small>
        </div>
      </div>
      <div className="operation-main">
        <div className="operation-line">
          <code className="operation-command">{operation.command}</code>
          <h2 data-testid="operation-headline">{operation.headline}</h2>
        </div>
        {operation.changes && (
          <div
            className="operation-changes"
            aria-label="Changes since previous operation"
          >
            {operation.changes.map((change) => (
              <span key={change.label}>
                {change.label} <b>{change.value}</b>
              </span>
            ))}
          </div>
        )}
        {operation.evidence && (
          <details className="operation-evidence">
            <summary>Operation details</summary>
            <p>{operation.evidence}</p>
          </details>
        )}
        {notice}
      </div>
      <dl className="operation-facts">
        {operation.facts.map((fact) => (
          <div key={fact.label} data-tone={fact.tone}>
            <dt>{fact.label}</dt>
            <dd className="num" title={fact.value}>
              {fact.value}
            </dd>
          </div>
        ))}
      </dl>
      {children && <div className="operation-next">{children}</div>}
    </section>
  );
}
