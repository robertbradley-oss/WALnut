# Phase 4 verification — coordinated workbench and recorded stories

Date: 2026-09-14. Phase 4 is implemented locally. The project owner selected **GPT-6 Astra, Ultra (`ultra`)** for this stage. The roadmap records that choice; it does not change runtime model settings.

## Delivered

- A coordinated command area, navigable B+ tree, selected-page inspector, WAL lane, and recorded timeline. Raw bytes and extended evidence open on demand.
- Three actual engine scenarios: a leaf split, an acknowledged commit recovered after process termination, and a checkpoint followed by reopen.
- Play/pause, previous/next step, speed, direct timeline selection, reset, zoom, Fit, and page inspection. Recorded controls make no database writes.
- Separate live and recorded state. Offline inspection retains the last verified live state and the entire captured recording; new live commands require a connected engine.
- Explicit staging, crash, recovery, invalid-command, capture-failure, incompatible-response, and restart behavior. Failed captures retain the previous valid recording.
- Keyboard controls, reduced motion, a bounded tree window, responsive playback, local fonts, and the restrained WALnut identity.
- An initial technical orientation explaining the Rust key/value engine, paged B+ tree, WAL, and crash experiments. Direct live entry remains available at `/?mode=live`.

## Verification

Run on Windows with Node 24.19.0, Rust 1.98.1, and the pinned Chromium/Playwright setup. Tests use real disposable database/WAL pairs and the built Rust server.

| Check                              | Observed result                                                                                                                                                         |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run check`                    | Passed: formatting, TypeScript, rustfmt, and Clippy with warnings denied                                                                                                |
| `npm run test:core`                | Passed: 57 Rust tests, including five new story tests and all 52 earlier regressions                                                                                    |
| Production build and browser suite | Passed: all 20 browser/API tests against the built UI and actual Rust server                                                                                            |
| Recorded state agreement           | All three stories: every frame's dimensions/state and every captured page's displayed byte window match the engine capture                                              |
| Disk agreement                     | Captured committed images match actual disposable main-file or WAL bytes; recovered pages match the acknowledged commit                                                 |
| Isolation                          | Full primary snapshots, pending batch, main bytes, and WAL bytes remain unchanged across story runs                                                                     |
| Interaction and failure states     | Keyboard, staging, ranges, restart, offline replay, paused/playing/step/reset/speed/zoom, busy controls, capture failure/retry, and malformed response rejection passed |
| Visual review                      | 1,440 × 1,080 desktop, 1,264 × 712 laptop, and 390 × 844 mobile; screenshots reviewed after transitions settle                                                          |

Test counts refer to functions, with multiple cases and subprocess boundaries inside them. Final browser run: **20 passed in 16.8 seconds**. The preview database remains at generation 5 with 132 records, 67 node pages, root P62, and height 3. Original format-1 and format-2 files retain the SHA256 values recorded in Phase 3.

## What a recording represents

Each frame records a completed observable operation. Its snapshot includes every node summary; its capture includes metadata page 0 and every allocated node's committed bytes and available checkpoint bytes. Page generation, whole-tree generation, and checkpoint generation remain distinct. The checkpoint byte-source label decodes the individual page's generation from its actual header.

The split uses three existing 64-byte keys with 1,000-byte values, then two more puts. Staging leaves the committed tree unchanged. Commit changes the tree from 3 records / 1 node / height 1 to 5 records / 3 nodes / height 2. A lookup follows the real root-to-leaf path.

The recovery worker captures an acknowledged commit, pauses, and is terminated and reaped. Its stopped-process frame explicitly holds the last pre-termination capture. Reopening the actual files produces the recovered snapshot; tests compare every recovered committed page with its acknowledged image. The worker's identity, exit, path, and process-termination model remain available in the evidence disclosure.

Checkpoint writes the committed tree into the main file and returns the WAL to its 64-byte identity header. The recording captures a subsequent real reopen. Browser checks compare captured images with the actual retained main file or WAL bytes, not another renderer's interpretation.

Playback reads these captures from browser memory. It does not reconstruct physical write timing or invent an intermediate tree during commit. The tree's search and latest-write/split markers are separately labeled. Live event and WAL page links inspect the selected current snapshot. Recorded page links inspect that frame's captured bytes.

## Walkthrough feedback and visual review

The owner's initial walkthrough found that the interface did not provide enough context to identify what the project and its panels represented. They also explicitly asked to retain technical language. The resulting revision adds a concise technical orientation and opens in guided mode, while preserving the detailed workbench and direct live route. The current story explanation appears before the scenario selector; laptop playback controls occupy less vertical space; the page map uses readable byte counts.

This is observed feedback and a resulting implementation change. A successful follow-up two-minute visitor walkthrough has not yet been observed; that usability claim remains open.

Saved visual evidence:

- [Technical orientation](media/phase4-orientation.png)
- [Committed split](media/phase4-split.png)
- [Recovered tree](media/phase4-recovery.png)
- [Mobile playback](media/phase4-mobile.png)
- [Mobile orientation](media/phase4-mobile-orientation.png)

The captures use the actual application and test fixture data. Screenshot capture finishes finite UI transitions so page positions are reviewed at rest; the separate browser checks still exercise normal and reduced-motion behavior.

## Reproduce

```sh
npm run check
npm run test:core
npm run test:e2e
npm run walnut -- story work/stories split
npm run walnut -- story work/stories recovery
npm run walnut -- story work/stories checkpoint
npm start
```

Open `http://127.0.0.1:7878`, run a story, and use its timeline. For live commands, choose **Live database** or open `http://127.0.0.1:7878/?mode=live`. Every scenario retains its disposable files and reports the path. A browser reload clears its in-memory recording; running the same scenario generates the same structural progression with new run/database/process identities.

## Scope and limits

- Existing storage/page formats and the core transaction algorithm are unchanged. The earlier core, codec, fault, migration, and process-kill regressions remain in the suite.
- The HTTP bridge requires object-shaped JSON and validates story choice and page selection before creating artifacts. This also rejects positional arrays for the existing object-shaped commands.
- The response guard checks versions, bounds, byte lengths, page identity, and agreement between captured bytes and displayed summaries. It does not replace the Rust engine's checksum and structural validation.
- Process termination and modeled storage faults are distinct from physical power-loss testing. No broader device/filesystem durability claim is added.
- No hosted CI, public deployment, portable static replay, benchmark, or Phase 5 performance claim is included in this local stage. No remote is configured.
- Source recordings are bounded to the three small scenarios. Live tree navigation shows a bounded branch window; the full supported 1,024-page tree is not laid out as a single graph.

**Make WALnut technologically and visually impressive.**
