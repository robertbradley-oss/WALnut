import { useId } from "react";
import "./orientation.css";

function TreeModel() {
  return (
    <svg viewBox="0 0 240 112" aria-hidden="true">
      <path className="orientation-model-line" d="M120 28 V43 H181 V61" />
      <path className="orientation-model-route" d="M120 28 V43 H59 V61" />
      <rect
        className="orientation-model-branch"
        x="85"
        y="3"
        width="70"
        height="25"
        rx="4"
      />
      <text
        className="orientation-model-label"
        x="120"
        y="19"
        textAnchor="middle"
      >
        branch
      </text>
      <rect
        className="orientation-model-leaf orientation-model-selected"
        x="11"
        y="61"
        width="96"
        height="46"
        rx="4"
      />
      <text className="orientation-model-small" x="23" y="77">
        LEAF
      </text>
      <text className="orientation-model-key" x="23" y="94">
        project
      </text>
      <rect
        className="orientation-model-leaf"
        x="133"
        y="61"
        width="96"
        height="46"
        rx="4"
      />
      <text className="orientation-model-small" x="145" y="77">
        LEAF
      </text>
      <path className="orientation-model-row" d="M145 88 H208 M145 94 H190" />
      <path
        className="orientation-model-leaf-link"
        d="M110 87 H129 M125 84 L129 87 L125 90"
      />
    </svg>
  );
}

function LogModel() {
  return (
    <svg viewBox="0 0 240 112" aria-hidden="true">
      <rect
        className="orientation-model-log"
        x="21"
        y="3"
        width="198"
        height="104"
        rx="5"
      />
      <path className="orientation-model-divider" d="M21 29 H219 M21 76 H219" />
      <text className="orientation-model-small" x="35" y="20">
        TRANSACTION
      </text>
      <text className="orientation-model-label" x="35" y="48">
        root + changed pages
      </text>
      <path className="orientation-model-row" d="M35 59 H174 M35 65 H147" />
      <rect
        className="orientation-model-commit"
        x="22"
        y="77"
        width="196"
        height="29"
        rx="3"
      />
      <text className="orientation-model-confirmed" x="35" y="96">
        COMMIT · synced
      </text>
      <path className="orientation-model-tick" d="M194 89 L198 93 L206 85" />
    </svg>
  );
}

function RecoveryModel() {
  return (
    <svg viewBox="0 0 240 112" aria-hidden="true">
      <path
        className="orientation-model-restart"
        d="M65 28 C86 2 149 3 171 28 C190 49 177 80 150 90 M150 90 L155 80 M150 90 L161 91"
      />
      <path
        className="orientation-model-return"
        d="M146 95 C105 114 56 92 54 65"
      />
      <rect
        className="orientation-model-restored"
        x="76"
        y="30"
        width="88"
        height="49"
        rx="5"
      />
      <text className="orientation-model-small" x="89" y="47">
        RECOVERED
      </text>
      <path className="orientation-model-row" d="M89 58 H125 M89 65 H114" />
      <path className="orientation-model-tick" d="M135 61 L140 66 L151 54" />
      <text className="orientation-model-small" x="27" y="57">
        ↻
      </text>
    </svg>
  );
}

export function Orientation({
  onStart,
  disabled,
}: {
  onStart: () => void;
  disabled: boolean;
}) {
  const headingId = useId();
  return (
    <section className="orientation" aria-labelledby={headingId}>
      <header className="orientation-heading">
        <p className="orientation-kicker">
          <span>WALnut</span> / UNDER THE SURFACE
        </p>
        <h2 id={headingId}>A storage engine you can inspect.</h2>
        <p>
          WALnut is a real Rust key/value database. Follow a write through a B+
          tree and its write-ahead log, then interrupt the process and inspect
          recovery.
        </p>
      </header>

      <figure
        className="orientation-model"
        aria-label="Engine model: a write changes tree pages, commits them to the log, and can be recovered after restart"
      >
        <figcaption className="orientation-model-caption">
          <span>ENGINE MODEL</span>
          <code>
            <span>PUT</span> project <i>→</i> WALnut
          </code>
          <small>example write</small>
        </figcaption>
        <div className="orientation-concepts">
          <div className="orientation-concept">
            <div className="orientation-diagram">
              <TreeModel />
            </div>
            <div className="orientation-concept-copy">
              <h3>
                <span>01</span> Paged B+ tree
              </h3>
              <p>
                Ordered keys live in 4 KB pages. Splits add leaves and routing
                branches as data grows.
              </p>
            </div>
          </div>
          <div className="orientation-concept">
            <div className="orientation-diagram">
              <LogModel />
            </div>
            <div className="orientation-concept-copy">
              <h3>
                <span>02</span> Write-ahead log
              </h3>
              <p>
                A commit syncs changed page images to the log. A checkpoint
                transfers them into the main file.
              </p>
            </div>
          </div>
          <div className="orientation-concept">
            <div className="orientation-diagram">
              <RecoveryModel />
            </div>
            <div className="orientation-concept-copy">
              <h3>
                <span>03</span> Crash recovery
              </h3>
              <p>
                Committed images rebuild the tree after restart. Incomplete
                transactions stay absent.
              </p>
            </div>
          </div>
        </div>
      </figure>

      <div className="orientation-start">
        <div>
          <strong>Trace one operation.</strong>
          <p>A real engine run, captured step by step.</p>
        </div>
        <button type="button" disabled={disabled} onClick={onStart}>
          Trace a page split <span aria-hidden="true">↗</span>
        </button>
      </div>
    </section>
  );
}
