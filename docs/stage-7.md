# Phase 7 — The database lab

A full redesign of the interface. The engine, its formats, its guarantees, and
its tests are unchanged; every claim below is about presentation.

## Why it changed

The owner's walkthrough of the phase 4–6 interface produced the decisive
comment: _"i have to be honest, i have no clue what i am looking at"_, followed
by _"it doesnt have to explain things like a 5 year old is using it"_. The
problem was not vocabulary. It was that the workspace presented six panels of
near-equal weight and never said what had just happened.

Four specific failures:

- **Nothing named the current operation.** A command ran, something changed
  somewhere, and the interface reported the new totals without ever stating the
  transition. There was no answer to "what did that do?".
- **The tree was not the subject.** It occupied a middle band and drew three of
  a branch's twenty-nine children. A visitor never saw the shape of the
  database.
- **Colour meant nothing.** One warm hue carried the brand, the selection, the
  staged batch, the committed log and the byte meter, so no state was legible
  at a glance.
- **The first screen explained instead of showing.** The default route opened on
  prose and a schematic; the real database was hidden behind a button.

## The direction

**An instrument, organised around one operation at a time.**

Surfaces are neutral near-black and carry no meaning. Colour is the entire state
vocabulary, and it follows the data's own journey from hot to at rest:

| Hue   | Means                                                  |
| ----- | ------------------------------------------------------ |
| Amber | Staged in memory. Not durable, invisible to reads.     |
| Green | Committed. Synced and verified in the write-ahead log. |
| Blue  | Checkpointed. At rest in the main database file.       |
| Cyan  | The page, record or route being inspected.             |
| Red   | A stopped process, a rejected command, a broken file.  |

Type is mono-first: every number, label, identifier and byte is JetBrains Mono;
Manrope carries only headings and prose. Live and recorded modes share one
layout, so the grammar learned in a recording transfers directly to the real
engine, and a badge, accent and origin tag keep them distinct.

Four questions answer themselves in reading order:

1. **What operation am I examining?** The operation bar, directly under the
   status strip.
2. **What changed?** The same bar's sentence and fact row, assembled from the
   command's own engine events.
3. **What is durable right now?** The durability rail under the tree.
4. **What can I inspect next?** The page map, the stage, the page inspector, and
   one suggested next action in the operation bar.

## What was built

- **Operation bar.** Names the last completed operation, states its result in
  one sentence, and reports its generation transition, page images, allocations
  and bytes appended. Every clause comes from that operation's event group; a
  bulk insert that splits thirty-three pages says so by count rather than
  listing them. Recorded frames reuse the bar with the engine's own captured
  title and explanation, and the stopped-process frame keeps its explicit
  "last captured state" label.
- **Two-register tree.** A page map draws every allocated page, grouped by level
  and ordered by key, with bar height set by real byte occupancy — the whole
  database at once, up to the 1,024-page limit, reachable by one tab stop and
  the arrow keys. The stage below draws a contiguous window of each level around
  the selection, so every edge is a real parent/child link. Level elision chips,
  ancestry breadcrumbs, the page selector and next-leaf links reach the rest.
  Page cards keep stable React keys, so a split animates as a real position
  change between two verified snapshots.
- **Durability rail.** Memory, log and main file as one strip. A checkpoint
  clears retained frames, so every transaction still in the log is one the main
  file lacks; the rail states that in words and shows the frames that prove it.
  This is where the project's name becomes self-explanatory.
- **Page inspector.** The selected page drawn to scale from real offsets, its
  records, its routing table, and the hex view with committed and checkpoint
  images. Selecting a record highlights the same bytes in the layout picture and
  the hex table.
- **Experiments panel.** The three signature runs, each with its starting state
  and its expected result in engine terms, so the experiment is legible before
  it runs.
- **Live-first landing.** `/` opens the live database with a real tree on
  screen. `?mode=replay` and the mode switch reach the recorded runs.

## Behavioural contracts held

- Snapshots, events, records and bytes are still the engine's. The operation bar
  derives sentences from event kinds and snapshot counters only; it invents no
  timing and no intermediate disk state.
- Staged, committed and checkpointed remain distinguishable — now by colour as
  well as by label.
- Point reads, scans, batching, checkpoints, recovery experiments and page
  inspection all remain reachable.
- Scrubbing a recording issues no writes. The portable export remains
  self-contained and offline, and accepts no database writes.
- Source, build and recording provenance are retained and still shown.
- The stopped-process frame is still labelled as the last pre-termination
  capture.
- Loading, disconnected, delayed, invalid-input, failed-operation and
  malformed-recording behaviour is unchanged.

## Verification

Run locally on Windows 11 Home build 26200 with Node 24.19.0 and Rust 1.98.1.

| Check                                           | Result    |
| ----------------------------------------------- | --------- |
| Formatting, TypeScript, Rust fmt, strict Clippy | Passed    |
| Rust tests                                      | 61 passed |
| Live browser/API tests                          | 23 passed |
| Portable replay tests                           | 6 passed  |

The browser suites keep their behavioural and data-fidelity assertions; only
selectors changed where the interface did. Three assertions were added for the
operation bar across the staged → committed → checkpointed transition, and the
old three-children pagination check was replaced by a stronger one: the page map
must contain a cell for every allocated page, and a level elision chip must
navigate to the page it names.

Inspected in a real browser at 1600, 1440, 1280, 1024, 820 and 390 px. No
horizontal document overflow at any of them, and no page errors. Keyboard pass:
the page map is a single tab stop with arrow/Home/End navigation that survives
the engine round-trip, focus is visible on every control, and the tree stage is
reachable and scrollable. Reduced motion zeroes every transition, asserted on
both the page cards and the page layout picture.

States exercised by hand and captured: empty database, staged batch, committed
split, three-level tree after two sample batches, the crash lab receipt, and
engine loss with stale verified state.

- [A committed split, portable replay](media/walnut-demo.png)
- [The live workbench after a point lookup](media/walnut-live.png)
- [The stopped-process frame](media/walnut-recovery.png)
- [The checkpointed main file](media/walnut-checkpoint.png)
- [Narrow layout at 390 px](media/walnut-narrow.png)

## Honest limits

- The visitor comprehension criterion in the gameplan is still **open**. This
  phase rebuilt the interface against the recorded feedback; it has not yet been
  watched in front of a new reader.
- Durability claims are unchanged and still bounded by the documented failure
  model. Process termination and simulated storage failures do not establish
  hardware power-loss survival.
- The stage draws a window of each level, not all 1,024 pages as cards. The page
  map covers the rest; a visitor at 390 px sees two cards per level and must use
  the map, the chips or the selector to travel.
- Motion between recorded frames is a transition between two verified captures.
  It is not a measurement of how long any I/O took.
- Linux verification for this phase has not been re-run; the table above is
  Windows only.
