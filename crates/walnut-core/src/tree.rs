use crate::{
    Error, Meta, Node, Result, WriteOp,
    page::{
        self, Contents, HEADER_SIZE, Image, MAX_HEIGHT, MAX_PAGES, PAGE_SIZE, bad, validate_key,
        validate_value,
    },
};
use serde::Serialize;
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::{Arc, OnceLock},
};

/// Candidate trees share every page they do not change, so planning a write
/// copies pointers rather than records.
#[derive(Clone, Debug)]
pub struct Tree {
    pub meta: Meta,
    pub pages: BTreeMap<u32, Arc<Node>>,
    /// CRC-32 of each node's encoded image, in ID order. `seal` rebuilds it;
    /// a prepared batch refreshes only the pages it changed.
    crcs: Vec<u32>,
}
// Equality is the tree's contents; the checksum cache is derived from them.
impl PartialEq for Tree {
    fn eq(&self, other: &Self) -> bool {
        self.meta == other.meta && self.pages == other.pages
    }
}
impl Eq for Tree {}

/// Linear map taking crc(a) to its contribution to crc(a || page) for any
/// page-sized suffix, split into one lookup table per input byte.
fn page_shift() -> &'static [[u32; 256]; 4] {
    static TABLES: OnceLock<[[u32; 256]; 4]> = OnceLock::new();
    TABLES.get_or_init(|| {
        let zeros = [0; PAGE_SIZE];
        let extend = |crc| {
            let mut h = crc32fast::Hasher::new_with_initial(crc);
            h.update(&zeros);
            h.finalize()
        };
        // Resuming a CRC over n bytes is affine in the starting CRC, and its
        // linear part depends only on n; removing the constant leaves it.
        let offset = extend(0);
        let mut tables = [[0; 256]; 4];
        for (byte, table) in tables.iter_mut().enumerate() {
            for (value, entry) in table.iter_mut().enumerate() {
                *entry = (0..8)
                    .filter(|bit| value >> bit & 1 == 1)
                    .map(|bit| extend(1 << (8 * byte + bit)) ^ offset)
                    .fold(0, |a, b| a ^ b);
            }
        }
        tables
    })
}

/// The state checksum: CRC-32 over every encoded node image in ID order,
/// combined from per-page CRCs instead of rehashing the pages.
fn combine(crcs: &[u32]) -> u32 {
    let t = page_shift();
    crcs.iter().fold(0, |state, page| {
        let [a, b, c, d] = state.to_le_bytes();
        t[0][a as usize] ^ t[1][b as usize] ^ t[2][c as usize] ^ t[3][d as usize] ^ page
    })
}
#[derive(Clone, Debug, Serialize)]
pub struct PageSummary {
    pub id: u32,
    pub kind: &'static str,
    pub level: u8,
    pub generation: u64,
    pub used_bytes: usize,
    pub count: usize,
    pub first_key: Option<String>,
    pub last_key: Option<String>,
    pub children: Vec<u32>,
    pub separators: Vec<String>,
    pub next_leaf: Option<u32>,
}
#[derive(Clone, Debug, Serialize)]
pub struct Split {
    pub left: u32,
    pub right: u32,
    pub level: u8,
    pub separator: String,
}
#[derive(Clone, Debug)]
pub struct ChangeEvent {
    pub kind: &'static str,
    pub page_id: u32,
    pub related_page: Option<u32>,
    pub detail: String,
}
pub struct Prepared {
    pub tree: Tree,
    pub changed: BTreeSet<u32>,
    pub splits: Vec<Split>,
    pub events: Vec<ChangeEvent>,
    pub last_path: Vec<u32>,
}
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct RangeRecord {
    pub key: String,
    pub value: String,
    pub page_id: u32,
}
#[derive(Clone, Debug, Serialize)]
pub struct RangeResult {
    pub records: Vec<RangeRecord>,
    pub next_key: Option<String>,
    pub path: Vec<u32>,
}
struct Bounds {
    min: Option<String>,
    max: Option<String>,
    count: u64,
}

impl Tree {
    pub fn empty() -> Self {
        let mut tree = Self {
            meta: Meta {
                generation: 0,
                root: 1,
                next_id: 2,
                height: 1,
                records: 0,
                state_crc: 0,
            },
            pages: BTreeMap::from([(1, Arc::new(Node::leaf(1, 0)))]),
            crcs: vec![],
        };
        tree.seal().expect("empty tree encodes");
        tree
    }
    /// Builds a tree from decoded pages, fully validating it and caching the
    /// per-page checksums that later commits update incrementally.
    pub fn from_pages(meta: Meta, pages: BTreeMap<u32, Node>) -> Result<Self> {
        let mut tree = Self {
            meta,
            pages: pages.into_iter().map(|(id, n)| (id, Arc::new(n))).collect(),
            crcs: vec![],
        };
        tree.check_structure()?;
        tree.crcs = tree.page_crcs()?;
        tree.check_state_crc(&tree.crcs)?;
        Ok(tree)
    }
    pub fn from_entries(
        entries: impl IntoIterator<Item = (String, String)>,
        generation: u64,
    ) -> Result<Self> {
        let mut prepared = Prepared {
            tree: Self::empty(),
            changed: BTreeSet::new(),
            splits: vec![],
            events: vec![],
            last_path: vec![],
        };
        prepared.tree.meta.generation = generation;
        Arc::make_mut(prepared.tree.pages.get_mut(&1).unwrap()).generation = generation;
        for (key, value) in entries {
            validate_key(&key)?;
            validate_value(&value)?;
            prepared.put(&key, &value)?;
        }
        prepared.tree.seal()?;
        prepared.tree.validate()?;
        Ok(prepared.tree)
    }
    pub fn with_batch(&self, writes: &[WriteOp]) -> Result<Prepared> {
        if !(1..=64).contains(&writes.len()) {
            return Err(Error::new(
                "invalid_batch",
                "A batch must contain 1–64 puts.",
            ));
        }
        for w in writes {
            validate_key(&w.key)?;
            validate_value(&w.value)?;
        }
        let generation = self.meta.generation.checked_add(1).ok_or_else(|| {
            Error::new("generation_limit", "The generation limit has been reached.")
        })?;
        let mut next = Prepared {
            tree: self.clone(),
            changed: BTreeSet::from([0]),
            splits: vec![],
            events: vec![],
            last_path: vec![],
        };
        next.tree.meta.generation = generation;
        for w in writes {
            next.put(&w.key, &w.value)?;
        }
        next.last_path = next.tree.path(&writes.last().unwrap().key)?;
        next.reseal()?;
        next.verify(self)?;
        // Every debug build, including the test suites, cross-checks the
        // incremental verification against a complete walk of the tree.
        #[cfg(debug_assertions)]
        if let Err(error) = next.tree.validate() {
            panic!("incremental verification accepted an invalid tree: {error}");
        }
        Ok(next)
    }
    pub fn image(&self, id: u32) -> Result<Image> {
        if id == 0 {
            self.meta.encode()
        } else {
            self.pages
                .get(&id)
                .ok_or_else(|| Error::new("page_not_found", "This page is not allocated."))?
                .encode()
        }
    }
    fn page_crcs(&self) -> Result<Vec<u32>> {
        self.pages
            .values()
            .map(|node| Ok(crc32fast::hash(&node.encode()?)))
            .collect()
    }
    /// CRC-32 over every encoded node image in ID order, recomputed from the pages.
    pub fn state_crc(&self) -> Result<u32> {
        Ok(combine(&self.page_crcs()?))
    }
    /// Re-encodes every page and records the state checksum. Call it after
    /// editing `pages` directly.
    pub fn seal(&mut self) -> Result<()> {
        self.crcs = self.page_crcs()?;
        self.meta.state_crc = combine(&self.crcs);
        Ok(())
    }
    fn check_state_crc(&self, crcs: &[u32]) -> Result<()> {
        if combine(crcs) != self.meta.state_crc {
            return Err(bad(
                "Tree state checksum differs from metadata; the checkpoint may contain mixed page versions.",
            ));
        }
        Ok(())
    }
    /// Complete validation, independent of any cached checksum: encodes every
    /// page and walks the whole tree.
    pub fn validate(&self) -> Result<()> {
        self.check_structure()?;
        self.check_state_crc(&self.page_crcs()?)
    }
    fn check_structure(&self) -> Result<()> {
        self.meta.validate()?;
        if self.pages.len() != self.meta.next_id as usize - 1
            || self.pages.keys().copied().ne(1..self.meta.next_id)
        {
            return Err(bad("Allocation must contain every node ID exactly once."));
        }
        let mut seen = BTreeSet::new();
        let mut leaves = vec![];
        let bounds = self.walk(
            self.meta.root,
            (self.meta.height - 1) as u8,
            &mut seen,
            &mut leaves,
        )?;
        if seen.len() != self.pages.len() || bounds.count != self.meta.records {
            return Err(bad("Unreachable pages or incorrect record count."));
        }
        for (index, id) in leaves.iter().enumerate() {
            let Contents::Leaf { next, .. } = &self.pages[id].contents else {
                unreachable!()
            };
            if *next != leaves.get(index + 1).copied().unwrap_or(0) {
                return Err(bad("Leaf chain does not match tree order."));
            }
        }
        Ok(())
    }
    fn walk(
        &self,
        id: u32,
        level: u8,
        seen: &mut BTreeSet<u32>,
        leaves: &mut Vec<u32>,
    ) -> Result<Bounds> {
        if !seen.insert(id) {
            return Err(bad("A page is reached twice or the tree has a cycle."));
        }
        let node = self
            .pages
            .get(&id)
            .ok_or_else(|| bad("A child references an unallocated page."))?;
        if node.id != id || node.level != level || node.generation > self.meta.generation {
            return Err(bad(
                "Page identity, generation, or tree depth is inconsistent.",
            ));
        }
        match &node.contents {
            Contents::Leaf { entries, .. } => {
                if level != 0 || (entries.is_empty() && id != self.meta.root) {
                    return Err(bad(
                        "Non-root leaves must contain records at the same depth.",
                    ));
                }
                leaves.push(id);
                Ok(Bounds {
                    min: entries.first().map(|r| r.0.clone()),
                    max: entries.last().map(|r| r.0.clone()),
                    count: entries.len() as u64,
                })
            }
            Contents::Internal { keys, children } => {
                let mut total = Bounds {
                    min: None,
                    max: None,
                    count: 0,
                };
                for (index, child) in children.iter().enumerate() {
                    let range = self.walk(
                        *child,
                        level
                            .checked_sub(1)
                            .ok_or_else(|| bad("Internal level is zero."))?,
                        seen,
                        leaves,
                    )?;
                    if index > 0
                        && (range.min.as_ref() != Some(&keys[index - 1])
                            || total
                                .max
                                .as_ref()
                                .zip(range.min.as_ref())
                                .is_none_or(|(a, b)| a >= b))
                    {
                        return Err(bad("Separator or child key range is inconsistent."));
                    }
                    if index == 0 {
                        total.min = range.min;
                    }
                    total.max = range.max;
                    total.count += range.count;
                }
                Ok(total)
            }
        }
    }
    fn page(&self, id: u32) -> Result<&Node> {
        self.pages
            .get(&id)
            .map(|node| &**node)
            .ok_or_else(|| bad("A child references an unallocated page."))
    }
    /// The leftmost or rightmost leaf below a page.
    fn edge(&self, id: u32, last: bool) -> Result<&Node> {
        let mut node = self.page(id)?;
        for _ in 0..MAX_HEIGHT {
            match &node.contents {
                Contents::Leaf { .. } => return Ok(node),
                Contents::Internal { children, .. } => {
                    let child = if last {
                        children.last()
                    } else {
                        children.first()
                    };
                    node =
                        self.page(*child.ok_or_else(|| bad("Internal page has no children."))?)?;
                }
            }
        }
        Err(bad("Descent exceeded the tree height bound."))
    }
    pub fn path(&self, key: &str) -> Result<Vec<u32>> {
        let mut id = self.meta.root;
        let mut path = vec![];
        for _ in 0..MAX_HEIGHT {
            path.push(id);
            let node = self
                .pages
                .get(&id)
                .ok_or_else(|| bad("Search encountered a missing page."))?;
            match &node.contents {
                Contents::Leaf { .. } => return Ok(path),
                Contents::Internal { keys, children } => {
                    id = children[keys.partition_point(|k| k.as_str() <= key)]
                }
            }
        }
        Err(bad("Search exceeded the tree height bound."))
    }
    pub fn get(&self, key: &str) -> Result<(Option<String>, Vec<u32>)> {
        validate_key(key)?;
        let path = self.path(key)?;
        let Contents::Leaf { entries, .. } = &self.pages[path.last().unwrap()].contents else {
            unreachable!()
        };
        let value = entries
            .binary_search_by(|(k, _)| k.as_str().cmp(key))
            .ok()
            .map(|at| entries[at].1.clone());
        Ok((value, path))
    }
    pub fn range(&self, start: &str, end: Option<&str>, limit: usize) -> Result<RangeResult> {
        if start.len() > page::KEY_LIMIT
            || end.is_some_and(|e| e.len() > page::KEY_LIMIT || e < start)
            || !(1..=256).contains(&limit)
        {
            return Err(Error::new(
                "invalid_range",
                "Use ordered bounds of at most 64 UTF-8 bytes and a limit of 1–256.",
            ));
        }
        let mut path = self.path(start)?;
        let mut id = *path.last().unwrap();
        let mut records = vec![];
        for _ in 0..MAX_PAGES {
            let Contents::Leaf { entries, next } = &self
                .pages
                .get(&id)
                .ok_or_else(|| bad("Range scan encountered a missing leaf."))?
                .contents
            else {
                return Err(bad("Range scan reached an internal node."));
            };
            for (key, value) in entries.iter().filter(|(k, _)| k.as_str() >= start) {
                if end.is_some_and(|e| key.as_str() >= e) {
                    return Ok(RangeResult {
                        records,
                        next_key: None,
                        path,
                    });
                }
                if records.len() == limit {
                    return Ok(RangeResult {
                        records,
                        next_key: Some(key.clone()),
                        path,
                    });
                }
                records.push(RangeRecord {
                    key: key.clone(),
                    value: value.clone(),
                    page_id: id,
                });
            }
            if *next == 0 {
                return Ok(RangeResult {
                    records,
                    next_key: None,
                    path,
                });
            }
            id = *next;
            path.push(id);
        }
        Err(bad("Range scan exceeded the leaf count bound."))
    }
    pub fn summaries(&self) -> Vec<PageSummary> {
        self.pages
            .values()
            .map(|p| {
                let (first, last, children, separators, next) = match &p.contents {
                    Contents::Leaf { entries, next } => (
                        entries.first().map(|r| r.0.clone()),
                        entries.last().map(|r| r.0.clone()),
                        vec![],
                        vec![],
                        (*next != 0).then_some(*next),
                    ),
                    Contents::Internal { keys, children } => (
                        keys.first().cloned(),
                        keys.last().cloned(),
                        children.clone(),
                        keys.clone(),
                        None,
                    ),
                };
                PageSummary {
                    id: p.id,
                    kind: p.kind(),
                    level: p.level,
                    generation: p.generation,
                    used_bytes: p.used_bytes(),
                    count: p.count(),
                    first_key: first,
                    last_key: last,
                    children,
                    separators,
                    next_leaf: next,
                }
            })
            .collect()
    }
}

impl Prepared {
    /// Re-encodes only the changed pages and folds the cached checksums of the
    /// rest into the new state checksum.
    fn reseal(&mut self) -> Result<()> {
        let tree = &mut self.tree;
        tree.crcs.resize(tree.pages.len(), 0);
        for &id in self.changed.iter().filter(|id| **id != 0) {
            let node = tree
                .pages
                .get(&id)
                .ok_or_else(|| bad("A changed page is missing from the candidate tree."))?;
            let crc = crc32fast::hash(&node.encode()?);
            *tree
                .crcs
                .get_mut(id as usize - 1)
                .ok_or_else(|| bad("A changed page is outside the allocated range."))? = crc;
        }
        tree.meta.state_crc = combine(&tree.crcs);
        Ok(())
    }
    /// Verifies a candidate against the validated tree it was planned from.
    ///
    /// Only changed pages and the routes and seams around them are visited;
    /// untouched subtrees are the base's, which was already validated. Every
    /// changed page must re-encode to its cached checksum and be reached by
    /// routing through changed ancestors. Each changed internal page must hold
    /// children one level down whose key ranges match its separators exactly
    /// and whose boundary leaves are linked. Child references, allocation and
    /// the record count must account for every page and record the batch added.
    pub fn verify(&self, base: &Tree) -> Result<()> {
        let tree = &self.tree;
        let meta = &tree.meta;
        meta.validate()?;
        let fail = |message| Err(bad(message));
        let added = base.meta.next_id..meta.next_id;
        if base.meta.generation.checked_add(1) != Some(meta.generation)
            || meta.next_id < base.meta.next_id
            || tree.pages.len() != meta.next_id as usize - 1
            || tree.pages.first_key_value().map(|(id, _)| *id) != Some(1)
            || tree.pages.last_key_value().map(|(id, _)| *id) != Some(meta.next_id - 1)
            || tree.crcs.len() != tree.pages.len()
            || !self.changed.contains(&0)
            || added.clone().any(|id| !self.changed.contains(&id))
        {
            return fail("Candidate generation, allocation, or changed-page set is inconsistent.");
        }
        let root = tree.page(meta.root)?;
        if root.level as u32 != meta.height - 1 {
            return fail("Root level does not match the tree height.");
        }
        if tree.edge(meta.root, true)?.next_leaf() != 0 {
            return fail("The last leaf links past the end of the tree.");
        }
        let mut new_refs = vec![meta.root];
        let mut old_refs = vec![base.meta.root];
        let mut record_delta = 0i64;
        for &id in self.changed.iter().filter(|id| **id != 0) {
            let node = tree.page(id)?;
            if node.id != id
                || node.generation != meta.generation
                || crc32fast::hash(&node.encode()?) != tree.crcs[id as usize - 1]
            {
                return fail("A changed page has the wrong identity, generation, or checksum.");
            }
            self.check_route(id, node)?;
            match &node.contents {
                Contents::Leaf { entries, .. } => {
                    if entries.is_empty() && id != meta.root {
                        return fail("Non-root leaves must contain records.");
                    }
                    record_delta += entries.len() as i64;
                }
                Contents::Internal { keys, children } => {
                    for (index, &child) in children.iter().enumerate() {
                        if tree.page(child)?.level + 1 != node.level {
                            return fail("A child is not exactly one level below its parent.");
                        }
                        let first = tree.edge(child, false)?.first_key()?;
                        let last_leaf = tree.edge(child, true)?;
                        if index > 0 && first != keys[index - 1] {
                            return fail(
                                "A separator is not the minimum key of its right subtree.",
                            );
                        }
                        if let Some(&right) = children.get(index + 1) {
                            if last_leaf.last_key()? >= keys[index].as_str() {
                                return fail(
                                    "A child holds keys at or beyond its right separator.",
                                );
                            }
                            if last_leaf.next_leaf() != tree.edge(right, false)?.id {
                                return fail("Leaf links do not join adjacent subtrees.");
                            }
                        }
                    }
                    new_refs.extend(children);
                }
            }
            if let Some(old) = base.pages.get(&id) {
                match &old.contents {
                    Contents::Leaf { entries, .. } => record_delta -= entries.len() as i64,
                    Contents::Internal { children, .. } => old_refs.extend(children),
                }
            }
        }
        if meta.records.checked_sub(base.meta.records) != Some(record_delta as u64) {
            return fail("Record count does not match the changed leaves.");
        }
        // The base references every page once. If the changed pages now
        // reference what they did before plus each new page, exactly once,
        // then so does the candidate; strictly decreasing levels rule out cycles.
        let count = new_refs.len();
        new_refs.sort_unstable();
        new_refs.dedup();
        old_refs.extend(added);
        old_refs.sort_unstable();
        if new_refs.len() != count || new_refs != old_refs {
            return fail("Changed pages do not reference every page exactly once.");
        }
        if combine(&tree.crcs) != meta.state_crc {
            return fail("Candidate state checksum does not match its pages.");
        }
        Ok(())
    }
    /// A changed page must be where routing by its smallest key leads, and every
    /// page on the way must be changed too, so no unchanged page can hide it.
    fn check_route(&self, id: u32, node: &Node) -> Result<()> {
        let tree = &self.tree;
        let Ok(probe) = tree.edge(id, false)?.first_key() else {
            // Only an empty root leaf has no key to route by.
            return if id == tree.meta.root {
                Ok(())
            } else {
                Err(bad("Non-root leaves must contain records."))
            };
        };
        let mut at = tree.meta.root;
        for _ in 0..MAX_HEIGHT {
            if at == id {
                return Ok(());
            }
            if !self.changed.contains(&at) {
                break;
            }
            let Contents::Internal { keys, children } = &tree.page(at)?.contents else {
                break;
            };
            if tree.page(at)?.level <= node.level {
                break;
            }
            at = children[keys.partition_point(|k| k.as_str() <= probe)];
        }
        Err(bad(
            "A changed page is not reachable through changed ancestors.",
        ))
    }
    fn event(
        &mut self,
        kind: &'static str,
        page_id: u32,
        related_page: Option<u32>,
        detail: String,
    ) {
        self.events.push(ChangeEvent {
            kind,
            page_id,
            related_page,
            detail,
        });
    }
    fn allocate(&mut self, mut node: Node) -> Result<u32> {
        let id = self.tree.meta.next_id;
        if id > MAX_PAGES {
            return Err(Error::new(
                "database_full",
                "The 1,024-page allocation limit has been reached.",
            ));
        }
        self.tree.meta.next_id += 1;
        node.id = id;
        self.tree.pages.insert(id, Arc::new(node));
        self.changed.insert(id);
        self.event(
            "page_allocated",
            id,
            None,
            format!("Allocated page {id} inside this atomic transaction."),
        );
        Ok(id)
    }
    fn put(&mut self, key: &str, value: &str) -> Result<()> {
        self.last_path = self.tree.path(key)?;
        let (inserted, split) = self.insert(self.tree.meta.root, key, value)?;
        if inserted {
            self.tree.meta.records += 1;
        }
        if let Some(split) = split {
            let old_root = self.tree.meta.root;
            let root = self.allocate(Node {
                id: 0,
                generation: self.tree.meta.generation,
                level: split.level + 1,
                contents: Contents::Internal {
                    keys: vec![split.separator],
                    children: vec![old_root, split.right],
                },
            })?;
            self.tree.meta.root = root;
            self.tree.meta.height += 1;
            self.event(
                "root_changed",
                root,
                Some(old_root),
                format!(
                    "Root changed from page {old_root} to {root}; height is now {}.",
                    self.tree.meta.height
                ),
            );
        }
        Ok(())
    }
    fn insert(&mut self, id: u32, key: &str, value: &str) -> Result<(bool, Option<Split>)> {
        // Copy-on-write: only pages on the insertion path are cloned.
        let mut node = Arc::unwrap_or_clone(
            self.tree
                .pages
                .remove(&id)
                .ok_or_else(|| bad("Insert encountered an unallocated page."))?,
        );
        node.generation = self.tree.meta.generation;
        self.changed.insert(id);
        let inserted = match &mut node.contents {
            Contents::Leaf { entries, .. } => {
                match entries.binary_search_by(|(k, _)| k.as_str().cmp(key)) {
                    Ok(at) => {
                        entries[at].1 = value.into();
                        false
                    }
                    Err(at) => {
                        entries.insert(at, (key.into(), value.into()));
                        true
                    }
                }
            }
            Contents::Internal { keys, children } => {
                let at = keys.partition_point(|k| k.as_str() <= key);
                let (inserted, split) = self.insert(children[at], key, value)?;
                if let Some(split) = split {
                    keys.insert(at, split.separator);
                    children.insert(at + 1, split.right);
                }
                inserted
            }
        };
        if node.used_bytes() <= PAGE_SIZE {
            self.tree.pages.insert(id, Arc::new(node));
            return Ok((inserted, None));
        }
        let (separator, right) = match &mut node.contents {
            Contents::Leaf { entries, next } => {
                let cut = (1..entries.len())
                    .filter_map(|cut| {
                        let left = HEADER_SIZE
                            + entries[..cut]
                                .iter()
                                .map(|(k, v)| 4 + k.len() + v.len())
                                .sum::<usize>();
                        let right = HEADER_SIZE
                            + entries[cut..]
                                .iter()
                                .map(|(k, v)| 4 + k.len() + v.len())
                                .sum::<usize>();
                        (left <= PAGE_SIZE && right <= PAGE_SIZE)
                            .then_some((left.abs_diff(right), cut))
                    })
                    .min()
                    .ok_or_else(|| bad("Leaf cannot be split within page bounds."))?
                    .1;
                let right_entries = entries.split_off(cut);
                let separator = right_entries[0].0.clone();
                let right = self.allocate(Node {
                    id: 0,
                    generation: node.generation,
                    level: 0,
                    contents: Contents::Leaf {
                        entries: right_entries,
                        next: *next,
                    },
                })?;
                *next = right;
                (separator, right)
            }
            Contents::Internal { keys, children } => {
                let mid = (1..keys.len() - 1)
                    .filter_map(|mid| {
                        let left =
                            HEADER_SIZE + keys[..mid].iter().map(|k| 6 + k.len()).sum::<usize>();
                        let right = HEADER_SIZE
                            + keys[mid + 1..].iter().map(|k| 6 + k.len()).sum::<usize>();
                        (left <= PAGE_SIZE && right <= PAGE_SIZE)
                            .then_some((left.abs_diff(right), mid))
                    })
                    .min()
                    .ok_or_else(|| bad("Internal node cannot be split within page bounds."))?
                    .1;
                let right_keys = keys.split_off(mid + 1);
                let separator = keys.pop().unwrap();
                let right_children = children.split_off(mid + 1);
                let right = self.allocate(Node {
                    id: 0,
                    generation: node.generation,
                    level: node.level,
                    contents: Contents::Internal {
                        keys: right_keys,
                        children: right_children,
                    },
                })?;
                (separator, right)
            }
        };
        let split = Split {
            left: id,
            right,
            level: node.level,
            separator,
        };
        self.event(
            if node.level == 0 {
                "leaf_split"
            } else {
                "internal_split"
            },
            id,
            Some(right),
            format!("Page {id} exceeded 4 KB; split into pages {id} and {right}."),
        );
        self.tree.pages.insert(id, Arc::new(node));
        self.splits.push(split.clone());
        Ok((inserted, Some(split)))
    }
}
