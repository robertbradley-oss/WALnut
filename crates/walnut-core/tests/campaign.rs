// The shared fault disk also provides helpers used by other integration suites.
#[allow(dead_code)]
mod support;
use std::{
    collections::BTreeMap,
    panic::{AssertUnwindSafe, catch_unwind},
};
use support::{Disk, Fault, TestEngine, fresh, key, writes};
use walnut_core::{Engine, WriteOp, page::PAGE_SIZE, wal::FILE_HEADER};

fn next(seed: &mut u64) -> u64 {
    *seed = seed
        .wrapping_mul(6364136223846793005)
        .wrapping_add(1442695040888963407);
    *seed
}

fn model_ops(model: &mut BTreeMap<String, String>, ops: &[WriteOp]) {
    for w in ops {
        model.insert(w.key.clone(), w.value.clone());
    }
}

fn contents(engine: &mut TestEngine) -> BTreeMap<String, String> {
    let mut result = BTreeMap::new();
    let mut start = String::new();
    loop {
        let range = engine.range(&start, None, 37).unwrap();
        for r in range.records {
            assert!(
                result.insert(r.key, r.value).is_none(),
                "duplicate scan record"
            );
        }
        match range.next_key {
            Some(next) => {
                assert!(next > start);
                start = next;
            }
            None => break,
        }
    }
    result
}

fn assert_model(engine: &mut TestEngine, model: &BTreeMap<String, String>, context: &str) {
    assert_eq!(&contents(engine), model, "{context}");
    assert_eq!(
        engine.snapshot().unwrap().record_count,
        model.len() as u64,
        "{context}"
    );
    for (key, value) in model.iter().step_by(29) {
        assert_eq!(engine.get(key).unwrap().as_ref(), Some(value), "{context}");
    }
    let bounds: Vec<_> = model.keys().skip(7).take(61).collect();
    if let (Some(start), Some(end)) = (bounds.first(), bounds.last()) {
        let range = engine.range(start, Some(end), 256).unwrap();
        let actual: Vec<_> = range
            .records
            .into_iter()
            .map(|r| (r.key, r.value))
            .collect();
        let expected: Vec<_> = model
            .range((*start).clone()..(*end).clone())
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();
        assert_eq!(actual, expected, "{context}");
    }
}

#[test]
fn seeded_mixed_workloads_survive_faults_checkpoints_and_repeated_recovery() {
    // Fixed seeds are part of the reproducer. Add any failing seed here before fixing it.
    for initial_seed in [0x57414c6e7574, 1, 0xdeadbeef, 0xffff_ffff] {
        let mut random = initial_seed;
        let (data, log, mut engine) = fresh(128, true);
        let mut model = BTreeMap::new();
        model_ops(&mut model, &writes(0, 128));
        for step in 0..72 {
            let context = format!("seed={initial_seed:#x}, step={step}, case={}", step % 12);
            let ops: Vec<_> = (0..1 + (next(&mut random) % 8))
                .map(|i| {
                    let n = next(&mut random);
                    WriteOp {
                        key: if i == 0 && step % 5 == 0 {
                            format!("é\0{:04}", n % 40)
                        } else {
                            key((n % 240) as usize)
                        },
                        value: format!(
                            "{step}:{i}:{}",
                            "v".repeat((next(&mut random) % 990) as usize)
                        ),
                    }
                })
                .collect();
            let mut candidate = model.clone();
            model_ops(&mut candidate, &ops);
            let power = step / 12 % 2 == 0;
            let mut ambiguous = false;
            match step % 12 {
                0 | 11 => {
                    engine.batch(ops).unwrap();
                    model = candidate.clone();
                }
                1 => {
                    for w in ops {
                        engine.stage(&w.key, &w.value).unwrap();
                    }
                    assert_model(&mut engine, &model, &context);
                    engine.discard().unwrap();
                }
                2 => {
                    for w in ops {
                        engine.stage(&w.key, &w.value).unwrap();
                    }
                    engine.checkpoint().unwrap();
                    assert_model(&mut engine, &model, &context);
                    engine.commit().unwrap();
                    model = candidate.clone();
                }
                3 => {
                    log.fail(Fault::Sync);
                    assert!(engine.batch(ops).is_err(), "{context}");
                    ambiguous = !power;
                }
                4 => {
                    let captured = log.clone();
                    engine.set_boundary_hook(move |name| {
                        if name == "after_wal_header" {
                            captured.fail(Fault::Write(31));
                        }
                    });
                    assert!(engine.batch(ops).is_err(), "{context}");
                }
                5 => {
                    log.fail(Fault::Mismatch);
                    assert!(engine.batch(ops).is_err(), "{context}");
                    // Full WAL sync succeeded before the deliberately bad verification read.
                    model = candidate.clone();
                }
                6..=8 => {
                    engine.batch(ops).unwrap();
                    model = candidate.clone();
                    match step % 12 {
                        6 => data.fail(Fault::Write(67)),
                        7 => data.fail(Fault::Sync),
                        _ => log.fail(Fault::Truncate(FILE_HEADER + 31)),
                    }
                    assert!(engine.checkpoint().is_err(), "{context}");
                }
                9 | 10 => {
                    let point = if step % 12 == 9 {
                        "after_commit_marker"
                    } else {
                        "after_wal_header"
                    };
                    engine.set_boundary_hook(move |name| {
                        if name == point {
                            panic!("injected interruption")
                        }
                    });
                    assert!(
                        catch_unwind(AssertUnwindSafe(|| engine.batch(ops))).is_err(),
                        "{context}"
                    );
                    ambiguous = step % 12 == 9 && !power;
                }
                _ => unreachable!(),
            }
            drop(engine);
            data.crash(power);
            log.crash(power);
            engine = Engine::open(data.clone(), log.clone(), step % 2 == 0)
                .unwrap_or_else(|e| panic!("{context}: {e}"));
            if ambiguous {
                let actual = contents(&mut engine);
                assert!(
                    actual == model || actual == candidate,
                    "partial transaction: {context}"
                );
                model = actual;
            }
            assert_model(&mut engine, &model, &context);
            // Reopen twice before checkpointing to test idempotent recovery and log reuse.
            drop(engine);
            engine = Engine::open(data.clone(), log.clone(), false).unwrap();
            assert_model(&mut engine, &model, &context);
            engine.checkpoint().unwrap();
        }
    }
}

#[test]
fn near_limit_tree_survives_partial_checkpoint_and_keeps_every_record() {
    let (data, log, mut engine) = fresh(1920, true);
    assert!(engine.snapshot().unwrap().page_count > 980);
    let mut model = BTreeMap::new();
    model_ops(&mut model, &writes(0, 1920));
    let updates: Vec<_> = (0..64)
        .map(|i| WriteOp {
            key: key(i * 29),
            value: "u".repeat(1000),
        })
        .collect();
    engine.batch(updates.clone()).unwrap();
    model_ops(&mut model, &updates);
    let changed = engine.snapshot().unwrap().changed_pages;
    let selected = changed[changed.len() / 2];
    let captured = data.clone();
    engine.set_boundary_hook(move |name| {
        if name == format!("after_checkpoint_page:{selected}") {
            captured.fail(Fault::Write(2047));
        }
    });
    assert!(engine.checkpoint().is_err());
    drop(engine);
    // Process loss retains partial main-file writes and the complete acknowledged WAL.
    data.crash(false);
    log.crash(false);
    let mut recovered = Engine::open(data.clone(), log.clone(), true).unwrap();
    assert_model(&mut recovered, &model, "near-limit recovery");
    recovered.checkpoint().unwrap();
    drop(recovered);
    data.crash(true);
    log.crash(true);
    assert_model(
        &mut Engine::open(data, log, false).unwrap(),
        &model,
        "near-limit checkpoint",
    );
}

#[test]
fn malformed_large_files_fail_closed_without_rewriting_evidence() {
    let (data, log, engine) = fresh(512, true);
    drop(engine);
    let original = data.bytes();
    let wal = log.bytes();
    // Whole pages missing at the beginning, interior and end; junk beyond allocation bounds.
    let mut cases = vec![
        original[..FILE_HEADER].to_vec(),
        original[..original.len() - 1].to_vec(),
    ];
    for id in [0, 1, 3, 60, 128] {
        let mut bad = original.clone();
        bad[FILE_HEADER + id * PAGE_SIZE + 100] ^= 0x80;
        cases.push(bad);
    }
    cases.push(vec![0; FILE_HEADER + 1025 * PAGE_SIZE + 1]);
    for bad in cases {
        data.replace(bad.clone());
        log.replace(wal.clone());
        assert!(Engine::open(data.clone(), log.clone(), false).is_err());
        assert_eq!(data.bytes(), bad);
        assert_eq!(log.bytes(), wal);
    }
    data.replace(original);
    let mut recovered = Engine::open(data, log, false).unwrap();
    assert_eq!(contents(&mut recovered).len(), 512);
}

#[test]
fn tracing_does_not_change_file_bytes_results_or_failure_outcomes() {
    let (a, b) = (Disk::default(), Disk::default());
    let (c, d) = (Disk::default(), Disk::default());
    let mut on = Engine::create(a.clone(), b.clone(), [42; 16], true).unwrap();
    let mut off = Engine::create(c.clone(), d.clone(), [42; 16], false).unwrap();
    for i in 0..4 {
        on.batch(writes(i * 32, 32)).unwrap();
        off.batch(writes(i * 32, 32)).unwrap();
        assert_eq!(a.bytes(), c.bytes());
        assert_eq!(b.bytes(), d.bytes());
        assert_eq!(on.get(&key(i)).unwrap(), off.get(&key(i)).unwrap());
        assert_eq!(contents(&mut on), contents(&mut off));
        assert_eq!(
            on.snapshot().unwrap().last_search_path,
            off.snapshot().unwrap().last_search_path
        );
        on.checkpoint().unwrap();
        off.checkpoint().unwrap();
    }
    assert_eq!(a.bytes(), c.bytes());
    assert_eq!(b.bytes(), d.bytes());
    assert_eq!(off.snapshot().unwrap().events.len(), 0);
    assert_eq!(on.snapshot().unwrap().events.len(), 128);
    b.fail(Fault::Sync);
    d.fail(Fault::Sync);
    assert_eq!(
        on.put("failed", "value").unwrap_err().code,
        off.put("failed", "value").unwrap_err().code
    );
    drop(on);
    drop(off);
    a.crash(true);
    b.crash(true);
    c.crash(true);
    d.crash(true);
    assert_eq!(
        contents(&mut Engine::open(a, b, true).unwrap()),
        contents(&mut Engine::open(c, d, false).unwrap())
    );
}
