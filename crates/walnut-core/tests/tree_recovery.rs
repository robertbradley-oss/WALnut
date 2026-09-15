mod support;
use std::{
    cell::RefCell,
    panic::{AssertUnwindSafe, catch_unwind},
    rc::Rc,
};
use support::*;
use walnut_core::{
    Engine, Tree, legacy, open_file,
    page::PAGE_SIZE,
    upgrade_file,
    wal::{self, FILE_HEADER, MAX_FRAMES, MAX_WAL_BYTES, TX_HEADER},
    wal_path,
};

#[test]
fn every_page_boundary_recovers_a_whole_root_split_under_process_and_power_loss() {
    let (_, _, mut dry) = fresh(116, true);
    let trace = Rc::new(RefCell::new(vec![]));
    let captured = trace.clone();
    dry.set_boundary_hook(move |name| captured.borrow_mut().push(name.to_owned()));
    dry.batch(writes(116, 2)).unwrap();
    trace.borrow_mut().push("after_commit_return".into());
    dry.checkpoint().unwrap();
    let points = trace.borrow().clone();
    assert!(points.contains(&"after_checkpoint_page:3".into()));
    let marker = points
        .iter()
        .position(|p| p == "after_commit_marker")
        .unwrap();
    let sync = points.iter().position(|p| p == "after_wal_sync").unwrap();
    for power in [false, true] {
        for (position, point) in points.iter().enumerate() {
            let (data, log, mut engine) = fresh(116, true);
            let selected = point.clone();
            engine.set_boundary_hook(move |name| {
                if name == selected {
                    panic!("cut {name}")
                }
            });
            assert!(
                catch_unwind(AssertUnwindSafe(|| {
                    engine.batch(writes(116, 2)).unwrap();
                    if point == "after_commit_return" {
                        panic!("commit returned")
                    };
                    engine.checkpoint().unwrap();
                }))
                .is_err()
            );
            drop(engine);
            data.crash(power);
            log.crash(power);
            let count = if position >= if power { sync } else { marker } {
                118
            } else {
                116
            };
            let mut recovered = Engine::open(data.clone(), log.clone(), true).unwrap();
            assert_records(&mut recovered, count);
            assert_eq!(
                recovered.snapshot().unwrap().tree_height,
                if count == 118 { 3 } else { 2 }
            );
            let root = recovered.snapshot().unwrap().root_page_id;
            drop(recovered);
            let mut again = Engine::open(data.clone(), log.clone(), true).unwrap();
            assert_eq!(again.snapshot().unwrap().root_page_id, root);
            assert_records(&mut again, count);
            again.checkpoint().unwrap();
            again.put("continued", "yes").unwrap();
            drop(again);
            data.crash(true);
            log.crash(true);
            assert_eq!(
                Engine::open(data, log, true)
                    .unwrap()
                    .get("continued")
                    .unwrap()
                    .as_deref(),
                Some("yes")
            );
        }
    }
}

#[test]
fn first_split_transaction_tail_is_discarded_at_every_byte_length() {
    let (data, log, engine) = fresh(3, false);
    let prefix = log.bytes();
    let base = Tree::from_entries(writes(0, 3).into_iter().map(|w| (w.key, w.value)), 1).unwrap();
    let plan = base.with_batch(&writes(3, 2)).unwrap();
    let tx = wal::encode(&plan.tree, &base.meta, &plan.changed, 2).unwrap();
    drop(engine);
    for cut in 0..tx.len() {
        let mut bytes = prefix.clone();
        bytes.extend_from_slice(&tx[..cut]);
        log.replace(bytes);
        let mut recovered = Engine::open(data.clone(), log.clone(), false).unwrap();
        assert_records(&mut recovered, 3);
        assert_eq!(
            recovered.snapshot().unwrap().recovery.discarded_tail_bytes,
            cut as u64
        );
        assert_eq!(log.bytes(), prefix);
    }
}

#[test]
fn complete_transaction_corruption_is_rejected_without_truncating_the_prefix() {
    let (data, log, mut engine) = fresh(3, true);
    engine.batch(writes(3, 2)).unwrap();
    let original = log.bytes();
    drop(engine);
    for index in FILE_HEADER..original.len() {
        let mut bytes = original.clone();
        bytes[index] ^= 1;
        log.replace(bytes.clone());
        assert_eq!(
            Engine::open(data.clone(), log.clone(), false)
                .err()
                .unwrap()
                .code,
            "corrupt_wal"
        );
        assert_eq!(log.bytes(), bytes);
    }
}

#[test]
fn staged_splits_are_invisible_and_checkpoint_preserves_the_pending_tree() {
    let (data, log, mut engine) = fresh(3, true);
    let before = (data.bytes(), log.bytes());
    for op in writes(3, 2) {
        engine.stage(&op.key, &op.value).unwrap();
    }
    assert_eq!(engine.snapshot().unwrap().tree_height, 1);
    assert_eq!(engine.snapshot().unwrap().staged_page_count, Some(3));
    assert_records(&mut engine, 3);
    assert_eq!((data.bytes(), log.bytes()), before);
    engine.checkpoint().unwrap();
    engine.commit().unwrap();
    assert_records(&mut engine, 5);
    assert_eq!(engine.snapshot().unwrap().tree_height, 2);
    engine.stage("discarded", "value").unwrap();
    drop(engine);
    let mut recovered = Engine::open(data, log, true).unwrap();
    assert!(recovered.get("discarded").unwrap().is_none());
    assert_records(&mut recovered, 5);
}

#[test]
fn partial_wal_writes_and_failed_sync_or_readback_poison_without_false_acknowledgement() {
    for point in [
        "before_frame",
        "after_wal_header",
        "after_wal_page:0",
        "after_frame",
    ] {
        for cut in [0, 1, 31, 63, 2048, 4095] {
            let (data, log, mut engine) = fresh(3, true);
            let captured = log.clone();
            engine.set_boundary_hook(move |name| {
                if name == point {
                    captured.fail(Fault::Write(cut));
                }
            });
            assert!(engine.batch(writes(3, 2)).is_err());
            assert_eq!(engine.get("x").unwrap_err().code, "needs_reopen");
            drop(engine);
            log.crash(true);
            data.crash(true);
            assert_records(&mut Engine::open(data, log, true).unwrap(), 3);
        }
    }
    for fault in [Fault::Sync, Fault::Read, Fault::Mismatch] {
        let (data, log, mut engine) = fresh(3, true);
        log.fail(fault);
        assert!(engine.batch(writes(3, 2)).is_err());
        drop(engine);
        data.crash(true);
        log.crash(true);
        assert_records(
            &mut Engine::open(data, log, true).unwrap(),
            if matches!(fault, Fault::Sync) { 3 } else { 5 },
        );
    }
}

#[test]
fn torn_nodes_torn_metadata_and_mixed_checkpoints_are_repaired_from_changed_images() {
    for page in [0, 1, 3, 59, 60, 61, 62] {
        for cut in [0, 17, 64, 2048, 4095] {
            let (data, log, mut engine) = fresh(116, true);
            engine.batch(writes(116, 2)).unwrap();
            let before = log.bytes();
            let captured = data.clone();
            engine.set_boundary_hook(move |name| {
                if (page == 1 && name == "before_checkpoint_write")
                    || (page == 0 && name == "after_checkpoint_page:62")
                    || (page > 1 && name == format!("after_checkpoint_page:{}", page - 1))
                {
                    captured.fail(Fault::Write(cut));
                }
            });
            assert!(engine.checkpoint().is_err());
            assert_eq!(log.bytes(), before);
            assert!(engine.snapshot().is_err());
            drop(engine);
            data.crash(false);
            log.crash(false);
            let mut recovered = Engine::open(data.clone(), log.clone(), true).unwrap();
            assert_records(&mut recovered, 118);
            recovered.checkpoint().unwrap();
            drop(recovered);
            data.crash(true);
            log.crash(true);
            assert_records(&mut Engine::open(data, log, true).unwrap(), 118);
        }
    }
}

#[test]
fn interrupted_reset_and_recovery_io_errors_keep_the_latest_root() {
    for retained in [
        FILE_HEADER,
        FILE_HEADER + 1,
        FILE_HEADER + TX_HEADER,
        FILE_HEADER + TX_HEADER + PAGE_SIZE,
    ] {
        let (data, log, mut engine) = fresh(116, true);
        engine.batch(writes(116, 2)).unwrap();
        log.fail(Fault::Truncate(retained));
        assert!(engine.checkpoint().is_err());
        drop(engine);
        data.crash(false);
        log.crash(false);
        let mut recovered = Engine::open(data.clone(), log.clone(), true).unwrap();
        assert_records(&mut recovered, 118);
        recovered.put("next", "ok").unwrap();
        drop(recovered);
        data.crash(true);
        log.crash(true);
        assert_eq!(
            Engine::open(data, log, true)
                .unwrap()
                .get("next")
                .unwrap()
                .as_deref(),
            Some("ok")
        );
    }
    for fault in [Fault::Read, Fault::Sync, Fault::Truncate(FILE_HEADER)] {
        let (data, log, engine) = fresh(3, true);
        drop(engine);
        let mut tail = log.bytes();
        tail.extend_from_slice(&[42; 9]);
        log.replace(tail);
        log.fail(fault);
        assert!(Engine::open(data.clone(), log.clone(), true).is_err());
        log.crash(false);
        assert_records(&mut Engine::open(data, log, true).unwrap(), 3);
    }
    let (data, log, mut engine) = fresh(116, true);
    engine.batch(writes(116, 2)).unwrap();
    let captured = log.clone();
    engine.set_boundary_hook(move |name| {
        if name == "after_wal_truncate" {
            captured.fail(Fault::Sync)
        }
    });
    assert!(engine.checkpoint().is_err());
    drop(engine);
    data.crash(true);
    log.crash(true);
    assert_records(&mut Engine::open(data, log, true).unwrap(), 118);
}

#[test]
fn state_checksum_rejects_individually_valid_pages_from_a_different_commit() {
    let (data, log, mut engine) = fresh(3, true);
    let old = data.bytes();
    engine.put(&key(0), "new").unwrap();
    engine.checkpoint().unwrap();
    drop(engine);
    let mut mixed = data.bytes();
    mixed[FILE_HEADER + PAGE_SIZE..FILE_HEADER + 2 * PAGE_SIZE]
        .copy_from_slice(&old[FILE_HEADER + PAGE_SIZE..FILE_HEADER + 2 * PAGE_SIZE]);
    data.replace(mixed);
    assert_eq!(
        Engine::open(data, log, true).err().unwrap().code,
        "unrecoverable_tree"
    );
}

#[test]
fn log_reuse_with_an_obsolete_complete_prefix_does_not_create_a_metadata_gap() {
    let (data, log, mut engine) = fresh(3, false);
    let prefix = log.bytes();
    engine.batch(writes(3, 2)).unwrap();
    log.fail(Fault::Truncate(prefix.len()));
    assert!(engine.checkpoint().is_err());
    drop(engine);
    log.crash(false);
    data.crash(false);
    let mut recovered = Engine::open(data.clone(), log.clone(), true).unwrap();
    assert_records(&mut recovered, 5);
    assert_eq!(
        recovered
            .snapshot()
            .unwrap()
            .recovery
            .obsolete_frames_removed,
        1
    );
    recovered.put("next", "ok").unwrap();
    drop(recovered);
    assert_eq!(
        Engine::open(data, log, true)
            .unwrap()
            .get("next")
            .unwrap()
            .as_deref(),
        Some("ok")
    );
}

#[test]
fn wal_capacity_preserves_pending_batch_and_new_allocations_must_have_images() {
    let (_, log, mut engine) = fresh(0, false);
    for _ in 0..MAX_FRAMES {
        engine.put("key", "value").unwrap();
    }
    let before = log.bytes();
    engine.stage("pending", "value").unwrap();
    assert_eq!(engine.commit().unwrap_err().code, "checkpoint_required");
    assert_eq!(before, log.bytes());
    engine.checkpoint().unwrap();
    engine.commit().unwrap();
    assert_eq!(engine.get("pending").unwrap().as_deref(), Some("value"));
    let base = Tree::from_entries(writes(0, 3).into_iter().map(|w| (w.key, w.value)), 1).unwrap();
    let plan = base.with_batch(&writes(3, 2)).unwrap();
    let mut missing = plan.changed.clone();
    missing.remove(&2);
    assert_eq!(
        wal::encode(&plan.tree, &base.meta, &missing, 2)
            .unwrap_err()
            .code,
        "corrupt_wal"
    );
}

#[test]
fn wal_byte_limit_rejects_before_io_and_checkpoint_allows_pending_retry() {
    let (data, log, mut engine) = fresh(128, true);
    let mut completed = 0;
    loop {
        let before_length = log.bytes().len();
        let before_generation = engine.snapshot().unwrap().generation;
        match engine.batch(writes(0, 64)) {
            Ok(()) => completed += 1,
            Err(error) => {
                assert_eq!(error.code, "checkpoint_required");
                assert_eq!(log.bytes().len(), before_length);
                assert_eq!(engine.snapshot().unwrap().generation, before_generation);
                assert!(before_length as u64 <= MAX_WAL_BYTES);
                assert!(completed < MAX_FRAMES);
                assert_eq!(engine.snapshot().unwrap().staged.len(), 64);
                break;
            }
        }
        assert!(completed < MAX_FRAMES);
    }
    assert!(completed > 1);
    engine.checkpoint().unwrap();
    engine.commit().unwrap();
    drop(engine);
    let mut reopened = Engine::open(data, log, true).unwrap();
    assert_records(&mut reopened, 128);
}

#[test]
fn format_three_file_ownership_identity_and_missing_wal_fail_closed() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("owned.db");
    let mut engine = walnut_core::create_file(&path, true).unwrap();
    assert_eq!(
        open_file(&path, true).err().unwrap().code,
        "database_locked"
    );
    engine.batch(writes(0, 5)).unwrap();
    drop(engine);
    let original = std::fs::read(wal_path(&path)).unwrap();
    std::fs::remove_file(wal_path(&path)).unwrap();
    assert_eq!(open_file(&path, true).err().unwrap().code, "missing_wal");
    let other = temp.path().join("other.db");
    drop(walnut_core::create_file(&other, false).unwrap());
    std::fs::copy(wal_path(&other), wal_path(&path)).unwrap();
    assert_eq!(
        open_file(&path, true).err().unwrap().code,
        "identity_mismatch"
    );
    std::fs::write(wal_path(&path), original).unwrap();
    assert_records(&mut open_file(&path, true).unwrap(), 5);
}

#[test]
fn explicit_legacy_upgrade_preserves_both_source_files_even_with_an_incomplete_tail() {
    let temp = tempfile::tempdir().unwrap();
    let old = temp.path().join("old.db");
    let target = temp.path().join("new.db");
    {
        let mut e = legacy::create_file(&old, true).unwrap();
        e.put("legacy", "kept").unwrap();
    }
    let original = std::fs::read(&old).unwrap();
    let mut log = std::fs::read(wal_path(&old)).unwrap();
    log.extend_from_slice(&[42; 31]);
    std::fs::write(wal_path(&old), &log).unwrap();
    assert_eq!(
        open_file(&old, true).err().unwrap().code,
        "migration_required"
    );
    let mut upgraded = upgrade_file(&old, &target, true).unwrap();
    assert_eq!(upgraded.get("legacy").unwrap().as_deref(), Some("kept"));
    upgraded.batch(writes(0, 5)).unwrap();
    upgraded.checkpoint().unwrap();
    drop(upgraded);
    assert_eq!(std::fs::read(&old).unwrap(), original);
    assert_eq!(std::fs::read(wal_path(&old)).unwrap(), log);
    assert!(upgrade_file(&old, &target, true).is_err());
    let mut reopened = open_file(&target, true).unwrap();
    assert_eq!(reopened.snapshot().unwrap().tree_height, 2);
    assert_eq!(reopened.get("legacy").unwrap().as_deref(), Some("kept"));
    let standalone = temp.path().join("page.db");
    let page = legacy::Page::empty()
        .with_put("v1", "copied")
        .unwrap()
        .encode()
        .unwrap();
    std::fs::write(&standalone, page).unwrap();
    assert_eq!(
        upgrade_file(&standalone, &temp.path().join("v3.db"), true)
            .unwrap()
            .get("v1")
            .unwrap()
            .as_deref(),
        Some("copied")
    );
}
