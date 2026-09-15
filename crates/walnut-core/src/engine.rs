use crate::{
    Error, Meta, Node, PageSummary, RangeResult, Result, Storage, Tree,
    page::{HEADER_SIZE, Image, KEY_LIMIT, MAX_PAGES, PAGE_SIZE, Record, VALUE_LIMIT, n32},
    tree::{Prepared, Split},
    wal::{self, COMMIT_SIZE, FILE_HEADER, MAX_FRAMES, MAX_WAL_BYTES, TX_HEADER, WalFrame},
};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, VecDeque},
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
    pub page_id: Option<u32>,
    pub related_page: Option<u32>,
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
    pub page_kind: &'static str,
    pub page_generation: u64,
    pub generation: u64,
    pub page_size: usize,
    pub header_size: usize,
    pub used_bytes: usize,
    pub key_limit: usize,
    pub value_limit: usize,
    pub checksum: String,
    pub record_count: u64,
    pub page_count: usize,
    pub page_limit: u32,
    pub tree_height: u32,
    pub root_page_id: u32,
    pub state_checksum: String,
    pub pages: Vec<PageSummary>,
    pub records: Vec<Record>,
    pub bytes: Vec<u8>,
    pub last_search_path: Vec<u32>,
    pub changed_pages: Vec<u32>,
    pub splits: Vec<Split>,
    pub staged: Vec<WriteOp>,
    pub staged_used_bytes: Option<usize>,
    pub staged_page_count: Option<usize>,
    pub checkpoint_generation: Option<u64>,
    pub checkpoint_bytes: Option<Vec<u8>>,
    pub database_bytes: u64,
    pub wal_bytes: u64,
    pub wal_header_bytes: usize,
    pub wal_frames: Vec<WalFrame>,
    pub wal_frame_count: usize,
    pub wal_limit: usize,
    pub wal_byte_limit: u64,
    pub recovery: Recovery,
    pub events: Vec<Event>,
    pub successful_writes: u64,
    pub reads: u64,
    pub tracing: bool,
}
type BoundaryHook = Box<dyn FnMut(&str)>;
pub struct Engine<D: Storage, W: Storage> {
    data: D,
    wal: W,
    id: [u8; 16],
    tree: Tree,
    checkpoint: Option<Tree>,
    frames: Vec<WalFrame>,
    wal_end: u64,
    database_bytes: u64,
    pending: Vec<WriteOp>,
    pending_plan: Option<Prepared>,
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
    last_path: Vec<u32>,
    changed_pages: Vec<u32>,
    splits: Vec<Split>,
}
pub fn page_offset(id: u32) -> u64 {
    FILE_HEADER as u64 + id as u64 * PAGE_SIZE as u64
}
fn load_tree<S: Storage>(data: &mut S, meta: Meta, overlay: &BTreeMap<u32, Image>) -> Result<Tree> {
    meta.validate()?;
    let length = data.size()?;
    let mut pages = BTreeMap::new();
    for id in 1..meta.next_id {
        let mut b = [0; PAGE_SIZE];
        if let Some(image) = overlay.get(&id) {
            b = *image;
        } else {
            if page_offset(id) + PAGE_SIZE as u64 > length {
                return Err(Error::new(
                    "corrupt_tree",
                    "A required page is missing from the checkpoint and WAL.",
                ));
            }
            data.read_exact_at(page_offset(id), &mut b)?;
        }
        let node = Node::decode(&b)?;
        if node.id != id {
            return Err(Error::new(
                "corrupt_tree",
                "Page ID does not match its physical slot.",
            ));
        }
        pages.insert(id, node);
    }
    let tree = Tree { meta, pages };
    tree.validate()?;
    Ok(tree)
}

impl<D: Storage, W: Storage> Engine<D, W> {
    pub fn create(data: D, wal: W, id: [u8; 16], tracing: bool) -> Result<Self> {
        Self::create_from_tree(data, wal, id, Tree::empty(), tracing)
    }
    pub(crate) fn create_from_tree(
        mut data: D,
        mut wal: W,
        id: [u8; 16],
        tree: Tree,
        tracing: bool,
    ) -> Result<Self> {
        if data.size()? != 0 || wal.size()? != 0 {
            return Err(Error::new(
                "already_exists",
                "Creation requires two empty, new storage objects.",
            ));
        }
        tree.validate()?;
        data.write_all_at(0, &wal::header(wal::DB_MAGIC, &id))?;
        for page in 1..tree.meta.next_id {
            data.write_all_at(page_offset(page), &tree.image(page)?)?;
        }
        data.write_all_at(page_offset(0), &tree.image(0)?)?;
        data.sync()?;
        wal.write_all_at(0, &wal::header(wal::WAL_MAGIC, &id))?;
        wal.sync()?;
        let mut engine = Self::open(data, wal, tracing)?;
        engine.emit(
            "created",
            None,
            None,
            None,
            "Created and verified a B+ tree database/WAL pair.",
        );
        Ok(engine)
    }
    pub fn open(mut data: D, mut wal: W, tracing: bool) -> Result<Self> {
        let database_bytes = data.size()?;
        if database_bytes < FILE_HEADER as u64 || database_bytes > page_offset(MAX_PAGES + 1) {
            return Err(Error::new(
                "invalid_file_size",
                "Database size exceeds the format-3 bounds.",
            ));
        }
        let id = wal::read_header(&mut data, wal::DB_MAGIC)?;
        if wal::read_header(&mut wal, wal::WAL_MAGIC)? != id {
            return Err(Error::new(
                "identity_mismatch",
                "Database and WAL identities differ.",
            ));
        }
        let raw_meta = if database_bytes >= page_offset(1) {
            let mut b = [0; PAGE_SIZE];
            data.read_exact_at(page_offset(0), &mut b)?;
            Meta::decode(&b).ok()
        } else {
            None
        };
        let checkpoint = if let Some(meta) = &raw_meta {
            match load_tree(&mut data, meta.clone(), &BTreeMap::new()) {
                Ok(tree) => Some(tree),
                Err(e) if e.code == "io" => return Err(e),
                Err(_) => None,
            }
        } else {
            None
        };
        let mut scan = wal::scan(&mut wal)?;
        if let (Some(base), Some(previous)) = (&raw_meta, &scan.first_previous)
            && (previous.generation > base.generation
                || (previous.generation == base.generation && previous != base))
        {
            return Err(Error::new(
                "wal_gap",
                "The WAL does not continue the checkpoint metadata.",
            ));
        }
        if let (Some(base), Some(latest)) = (&raw_meta, &scan.latest)
            && base.generation == latest.generation
            && base != latest
        {
            return Err(Error::new(
                "metadata_mismatch",
                "Checkpoint and WAL metadata disagree at the same generation.",
            ));
        }
        let obsolete = scan.latest.as_ref().is_some_and(|last| {
            raw_meta
                .as_ref()
                .is_some_and(|base| base.generation > last.generation)
        });
        let tree = if obsolete || scan.latest.is_none() {
            checkpoint.clone().ok_or_else(|| {
                Error::new(
                    "unrecoverable_tree",
                    "The current checkpoint is invalid and no current WAL can reconstruct it.",
                )
            })?
        } else {
            load_tree(&mut data, scan.latest.clone().unwrap(), &scan.images)?
        };
        let mut recovery = Recovery {
            scanned_transactions: scan.frames.len(),
            replayed_transactions: scan
                .frames
                .iter()
                .filter(|f| {
                    checkpoint
                        .as_ref()
                        .is_none_or(|c| f.generation > c.meta.generation)
                })
                .count(),
            discarded_tail_bytes: scan.tail_bytes,
            repaired_page: checkpoint.is_none(),
            obsolete_frames_removed: 0,
        };
        if obsolete {
            data.sync()?;
            recovery.obsolete_frames_removed = scan.frames.len();
            scan.frames.clear();
            scan.valid_end = FILE_HEADER as u64;
        }
        if obsolete || scan.tail_bytes > 0 {
            wal.truncate(scan.valid_end)?;
        }
        wal.sync()?;
        let mut engine = Self {
            data,
            wal,
            id,
            tree,
            checkpoint,
            frames: scan.frames,
            wal_end: scan.valid_end,
            database_bytes,
            pending: vec![],
            pending_plan: None,
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
            last_path: vec![],
            changed_pages: vec![],
            splits: vec![],
        };
        engine.emit("opened",None,None,None,"Validated identities, committed page images, allocation, routing, leaf links, and the complete tree checksum.");
        if engine.recovery.replayed_transactions > 0
            || engine.recovery.discarded_tail_bytes > 0
            || engine.recovery.repaired_page
            || engine.recovery.obsolete_frames_removed > 0
        {
            engine.emit("recovery_complete",None,None,None,&format!("Recovered generation {} with {} records and {} node pages; removed {} incomplete tail bytes.",engine.tree.meta.generation,engine.tree.meta.records,engine.tree.pages.len(),engine.recovery.discarded_tail_bytes));
        }
        Ok(engine)
    }
    pub fn set_boundary_hook(&mut self, hook: impl FnMut(&str) + 'static) {
        self.hook = Some(Box::new(hook));
    }
    fn boundary(&mut self, name: &str) {
        if let Some(h) = &mut self.hook {
            h(name);
        }
    }
    fn ready(&self) -> Result<()> {
        if self.poisoned {
            Err(Error::new(
                "needs_reopen",
                "An I/O operation failed. Reopen to recover before continuing.",
            ))
        } else {
            Ok(())
        }
    }
    fn emit(
        &mut self,
        kind: &'static str,
        key: Option<&str>,
        page_id: Option<u32>,
        related_page: Option<u32>,
        detail: &str,
    ) {
        if !self.tracing {
            return;
        }
        self.sequence += 1;
        if self.events.len() == 128 {
            self.events.pop_front();
        }
        self.events.push_back(Event {
            schema_version: 3,
            session_id: self.session_id.clone(),
            sequence: self.sequence,
            operation: self.operation,
            kind,
            generation: self.tree.meta.generation,
            key: key.map(str::to_owned),
            page_id,
            related_page,
            detail: detail.into(),
        });
    }
    pub fn stage(&mut self, key: &str, value: &str) -> Result<()> {
        self.ready()?;
        let mut pending = self.pending.clone();
        pending.push(WriteOp {
            key: key.into(),
            value: value.into(),
        });
        let plan = self.tree.with_batch(&pending)?;
        self.pending = pending;
        self.pending_plan = Some(plan);
        self.operation += 1;
        self.emit(
            "batch_staged",
            Some(key),
            None,
            None,
            "Staged in memory; committed records and tree structure remain unchanged.",
        );
        Ok(())
    }
    pub fn discard(&mut self) -> Result<()> {
        self.ready()?;
        self.pending.clear();
        self.pending_plan = None;
        self.operation += 1;
        self.emit(
            "batch_discarded",
            None,
            None,
            None,
            "Discarded the pending batch.",
        );
        Ok(())
    }
    fn trace_path(&mut self, path: Vec<u32>, key: Option<&str>) {
        if self.tracing {
            for (i, id) in path.iter().enumerate() {
                self.emit(
                    "search_step",
                    key,
                    Some(*id),
                    path.get(i + 1).copied(),
                    &format!("Visited {} page {id}.", self.tree.pages[id].kind()),
                );
            }
        }
        self.last_path = path;
    }
    pub fn get(&mut self, key: &str) -> Result<Option<String>> {
        self.ready()?;
        let (value, path) = self.tree.get(key)?;
        self.operation += 1;
        self.reads += 1;
        self.trace_path(path, Some(key));
        self.emit(
            if value.is_some() {
                "read_found"
            } else {
                "read_missing"
            },
            Some(key),
            self.last_path.last().copied(),
            None,
            "Read committed data by following the B+ tree search path.",
        );
        Ok(value)
    }
    pub fn range(&mut self, start: &str, end: Option<&str>, limit: usize) -> Result<RangeResult> {
        self.ready()?;
        let result = self.tree.range(start, end, limit)?;
        self.operation += 1;
        self.reads += 1;
        self.trace_path(result.path.clone(), None);
        self.emit(
            "range_read",
            None,
            self.last_path.last().copied(),
            None,
            &format!(
                "Returned {} ordered records using leaf links.",
                result.records.len()
            ),
        );
        Ok(result)
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
        let plan = self.tree.with_batch(&writes)?;
        self.pending = writes;
        self.pending_plan = Some(plan);
        self.commit()
    }
    pub fn commit(&mut self) -> Result<()> {
        self.ready()?;
        let plan = self.pending_plan.as_ref().ok_or_else(|| {
            Error::new("invalid_batch", "Stage at least one put before committing.")
        })?;
        let transaction = wal::encode(
            &plan.tree,
            &self.tree.meta,
            &plan.changed,
            self.pending.len(),
        )?;
        if self.frames.len() >= MAX_FRAMES
            || self.wal_end + transaction.len() as u64 > MAX_WAL_BYTES
        {
            return Err(Error::new(
                "checkpoint_required",
                "The WAL is full. Checkpoint, then commit the pending batch.",
            ));
        }
        let decoded = wal::decode(&transaction, self.wal_end)?;
        self.operation += 1;
        self.poisoned = true;
        if let Err(error) = self.append(&transaction) {
            self.emit("commit_failed", None, None, None, &error.message);
            return Err(error);
        }
        let plan = self.pending_plan.take().unwrap();
        let last_key = self.pending.last().unwrap().key.clone();
        self.changed_pages = plan.changed.iter().copied().collect();
        self.splits = plan.splits;
        self.tree = plan.tree;
        self.wal_end += transaction.len() as u64;
        self.frames.push(decoded.frame);
        self.pending.clear();
        self.poisoned = false;
        self.writes += 1;
        for event in plan.events {
            self.emit(
                event.kind,
                None,
                Some(event.page_id),
                event.related_page,
                &event.detail,
            );
        }
        self.trace_path(plan.last_path, Some(&last_key));
        self.emit("transaction_committed",None,Some(self.tree.meta.root),None,&format!("Synced and verified {} page images including root/allocation metadata. The whole batch is now visible.",self.changed_pages.len()));
        Ok(())
    }
    fn append(&mut self, bytes: &[u8]) -> Result<()> {
        let body = bytes.len() - COMMIT_SIZE;
        self.boundary("before_frame");
        self.wal.write_all_at(self.wal_end, &bytes[..TX_HEADER])?;
        self.boundary("after_wal_header");
        for (index, image) in bytes[TX_HEADER..body - 4]
            .as_chunks::<PAGE_SIZE>()
            .0
            .iter()
            .enumerate()
        {
            self.wal
                .write_all_at(self.wal_end + (TX_HEADER + index * PAGE_SIZE) as u64, image)?;
            self.boundary(&format!("after_wal_page:{}", n32(image, 12)));
        }
        self.wal
            .write_all_at(self.wal_end + body as u64 - 4, &bytes[body - 4..body])?;
        self.emit(
            "wal_frame_written",
            None,
            None,
            None,
            "Appended all changed pages and transaction metadata; no commit marker yet.",
        );
        self.boundary("after_frame");
        self.wal
            .write_all_at(self.wal_end + body as u64, &bytes[body..])?;
        self.emit(
            "commit_marker_written",
            None,
            None,
            None,
            "Appended the commit marker; synchronization is pending.",
        );
        self.boundary("after_commit_marker");
        self.wal.sync()?;
        self.boundary("after_wal_sync");
        let mut actual = vec![0; bytes.len()];
        self.wal.read_exact_at(self.wal_end, &mut actual)?;
        if actual != bytes {
            return Err(Error::new(
                "verification_failed",
                "WAL read-back differs from the requested transaction.",
            ));
        }
        self.emit(
            "wal_synced",
            None,
            None,
            None,
            "WAL sync and complete transaction read-back succeeded.",
        );
        Ok(())
    }
    pub fn checkpoint(&mut self) -> Result<()> {
        self.ready()?;
        self.operation += 1;
        self.poisoned = true;
        if let Err(error) = self.checkpoint_io() {
            self.emit("checkpoint_failed", None, None, None, &error.message);
            return Err(error);
        }
        self.checkpoint = Some(self.tree.clone());
        self.database_bytes = page_offset(self.tree.meta.next_id);
        self.frames.clear();
        self.wal_end = FILE_HEADER as u64;
        self.poisoned = false;
        self.emit("checkpoint_complete",None,Some(0),None,"Synced and verified all pages and metadata, then truncated and synced the WAL. Staged puts remain in memory.");
        Ok(())
    }
    fn checkpoint_io(&mut self) -> Result<()> {
        self.wal.sync()?;
        self.boundary("before_checkpoint_write");
        for id in 1..self.tree.meta.next_id {
            self.data
                .write_all_at(page_offset(id), &self.tree.image(id)?)?;
            self.boundary(&format!("after_checkpoint_page:{id}"));
        }
        self.data
            .write_all_at(page_offset(0), &self.tree.image(0)?)?;
        self.emit(
            "checkpoint_written",
            None,
            Some(0),
            None,
            "Wrote all node pages and metadata last. WAL recovery copies remain available.",
        );
        self.boundary("after_checkpoint_write");
        self.data.sync()?;
        self.boundary("after_checkpoint_sync");
        for id in 0..self.tree.meta.next_id {
            let mut actual = [0; PAGE_SIZE];
            self.data.read_exact_at(page_offset(id), &mut actual)?;
            if actual != self.tree.image(id)? {
                return Err(Error::new(
                    "verification_failed",
                    format!("Checkpoint page {id} differs from committed state."),
                ));
            }
        }
        self.wal.truncate(FILE_HEADER as u64)?;
        self.boundary("after_wal_truncate");
        self.wal.sync()?;
        self.boundary("after_reset_sync");
        Ok(())
    }
    pub fn snapshot(&self) -> Result<Snapshot> {
        self.snapshot_page(1)
    }
    pub fn snapshot_page(&self, id: u32) -> Result<Snapshot> {
        self.ready()?;
        let bytes = self.tree.image(id)?;
        let node = self.tree.pages.get(&id);
        let checkpoint_bytes = self
            .checkpoint
            .as_ref()
            .filter(|t| id < t.meta.next_id)
            .map(|t| t.image(id))
            .transpose()?
            .map(|b| b.to_vec());
        let staged = self.pending_plan.as_ref();
        Ok(Snapshot {
            schema_version: 3,
            session_id: self.session_id.clone(),
            format_version: 2,
            storage_format_version: 3,
            database_id: self.id.iter().map(|b| format!("{b:02x}")).collect(),
            page_id: id,
            page_kind: node.map_or("metadata", Node::kind),
            page_generation: node.map_or(self.tree.meta.generation, |p| p.generation),
            generation: self.tree.meta.generation,
            page_size: PAGE_SIZE,
            header_size: HEADER_SIZE,
            used_bytes: node.map_or(HEADER_SIZE, Node::used_bytes),
            key_limit: KEY_LIMIT,
            value_limit: VALUE_LIMIT,
            checksum: format!("{:08x}", n32(&bytes, 28)),
            record_count: self.tree.meta.records,
            page_count: self.tree.pages.len(),
            page_limit: MAX_PAGES,
            tree_height: self.tree.meta.height,
            root_page_id: self.tree.meta.root,
            state_checksum: format!("{:08x}", self.tree.meta.state_crc),
            pages: self.tree.summaries(),
            records: node.map_or_else(Vec::new, Node::records),
            bytes: bytes.to_vec(),
            last_search_path: self.last_path.clone(),
            changed_pages: self.changed_pages.clone(),
            splits: self.splits.clone(),
            staged: self.pending.clone(),
            staged_used_bytes: staged.map(|p| p.tree.pages.values().map(Node::used_bytes).sum()),
            staged_page_count: staged.map(|p| p.tree.pages.len()),
            checkpoint_generation: self.checkpoint.as_ref().map(|t| t.meta.generation),
            checkpoint_bytes,
            database_bytes: self.database_bytes,
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
            wal_byte_limit: MAX_WAL_BYTES,
            recovery: self.recovery.clone(),
            events: self.events.iter().cloned().collect(),
            successful_writes: self.writes,
            reads: self.reads,
            tracing: self.tracing,
        })
    }
}
