//! Repeatable, file-backed measurements. Setup and correctness checks are untimed.
use serde_json::{Value, json};
use std::{hint::black_box, path::Path, time::Instant};
use walnut_core::{FileEngine, Result, Tree, create_file, open_file, page::Contents};

const SIZES: [usize; 3] = [128, 512, 1792];
const SEED: u64 = 0x57414c6e7574;

fn distribution(mut samples: Vec<u64>) -> Value {
    samples.sort_unstable();
    let percentile = |p: usize| samples[(samples.len() * p).div_ceil(100) - 1];
    json!({"samples":samples.len(), "min_ns":samples[0],
        "p50_ns":percentile(50),"p95_ns":percentile(95),"p99_ns":percentile(99),
        "max_ns":samples[samples.len()-1],
        "mean_ns":samples.iter().map(|n| *n as f64).sum::<f64>() / samples.len() as f64,
        "raw_ns":samples})
}

fn measure(mut operation: impl FnMut(usize) -> Result<()>, count: usize) -> Result<Value> {
    let mut samples = Vec::with_capacity(count);
    for i in 0..count {
        let start = Instant::now();
        operation(i)?;
        samples.push(start.elapsed().as_nanos() as u64);
    }
    Ok(distribution(samples))
}

fn queries(count: usize) -> Vec<usize> {
    let mut seed = SEED;
    (0..1000)
        .map(|_| {
            seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1);
            (seed >> 32) as usize % count
        })
        .collect()
}

fn prepare(path: &Path, count: usize, tracing: bool) -> Result<FileEngine> {
    let mut engine = create_file(path, tracing)?;
    for batch in crate::workload::split_writes(0, count).chunks(64) {
        engine.batch(batch.to_vec())?;
    }
    engine.checkpoint()?;
    Ok(engine)
}

fn verify(engine: &mut FileEngine, expected: &[(String, String)]) -> Result<()> {
    let mut actual = Vec::new();
    let mut start = String::new();
    loop {
        let result = engine.range(&start, None, 256)?;
        actual.extend(result.records.into_iter().map(|r| (r.key, r.value)));
        match result.next_key {
            Some(next) => start = next,
            None => break,
        }
    }
    if actual != expected {
        return Err(walnut_core::Error::new(
            "benchmark_mismatch",
            "Readback differs from the workload.",
        ));
    }
    Ok(())
}

fn file_sizes(engine: &FileEngine) -> Result<Value> {
    let s = engine.snapshot()?;
    Ok(
        json!({"main_bytes":s.database_bytes,"wal_bytes":s.wal_bytes,
        "generation":s.generation,"records":s.record_count,"pages":s.page_count,"height":s.tree_height}),
    )
}

fn engine_run(directory: &Path, count: usize, tracing: bool, trial: usize) -> Result<Value> {
    let path = directory.join(format!("n{count}-trace{tracing}-trial{trial}.db"));
    let mut engine = prepare(&path, count, tracing)?;
    let writes = crate::workload::split_writes(0, count);
    let mut expected: Vec<_> = writes
        .iter()
        .map(|w| (w.key.clone(), w.value.clone()))
        .collect();
    let query = queries(count);
    verify(&mut engine, &expected)?;
    let initial = file_sizes(&engine)?;
    for &i in query.iter().take(100) {
        black_box(engine.get(&writes[i].key)?);
    }
    let mut metrics = serde_json::Map::new();
    metrics.insert(
        "point_hit".into(),
        measure(
            |i| {
                black_box(engine.get(black_box(&writes[query[i]].key))?);
                Ok(())
            },
            1000,
        )?,
    );
    let misses: Vec<_> = query.iter().map(|i| format!("absent/{i:05}")).collect();
    metrics.insert(
        "point_miss".into(),
        measure(
            |i| {
                black_box(engine.get(black_box(&misses[i]))?);
                Ok(())
            },
            1000,
        )?,
    );
    metrics.insert(
        "range_64".into(),
        measure(
            |i| {
                black_box(engine.range(
                    black_box(&writes[query[i] % (count - 64)].key),
                    None,
                    64,
                )?);
                Ok(())
            },
            100,
        )?,
    );
    metrics.insert(
        "snapshot".into(),
        measure(
            |_| {
                black_box(engine.snapshot()?);
                Ok(())
            },
            100,
        )?,
    );
    metrics.insert(
        "snapshot_json".into(),
        measure(
            |_| {
                black_box(serde_json::to_vec(&engine.snapshot()?).unwrap());
                Ok(())
            },
            100,
        )?,
    );
    metrics.insert(
        "point_plus_snapshot_json".into(),
        measure(
            |i| {
                black_box(engine.get(black_box(&writes[query[i]].key))?);
                black_box(serde_json::to_vec(&engine.snapshot()?).unwrap());
                Ok(())
            },
            100,
        )?,
    );
    // Update existing keys with the same byte length, avoiding growth as a confounder.
    let updated = "u".repeat(1000);
    metrics.insert(
        "durable_put".into(),
        measure(
            |i| engine.put(&writes[query[i]].key, black_box(&updated)),
            32,
        )?,
    );
    for &i in query.iter().take(32) {
        expected[i].1 = updated.clone();
    }
    let after_puts = file_sizes(&engine)?;
    let batches: Vec<_> = (0..16)
        .map(|i| {
            query[i * 16..i * 16 + 16]
                .iter()
                .map(|&j| walnut_core::WriteOp {
                    key: writes[j].key.clone(),
                    value: updated.clone(),
                })
                .collect::<Vec<_>>()
        })
        .collect();
    metrics.insert(
        "durable_batch_16".into(),
        measure(|i| engine.batch(batches[i].clone()), 16)?,
    );
    for &i in query.iter().take(256) {
        expected[i].1 = updated.clone();
    }
    let after_batches = file_sizes(&engine)?;
    verify(&mut engine, &expected)?;

    // Each checkpoint starts with 16 committed updates in the WAL.
    let mut checkpoint_samples = Vec::new();
    let mut recovery_samples = Vec::new();
    engine.checkpoint()?;
    let after_checkpoint = file_sizes(&engine)?;
    for _ in 0..9 {
        engine.batch(batches[0].clone())?;
        let start = Instant::now();
        engine.checkpoint()?;
        checkpoint_samples.push(start.elapsed().as_nanos() as u64);
        verify(&mut engine, &expected)?;
    }
    // Close, reopen, validate and sync a 16-transaction WAL. This is warm OS-cache recovery.
    for _ in 0..9 {
        engine.checkpoint()?;
        for i in 0..16 {
            engine.put(&writes[query[i]].key, &updated)?;
        }
        drop(engine);
        let start = Instant::now();
        engine = open_file(&path, tracing)?;
        recovery_samples.push(start.elapsed().as_nanos() as u64);
        if engine.snapshot()?.recovery.replayed_transactions != 16 {
            return Err(walnut_core::Error::new(
                "benchmark_mismatch",
                "Recovery did not replay 16 transactions.",
            ));
        }
        verify(&mut engine, &expected)?;
    }
    metrics.insert(
        "checkpoint_after_batch_16".into(),
        distribution(checkpoint_samples),
    );
    metrics.insert(
        "recover_16_transactions".into(),
        distribution(recovery_samples),
    );
    let final_sizes = file_sizes(&engine)?;
    Ok(
        json!({"records":count,"tracing":tracing,"trial":trial,"metrics":metrics,
        "files":{"initial":initial,"after_32_puts":after_puts,"after_16_batches":after_batches,
            "after_checkpoint":after_checkpoint,"final":final_sizes},"verified":true}),
    )
}

/// Linear leaf traversal of the SAME tree, cloning only the matching value.
fn sequential(tree: &Tree, key: &str) -> Option<String> {
    let mut id = 1;
    while id != 0 {
        let Contents::Leaf { entries, next } = &tree.pages[&id].contents else {
            unreachable!()
        };
        for record in entries {
            match record.0.as_str().cmp(key) {
                std::cmp::Ordering::Equal => return Some(record.1.clone()),
                std::cmp::Ordering::Greater => return None,
                std::cmp::Ordering::Less => (),
            }
        }
        id = *next;
    }
    None
}

fn index_comparison(count: usize) -> Result<Value> {
    let entries = crate::workload::split_writes(0, count);
    let tree = Tree::from_entries(entries.iter().map(|w| (w.key.clone(), w.value.clone())), 1)?;
    let keys: Vec<_> = queries(count)
        .iter()
        .map(|&i| entries[i].key.clone())
        .collect();
    for key in &keys {
        assert_eq!(tree.get(key)?.0, sequential(&tree, key));
    }
    let indexed = measure(
        |i| {
            black_box(tree.get(black_box(&keys[i]))?);
            Ok(())
        },
        1000,
    )?;
    let linear = measure(
        |i| {
            black_box(sequential(black_box(&tree), black_box(&keys[i])));
            Ok(())
        },
        1000,
    )?;
    let update = vec![walnut_core::WriteOp {
        key: keys[0].clone(),
        value: "u".repeat(1000),
    }];
    let prepare_update = measure(
        |_| {
            black_box(tree.with_batch(black_box(&update))?);
            Ok(())
        },
        100,
    )?;
    Ok(
        json!({"records":count,"pages":tree.pages.len(),"indexed":indexed,"sequential":linear,"prepare_update":prepare_update}),
    )
}

pub fn run(directory: &Path) -> Result<Value> {
    // create_dir refuses existing destinations: never overwrite earlier evidence or databases.
    std::fs::create_dir(directory)?;
    let mut runs = Vec::new();
    let mut comparisons = Vec::new();
    for count in SIZES {
        comparisons.push(index_comparison(count)?);
        for trial in 0..3 {
            for tracing in if trial % 2 == 0 {
                [false, true]
            } else {
                [true, false]
            } {
                eprintln!("Measuring {count} records, tracing={tracing}, trial={trial}");
                runs.push(engine_run(directory, count, tracing, trial)?);
            }
        }
    }
    Ok(
        json!({"schema_version":1,"engine_version":env!("CARGO_PKG_VERSION"),
        "debug_assertions":cfg!(debug_assertions),"seed":SEED,"sizes":SIZES,
        "key_bytes":64,"value_bytes":1000,"sync":"Storage::sync -> File::sync_all; commit readback enabled",
        "cache":"resident tree; warm OS file cache; no cache eviction",
        "timer_baseline":measure(|_| { black_box(0); Ok(()) },1000)?,
        "index_comparison":comparisons,"runs":runs}),
    )
}

pub fn fixture(directory: &Path) -> Result<Value> {
    std::fs::create_dir(directory)?;
    let path = directory.join("large.db");
    let mut engine = prepare(&path, 1792, true)?;
    for i in queries(1792) {
        engine.get(&crate::workload::split_writes(i, 1)[0].key)?;
    }
    let mut live = serde_json::to_value(engine.snapshot()?).unwrap();
    live["database_name"] = json!("large.db");
    let path = directory.join("recording.db");
    let mut engine = prepare(&path, 116, true)?;
    let baseline = crate::story::capture(&engine, &path, 3)?;
    for w in crate::workload::split_writes(116, 2) {
        engine.stage(&w.key, &w.value)?;
    }
    let staged = crate::story::capture(&engine, &path, 3)?;
    engine.commit()?;
    let root = engine.snapshot()?.root_page_id;
    let committed = crate::story::capture(&engine, &path, root)?;
    engine.get(&crate::workload::split_writes(117, 1)[0].key)?;
    let lookup = crate::story::capture(&engine, &path, root)?;
    let frames: Vec<_> = [baseline, staged, committed, lookup]
        .into_iter()
        .enumerate()
        .map(|(i, capture)| {
            let kind = ["baseline", "staged", "committed", "lookup"][i];
            json!({"id":kind,"kind":kind,"title":format!("Large tree {kind}"),
            "explanation":format!("Captured engine state after {kind}; profile fixture."),
            "command":kind,"focus_page_id":capture["snapshot"]["page_id"],"capture":capture})
        })
        .collect();
    Ok(
        json!({"snapshot":live,"story":{"schema_version":1,"run_id":"profile-root-split",
        "scenario":"split","title":"Recorded root split: 59 to 62 node pages",
        "source":{"engine_version":env!("CARGO_PKG_VERSION"),"storage_format_version":3,
            "page_format_version":2,"database_path":path,"workload":crate::workload::split_writes(116,2),
            "failure_model":"none"},"frames":frames}}),
    )
}
