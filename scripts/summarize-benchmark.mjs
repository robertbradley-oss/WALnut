import { readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
const input = await readFile(process.argv[2]);
const report = JSON.parse(
  (process.argv[2].endsWith(".gz") ? gunzipSync(input) : input).toString(
    "utf8",
  ),
);
function p(samples, percentile = 50) {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.ceil((sorted.length * percentile) / 100) - 1];
}
function samples(size, tracing, metric) {
  return report.runs
    .filter((r) => r.records === size && r.tracing === tracing)
    .flatMap((r) => r.metrics[metric].raw_ns);
}
const metrics = {
  point_hit: "Point hit",
  point_miss: "Point miss",
  range_64: "Range: 64 results",
  snapshot: "Snapshot",
  snapshot_json: "Snapshot + JSON",
  point_plus_snapshot_json: "Point + snapshot + JSON",
  durable_put: "Durable put",
  durable_batch_16: "Durable batch: 16 puts",
  checkpoint_after_batch_16: "Checkpoint after 16 puts",
  recover_16_transactions: "Recover 16 transactions",
};
console.log(
  "Tracing off. All cells are **p50 / p95 in microseconds**, pooled across three trials.\n",
);
console.log(`| Operation | ${report.sizes.join(" records | ")} records |`);
console.log("| --- | ---: | ---: | ---: |");
for (const [key, label] of Object.entries(metrics)) {
  console.log(
    `| ${label} | ${report.sizes
      .map((n) => {
        const raw = samples(n, false, key);
        return `${(p(raw) / 1000).toFixed(1)} / ${(p(raw, 95) / 1000).toFixed(1)}`;
      })
      .join(" | ")} |`,
  );
}
console.log(
  "\nTracing overhead: median microseconds, same workload and durable settings.\n",
);
console.log(
  "| Records | Point: off / on | Snapshot + JSON: off / on | Durable put: off / on |",
);
console.log("| ---: | ---: | ---: | ---: |");
for (const n of report.sizes)
  console.log(
    `| ${n} | ${["point_hit", "snapshot_json", "durable_put"].map((metric) => [false, true].map((t) => (p(samples(n, t, metric)) / 1000).toFixed(1)).join(" / ")).join(" | ")} |`,
  );
console.log(
  "\nIndex comparison: median microseconds; same resident tree, no tracing or I/O.\n",
);
console.log(
  "| Records | Indexed hit | Sequential hit | Candidate preparation |",
);
console.log("| ---: | ---: | ---: | ---: |");
for (const row of report.index_comparison)
  console.log(
    `| ${row.records} | ${(row.indexed.p50_ns / 1000).toFixed(1)} | ${(row.sequential.p50_ns / 1000).toFixed(1)} | ${(row.prepare_update.p50_ns / 1000).toFixed(1)} |`,
  );
console.log(
  "\nFile growth, bytes: updates keep the allocated page count constant.\n",
);
console.log(
  "| Records | Main after setup | WAL after 32 puts | WAL after another 16 batches | WAL after checkpoint |",
);
console.log("| ---: | ---: | ---: | ---: | ---: |");
for (const n of report.sizes) {
  const files = report.runs.find((r) => r.records === n && !r.tracing).files;
  console.log(
    `| ${n} | ${files.initial.main_bytes} | ${files.after_32_puts.wal_bytes} | ${files.after_16_batches.wal_bytes} | ${files.after_checkpoint.wal_bytes} |`,
  );
}
