use std::{
    cell::RefCell,
    io,
    panic::{AssertUnwindSafe, catch_unwind},
    rc::Rc,
};
use walnut_core::Storage;
use walnut_core::legacy::{
    Engine, Page, WriteOp, create_file, open_file, upgrade_file,
    wal::{self, BODY_SIZE, FILE_HEADER, FRAME_SIZE, MAX_FRAMES},
    wal_path,
};

#[derive(Clone, Copy, Default)]
enum Fault {
    #[default]
    None,
    Write(usize),
    Sync,
    Read,
    Mismatch,
    Truncate(usize),
}
#[derive(Default, Clone)]
struct Memory {
    live: Vec<u8>,
    stable: Vec<u8>,
    fault: Fault,
    writes: usize,
}
#[derive(Default, Clone)]
struct Disk(Rc<RefCell<Memory>>);
impl Disk {
    fn power_loss(&self) {
        let mut m = self.0.borrow_mut();
        m.live = m.stable.clone();
        m.fault = Fault::None;
    }
    fn fail(&self, fault: Fault) {
        self.0.borrow_mut().fault = fault;
    }
    fn bytes(&self) -> Vec<u8> {
        self.0.borrow().live.clone()
    }
    fn replace(&self, bytes: Vec<u8>) {
        self.0.borrow_mut().live = bytes;
    }
}
impl Storage for Disk {
    fn size(&mut self) -> io::Result<u64> {
        Ok(self.0.borrow().live.len() as u64)
    }
    fn read_exact_at(&mut self, at: u64, bytes: &mut [u8]) -> io::Result<()> {
        let m = self.0.borrow();
        if matches!(m.fault, Fault::Read) {
            return Err(io::Error::other("injected read failure"));
        }
        let at = at as usize;
        let source = m
            .live
            .get(at..at + bytes.len())
            .ok_or(io::ErrorKind::UnexpectedEof)?;
        bytes.copy_from_slice(source);
        if matches!(m.fault, Fault::Mismatch) {
            bytes[0] ^= 1;
        }
        Ok(())
    }
    fn write_all_at(&mut self, at: u64, bytes: &[u8]) -> io::Result<()> {
        let mut m = self.0.borrow_mut();
        let count = if let Fault::Write(count) = m.fault {
            count.min(bytes.len())
        } else {
            bytes.len()
        };
        let end = at as usize + count;
        let length = m.live.len().max(end);
        m.live.resize(length, 0);
        m.live[at as usize..end].copy_from_slice(&bytes[..count]);
        m.writes += 1;
        if matches!(m.fault, Fault::Write(_)) {
            return Err(io::Error::other("injected partial write"));
        }
        Ok(())
    }
    fn sync(&mut self) -> io::Result<()> {
        let mut m = self.0.borrow_mut();
        if matches!(m.fault, Fault::Sync) {
            return Err(io::Error::other("injected sync failure"));
        }
        m.stable = m.live.clone();
        Ok(())
    }
    fn truncate(&mut self, length: u64) -> io::Result<()> {
        let mut m = self.0.borrow_mut();
        if let Fault::Truncate(retained) = m.fault {
            m.live.truncate(retained);
            return Err(io::Error::other("injected interrupted truncate"));
        }
        m.live.resize(length as usize, 0);
        Ok(())
    }
}
type TestEngine = Engine<Disk, Disk>;
fn fresh() -> (Disk, Disk, TestEngine) {
    let data = Disk::default();
    let log = Disk::default();
    let engine = Engine::create(data.clone(), log.clone(), [7; 16], true).unwrap();
    (data, log, engine)
}
fn writes() -> Vec<WriteOp> {
    vec![
        WriteOp {
            key: "alpha".into(),
            value: "one".into(),
        },
        WriteOp {
            key: "beta".into(),
            value: "two".into(),
        },
    ]
}
fn recovered(data: &Disk, log: &Disk, batch: bool) -> TestEngine {
    let mut engine = Engine::open(data.clone(), log.clone(), true).unwrap();
    assert_eq!(engine.get("seed").unwrap().as_deref(), Some("kept"));
    assert_eq!(
        engine.get("alpha").unwrap().as_deref(),
        batch.then_some("one")
    );
    assert_eq!(
        engine.get("beta").unwrap().as_deref(),
        batch.then_some("two")
    );
    engine
}

#[test]
fn staging_is_invisible_atomic_and_has_no_io_until_commit() {
    let (data, log, mut engine) = fresh();
    engine.put("seed", "kept").unwrap();
    let before = (data.bytes(), log.bytes());
    engine.stage("alpha", "old").unwrap();
    engine.stage("alpha", "one").unwrap();
    engine.stage("beta", "two").unwrap();
    assert!(engine.get("alpha").unwrap().is_none());
    assert_eq!(engine.snapshot().unwrap().generation, 1);
    assert_eq!((data.bytes(), log.bytes()), before);
    assert_eq!(
        engine.put("other", "value").unwrap_err().code,
        "batch_pending"
    );
    assert_eq!(engine.stage("", "bad").unwrap_err().code, "invalid_key");
    assert_eq!(engine.snapshot().unwrap().staged.len(), 3);
    engine.commit().unwrap();
    let snap = engine.snapshot().unwrap();
    assert_eq!(snap.generation, 2);
    assert_eq!(snap.wal_frames.last().unwrap().operations, 3);
    assert!(snap.staged.is_empty());
    assert_eq!(data.bytes(), before.0);
    drop(engine);
    recovered(&data, &log, true);
}

#[test]
fn validates_whole_batch_before_io_and_checks_final_size() {
    let (data, log, mut engine) = fresh();
    assert_eq!(engine.batch(vec![]).unwrap_err().code, "invalid_batch");
    assert_eq!(
        engine
            .batch(vec![
                WriteOp {
                    key: "x".into(),
                    value: "v".into()
                };
                65
            ])
            .unwrap_err()
            .code,
        "invalid_batch"
    );
    let before = (data.bytes(), log.bytes());
    assert_eq!(
        engine
            .batch(vec![
                WriteOp {
                    key: "good".into(),
                    value: "yes".into()
                },
                WriteOp {
                    key: "".into(),
                    value: "bad".into()
                }
            ])
            .unwrap_err()
            .code,
        "invalid_key"
    );
    assert_eq!((data.bytes(), log.bytes()), before);
    assert!(engine.snapshot().unwrap().staged.is_empty());
    for key in ["a", "b", "c"] {
        engine.put(key, &"x".repeat(1024)).unwrap();
    }
    // The first put alone would overflow; the final atomic result fits.
    engine
        .batch(vec![
            WriteOp {
                key: "d".into(),
                value: "x".repeat(1024),
            },
            WriteOp {
                key: "a".into(),
                value: "short".into(),
            },
        ])
        .unwrap();
    assert_eq!(engine.snapshot().unwrap().generation, 4);
    let mut full = Page::empty();
    full.generation = u64::MAX;
    assert_eq!(
        full.with_put("a", "b").unwrap_err().code,
        "generation_limit"
    );
}

#[test]
fn discard_and_reopen_drop_pending_without_touching_committed_data() {
    let (data, log, mut engine) = fresh();
    engine.put("seed", "kept").unwrap();
    let before = log.bytes();
    engine.stage("alpha", "one").unwrap();
    engine.discard().unwrap();
    assert!(engine.snapshot().unwrap().staged.is_empty());
    assert_eq!(before, log.bytes());
    engine.stage("beta", "two").unwrap();
    drop(engine);
    assert!(
        recovered(&data, &log, false)
            .snapshot()
            .unwrap()
            .staged
            .is_empty()
    );
}

#[test]
fn process_and_modeled_power_loss_at_every_commit_and_checkpoint_boundary() {
    let boundaries = [
        "before_frame",
        "after_frame",
        "after_commit_marker",
        "after_wal_sync",
        "after_commit_return",
        "before_checkpoint_write",
        "after_checkpoint_write",
        "after_checkpoint_sync",
        "after_wal_truncate",
        "after_reset_sync",
    ];
    for power_loss in [false, true] {
        for (index, boundary) in boundaries.into_iter().enumerate() {
            let (data, log, mut engine) = fresh();
            engine.put("seed", "kept").unwrap();
            engine.checkpoint().unwrap();
            // A second acknowledged generation in the WAL must survive every cut.
            engine.put("anchor", "acknowledged").unwrap();
            engine.set_boundary_hook(move |point| {
                if point == boundary {
                    panic!("power cut at {point}");
                }
            });
            let interrupted = catch_unwind(AssertUnwindSafe(|| {
                engine.batch(writes()).unwrap();
                if boundary == "after_commit_return" {
                    panic!("after commit returned");
                }
                engine.checkpoint().unwrap();
            }));
            assert!(interrupted.is_err(), "missed {boundary}");
            drop(engine);
            if power_loss {
                data.power_loss();
                log.power_loss();
            }
            let present = index >= if power_loss { 3 } else { 2 };
            let mut reopened = recovered(&data, &log, present);
            assert_eq!(
                reopened.get("anchor").unwrap().as_deref(),
                Some("acknowledged")
            );
            let generation = reopened.snapshot().unwrap().generation;
            drop(reopened);
            let mut again = recovered(&data, &log, present);
            assert_eq!(again.snapshot().unwrap().generation, generation);
            again.checkpoint().unwrap();
            again.put("continued", "yes").unwrap();
            drop(again);
            data.power_loss();
            log.power_loss();
            assert_eq!(
                recovered(&data, &log, present)
                    .get("continued")
                    .unwrap()
                    .as_deref(),
                Some("yes")
            );
        }
    }
}

#[test]
fn every_incomplete_transaction_tail_is_discarded_after_valid_prefix() {
    let (data, log, mut engine) = fresh();
    engine.put("seed", "kept").unwrap();
    let prefix = log.bytes();
    let next = Page::decode(&engine.snapshot().unwrap().bytes)
        .unwrap()
        .with_batch([("alpha", "one"), ("beta", "two")])
        .unwrap();
    let frame = wal::encode(&next, 1, 2).unwrap();
    drop(engine);
    for cut in 0..FRAME_SIZE {
        let mut bytes = prefix.clone();
        bytes.extend_from_slice(&frame[..cut]);
        log.replace(bytes);
        let reopened = recovered(&data, &log, false);
        assert_eq!(
            reopened.snapshot().unwrap().recovery.discarded_tail_bytes,
            cut as u64
        );
        assert_eq!(log.bytes(), prefix);
    }
}

#[test]
fn complete_committed_corruption_is_never_treated_as_an_uncommitted_tail() {
    let (data, log, mut engine) = fresh();
    engine.put("seed", "kept").unwrap();
    let original = log.bytes();
    drop(engine);
    for byte in FILE_HEADER..original.len() {
        let mut changed = original.clone();
        changed[byte] ^= 1;
        log.replace(changed.clone());
        assert_eq!(
            Engine::open(data.clone(), log.clone(), false)
                .err()
                .unwrap()
                .code,
            "corrupt_wal",
            "byte {byte}"
        );
        assert_eq!(log.bytes(), changed);
    }
}

#[test]
fn partial_body_or_marker_writes_never_expose_half_a_batch() {
    for marker in [false, true] {
        let size = if marker { 32 } else { BODY_SIZE };
        for cut in [0, 1, size / 2, size - 1, size] {
            let (data, log, mut engine) = fresh();
            engine.put("seed", "kept").unwrap();
            let fault_disk = log.clone();
            engine.set_boundary_hook(move |point| {
                if point
                    == if marker {
                        "after_frame"
                    } else {
                        "before_frame"
                    }
                {
                    fault_disk.fail(Fault::Write(cut));
                }
            });
            assert!(engine.batch(writes()).is_err());
            assert_eq!(engine.get("seed").unwrap_err().code, "needs_reopen");
            assert!(engine.snapshot().is_err());
            drop(engine);
            log.fail(Fault::None);
            recovered(&data, &log, marker && cut == size);
        }
    }
}

#[test]
fn sync_and_readback_failures_poison_until_recovery_without_false_acknowledgement() {
    for fault in [Fault::Sync, Fault::Read, Fault::Mismatch] {
        let (data, log, mut engine) = fresh();
        engine.put("seed", "kept").unwrap();
        log.fail(fault);
        assert!(engine.batch(writes()).is_err());
        assert_eq!(engine.snapshot().err().unwrap().code, "needs_reopen");
        drop(engine);
        data.power_loss();
        log.power_loss();
        recovered(&data, &log, !matches!(fault, Fault::Sync));
    }
}

#[test]
fn torn_checkpoint_failed_sync_and_readback_keep_the_complete_wal() {
    for fault in [
        Fault::Write(0),
        Fault::Write(31),
        Fault::Write(2048),
        Fault::Write(4096),
        Fault::Sync,
        Fault::Read,
        Fault::Mismatch,
    ] {
        for power_loss in [false, true] {
            let (data, log, mut engine) = fresh();
            engine.put("seed", "kept").unwrap();
            engine.batch(writes()).unwrap();
            let before_log = log.bytes();
            data.fail(fault);
            assert!(engine.checkpoint().is_err());
            assert_eq!(log.bytes(), before_log);
            assert_eq!(engine.get("seed").unwrap_err().code, "needs_reopen");
            drop(engine);
            data.fail(Fault::None);
            if power_loss {
                data.power_loss();
                log.power_loss();
            }
            let mut recovered = recovered(&data, &log, true);
            recovered.checkpoint().unwrap();
            assert_eq!(log.bytes().len(), FILE_HEADER);
        }
    }
}

#[test]
fn interrupted_reset_with_an_old_prefix_can_recover_and_append_without_a_gap() {
    for retained in [
        FILE_HEADER,
        FILE_HEADER + 17,
        FILE_HEADER + FRAME_SIZE,
        FILE_HEADER + FRAME_SIZE + 200,
        FILE_HEADER + 2 * FRAME_SIZE,
    ] {
        let (data, log, mut engine) = fresh();
        engine.put("seed", "kept").unwrap();
        engine.batch(writes()).unwrap();
        log.fail(Fault::Truncate(retained));
        assert!(engine.checkpoint().is_err());
        drop(engine);
        log.fail(Fault::None);
        let mut reopened = recovered(&data, &log, true);
        reopened.put("new", "after reset").unwrap();
        drop(reopened);
        data.power_loss();
        log.power_loss();
        assert_eq!(
            recovered(&data, &log, true).get("new").unwrap().as_deref(),
            Some("after reset")
        );
    }
}

#[test]
fn failure_syncing_the_reset_length_blocks_appends_until_reopen() {
    let (data, log, mut engine) = fresh();
    engine.put("seed", "kept").unwrap();
    engine.batch(writes()).unwrap();
    let hook_log = log.clone();
    engine.set_boundary_hook(move |point| {
        if point == "after_wal_truncate" {
            hook_log.fail(Fault::Sync);
        }
    });
    assert!(engine.checkpoint().is_err());
    assert_eq!(engine.put("new", "bad").unwrap_err().code, "needs_reopen");
    drop(engine);
    data.power_loss();
    log.power_loss();
    let mut reopened = recovered(&data, &log, true);
    reopened.put("new", "good").unwrap();
    drop(reopened);
    assert_eq!(
        recovered(&data, &log, true).get("new").unwrap().as_deref(),
        Some("good")
    );
}

#[test]
fn wal_capacity_requires_checkpoint_and_preserves_pending_batch() {
    let (data, log, mut engine) = fresh();
    for _ in 0..MAX_FRAMES {
        engine.put("seed", "kept").unwrap();
    }
    engine.stage("alpha", "one").unwrap();
    engine.stage("beta", "two").unwrap();
    let before = log.bytes();
    assert_eq!(engine.commit().unwrap_err().code, "checkpoint_required");
    assert_eq!(before, log.bytes());
    assert_eq!(engine.snapshot().unwrap().wal_frames.len(), 32);
    engine.checkpoint().unwrap();
    assert_eq!(engine.snapshot().unwrap().staged.len(), 2);
    engine.commit().unwrap();
    drop(engine);
    recovered(&data, &log, true);
}

#[test]
fn gaps_identity_mismatch_missing_wal_and_invalid_base_fail_closed() {
    let (data, log, mut engine) = fresh();
    engine.put("seed", "kept").unwrap();
    drop(engine);
    let bytes = log.bytes();
    let newer = Page::empty()
        .with_put("x", "1")
        .unwrap()
        .with_put("y", "2")
        .unwrap();
    let mut gap = bytes[..FILE_HEADER].to_vec();
    gap.extend_from_slice(&wal::encode(&newer, 1, 1).unwrap());
    log.replace(gap);
    assert_eq!(
        Engine::open(data.clone(), log.clone(), true)
            .err()
            .unwrap()
            .code,
        "wal_gap"
    );
    log.replace(bytes.clone());
    let mut wrong = bytes.clone();
    wrong[..FILE_HEADER].copy_from_slice(&wal::header(wal::WAL_MAGIC, &[99; 16]));
    log.replace(wrong);
    assert_eq!(
        Engine::open(data.clone(), log.clone(), true)
            .err()
            .unwrap()
            .code,
        "identity_mismatch"
    );
    log.replace(bytes[..FILE_HEADER].to_vec());
    let mut bad = data.bytes();
    bad[FILE_HEADER + 200] ^= 1;
    data.replace(bad);
    assert_eq!(
        Engine::open(data.clone(), log.clone(), true)
            .err()
            .unwrap()
            .code,
        "unrecoverable_page"
    );
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("missing.db");
    drop(create_file(&path, true).unwrap());
    std::fs::remove_file(wal_path(&path)).unwrap();
    assert_eq!(open_file(&path, true).err().unwrap().code, "missing_wal");
    assert!(!wal_path(&path).exists());
}

#[test]
fn upgrade_preserves_legacy_source_and_requires_a_new_target() {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("old.db");
    let target = temp.path().join("new.db");
    let bytes = Page::empty()
        .with_put("old", "kept")
        .unwrap()
        .encode()
        .unwrap();
    std::fs::write(&source, bytes).unwrap();
    assert_eq!(
        open_file(&source, true).err().unwrap().code,
        "migration_required"
    );
    let mut engine = upgrade_file(&source, &target, true).unwrap();
    assert_eq!(engine.get("old").unwrap().as_deref(), Some("kept"));
    assert_eq!(engine.snapshot().unwrap().generation, 1);
    engine.put("new", "added").unwrap();
    drop(engine);
    assert_eq!(std::fs::read(&source).unwrap(), bytes);
    assert!(upgrade_file(&source, &target, true).is_err());
    assert_eq!(
        open_file(&target, true)
            .unwrap()
            .get("new")
            .unwrap()
            .as_deref(),
        Some("added")
    );
}

#[test]
fn recovery_propagates_read_sync_and_truncate_errors_before_serving_state() {
    for fault in [
        Fault::Read,
        Fault::Sync,
        Fault::Truncate(FILE_HEADER + FRAME_SIZE),
    ] {
        let (data, log, mut engine) = fresh();
        engine.put("seed", "kept").unwrap();
        drop(engine);
        let mut tail = log.bytes();
        tail.extend_from_slice(&[42; 17]);
        log.replace(tail);
        log.fail(fault);
        assert_eq!(
            Engine::open(data.clone(), log.clone(), true)
                .err()
                .unwrap()
                .code,
            "io"
        );
        log.fail(Fault::None);
        recovered(&data, &log, false);
    }
    let (data, log, mut engine) = fresh();
    engine.put("seed", "kept").unwrap();
    drop(engine);
    data.fail(Fault::Read);
    assert_eq!(
        Engine::open(data.clone(), log.clone(), true)
            .err()
            .unwrap()
            .code,
        "io"
    );
    data.fail(Fault::None);
    recovered(&data, &log, false);
}

#[test]
fn every_file_header_byte_is_checked_and_discontinuous_logs_are_rejected() {
    let (data, log, mut engine) = fresh();
    engine.put("seed", "kept").unwrap();
    drop(engine);
    for disk in [&data, &log] {
        let original = disk.bytes();
        for index in 0..FILE_HEADER {
            let mut bad = original.clone();
            bad[index] ^= 1;
            disk.replace(bad);
            assert_eq!(
                Engine::open(data.clone(), log.clone(), true)
                    .err()
                    .unwrap()
                    .code,
                "invalid_file_header"
            );
        }
        disk.replace(original);
    }
    let original_log = log.bytes();
    let mut duplicate = original_log.clone();
    duplicate.extend_from_slice(&original_log[FILE_HEADER..]);
    log.replace(duplicate);
    assert_eq!(
        Engine::open(data.clone(), log.clone(), true)
            .err()
            .unwrap()
            .code,
        "corrupt_wal"
    );
    log.replace(original_log);
    // Both images validate individually, but different data at the same generation cannot be accepted.
    let mut inconsistent = data.bytes();
    inconsistent[FILE_HEADER..].copy_from_slice(
        &Page::empty()
            .with_put("different", "value")
            .unwrap()
            .encode()
            .unwrap(),
    );
    data.replace(inconsistent);
    assert_eq!(
        Engine::open(data.clone(), log.clone(), true)
            .err()
            .unwrap()
            .code,
        "page_mismatch"
    );
}
