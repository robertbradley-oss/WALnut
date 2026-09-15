use crate::{Error, PAGE_SIZE, Page, Result, Storage};
use serde::Serialize;

pub const FILE_HEADER: usize = 64;
pub const BODY_SIZE: usize = 32 + PAGE_SIZE + 4;
pub const FRAME_SIZE: usize = BODY_SIZE + 32;
pub const MAX_FRAMES: usize = 1024;
pub const DB_MAGIC: &[u8; 8] = b"WALNDB02";
pub const WAL_MAGIC: &[u8; 8] = b"WALNWAL2";

fn bad(message: &str) -> Error {
    Error::new("corrupt_wal", message)
}
fn n64(bytes: &[u8], at: usize) -> u64 {
    u64::from_le_bytes(bytes[at..at + 8].try_into().unwrap())
}
fn n32(bytes: &[u8], at: usize) -> u32 {
    u32::from_le_bytes(bytes[at..at + 4].try_into().unwrap())
}

pub fn header(magic: &[u8; 8], id: &[u8; 16]) -> [u8; FILE_HEADER] {
    let mut bytes = [0; FILE_HEADER];
    bytes[..8].copy_from_slice(magic);
    bytes[8..12].copy_from_slice(&2u32.to_le_bytes());
    bytes[12..16].copy_from_slice(&(PAGE_SIZE as u32).to_le_bytes());
    bytes[16..32].copy_from_slice(id);
    let crc = crc32fast::hash(&bytes[..60]);
    bytes[60..].copy_from_slice(&crc.to_le_bytes());
    bytes
}

pub fn read_header<S: Storage>(storage: &mut S, magic: &[u8; 8]) -> Result<[u8; 16]> {
    let mut bytes = [0; FILE_HEADER];
    storage.read_exact_at(0, &mut bytes)?;
    if &bytes[..8] != magic
        || n32(&bytes, 8) != 2
        || n32(&bytes, 12) != PAGE_SIZE as u32
        || bytes[32..60].iter().any(|b| *b != 0)
        || n32(&bytes, 60) != crc32fast::hash(&bytes[..60])
    {
        return Err(Error::new(
            "invalid_file_header",
            "File identity/header is invalid or unsupported.",
        ));
    }
    Ok(bytes[16..32].try_into().unwrap())
}

#[derive(Clone, Debug, Serialize)]
pub struct WalFrame {
    pub generation: u64,
    pub previous_generation: u64,
    pub operations: usize,
    pub offset: u64,
    pub length: usize,
    pub checksum: String,
}

pub fn encode(page: &Page, previous: u64, operations: usize) -> Result<[u8; FRAME_SIZE]> {
    let mut bytes = [0; FRAME_SIZE];
    bytes[..8].copy_from_slice(b"WNFRAME2");
    bytes[8..16].copy_from_slice(&page.generation.to_le_bytes());
    bytes[16..24].copy_from_slice(&previous.to_le_bytes());
    bytes[24..28].copy_from_slice(&(PAGE_SIZE as u32).to_le_bytes());
    bytes[28..32].copy_from_slice(&(operations as u32).to_le_bytes());
    bytes[32..32 + PAGE_SIZE].copy_from_slice(&page.encode()?);
    let body_crc = crc32fast::hash(&bytes[..BODY_SIZE - 4]);
    bytes[BODY_SIZE - 4..BODY_SIZE].copy_from_slice(&body_crc.to_le_bytes());
    let commit = &mut bytes[BODY_SIZE..];
    commit[..8].copy_from_slice(b"WNCOMIT2");
    commit[8..16].copy_from_slice(&page.generation.to_le_bytes());
    commit[16..20].copy_from_slice(&body_crc.to_le_bytes());
    let commit_crc = crc32fast::hash(&commit[..28]);
    commit[28..32].copy_from_slice(&commit_crc.to_le_bytes());
    Ok(bytes)
}

pub fn decode(bytes: &[u8; FRAME_SIZE], offset: u64) -> Result<(WalFrame, [u8; PAGE_SIZE])> {
    let generation = n64(bytes, 8);
    let previous = n64(bytes, 16);
    let operations = n32(bytes, 28) as usize;
    let crc = n32(bytes, BODY_SIZE - 4);
    let commit = &bytes[BODY_SIZE..];
    if &bytes[..8] != b"WNFRAME2"
        || n32(bytes, 24) != PAGE_SIZE as u32
        || !(1..=64).contains(&operations)
        || previous.checked_add(1) != Some(generation)
        || crc != crc32fast::hash(&bytes[..BODY_SIZE - 4])
        || &commit[..8] != b"WNCOMIT2"
        || n64(commit, 8) != generation
        || n32(commit, 16) != crc
        || commit[20..28].iter().any(|b| *b != 0)
        || n32(commit, 28) != crc32fast::hash(&commit[..28])
    {
        return Err(bad(
            "A complete WAL transaction failed validation; recovery will not silently drop it.",
        ));
    }
    let image: [u8; PAGE_SIZE] = bytes[32..32 + PAGE_SIZE].try_into().unwrap();
    let page = Page::decode(&image).map_err(|e| bad(&e.message))?;
    if page.generation != generation {
        return Err(bad("WAL generation and page image disagree."));
    }
    Ok((
        WalFrame {
            generation,
            previous_generation: previous,
            operations,
            offset,
            length: FRAME_SIZE,
            checksum: format!("{crc:08x}"),
        },
        image,
    ))
}

pub struct Scan {
    pub frames: Vec<WalFrame>,
    pub latest: Option<[u8; PAGE_SIZE]>,
    pub valid_end: u64,
    pub tail_bytes: u64,
}

pub fn scan<S: Storage>(wal: &mut S) -> Result<Scan> {
    let size = wal.size()?;
    if size < FILE_HEADER as u64 || size > (FILE_HEADER + MAX_FRAMES * FRAME_SIZE) as u64 {
        return Err(bad("WAL length is outside the supported bounds."));
    }
    let count = (size - FILE_HEADER as u64) / FRAME_SIZE as u64;
    let mut frames: Vec<WalFrame> = Vec::new();
    let mut latest = None;
    for i in 0..count {
        let offset = FILE_HEADER as u64 + i * FRAME_SIZE as u64;
        let mut bytes = [0; FRAME_SIZE];
        wal.read_exact_at(offset, &mut bytes)?;
        let (frame, image) = decode(&bytes, offset)?;
        if frames
            .last()
            .is_some_and(|last| last.generation != frame.previous_generation)
        {
            return Err(bad("The WAL generation chain has a gap or duplicate."));
        }
        frames.push(frame);
        latest = Some(image);
    }
    let valid_end = FILE_HEADER as u64 + count * FRAME_SIZE as u64;
    Ok(Scan {
        frames,
        latest,
        valid_end,
        tail_bytes: size - valid_end,
    })
}
