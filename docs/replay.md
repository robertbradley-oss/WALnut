# Portable recorded demo

The demo is one HTML file containing the React viewer, fonts, icon, license notices, and three complete recordings from the Rust engine. It works from disk or at a nested path on a static host. It needs no API, account, paid runtime, CDN, or database process.

```sh
npm ci
npm run build:demo
```

Open `dist-demo/index.html` directly, or run `npm run preview:demo` and visit **http://127.0.0.1:7879**. The preview only serves that file.

## What is recorded

`scripts/build-demo.mjs` builds the release engine and invokes the existing `story` command once for each scenario in a new disposable directory:

| Recording           | Observable result                                                                                                       |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| A page splits       | 3 → 5 records, 1 → 3 node pages, height 1 → 2; two puts and all split metadata commit together.                         |
| A commit survives   | The worker acknowledges the split, is terminated and reaped, then a new engine recovers the same five records and tree. |
| The file catches up | The main file advances to generation 2; the WAL shrinks to its 64-byte identity header; reopen preserves the tree.      |

Frames contain verified snapshots and every page's captured committed/checkpoint bytes. The stopped-process frame deliberately holds the last verified capture. These are completed-operation snapshots, not samples of every intermediate disk write. Playback speed controls viewing time, not measured engine latency.

The export changes only the machine-specific database paths to recording-relative labels. Run IDs, session IDs, worker receipts, workload, page bytes, and events stay intact. Raw local source files remain under the printed `work/replay-export-*` directory.

## Source identity and integrity

The embedded bundle and `manifest.json` identify the package version, Git revision, dirty-source flag, capture time, platform, and engine executable SHA256. The manifest records each export file's length and SHA256. Capture IDs, process IDs, and times vary between runs; reproduction means the same validated operations and outcomes, not identical output bytes.

`src/ReplayApp.tsx` validates metadata and the existing story protocol before rendering. `src/replay-main.tsx` is a separate entry point from the live workbench. It has no engine command or polling path. An embedded Content Security Policy denies network connections and form submissions. A malformed recording gets an explicit error screen.

`npm run test:replay` checks all scenarios against their captured statistics and the first 256 bytes of **every page at every frame**, including checkpoint bytes where present. It also checks disk/offline operation, nested static URLs, keyboard playback, mobile/tablet widths, and damaged recordings.

## Media

`npm run record:demo` records the actual standalone UI and trims it to 30 seconds. It uses the Chromium/FFmpeg installation from `npm run browser:install`; `FFMPEG` can select a compatible executable. Outputs are `docs/media/walnut-demo.webm` and the PNG poster. The recording shows staging/split, process termination/recovery, checkpoint, and byte inspection. It contains no synthetic state or added animation frames.

The shared viewer styles also serve the live inspector. Phase 6 corrected the tablet inspector's grid sizing so long stored values cannot expand the outer page width.
