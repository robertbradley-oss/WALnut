# Phase 5 — verification and performance

Date: 2026-09-15. Roadmap guidance: **GPT-6 Astra, Max (`max`)**. This records the recommended setting, not a runtime-setting change.

## Delivered

- A deterministic mixed-workload fault campaign: four fixed seeds, 72 steps each, with inserts/updates, Unicode/NUL keys, variable values, staging/discard/commit, checkpoint, short writes, failed sync/read-back, interrupted log reset, and process/modeled power-loss boundaries.
- Independent ordered-map comparisons of full paginated scans, point reads, bounded ranges, and record counts after every recovery. Each step reopens twice before checkpointing and continuing.
- A 1,920-record tree above 980 node pages, 64 distributed updates, a torn checkpoint, full recovery verification, checkpoint, modeled power loss, and another full verification.
- Malformed large-file cases that fail closed without rewriting evidence; tracing on/off comparisons of file bytes, results, search paths, and failure outcomes.
- File-backed release benchmarks with deterministic inputs, warmup, three trials per size and tracing mode, raw latency samples, environment/source metadata, and file growth. Indexed lookups are compared with WALnut's own sequential leaf scan.
- A separate inspector profile using actual large live/recorded captures, native and 4× CPU conditions, bounded DOM/playback assertions, timing/counter JSON, and screenshots.
- A measured read-path optimization: skip trace-message formatting when tracing is disabled and move the retained path instead of cloning it. Commit/checkpoint ordering, formats, and validation remain unchanged.
- Explicit delayed polling and timeline gaps; rejection of stale snapshots and discontinuous event windows. One snapshot request stays in flight; captures remain usable offline.
- A Windows toolchain-wrapper correction: preserve inherited `Path` when constructing a child environment with `PATH`. The profiling harness exposed the missing inherited Git path.

## Verification

| Check                                   | Result                                                                                                                         |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Formatting, TypeScript, rustfmt, Clippy | Passed with warnings denied                                                                                                    |
| Rust suite                              | 61 tests passed: all 57 earlier checks and four new campaign functions                                                         |
| Browser/API suite                       | 23 tests passed, including delayed polling, event gaps, and stale response rejection                                           |
| Release benchmark                       | All 18 dataset/tracing/trial combinations verified against their expected contents; paired control and optimized runs retained |
| Inspector profile                       | Passed: native and 4× CPU conditions, five imports and 48 steps each, no page errors, bounded cards/timeline/timing retention  |
| Visual inspection                       | Reviewed the large recorded tree, delayed state, and timeline gap; corrected the command panel's delayed/offline wording       |
| Legacy data                             | Format-1/2 file SHA256 hashes remain identical to the Phase 3 evidence                                                         |

The measurements are local Windows results. Hosted Windows/Linux CI and a successful follow-up visitor walkthrough remain unverified.

The new campaign passed without discovering a storage-correctness regression. Its fixed seeds are retained in `crates/walnut-core/tests/campaign.rs`; a future failing seed should be added there before fixing its cause. The four new test functions contain 288 campaign steps plus the large-tree, malformed-file, and tracing-equivalence cases. Counts refer to test functions, not individual fault positions.

The prior recovery suites remain in place, including per-byte corruption/truncation, split/root/checkpoint boundaries, modeled storage failures, legacy migration, and actual subprocess termination. This stage does not turn modeled power loss into a claim about physical power failure.

## Reproduce

```sh
npm run check
npm run test:core
npm run test:e2e
npm run benchmark
npm run profile:inspector
npm run cargo -- test -p walnut-core --test campaign seeded_mixed_workloads
npm run walnut -- lab work/phase5-lab after_wal_sync root_split
```

See [performance results and methods](performance.md) for hardware, workload definitions, distributions, known costs, source evidence, and profile limitations. Every scenario uses disposable files. No benchmark targets the local demo database.

## Remaining work

Phase 6 covers portfolio presentation, the portable recorded demo, clean-checkout/platform release checks, and the follow-up visitor walkthrough. The revised orientation retains database terminology, as requested. A successful comprehension walkthrough has not been observed yet. No remote, public deployment, or hosted CI result is claimed here.

**Make WALnut technologically and visually impressive.**
