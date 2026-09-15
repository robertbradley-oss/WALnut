use crate::{
    Error, Meta, Node, Result, Storage, Tree,
    page::{Image, MAX_PAGES, PAGE_SIZE, n32, n64},
};
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet};

pub const FILE_HEADER: usize = 64;
pub const TX_HEADER: usize = 64;
pub const COMMIT_SIZE: usize = 32;
pub const MAX_FRAMES: usize = 1024;
pub const MAX_WAL_BYTES: u64 = 32 * 1024 * 1024;
pub const DB_MAGIC: &[u8; 8] = b"WALNDB03";
pub const WAL_MAGIC: &[u8; 8] = b"WALNWAL3";
fn bad(message: &str) -> Error {
    Error::new("corrupt_wal", message)
}

pub fn header(magic: &[u8; 8], id: &[u8; 16]) -> [u8; FILE_HEADER] {
    let mut b = [0; FILE_HEADER];
    b[..8].copy_from_slice(magic);
    b[8..12].copy_from_slice(&3u32.to_le_bytes());
    b[12..16].copy_from_slice(&(PAGE_SIZE as u32).to_le_bytes());
    b[16..32].copy_from_slice(id);
    let crc = crc32fast::hash(&b[..60]);
    b[60..64].copy_from_slice(&crc.to_le_bytes());
    b
}
pub fn read_header<S: Storage>(storage: &mut S, magic: &[u8; 8]) -> Result<[u8; 16]> {
    let mut b = [0; FILE_HEADER];
    storage.read_exact_at(0, &mut b)?;
    if &b[..8] != magic
        || n32(&b, 8) != 3
        || n32(&b, 12) != PAGE_SIZE as u32
        || b[32..60].iter().any(|v| *v != 0)
        || n32(&b, 60) != crc32fast::hash(&b[..60])
    {
        return Err(Error::new(
            "invalid_file_header",
            "File header is invalid or uses an unsupported storage format.",
        ));
    }
    Ok(b[16..32].try_into().unwrap())
}
#[derive(Clone, Debug, Serialize)]
pub struct WalFrame {
    pub generation: u64,
    pub previous_generation: u64,
    pub operations: usize,
    pub offset: u64,
    pub length: usize,
    pub checksum: String,
    pub page_ids: Vec<u32>,
    pub root_page_id: u32,
    pub tree_height: u32,
}
pub struct Transaction {
    pub frame: WalFrame,
    pub previous: Meta,
    pub meta: Meta,
    pub images: BTreeMap<u32, Image>,
}

fn read_tx_header(b: &[u8]) -> Result<(usize, usize, Meta, u64, usize)> {
    if b.len() < TX_HEADER || &b[..8] != b"WNTX0003" || n32(b, 60) != crc32fast::hash(&b[..60]) {
        return Err(bad(
            "A complete WAL header failed checksum or format validation.",
        ));
    }
    let body = n32(b, 8) as usize;
    let count = n32(b, 12) as usize;
    let generation = n64(b, 16);
    let operations = n32(b, 32) as usize;
    let previous = Meta {
        generation: n64(b, 24),
        next_id: n32(b, 36),
        root: n32(b, 40),
        height: n32(b, 44),
        records: n64(b, 48),
        state_crc: n32(b, 56),
    };
    previous.validate().map_err(|e| bad(&e.message))?;
    if !(2..=MAX_PAGES as usize + 1).contains(&count)
        || body != TX_HEADER + count * PAGE_SIZE + 4
        || previous.generation.checked_add(1) != Some(generation)
        || !(1..=64).contains(&operations)
    {
        return Err(bad(
            "WAL header length, image count, generation, or operation bounds are invalid.",
        ));
    }
    Ok((body, count, previous, generation, operations))
}
pub fn encode(
    tree: &Tree,
    previous: &Meta,
    changed: &BTreeSet<u32>,
    operations: usize,
) -> Result<Vec<u8>> {
    let body = TX_HEADER + changed.len() * PAGE_SIZE + 4;
    let mut b = vec![0; body + COMMIT_SIZE];
    b[..8].copy_from_slice(b"WNTX0003");
    b[8..12].copy_from_slice(&(body as u32).to_le_bytes());
    b[12..16].copy_from_slice(&(changed.len() as u32).to_le_bytes());
    b[16..24].copy_from_slice(&tree.meta.generation.to_le_bytes());
    b[24..32].copy_from_slice(&previous.generation.to_le_bytes());
    b[32..36].copy_from_slice(&(operations as u32).to_le_bytes());
    b[36..40].copy_from_slice(&previous.next_id.to_le_bytes());
    b[40..44].copy_from_slice(&previous.root.to_le_bytes());
    b[44..48].copy_from_slice(&previous.height.to_le_bytes());
    b[48..56].copy_from_slice(&previous.records.to_le_bytes());
    b[56..60].copy_from_slice(&previous.state_crc.to_le_bytes());
    let crc = crc32fast::hash(&b[..60]);
    b[60..64].copy_from_slice(&crc.to_le_bytes());
    for (index, id) in changed.iter().enumerate() {
        b[TX_HEADER + index * PAGE_SIZE..TX_HEADER + (index + 1) * PAGE_SIZE]
            .copy_from_slice(&tree.image(*id)?);
    }
    let crc = crc32fast::hash(&b[..body - 4]);
    b[body - 4..body].copy_from_slice(&crc.to_le_bytes());
    let marker = &mut b[body..];
    marker[..8].copy_from_slice(b"WNCMIT03");
    marker[8..16].copy_from_slice(&tree.meta.generation.to_le_bytes());
    marker[16..20].copy_from_slice(&crc.to_le_bytes());
    let sum = crc32fast::hash(&marker[..28]);
    marker[28..32].copy_from_slice(&sum.to_le_bytes());
    decode(&b, 0)?;
    Ok(b)
}
pub fn decode(b: &[u8], offset: u64) -> Result<Transaction> {
    let (body, count, previous, generation, operations) = read_tx_header(b)?;
    if b.len() != body + COMMIT_SIZE {
        return Err(bad("WAL transaction has the wrong length."));
    }
    let crc = n32(b, body - 4);
    let marker = &b[body..];
    if crc != crc32fast::hash(&b[..body - 4])
        || &marker[..8] != b"WNCMIT03"
        || n64(marker, 8) != generation
        || n32(marker, 16) != crc
        || marker[20..28] != [0; 8]
        || n32(marker, 28) != crc32fast::hash(&marker[..28])
    {
        return Err(bad(
            "A complete WAL transaction or commit marker failed validation.",
        ));
    }
    let meta = Meta::decode(&b[TX_HEADER..TX_HEADER + PAGE_SIZE]).map_err(|e| bad(&e.message))?;
    if meta.generation != generation
        || meta.next_id < previous.next_id
        || meta.records < previous.records
    {
        return Err(bad(
            "Transaction metadata regresses allocation or record count.",
        ));
    }
    let mut images = BTreeMap::new();
    images.insert(0, b[TX_HEADER..TX_HEADER + PAGE_SIZE].try_into().unwrap());
    let mut prior_id = 0;
    for i in 1..count {
        let image: Image = b[TX_HEADER + i * PAGE_SIZE..TX_HEADER + (i + 1) * PAGE_SIZE]
            .try_into()
            .unwrap();
        let node = Node::decode(&image).map_err(|e| bad(&e.message))?;
        if node.id <= prior_id || node.id >= meta.next_id || node.generation != generation {
            return Err(bad(
                "Transaction images must have ordered unique IDs and the committed generation.",
            ));
        }
        prior_id = node.id;
        images.insert(node.id, image);
    }
    if (previous.next_id..meta.next_id).any(|id| !images.contains_key(&id)) {
        return Err(bad(
            "A newly allocated page is missing from its transaction.",
        ));
    }
    let frame = WalFrame {
        generation,
        previous_generation: previous.generation,
        operations,
        offset,
        length: b.len(),
        checksum: format!("{crc:08x}"),
        page_ids: images.keys().copied().collect(),
        root_page_id: meta.root,
        tree_height: meta.height,
    };
    Ok(Transaction {
        frame,
        previous,
        meta,
        images,
    })
}
pub struct Scan {
    pub frames: Vec<WalFrame>,
    pub first_previous: Option<Meta>,
    pub latest: Option<Meta>,
    pub images: BTreeMap<u32, Image>,
    pub valid_end: u64,
    pub tail_bytes: u64,
}
pub fn scan<S: Storage>(wal: &mut S) -> Result<Scan> {
    let size = wal.size()?;
    if !(FILE_HEADER as u64..=MAX_WAL_BYTES).contains(&size) {
        return Err(bad("WAL size is outside supported bounds."));
    }
    let mut scan = Scan {
        frames: vec![],
        first_previous: None,
        latest: None,
        images: BTreeMap::new(),
        valid_end: FILE_HEADER as u64,
        tail_bytes: 0,
    };
    while scan.valid_end < size {
        let remain = size - scan.valid_end;
        if remain < TX_HEADER as u64 {
            break;
        }
        if scan.frames.len() >= MAX_FRAMES {
            return Err(bad("WAL transaction count exceeds its limit."));
        }
        let mut header = [0; TX_HEADER];
        wal.read_exact_at(scan.valid_end, &mut header)?;
        let (body, _, _, _, _) = read_tx_header(&header)?;
        if remain < (body + COMMIT_SIZE) as u64 {
            break;
        }
        let mut bytes = vec![0; body + COMMIT_SIZE];
        wal.read_exact_at(scan.valid_end, &mut bytes)?;
        let tx = decode(&bytes, scan.valid_end)?;
        if scan
            .latest
            .as_ref()
            .is_some_and(|last| last != &tx.previous)
        {
            return Err(bad("The WAL metadata chain has a gap or mismatch."));
        }
        if scan.first_previous.is_none() {
            scan.first_previous = Some(tx.previous);
        }
        scan.latest = Some(tx.meta);
        scan.images.extend(tx.images);
        scan.valid_end += tx.frame.length as u64;
        scan.frames.push(tx.frame);
    }
    scan.tail_bytes = size - scan.valid_end;
    Ok(scan)
}
