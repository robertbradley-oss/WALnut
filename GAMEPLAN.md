# WALnut — GamePlan

> A tiny database with its internals on display.

## Outcome

**Make WALnut technologically and visually impressive.**

Build a small, real database engine and an interactive inspector that makes its hardest work visible. A developer should be able to inspect the implementation, reproduce its behavior, and understand why its recovery works. A visitor should understand the appeal within 30 seconds and be able to explore a complete story in two minutes.

The signature demonstration: insert a record that splits a B+ tree page, interrupt the transaction at a chosen persistence boundary, restart the engine, and watch recovery explain which changes survived. The interface connects the command, tree, affected pages, write-ahead log, and recovered records.

Success requires both a credible engine and an exceptional interface. A polished animation alone or an engine with an unfinished inspector does not complete the project.

## Scope

One independent WALnut repository, with three connected parts:

- **Engine:** a persistent, ordered key-value store with a page format, B+ tree index, bounded keys and values, inserts and updates, point lookups, range scans, atomic write batches, write-ahead logging, checkpointing, and recovery. A checkpoint transfers committed changes from the log into the main database file.
- **Inspector:** a local browser interface driven by real engine events, with page and record inspection, coordinated tree/log views, stepping, recorded playback, failure injection, and plain-language explanations.
- **Portfolio:** reproducible scenarios, correctness evidence, measured benchmarks, architecture and file-format explanations, a short demo recording, and a browser replay that can be shared without installing the engine.

The first release uses one process with serialized transactions and exclusive database ownership. Deletion and space reclamation, SQL, replication, multiple concurrent writers, production deployment, and arbitrary-size values are outside this release. They are possible later projects, not prerequisites for making WALnut impressive.

## Guardrails

- Implement the storage and recovery mechanisms ourselves. General-purpose libraries are welcome; an existing database cannot supply the engine behind the demo.
- The engine is the source of truth. Give events stable identities and explicit meanings. Distinguish staged changes, a committed log, and checkpointed pages. Label recorded playback; scrubbing history does not rewind the live database.
- Treat durability as a specific, tested contract. State the supported failure model and filesystem assumptions. Keep process termination tests, simulated storage failures, and physical power-loss evidence distinct.
- Develop technical and visual quality together. Every meaningful capability needs a way to inspect or demonstrate it; every animation must correspond to an engine event or clearly labeled explanation.
- Keep the engine usable and testable without the interface. Make tracing optional and measure its overhead.
- Use synthetic, disposable databases for crash scenarios. Development stays local and needs no paid service. Prepare public-ready artifacts; publishing remains a separate user-directed action.
- Preserve a finishable first release. Feature ideas earn priority by strengthening the signature demonstration, correctness, understanding, or reproducibility.

## Strategy

**Working architecture:** Rust for the engine, command-line runner, and local bridge; TypeScript and React for the inspector. A narrow storage interface supports real files and deterministic fault tests. A versioned event format connects engine, live inspector, and exported replay. Exact frameworks and on-disk details belong in implementation notes and can change when evidence warrants it.

**Visual direction:** an instrument, organised around one operation at a time. Neutral near-black surfaces carry no meaning; colour does. Five state hues are the whole vocabulary — amber for staged bytes held in memory, green for a committed log, blue for a checkpointed main file, cyan for the selection and the route it follows, red for a stopped process or a rejected command. Mono type for every number, label and identifier; a sans face only for headings and prose.

The database is the largest object on screen at every width. An operation bar states what the engine last did and what changed; the tree stage draws real page relationships with stable identities; a durability rail shows the same bytes moving from memory to log to file. Detail arrives through selection: records, routing, byte spans, hex, checksums. Motion carries a structural change between two verified states and never implies measured I/O. Support keyboard operation, reduced motion, and a readable narrow-screen replay.

**Build sequence:** foundation and a thin live inspector → atomic recovery → B+ tree depth → complete visual stories → verification and performance → portfolio finish. See [ROADMAP.md](ROADMAP.md) for observable milestones.

**Model guidance:** use GPT-6 Astra (`gpt-6-astra`) with the recommended reasoning level recorded for each roadmap stage. Allocate more effort to foundational decisions, recovery, and structural correctness. These are task-setting recommendations; correctness tests and visual review remain the evidence of quality.

Use this plan as context for normal work. Revisit it when direction changes, rather than after every task. Keep detailed specifications, test results, and task lists in their own files.

## Finish line

WALnut v1 is complete when:

1. Fresh-checkout instructions reproduce the engine, inspector, and three signature scenarios: page split, crash recovery, and checkpoint.
2. Correctness checks cover tree invariants, transaction outcomes, recovery, and corrupt input; reported platform checks pass on Windows and Linux.
3. The inspector accurately shows the engine's state, remains usable through failure/restart, and delivers polished interaction at ordinary laptop sizes.
4. Another person can use the two-minute walkthrough to explain what was written, what was committed, and what recovery restored. Record observations rather than assuming comprehension.
5. The repository includes the demo, architecture explanation, repeatable benchmark results with limitations, and one concrete engineering case study. The browser replay identifies its recorded source and build.

Once these are satisfied, finish and present v1 before expanding scope.

## Next move

The standalone project lives at `C:\Users\robby\Documents\Codex\Projects\walnut`. The foundation and atomic recovery increments are implemented locally. Next is milestone 3: carry the recovery contract into a paged B+ tree and expose its real structure in the inspector. Current evidence and remaining platform checks live in the roadmap and verification notes.

**Make WALnut technologically and visually impressive.**
