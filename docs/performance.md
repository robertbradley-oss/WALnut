# Performance and reproducibility

WALnut is a bounded, resident B+ tree with durable redo logging. These measurements describe this implementation on one Windows machine. They are not a comparison with another database or a claim about cold-cache disk reads.

## Reproduce

```sh
npm run benchmark
npm run profile:inspector
```

Install the pinned browser first with `npm run browser:install`. The benchmark builds Rust in **release** mode with thin LTO. It creates a unique `work/benchmark-<timestamp>/` containing disposable database/WAL pairs and `report.json`. An optional label, `npm run benchmark -- my-run`, makes the directory easier to find; reusing an existing label fails instead of overwriting it. Set `WALNUT_BENCH_STORAGE` to the drive/filesystem description when collecting evidence on a different machine.

The inspector command builds the production UI, generates real engine captures, and writes `work/inspector-profile-<id>/report.json` and screenshots. The separate profile configuration uses one worker and pinned Chromium. Normal CI runs behavioral assertions; machine-dependent latency measurements do not gate CI.

For comparable runs, use the same build, dataset, drive, sync policy, and hardware; close other CPU/disk workloads. Keep multiple trials, raw samples, and outliers. Never interpret a fast in-memory lookup as a durable-write throughput result.

## Engine method

The fixed seed is `0x57414c6e7574`. Datasets contain **128, 512, and 1,792 records**, inserted in key order in batches of 64, then checkpointed. Keys are 64 bytes; values are 1,000 bytes. The datasets occupy 67, 265, and 927 node pages. Each engine run starts from fresh files. Setup, warmup, full ordered-map comparisons, and report serialization are outside the timed intervals.

Three trials per dataset run with tracing off and on; order alternates between trials. A sample is one complete operation, timed with Rust `Instant`, including its normal allocations. Inputs use the same seeded query order. `black_box` consumes results. The report keeps every sample and nearest-rank p50/p95/p99/min/max/mean; the tables below pool the three matching trials. The timer baseline is recorded separately. Very short reads are quantized by the local clock (about 100 ns), so sub-microsecond figures are approximate.

| Measurement             | Samples per trial | Timed work                                                                                 |
| ----------------------- | ----------------- | ------------------------------------------------------------------------------------------ |
| Point hit               | 1,000             | Random existing key, owned value and real search path                                      |
| Point miss              | 1,000             | Missing `absent/` prefix before the stored key range                                       |
| Range                   | 100               | 64 ordered results using leaf links; starts leave room for all 64                          |
| Snapshot                | 100               | Selected-page bytes, all node summaries, and bounded event/WAL history                     |
| Snapshot + JSON         | 100               | Snapshot creation and serialization; no HTTP/browser work                                  |
| Point + snapshot + JSON | 100               | The core work behind an inspected lookup; no HTTP/browser work                             |
| Durable put             | 32                | Update an existing key with another 1,000-byte value                                       |
| Durable batch           | 16                | 16 updates, one atomic commit and one WAL sync                                             |
| Checkpoint              | 9                 | After one 16-update batch: WAL sync, all main pages, main sync/readback, WAL truncate/sync |
| Recovery                | 9                 | Open/lock/decode/validate/sync a checkpoint plus 16 single-update WAL transactions         |

Durable operations use the normal `File::sync_all` path and complete read-back verification. There is no relaxed durability mode. Recovery repeatedly closes and reopens the real pair with a warm OS file cache; it is not a process-launch benchmark or a cold boot. Every recovered database is compared against the full expected contents outside the timer.

The index comparison uses the **same `Tree` object and queries**: `Tree::get` versus walking leaf links from the first leaf and comparing keys sequentially. The baseline stops when it finds the key or passes it and clones only the matching value. Both use the resident WALnut tree; neither performs file I/O or tracing. This comparison has 1,000 hit samples per size. A separate 100-sample `prepare_update` measurement clones, edits, seals, and validates a candidate tree without writing files. It isolates the CPU work in the current conservative commit design.

## Measured results

Collected 2026-09-15 on Windows 11 Home, build 26200, AMD Ryzen 5 7500X3D (6 cores / 12 logical CPUs), about 32 GiB RAM, KINGSTON SNV3S1000G NVMe SSD, local NTFS. Node 24.19.0; Rust 1.98.1, `x86_64-pc-windows-gnullvm`, LLVM 22.1.8. No external database benchmark is included.

The [optimized measurement JSON](measurements/phase5-final.json.gz) and [control JSON](measurements/phase5-control.json.gz) retain every sample, file-growth checkpoint, source hash, and environment field (gzip compressed). Working-tree measurements explicitly record `dirty: true`; their source hashes precede final formatting. The control uses the Phase 4 `engine.rs` at `c5a2af8`, compiled with the same new benchmark harness as the optimized run. Exploratory earlier runs are excluded from the tables.

```sh
node scripts/summarize-benchmark.mjs docs/measurements/phase5-final.json.gz
```

Tracing off. All cells are **p50 / p95 in microseconds**, pooled across three trials.

| Operation                |      128 records |      512 records |      1792 records |
| ------------------------ | ---------------: | ---------------: | ----------------: |
| Point hit                |        0.2 / 0.3 |        0.3 / 0.3 |         0.4 / 0.4 |
| Point miss               |        0.1 / 0.2 |        0.1 / 0.2 |         0.2 / 0.2 |
| Range: 64 results        |        6.2 / 7.2 |        6.3 / 7.4 |         7.0 / 8.9 |
| Snapshot                 |      13.1 / 13.4 |      32.8 / 35.2 |     103.7 / 132.2 |
| Snapshot + JSON          |      65.8 / 87.1 |    132.0 / 169.9 |     361.0 / 453.6 |
| Point + snapshot + JSON  |      65.9 / 94.7 |    131.8 / 204.4 |     361.4 / 399.9 |
| Durable put              |   961.4 / 1205.8 |  2106.6 / 2536.3 |   6098.9 / 6691.8 |
| Durable batch: 16 puts   |  1244.5 / 1547.3 |  2466.7 / 2719.6 |   6745.7 / 8426.0 |
| Checkpoint after 16 puts |  1751.6 / 2109.5 |  3506.2 / 3923.1 | 10072.0 / 10502.1 |
| Recover 16 transactions  | 8026.6 / 18428.1 | 8180.5 / 11494.9 | 18626.5 / 30365.8 |

Tracing overhead: median microseconds, same workload and durable settings.

| Records | Point: off / on | Snapshot + JSON: off / on | Durable put: off / on |
| ------: | --------------: | ------------------------: | --------------------: |
|     128 |       0.2 / 0.8 |               65.8 / 92.7 |         961.4 / 956.2 |
|     512 |       0.3 / 0.8 |             132.0 / 162.1 |       2106.6 / 2108.6 |
|    1792 |       0.4 / 0.9 |             361.0 / 396.9 |       6098.9 / 6064.3 |

Index comparison: median microseconds; same resident tree, no tracing or I/O.

| Records | Indexed hit | Sequential hit | Candidate preparation |
| ------: | ----------: | -------------: | --------------------: |
|     128 |         0.2 |            0.3 |                 418.9 |
|     512 |         0.2 |            1.5 |                1522.7 |
|    1792 |         0.3 |            5.7 |                5540.7 |

File growth, bytes: updates keep the allocated page count constant.

| Records | Main after setup | WAL after 32 puts | WAL after another 16 batches | WAL after checkpoint |
| ------: | ---------------: | ----------------: | ---------------------------: | -------------------: |
|     128 |           278592 |            527552 |                      1729280 |                   64 |
|     512 |          1089600 |            527552 |                      2114304 |                   64 |
|    1792 |          3801152 |            527552 |                      2523904 |                   64 |

## What the costs mean

An indexed read follows a short in-memory path. Returning the full inspector snapshot walks all page summaries and serializes them, so inspecting every read is a different workload. The UI polls at 1.5-second intervals, allows only one snapshot request in flight, and pauses polling during commands.

Candidate preparation clones and validates the complete bounded tree on every write. Its cost grows with the dataset. Batching amortizes that work and the durable sync across several puts. The current implementation deliberately retains full validation and read-back rather than trading away recovery evidence for a higher throughput number. It is not designed as a disk-backed page cache for unbounded datasets.

Phase 5 removes formatting and cloning of search-path trace messages when tracing is disabled, while preserving the actual path in snapshots. Tracing on/off tests compare results, complete file bytes, recovery outcomes, and path metadata. This optimization concerns read overhead; it does not establish a durable-write or recovery speedup.

In the paired comparison, tracing-off lookup medians changed from about **0.4 to 0.2 µs**, **0.5 to 0.3 µs**, and **0.6 to 0.4 µs** for the three sizes. Individual largest-dataset trial medians were 0.3, 0.3, and 0.4 µs after the change. Durable-write results stayed in the same millisecond range. The independent candidate-preparation measurement explains most of the large-tree update cost.

## Inspector profile

The fixture is produced by `walnut profile-fixture <new-directory>` using the real engine:

- Live: 1,792 records, 927 node pages, and 128 retained events.
- Recorded root split: 116 → 118 records, 59 → 62 pages, four captured operation checkpoints including every page's bytes.
- About 7.3 MB of JSON for the combined fixture. This intentionally stresses the current recording bound; the three default stories are much smaller.

Playwright routes deliver those captured bytes to the production UI without repeatedly rebuilding the fixture. This isolates frontend ingestion and playback; **network transfer and engine capture generation are excluded**. Tests check displayed generations, a bounded number of drawn tree cards, one page-map cell per allocated page, four timeline steps, and no page errors. Stepping is measured 48 times from a DOM click through two animation frames. This includes frame scheduling and is **not INP or a pure render-time measurement**.

Chromium runs at native speed and a simulated 4× CPU slowdown, 1,440 × 1,080, headless. The report includes snapshot/story validation times, long tasks, DOM/heap/task metrics, and screenshots. User Timing retains only the latest sample for each of two operation names; the profile observer retains at most 512 entries. The trace itself is bounded to five operation frames and 64 node pages per frame. Larger arbitrary recordings are outside this schema.

[Phase 7 measurements](measurements/phase7-inspector.json) and the earlier [phase 5 measurements](measurements/phase5-inspector.json), Chromium 153.0.8010.12. Each condition includes five recording imports and 48 steps. Values below are p50 / p95 in milliseconds, phase 7 first.

| Operation                         |                    Native |           4× CPU slowdown |
| --------------------------------- | ------------------------: | ------------------------: |
| Validate 927-page snapshot        |     2.2 / 4.1 _(2.4/4.0)_ | 16.3 / 21.7 _(11.5/20.1)_ |
| Validate 62-page recording        | 14.3 / 15.7 _(14.3/17.7)_ | 81.7 / 94.2 _(68.2/82.8)_ |
| Step through two animation frames | 29.9 / 31.6 _(31.0/32.2)_ | 49.4 / 81.1 _(27.8/35.9)_ |

The 48-step task-counter delta was 462 ms native and 3,109 ms at 4× slowdown. Two-frame timing includes refresh scheduling and has a floor near one 60 Hz interval, so the native median is close to that floor rather than to the work done. At rest, recorded playback rendered seven tree cards, 62 page-map cells and 1,046 DOM elements in both conditions; post-GC JavaScript heap usage was about 13.6 MiB (not total browser memory). There were no long tasks in the native profile and 25 tasks of 51–177 ms across the slowed profile, which includes import, polling, and stepping. These observations do not assert a universal frame-rate target.

The phase 7 interface draws more than its predecessor: a page map with one cell per allocated page, a wider slice of each tree level, and an operation bar rebuilt from the snapshot's events. Native stepping is unchanged, and the throttled p95 roughly doubled (35.9 → 81.1 ms). Memoizing the page-map cells against primitive props recovered about a tenth of that. The remaining cost is the deliberate tradeoff for showing the whole database at once; at native speed a step still lands inside two animation frames.

Visual evidence for the current interface: [a committed split](media/walnut-demo.png), [the live workbench](media/walnut-live.png), [a stopped process](media/walnut-recovery.png), and [a checkpointed file](media/walnut-checkpoint.png). The phase 5 interface is retained at [large live tree](media/phase5-large-live.png), [recorded root split](media/phase5-large-replay.png), [delayed engine](media/phase5-delayed.png), and [event gap](media/phase5-event-gap.png).

Initial large-recording import performs more work than steady playback. A slowdown multiplier is a local lab condition, not evidence about a specific phone or laptop. Heap measurements are observations, not proof of absence of every possible leak.

## Delayed and missing events

A snapshot request taking more than 2.5 seconds displays **Engine delayed**, retains the last verified state, and disables new live commands until the response completes. A 6-second timeout becomes offline; captured replay stays available. Story/crash requests retain their longer 20-second timeout. Slow polls are not queued.

The engine's 128-event ring can advance beyond the last event the browser saw. The timeline reports that gap and accepts the complete current snapshot; it does not invent missing history. A new engine session resets the gap counter. Discontinuous event windows or a generation/event sequence moving backward within the same session are rejected while retaining the last verified view.

## References

- [W3C User Timing](https://www.w3.org/TR/user-timing/) defines the local timing entries used for validation measurements.
- [Chromium CPU throttling](https://chromedevtools.github.io/devtools-protocol/1-3/Emulation/#method-setCPUThrottlingRate) and [performance metrics](https://chromedevtools.github.io/devtools-protocol/1-3/Performance/#method-getMetrics) define the profiling controls and counters.

These local results do not establish Linux performance, hosted CI success, filesystem power-loss behavior, or visitor comprehension. The follow-up usability walkthrough and portable public replay remain Phase 6 work.
