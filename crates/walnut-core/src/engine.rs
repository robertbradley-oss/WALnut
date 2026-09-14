use crate::{
    Error, HEADER_SIZE, KEY_LIMIT, PAGE_SIZE, Page, Record, Result, Storage, VALUE_LIMIT,
    page::validate_key,
};
use serde::Serialize;
use std::{
    collections::VecDeque,
    time::{SystemTime, UNIX_EPOCH},
};

#[derive(Clone, Debug, Serialize)]
pub struct Event {
    pub schema_version: u8,
    pub session_id: String,
    pub sequence: u64,
    pub operation: u64,
    pub kind: &'static str,
    pub generation: u64,
    pub key: Option<String>,
    pub detail: String,
}

#[derive(Serialize)]
pub struct Snapshot {
    pub schema_version: u8,
    pub session_id: String,
    pub format_version: u8,
    pub page_id: u32,
    pub generation: u64,
    pub page_size: usize,
    pub header_size: usize,
    pub used_bytes: usize,
    pub key_limit: usize,
    pub value_limit: usize,
    pub checksum: String,
    pub records: Vec<Record>,
    pub bytes: Vec<u8>,
    pub events: Vec<Event>,
    pub successful_writes: u64,
    pub reads: u64,
    pub tracing: bool,
}

pub struct Engine<S: Storage> {
    storage: S,
    page: Page,
    bytes: [u8; PAGE_SIZE],
    poisoned: bool,
    tracing: bool,
    session_id: String,
    events: VecDeque<Event>,
    sequence: u64,
    operation: u64,
    writes: u64,
    reads: u64,
}

impl<S: Storage> Engine<S> {
    pub fn create(mut storage: S, tracing: bool) -> Result<Self> {
        if storage.size()? != 0 {
            return Err(Error::new(
                "already_exists",
                "Creation requires an empty, new storage object.",
            ));
        }
        let bytes = Page::empty().encode()?;
        storage.write_all_at(0, &bytes)?;
        storage.sync()?;
        let mut engine = Self::open(storage, tracing)?;
        engine.emit(
            "created",
            None,
            "Created one 4,096-byte page. Header and checksum verified.",
        );
        Ok(engine)
    }

    pub fn open(mut storage: S, tracing: bool) -> Result<Self> {
        if storage.size()? != PAGE_SIZE as u64 {
            return Err(Error::new(
                "corrupt_page",
                "Stage 1 expects a database containing exactly one 4,096-byte page.",
            ));
        }
        let mut bytes = [0; PAGE_SIZE];
        storage.read_exact_at(0, &mut bytes)?;
        let page = Page::decode(&bytes)?;
        let session_id = format!(
            "{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        );
        let mut engine = Self {
            storage,
            page,
            bytes,
            poisoned: false,
            tracing,
            session_id,
            events: VecDeque::new(),
            sequence: 0,
            operation: 0,
            writes: 0,
            reads: 0,
        };
        engine.emit(
            "opened",
            None,
            "Read page 0 from the file and verified its format and checksum.",
        );
        Ok(engine)
    }

    fn ready(&self) -> Result<()> {
        if self.poisoned {
            return Err(Error::new(
                "needs_reopen",
                "A storage operation failed. Close and reopen this database before continuing; stage 1 cannot recover interrupted writes.",
            ));
        }
        Ok(())
    }

    fn emit(&mut self, kind: &'static str, key: Option<&str>, detail: &str) {
        if !self.tracing {
            return;
        }
        self.sequence += 1;
        if self.events.len() == 128 {
            self.events.pop_front();
        }
        self.events.push_back(Event {
            schema_version: 1,
            session_id: self.session_id.clone(),
            sequence: self.sequence,
            operation: self.operation,
            kind,
            generation: self.page.generation,
            key: key.map(str::to_owned),
            detail: detail.into(),
        });
    }

    pub fn get(&mut self, key: &str) -> Result<Option<String>> {
        self.ready()?;
        validate_key(key)?;
        self.operation += 1;
        self.reads += 1;
        let value = self.page.entries.get(key).cloned();
        self.emit(
            if value.is_some() {
                "read_found"
            } else {
                "read_missing"
            },
            Some(key),
            if value.is_some() {
                "Found this key in the verified page cache."
            } else {
                "This key is not stored in page 0."
            },
        );
        Ok(value)
    }

    pub fn put(&mut self, key: &str, value: &str) -> Result<()> {
        self.ready()?;
        let next = self.page.with_put(key, value)?;
        let bytes = next.encode()?;
        self.operation += 1;
        self.emit(
            "write_started",
            Some(key),
            "Encoded the next page image in memory.",
        );
        self.poisoned = true;
        if let Err(error) = self.persist(&bytes, key) {
            self.emit("write_failed", Some(key), &error.message);
            return Err(error);
        }
        self.page = next;
        self.bytes = bytes;
        self.poisoned = false;
        self.writes += 1;
        self.emit(
            "page_verified",
            Some(key),
            "Read the page back from the file; bytes and checksum match the write.",
        );
        Ok(())
    }

    fn persist(&mut self, bytes: &[u8; PAGE_SIZE], key: &str) -> Result<()> {
        self.storage.write_all_at(0, bytes)?;
        self.emit(
            "page_written",
            Some(key),
            "The full page write returned successfully.",
        );
        self.storage.sync()?;
        self.emit(
            "file_synced",
            Some(key),
            "The operating system reported successful file synchronization.",
        );
        let mut actual = [0; PAGE_SIZE];
        self.storage.read_exact_at(0, &mut actual)?;
        Page::decode(&actual)?;
        if &actual != bytes {
            return Err(Error::new(
                "verification_failed",
                "File bytes differ from the requested page image.",
            ));
        }
        Ok(())
    }

    pub fn snapshot(&self) -> Result<Snapshot> {
        self.ready()?;
        Ok(Snapshot {
            schema_version: 1,
            session_id: self.session_id.clone(),
            format_version: 1,
            page_id: 0,
            generation: self.page.generation,
            page_size: PAGE_SIZE,
            header_size: HEADER_SIZE,
            used_bytes: self.page.used_bytes(),
            key_limit: KEY_LIMIT,
            value_limit: VALUE_LIMIT,
            checksum: format!(
                "{:08x}",
                u32::from_le_bytes(self.bytes[28..32].try_into().unwrap())
            ),
            records: self.page.records(),
            bytes: self.bytes.to_vec(),
            events: self.events.iter().cloned().collect(),
            successful_writes: self.writes,
            reads: self.reads,
            tracing: self.tracing,
        })
    }
}
