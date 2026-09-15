use super::{
    HEADER_SIZE, KEY_LIMIT, PAGE_SIZE, Page, Record, VALUE_LIMIT,
    page::validate_key,
    wal::{self, BODY_SIZE, FILE_HEADER, FRAME_SIZE, MAX_FRAMES, WalFrame},
};
use crate::{Error, Result, Storage};
use serde::{Deserialize, Serialize};
use std::{
    collections::VecDeque,
    time::{SystemTime, UNIX_EPOCH},
};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WriteOp {
    pub key: String,
    pub value: String,
}

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

#[derive(Clone, Debug, Default, Serialize)]
pub struct Recovery {
    pub scanned_transactions: usize,
    pub replayed_transactions: usize,
    pub discarded_tail_bytes: u64,
    pub repaired_page: bool,
    pub obsolete_frames_removed: usize,
}

#[derive(Serialize)]
pub struct Snapshot {
    pub schema_version: u8,
    pub session_id: String,
    pub format_version: u8,
    pub storage_format_version: u8,
    pub database_id: String,
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
    pub staged: Vec<WriteOp>,
    pub staged_used_bytes: Option<usize>,
    pub checkpoint_generation: Option<u64>,
    pub checkpoint_bytes: Option<Vec<u8>>,
    pub wal_bytes: u64,
    pub wal_header_bytes: usize,
    pub wal_frames: Vec<WalFrame>,
    pub wal_frame_count: usize,
    pub wal_limit: usize,
    pub recovery: Recovery,
    pub events: Vec<Event>,
    pub successful_writes: u64,
    pub reads: u64,
    pub tracing: bool,
}

type BoundaryHook = Box<dyn FnMut(&'static str)>;

pub struct Engine<D: Storage, W: Storage> {
    data: D,
    wal: W,
    id: [u8; 16],
    page: Page,
    bytes: [u8; PAGE_SIZE],
    checkpoint: Option<Page>,
    checkpoint_bytes: Option<[u8; PAGE_SIZE]>,
    frames: Vec<WalFrame>,
    wal_end: u64,
    pending: Vec<WriteOp>,
    poisoned: bool,
    tracing: bool,
    session_id: String,
    events: VecDeque<Event>,
    sequence: u64,
    operation: u64,
    writes: u64,
    reads: u64,
    recovery: Recovery,
    hook: Option<BoundaryHook>,
}

impl<D: Storage, W: Storage> Engine<D, W> {
    pub fn create(data: D, wal: W, id: [u8; 16], tracing: bool) -> Result<Self> {
        Self::create_from_page(data, wal, id, Page::empty(), tracing)
    }

    pub(crate) fn create_from_page(
        mut data: D,
        mut wal: W,
        id: [u8; 16],
        page: Page,
        tracing: bool,
    ) -> Result<Self> {
        if data.size()? != 0 || wal.size()? != 0 {
            return Err(Error::new(
                "already_exists",
                "Creation requires two empty, new storage objects.",
            ));
        }
        let bytes = page.encode()?;
        data.write_all_at(0, &wal::header(wal::DB_MAGIC, &id))?;
        data.write_all_at(FILE_HEADER as u64, &bytes)?;
        data.sync()?;
        wal.write_all_at(0, &wal::header(wal::WAL_MAGIC, &id))?;
        wal.sync()?;
        let mut engine = Self::open(data, wal, tracing)?;
        engine.emit(
            "created",
            None,
            "Created and verified a database/WAL pair with matching identities.",
        );
        Ok(engine)
    }

    pub fn open(mut data: D, mut wal: W, tracing: bool) -> Result<Self> {
        if data.size()? != (FILE_HEADER + PAGE_SIZE) as u64 {
            return Err(Error::new(
                "invalid_file_size",
                "Storage format 2 requires a 64-byte header and one 4,096-byte page.",
            ));
        }
        let id = wal::read_header(&mut data, wal::DB_MAGIC)?;
        if wal::read_header(&mut wal, wal::WAL_MAGIC)? != id {
            return Err(Error::new(
                "identity_mismatch",
                "Database and WAL identities differ. Use the matching pair.",
            ));
        }
        let mut base_bytes = [0; PAGE_SIZE];
        data.read_exact_at(FILE_HEADER as u64, &mut base_bytes)?;
        let checkpoint = Page::decode(&base_bytes).ok();
        let mut scan = wal::scan(&mut wal)?;
        if let (Some(base), Some(first)) = (&checkpoint, scan.frames.first())
            && first.previous_generation > base.generation
        {
            return Err(Error::new(
                "wal_gap",
                "The WAL starts beyond the database generation.",
            ));
        }
        let latest = scan.latest.as_ref().map(|b| Page::decode(b)).transpose()?;
        let use_log = latest.as_ref().is_some_and(|p| {
            checkpoint
                .as_ref()
                .is_none_or(|b| p.generation > b.generation)
        });
        // Equal generations must be the same page, even if both individual CRCs validate.
        if let (Some(base), Some(log)) = (&checkpoint, &latest)
            && base.generation == log.generation
            && Some(&base_bytes) != scan.latest.as_ref()
        {
            return Err(Error::new(
                "page_mismatch",
                "The checkpoint and WAL disagree at the same generation.",
            ));
        }
        let bytes = if use_log {
            scan.latest.unwrap()
        } else if checkpoint.is_some() {
            base_bytes
        } else {
            return Err(Error::new(
                "unrecoverable_page",
                "The main page is invalid and no complete WAL image can recover it.",
            ));
        };
        let page = Page::decode(&bytes)?;
        let mut recovery = Recovery {
            scanned_transactions: scan.frames.len(),
            replayed_transactions: scan
                .frames
                .iter()
                .filter(|f| {
                    checkpoint
                        .as_ref()
                        .is_none_or(|p| f.generation > p.generation)
                })
                .count(),
            discarded_tail_bytes: scan.tail_bytes,
            repaired_page: checkpoint.is_none(),
            obsolete_frames_removed: 0,
        };
        // A failed reset may leave an older prefix. Remove it before a new append can
        // create a discontinuous chain. The main page must be synced first.
        let obsolete_prefix = scan.frames.last().is_some_and(|f| {
            checkpoint
                .as_ref()
                .is_some_and(|p| f.generation < p.generation)
        });
        if obsolete_prefix {
            data.sync()?;
            recovery.obsolete_frames_removed = scan.frames.len();
            scan.frames.clear();
            scan.valid_end = FILE_HEADER as u64;
        }
        if scan.tail_bytes != 0 || obsolete_prefix {
            wal.truncate(scan.valid_end)?;
        }
        // Also makes a complete but unacknowledged surviving commit stable before use.
        wal.sync()?;
        let checkpoint_bytes = checkpoint.as_ref().map(|_| base_bytes);
        let mut engine = Self {
            data,
            wal,
            id,
            page,
            bytes,
            checkpoint,
            checkpoint_bytes,
            frames: scan.frames,
            wal_end: scan.valid_end,
            pending: vec![],
            poisoned: false,
            tracing,
            session_id: format!(
                "{}-{}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_nanos()
            ),
            events: VecDeque::new(),
            sequence: 0,
            operation: 0,
            writes: 0,
            reads: 0,
            recovery,
            hook: None,
        };
        engine.emit(
            "opened",
            None,
            "Read checkpoint status and verified both file identities and every complete WAL transaction.",
        );
        if engine.recovery.replayed_transactions > 0
            || engine.recovery.discarded_tail_bytes > 0
            || engine.recovery.obsolete_frames_removed > 0
        {
            engine.emit("recovery_complete",None,&format!("Recovered {} transaction(s); removed {} incomplete tail bytes and {} obsolete frames.",engine.recovery.replayed_transactions,engine.recovery.discarded_tail_bytes,engine.recovery.obsolete_frames_removed));
        }
        Ok(engine)
    }

    /// Diagnostic pause points for isolated crash workers and deterministic tests.
    /// A hook may terminate the process; it must never reenter the engine.
    pub fn set_boundary_hook(&mut self, hook: impl FnMut(&'static str) + 'static) {
        self.hook = Some(Box::new(hook));
    }
    fn boundary(&mut self, name: &'static str) {
        if let Some(hook) = &mut self.hook {
            hook(name);
        }
    }
    fn ready(&self) -> Result<()> {
        if self.poisoned {
            return Err(Error::new(
                "needs_reopen",
                "An I/O operation failed. Reopen the database to recover before continuing.",
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
            schema_version: 2,
            session_id: self.session_id.clone(),
            sequence: self.sequence,
            operation: self.operation,
            kind,
            generation: self.page.generation,
            key: key.map(str::to_owned),
            detail: detail.into(),
        });
    }
    fn candidate(&self, writes: &[WriteOp]) -> Result<Page> {
        if !(1..=64).contains(&writes.len()) {
            return Err(Error::new(
                "invalid_batch",
                "A batch must contain 1–64 puts.",
            ));
        }
        self.page
            .with_batch(writes.iter().map(|op| (op.key.as_str(), op.value.as_str())))
    }
    pub fn stage(&mut self, key: &str, value: &str) -> Result<()> {
        self.ready()?;
        let mut pending = self.pending.clone();
        pending.push(WriteOp {
            key: key.into(),
            value: value.into(),
        });
        self.candidate(&pending)?;
        self.pending = pending;
        self.operation += 1;
        self.emit(
            "batch_staged",
            Some(key),
            "Added a put to memory. Committed data and files are unchanged.",
        );
        Ok(())
    }
    pub fn discard(&mut self) -> Result<()> {
        self.ready()?;
        self.pending.clear();
        self.operation += 1;
        self.emit("batch_discarded", None, "Discarded the in-memory batch.");
        Ok(())
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
            "Read committed data; staged puts are not visible.",
        );
        Ok(value)
    }
    pub fn put(&mut self, key: &str, value: &str) -> Result<()> {
        self.batch(vec![WriteOp {
            key: key.into(),
            value: value.into(),
        }])
    }
    pub fn batch(&mut self, writes: Vec<WriteOp>) -> Result<()> {
        self.ready()?;
        if !self.pending.is_empty() {
            return Err(Error::new(
                "batch_pending",
                "Commit or discard the staged batch first.",
            ));
        }
        self.candidate(&writes)?;
        self.pending = writes;
        self.commit()
    }
    pub fn commit(&mut self) -> Result<()> {
        self.ready()?;
        let next = self.candidate(&self.pending)?;
        if self.frames.len() >= MAX_FRAMES {
            return Err(Error::new(
                "checkpoint_required",
                "The WAL is full. Checkpoint, then commit the pending batch.",
            ));
        }
        let bytes = next.encode()?;
        let transaction = wal::encode(&next, self.page.generation, self.pending.len())?;
        let (frame, _) = wal::decode(&transaction, self.wal_end)?;
        self.operation += 1;
        self.poisoned = true;
        if let Err(error) = self.append(&transaction) {
            self.emit("commit_failed", None, &error.message);
            return Err(error);
        }
        self.frames.push(frame);
        self.wal_end += FRAME_SIZE as u64;
        self.page = next;
        self.bytes = bytes;
        self.pending.clear();
        self.writes += 1;
        self.poisoned = false;
        self.emit(
            "transaction_committed",
            None,
            "WAL synchronization and read-back succeeded. The entire batch is now visible.",
        );
        Ok(())
    }
    fn append(&mut self, transaction: &[u8; FRAME_SIZE]) -> Result<()> {
        self.boundary("before_frame");
        self.wal
            .write_all_at(self.wal_end, &transaction[..BODY_SIZE])?;
        self.emit(
            "wal_frame_written",
            None,
            "Appended a full-page redo image. No commit marker yet.",
        );
        self.boundary("after_frame");
        self.wal
            .write_all_at(self.wal_end + BODY_SIZE as u64, &transaction[BODY_SIZE..])?;
        self.emit(
            "commit_marker_written",
            None,
            "Appended the commit marker; WAL synchronization is still pending.",
        );
        self.boundary("after_commit_marker");
        self.wal.sync()?;
        self.boundary("after_wal_sync");
        let mut actual = [0; FRAME_SIZE];
        self.wal.read_exact_at(self.wal_end, &mut actual)?;
        if &actual != transaction {
            return Err(Error::new(
                "verification_failed",
                "WAL read-back differs from the requested transaction.",
            ));
        }
        self.emit(
            "wal_synced",
            None,
            "The operating system reported successful WAL synchronization; read-back matches.",
        );
        Ok(())
    }
    pub fn checkpoint(&mut self) -> Result<()> {
        self.ready()?;
        self.operation += 1;
        self.poisoned = true;
        if let Err(error) = self.checkpoint_io() {
            self.emit("checkpoint_failed", None, &error.message);
            return Err(error);
        }
        self.checkpoint = Some(self.page.clone());
        self.checkpoint_bytes = Some(self.bytes);
        self.frames.clear();
        self.wal_end = FILE_HEADER as u64;
        self.poisoned = false;
        self.emit("checkpoint_complete",None,"Synced and verified the main page, then truncated and synced the WAL. Staged puts remain in memory.");
        Ok(())
    }
    fn checkpoint_io(&mut self) -> Result<()> {
        self.wal.sync()?;
        self.boundary("before_checkpoint_write");
        self.data.write_all_at(FILE_HEADER as u64, &self.bytes)?;
        self.emit(
            "checkpoint_written",
            None,
            "Wrote committed state to the main file; the WAL still holds the recovery copy.",
        );
        self.boundary("after_checkpoint_write");
        self.data.sync()?;
        self.boundary("after_checkpoint_sync");
        let mut actual = [0; PAGE_SIZE];
        self.data.read_exact_at(FILE_HEADER as u64, &mut actual)?;
        if actual != self.bytes {
            return Err(Error::new(
                "verification_failed",
                "Checkpoint read-back differs from committed state.",
            ));
        }
        self.wal.truncate(FILE_HEADER as u64)?;
        self.boundary("after_wal_truncate");
        self.wal.sync()?;
        self.boundary("after_reset_sync");
        Ok(())
    }
    pub fn snapshot(&self) -> Result<Snapshot> {
        self.ready()?;
        Ok(Snapshot {
            schema_version: 2,
            session_id: self.session_id.clone(),
            format_version: 1,
            storage_format_version: 2,
            database_id: self.id.iter().map(|b| format!("{b:02x}")).collect(),
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
            staged: self.pending.clone(),
            staged_used_bytes: if self.pending.is_empty() {
                None
            } else {
                Some(self.candidate(&self.pending)?.used_bytes())
            },
            checkpoint_generation: self.checkpoint.as_ref().map(|p| p.generation),
            checkpoint_bytes: self.checkpoint_bytes.map(|b| b.to_vec()),
            wal_bytes: self.wal_end,
            wal_header_bytes: FILE_HEADER,
            wal_frames: self
                .frames
                .iter()
                .skip(self.frames.len().saturating_sub(32))
                .cloned()
                .collect(),
            wal_frame_count: self.frames.len(),
            wal_limit: MAX_FRAMES,
            recovery: self.recovery.clone(),
            events: self.events.iter().cloned().collect(),
            successful_writes: self.writes,
            reads: self.reads,
            tracing: self.tracing,
        })
    }
}
