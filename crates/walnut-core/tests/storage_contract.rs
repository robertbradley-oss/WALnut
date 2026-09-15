use std::{cell::RefCell, io, rc::Rc};
use walnut_core::legacy::{Engine, PAGE_SIZE, Page, create_file, open_file};
use walnut_core::{FileStorage, Storage};

#[derive(Clone, Copy, Default)]
enum Fault {
    #[default]
    None,
    PartialWrite,
    Sync,
    Read,
    Mismatch,
}

#[derive(Default)]
struct Memory {
    bytes: Vec<u8>,
    fault: Fault,
}

#[derive(Clone, Default)]
struct TestStorage(Rc<RefCell<Memory>>);
impl Storage for TestStorage {
    fn size(&mut self) -> io::Result<u64> {
        Ok(self.0.borrow().bytes.len() as u64)
    }
    fn read_exact_at(&mut self, offset: u64, target: &mut [u8]) -> io::Result<()> {
        let memory = self.0.borrow();
        if matches!(memory.fault, Fault::Read) {
            return Err(io::Error::other("injected read failure"));
        }
        let at = offset as usize;
        if at + target.len() > memory.bytes.len() {
            return Err(io::ErrorKind::UnexpectedEof.into());
        }
        target.copy_from_slice(&memory.bytes[at..at + target.len()]);
        if matches!(memory.fault, Fault::Mismatch) {
            target[0] ^= 1;
        }
        Ok(())
    }
    fn write_all_at(&mut self, offset: u64, bytes: &[u8]) -> io::Result<()> {
        let mut memory = self.0.borrow_mut();
        let at = offset as usize;
        let length = memory.bytes.len().max(at + bytes.len());
        memory.bytes.resize(length, 0);
        if matches!(memory.fault, Fault::PartialWrite) {
            memory.bytes[at..at + 32].copy_from_slice(&bytes[..32]);
            return Err(io::Error::other("injected partial write"));
        }
        memory.bytes[at..at + bytes.len()].copy_from_slice(bytes);
        Ok(())
    }
    fn sync(&mut self) -> io::Result<()> {
        if matches!(self.0.borrow().fault, Fault::Sync) {
            return Err(io::Error::other("injected sync failure"));
        }
        Ok(())
    }
    fn truncate(&mut self, length: u64) -> io::Result<()> {
        self.0.borrow_mut().bytes.resize(length as usize, 0);
        Ok(())
    }
}

fn rewrite_crc(bytes: &mut [u8]) {
    bytes[28..32].fill(0);
    let crc = crc32fast::hash(bytes);
    bytes[28..32].copy_from_slice(&crc.to_le_bytes());
}

#[test]
fn format_round_trip_preserves_byte_order_unicode_and_empty_values() {
    let mut page = Page::empty();
    for (key, value) in [
        ("z", ""),
        ("é", "🌰"),
        ("A", "zero\0byte"),
        ("a", "line\nbreak"),
    ] {
        page = page.with_put(key, value).unwrap();
    }
    let bytes = page.encode().unwrap();
    assert_eq!(Page::decode(&bytes).unwrap(), page);
    assert_eq!(
        page.entries.keys().map(String::as_str).collect::<Vec<_>>(),
        ["A", "a", "z", "é"]
    );
    for record in page.records() {
        assert_eq!(
            &bytes[record.key_offset..record.value_offset],
            record.key.as_bytes()
        );
        assert_eq!(
            &bytes[record.value_offset..record.offset + record.length],
            record.value.as_bytes()
        );
    }
}

#[test]
fn header_and_first_record_have_documented_layout() {
    let page = Page::empty().with_put("a", "b").unwrap();
    let bytes = page.encode().unwrap();
    assert_eq!(&bytes[..8], b"WALNUT\0\0");
    assert_eq!(&bytes[8..16], &[1, 0, 32, 0, 0, 0, 0, 0]);
    assert_eq!(&bytes[16..24], &1u64.to_le_bytes());
    assert_eq!(&bytes[24..28], &[1, 0, 38, 0]);
    assert_eq!(&bytes[32..38], &[1, 0, 1, 0, b'a', b'b']);
    assert!(bytes[38..].iter().all(|b| *b == 0));
}

#[test]
fn rejects_truncation_extra_data_and_corruption_without_panics() {
    let bytes = Page::empty()
        .with_put("hello", "world")
        .unwrap()
        .encode()
        .unwrap();
    for size in 0..PAGE_SIZE {
        assert!(Page::decode(&bytes[..size]).is_err());
    }
    assert!(Page::decode(&[0; PAGE_SIZE + 1]).is_err());
    for index in 0..PAGE_SIZE {
        let mut altered = bytes;
        altered[index] ^= 1;
        assert!(
            Page::decode(&altered).is_err(),
            "accepted changed byte {index}"
        );
    }
}

#[test]
fn structural_validation_rejects_invalid_but_checksummed_pages() {
    let bytes = Page::empty()
        .with_put("a", "v")
        .unwrap()
        .with_put("b", "w")
        .unwrap()
        .encode()
        .unwrap();
    for (offset, value) in [
        (10, 31),
        (12, 1),
        (24, 3),
        (26, 31),
        (32, 0),
        (34, 255),
        (36, 255),
        (42, b'a'),
        (100, 1),
    ] {
        let mut altered = bytes;
        altered[offset] = value;
        rewrite_crc(&mut altered);
        assert!(
            Page::decode(&altered).is_err(),
            "accepted invalid field at {offset}"
        );
    }
}

#[test]
fn bounds_are_utf8_bytes_and_rejection_leaves_generation_unchanged() {
    let storage = TestStorage::default();
    let mut engine =
        Engine::create(TestStorage::default(), storage.clone(), [1; 16], true).unwrap();
    engine.put(&"é".repeat(32), &"🌰".repeat(256)).unwrap();
    let before = storage.0.borrow().bytes.clone();
    for (key, value, code) in [
        ("".to_string(), "x".to_string(), "invalid_key"),
        ("é".repeat(33), "x".into(), "invalid_key"),
        ("key".into(), "🌰".repeat(257), "invalid_value"),
    ] {
        assert_eq!(engine.put(&key, &value).unwrap_err().code, code);
        assert_eq!(storage.0.borrow().bytes, before);
        assert_eq!(engine.snapshot().unwrap().generation, 1);
    }
}

#[test]
fn full_page_rejection_preserves_previous_file_and_accepts_smaller_update() {
    let storage = TestStorage::default();
    let mut engine =
        Engine::create(TestStorage::default(), storage.clone(), [1; 16], true).unwrap();
    for key in ["a", "b", "c"] {
        engine.put(key, &"x".repeat(1024)).unwrap();
    }
    let before = storage.0.borrow().bytes.clone();
    assert_eq!(
        engine.put("d", &"y".repeat(1024)).unwrap_err().code,
        "page_full"
    );
    assert_eq!(storage.0.borrow().bytes, before);
    engine.put("b", "short").unwrap();
    assert_eq!(engine.snapshot().unwrap().records.len(), 3);
    assert_eq!(engine.get("b").unwrap().as_deref(), Some("short"));
}

#[test]
fn storage_failure_never_acknowledges_or_serves_stale_cache() {
    for fault in [
        Fault::PartialWrite,
        Fault::Sync,
        Fault::Read,
        Fault::Mismatch,
    ] {
        let storage = TestStorage::default();
        let mut engine =
            Engine::create(TestStorage::default(), storage.clone(), [1; 16], true).unwrap();
        engine.put("key", "old").unwrap();
        storage.0.borrow_mut().fault = fault;
        assert!(engine.put("key", "new").is_err());
        assert_eq!(engine.get("key").unwrap_err().code, "needs_reopen");
        assert_eq!(engine.put("x", "y").unwrap_err().code, "needs_reopen");
        assert_eq!(engine.snapshot().err().unwrap().code, "needs_reopen");
    }
}

#[test]
fn real_file_reopen_retrieves_updates_and_clears_session_counters() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("walnut.db");
    let session;
    {
        let mut engine = create_file(&path, true).unwrap();
        engine.put("greeting", "hello").unwrap();
        engine.put("greeting", "🌰 again").unwrap();
        engine.checkpoint().unwrap();
        session = engine.snapshot().unwrap().session_id;
    }
    assert_eq!(
        std::fs::metadata(&path).unwrap().len(),
        (64 + PAGE_SIZE) as u64
    );
    let mut reopened = open_file(&path, true).unwrap();
    assert_eq!(
        reopened.get("greeting").unwrap().as_deref(),
        Some("🌰 again")
    );
    assert_eq!(reopened.snapshot().unwrap().generation, 2);
    assert_eq!(reopened.snapshot().unwrap().successful_writes, 0);
    assert_ne!(reopened.snapshot().unwrap().session_id, session);
    let verified_bytes = reopened.snapshot().unwrap().bytes;
    drop(reopened);
    assert_eq!(verified_bytes, std::fs::read(&path).unwrap()[64..]);
}

#[test]
fn a_second_owner_is_rejected_and_create_never_overwrites() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("owned.db");
    let engine = create_file(&path, true).unwrap();
    assert_eq!(
        FileStorage::open(&path).err().unwrap().code,
        "database_locked"
    );
    assert!(FileStorage::create(&path).is_err());
    drop(engine);
    assert!(FileStorage::open(&path).is_ok());
}

#[test]
fn event_order_is_truthful_bounded_and_optional() {
    let mut engine = Engine::create(
        TestStorage::default(),
        TestStorage::default(),
        [1; 16],
        true,
    )
    .unwrap();
    engine.put("a", "b").unwrap();
    let events = engine.snapshot().unwrap().events;
    assert_eq!(
        events
            .iter()
            .rev()
            .take(4)
            .map(|e| e.kind)
            .collect::<Vec<_>>(),
        [
            "transaction_committed",
            "wal_synced",
            "commit_marker_written",
            "wal_frame_written"
        ]
    );
    for _ in 0..150 {
        assert!(engine.get("missing").unwrap().is_none());
    }
    let snapshot = engine.snapshot().unwrap();
    assert_eq!(snapshot.events.len(), 128);
    assert_eq!(snapshot.generation, 1);
    assert!(
        snapshot
            .events
            .windows(2)
            .all(|pair| pair[0].sequence + 1 == pair[1].sequence)
    );
    let mut silent = Engine::create(
        TestStorage::default(),
        TestStorage::default(),
        [1; 16],
        false,
    )
    .unwrap();
    silent.put("a", "b").unwrap();
    assert!(silent.snapshot().unwrap().events.is_empty());
}

#[test]
fn generated_updates_agree_with_an_independent_linear_reference() {
    let mut engine = Engine::create(
        TestStorage::default(),
        TestStorage::default(),
        [1; 16],
        false,
    )
    .unwrap();
    let mut reference: Vec<(String, String)> = vec![];
    let mut seed = 71u64;
    for _ in 0..600 {
        seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1);
        let key = format!("key{:02}", (seed >> 32) % 40);
        let value = format!("{:x}", seed);
        engine.put(&key, &value).unwrap();
        if let Some(entry) = reference.iter_mut().find(|e| e.0 == key) {
            entry.1 = value;
        } else {
            reference.push((key, value));
        }
        for (k, v) in &reference {
            assert_eq!(engine.get(k).unwrap().as_ref(), Some(v));
        }
        reference.sort_by(|a, b| a.0.as_bytes().cmp(b.0.as_bytes()));
        let records = engine.snapshot().unwrap().records;
        assert_eq!(
            records
                .iter()
                .map(|r| (&r.key, &r.value))
                .collect::<Vec<_>>(),
            reference.iter().map(|(k, v)| (k, v)).collect::<Vec<_>>()
        );
    }
}
