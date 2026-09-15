# WALnut — Build Roadmap

The lasting direction is in [GAMEPLAN.md](GAMEPLAN.md). This roadmap describes the sequence and observable results. Stages 1–3 are implemented locally; see [foundation verification](docs/stage-1.md), [recovery verification](docs/stage-2.md), and [B+ tree verification](docs/stage-3.md). Stage 4 is next. Milestones represent working increments, not calendar promises.

## Astra reasoning levels

Use **GPT-6 Astra** (`gpt-6-astra`). These are recommended starting settings for substantive work in each stage, based on its complexity and consequences. Recording them here does not automatically change a task's model settings.

| Stage | Reasoning level | Focus |
| --- | --- | --- |
| 1. Foundation | Extra high (`xhigh`) | Architecture, storage boundaries, and the first complete engine/UI path. |
| 2. Recovery | Max (`max`) | Commit ordering, interruption cases, checkpoint safety, and durability assumptions. |
| 3. B+ tree | Max (`max`) | Structural invariants, cascading splits, and atomic changes across pages. |
| 4. Visual experience | Extra high (`xhigh`) | Interaction design, state fidelity, coordinated motion, and failure states. |
| 5. Verification and performance | Max (`max`) | Fault analysis, independent test models, benchmark validity, and regression diagnosis. |
| 6. Portfolio finish | High (`high`) | Clear presentation, reproducible setup, documentation, and release preparation. |

Use lower effort for routine edits when appropriate. If a later stage uncovers a storage-correctness problem, investigate it at the level assigned to recovery or B+ tree work. Greater reasoning effort does not replace tests, profiling, or observing the interface.

## 1. Lay the foundation and expose one real write

**Astra reasoning:** Extra high (`xhigh`).

**Build**

- Set up a Rust workspace and TypeScript/React inspector with reproducible toolchains, a documented development command, and Windows/Linux CI.
- Define the initial API, key ordering, size bounds, error behavior, database ownership, and versioned page/event formats. Record a short architecture decision explaining the serialized transaction model.
- Implement the first bounded page store and CLI operations to create, put, get, and reopen a database. Normal close/reopen persistence is the initial claim; crash recovery comes next.
- Route storage operations through a small interface so tests can inject short writes, failed syncs, and interrupted operations later.
- Connect a thin live inspector: issue a write, see its event, inspect the page and record. Establish typography, spacing, color roles, and basic motion on this working screen.

**Demonstrate:** write a value, inspect its real encoded bytes, stop normally, reopen, and retrieve the same value.

**Evidence:** meaningful encoding/decoding and bounds checks, malformed-page handling, normal reopen coverage, and an end-to-end check that the inspector reports the engine's actual result.

**Why it matters:** establishes a real product slice and the engine/UI connection before either grows complicated.

## 2. Make commits and recovery trustworthy

**Astra reasoning:** Max (`max`).

**Build**

- Specify the write-ahead log (WAL), transaction boundaries, checksums, synchronization order, replay rules, and checkpoint lifecycle before relying on their durability.
- Start with a simple redo design using complete changed-page images, including allocation/root metadata when applicable. Retain recovery information until the corresponding database state is safely checkpointed. Resolve log reuse and checkpoint interruption in the format design.
- Add atomic batches, commit acknowledgments, restart recovery, and manual checkpoints. Do not expose unfinished transaction changes to other commands.
- Create deterministic storage-fault tests and real subprocess termination tests. Exercise failures during append, commit synchronization, checkpoint writes, and log reset.
- Add a log lane to the inspector and explicit staged, committed, and checkpointed states.

**Demonstrate:** stop before commit and observe no partial batch; stop after an acknowledged commit but before checkpoint and recover the whole batch.

**Evidence:** acknowledged commits survive within the stated model; batches never appear partially; a valid committed transaction whose reply was interrupted may appear whole. An incomplete tail and corruption in required committed data receive distinct handling. Repeated recovery is safe, and storage errors reach the caller.

**Why it matters:** WALnut's name and central promise rest on this behavior.

## 3. Build the tree and its difficult cases

**Astra reasoning:** Max (`max`).

**Build**

- Add page-based B+ tree leaves and internal nodes, leaf splits, cascading splits, root changes, updates, point lookups, and ordered range scans. A B+ tree keeps records in leaves and uses internal pages to route searches.
- Include every page and metadata change for an operation in the transaction model from milestone 2.
- Emit events for search paths, split decisions, page creation, and root changes. Visualize the actual tree and let users inspect each page.

**Demonstrate:** grow a multi-level tree, watch a lookup choose its path, and reproduce a crash around a split with the exact workload and fault position.

**Evidence:** generated operation sequences agree with a simple independent ordered-map model; structural checks verify ordering, reachability, balanced depth, and scan results. Split/root-update failures preserve complete transaction outcomes after recovery.

**Why it matters:** turns persistence into substantial, inspectable data-structure engineering.

## 4. Make the whole system understandable and striking

**Astra reasoning:** Extra high (`xhigh`).

**Build**

- Compose a command area, tree canvas, page inspector, WAL lane, and timeline into one coordinated workspace. Reveal byte-level detail on demand.
- Provide pause, step, speed control, zoom, reset, and deterministic scenario replay. Separate controls for viewing recorded events from commands that change a live database.
- Finish three guided stories: a page split, a recovered transaction, and a checkpoint. Each explains the command, changed state, and reason for the result.
- Handle empty data, running operations, engine disconnect, a crashed process, recovery failure, invalid commands, and restart without ambiguous status.
- Refine stable layout transitions, focus behavior, reduced motion, non-color state cues, and a readable mobile replay. Add a restrained WALnut identity and icon.

**Demonstrate:** a visitor follows the split-and-crash story in two minutes, then investigates a selected page or log record independently.

**Evidence:** compare displayed state against engine snapshots at chosen events. Test keyboard paths, failure/restart behavior, normal laptop widths, and narrow-screen playback. Keep a screenshot/recording review and a brief observed walkthrough with another person.

**Why it matters:** visual quality becomes a way to understand technical depth.

## 5. Measure, challenge, and refine

**Astra reasoning:** Max (`max`).

**Build**

- Broaden the existing fault suite around realistic operation sequences, checkpoints, malformed files, and large supported trees. Preserve failing seeds as regression cases.
- Benchmark deterministic point reads, range scans, writes, checkpointing, and recovery at documented dataset sizes. Record hardware, OS, build, sync settings, workload, latency distribution, and file growth.
- Measure inspection/tracing overhead separately. Compare indexed reads with WALnut's own sequential-scan baseline; use an external database comparison only when operation and durability settings are genuinely comparable.
- Profile the inspector with a documented representative large trace. Keep playback work bounded and expose a clear response to disconnected or lagging event streams.

**Demonstrate:** rerun a benchmark and fault scenario from documented commands and explain the result, including the cost of tracing and durable writes.

**Evidence:** reproducible measurements and meaningful regression checks. No throughput target substitutes for correctness; optimize measured bottlenecks and verify again after changes.

**Why it matters:** gives a technical reader evidence beyond the animation.

## 6. Finish a portfolio-quality v1

**Astra reasoning:** High (`high`).

**Build**

- Make the README open with the product, a 30-second recording, a clear quickstart, and a route into the implementation.
- Include architecture and file-format explanations, supported guarantees and limits, benchmark reproduction, and a case study of one difficult bug and its fix.
- Export the three real engine traces into a self-contained browser replay with no paid runtime dependency. Identify it as recorded exploration, attach source build/scenario metadata, and show how to reproduce it locally. It does not accept new database writes.
- Check clean-checkout setup and claimed platform support, complete repository hygiene and licensing, and prepare versioned release artifacts. Publication follows the user's release direction.
- Finish the walkthrough review and correct confusing visuals or explanations before adding features.

**Demonstrate:** a technical visitor can watch it, inspect it, run it, break it, and verify the recovery.

**Evidence:** satisfy the GamePlan finish line and report the remaining limitations plainly. Additional features wait until this release is finished.

## Technical references

These inform implementation choices; WALnut has its own small, documented design.

- [SQLite: Write-Ahead Logging](https://www.sqlite.org/wal.html) — commit/checkpoint separation and synchronization ordering.
- [SQLite: WAL file format](https://www.sqlite.org/walformat.html) — a concrete reference for log structure and recovery terminology.
- [Rust: File::sync_all](https://doc.rust-lang.org/std/fs/struct.File.html#method.sync_all) — file synchronization behavior; filesystem and platform assumptions still need explicit treatment.
- [W3C: Respecting reduced-motion preferences](https://www.w3.org/WAI/WCAG21/Techniques/css/C39.html) — motion that remains optional for the user.

**Make WALnut technologically and visually impressive.**
