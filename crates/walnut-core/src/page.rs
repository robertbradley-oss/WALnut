use crate::{Error, Result};
use serde::Serialize;

pub const PAGE_SIZE: usize = 4096;
pub const HEADER_SIZE: usize = 64;
pub const KEY_LIMIT: usize = 64;
pub const VALUE_LIMIT: usize = 1024;
pub const MAX_PAGES: u32 = 1024;
pub const MAX_HEIGHT: u32 = 16;
pub type Image = [u8; PAGE_SIZE];

pub(crate) fn bad(message: &str) -> Error {
    Error::new("corrupt_tree", message)
}
pub(crate) fn n16(bytes: &[u8], at: usize) -> usize {
    u16::from_le_bytes(bytes[at..at + 2].try_into().unwrap()) as usize
}
pub(crate) fn n32(bytes: &[u8], at: usize) -> u32 {
    u32::from_le_bytes(bytes[at..at + 4].try_into().unwrap())
}
pub(crate) fn n64(bytes: &[u8], at: usize) -> u64 {
    u64::from_le_bytes(bytes[at..at + 8].try_into().unwrap())
}
fn crc(bytes: &[u8]) -> u32 {
    let mut h = crc32fast::Hasher::new();
    h.update(&bytes[..28]);
    h.update(&[0; 4]);
    h.update(&bytes[32..]);
    h.finalize()
}
fn seal(mut bytes: Image) -> Image {
    let sum = crc(&bytes);
    bytes[28..32].copy_from_slice(&sum.to_le_bytes());
    bytes
}
fn header(
    kind: u8,
    level: u8,
    id: u32,
    generation: u64,
    count: usize,
    used: usize,
) -> Result<Image> {
    if used > PAGE_SIZE || count > u16::MAX as usize {
        return Err(Error::new("page_full", "Encoded page exceeds 4 KB."));
    }
    let mut b = [0; PAGE_SIZE];
    b[..8].copy_from_slice(b"WALPAGE2");
    b[8..10].copy_from_slice(&2u16.to_le_bytes());
    b[10] = kind;
    b[11] = level;
    b[12..16].copy_from_slice(&id.to_le_bytes());
    b[16..24].copy_from_slice(&generation.to_le_bytes());
    b[24..26].copy_from_slice(&(count as u16).to_le_bytes());
    b[26..28].copy_from_slice(&(used as u16).to_le_bytes());
    Ok(b)
}
fn check(bytes: &[u8]) -> Result<()> {
    if bytes.len() != PAGE_SIZE || &bytes[..8] != b"WALPAGE2" || n16(bytes, 8) != 2 {
        return Err(bad("Wrong page size, magic, or version."));
    }
    if n32(bytes, 28) != crc(bytes) || !(HEADER_SIZE..=PAGE_SIZE).contains(&n16(bytes, 26)) {
        return Err(bad("Page checksum or used-byte boundary is invalid."));
    }
    if bytes[n16(bytes, 26)..].iter().any(|b| *b != 0) {
        return Err(bad("Unused page bytes must be zero."));
    }
    Ok(())
}
pub fn validate_key(key: &str) -> Result<()> {
    if key.is_empty() || key.len() > KEY_LIMIT {
        return Err(Error::new(
            "invalid_key",
            "Keys must contain 1–64 UTF-8 bytes.",
        ));
    }
    Ok(())
}
pub fn validate_value(value: &str) -> Result<()> {
    if value.len() > VALUE_LIMIT {
        return Err(Error::new(
            "invalid_value",
            "Values may contain at most 1,024 UTF-8 bytes.",
        ));
    }
    Ok(())
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Meta {
    pub generation: u64,
    pub root: u32,
    pub next_id: u32,
    pub height: u32,
    pub records: u64,
    pub state_crc: u32,
}
impl Meta {
    pub fn validate(&self) -> Result<()> {
        if self.next_id < 2
            || self.next_id > MAX_PAGES + 1
            || self.root == 0
            || self.root >= self.next_id
            || !(1..=MAX_HEIGHT).contains(&self.height)
        {
            return Err(bad(
                "Root, allocation, or height metadata is out of bounds.",
            ));
        }
        Ok(())
    }
    pub fn encode(&self) -> Result<Image> {
        self.validate()?;
        let mut b = header(0, 0, 0, self.generation, 0, HEADER_SIZE)?;
        b[32..36].copy_from_slice(&self.root.to_le_bytes());
        b[36..40].copy_from_slice(&self.next_id.to_le_bytes());
        b[40..44].copy_from_slice(&self.height.to_le_bytes());
        b[48..56].copy_from_slice(&self.records.to_le_bytes());
        b[56..60].copy_from_slice(&self.state_crc.to_le_bytes());
        Ok(seal(b))
    }
    pub fn decode(b: &[u8]) -> Result<Self> {
        check(b)?;
        if b[10] != 0
            || b[11] != 0
            || n32(b, 12) != 0
            || n16(b, 24) != 0
            || n16(b, 26) != HEADER_SIZE
            || b[44..48] != [0; 4]
            || b[60..64] != [0; 4]
        {
            return Err(bad("Invalid metadata page structure."));
        }
        let meta = Self {
            generation: n64(b, 16),
            root: n32(b, 32),
            next_id: n32(b, 36),
            height: n32(b, 40),
            records: n64(b, 48),
            state_crc: n32(b, 56),
        };
        meta.validate()?;
        Ok(meta)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Contents {
    Leaf {
        entries: Vec<(String, String)>,
        next: u32,
    },
    Internal {
        keys: Vec<String>,
        children: Vec<u32>,
    },
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Node {
    pub id: u32,
    pub generation: u64,
    pub level: u8,
    pub contents: Contents,
}
#[derive(Clone, Debug, Serialize)]
pub struct Record {
    pub key: String,
    pub value: String,
    pub offset: usize,
    pub length: usize,
    pub key_offset: usize,
    pub key_length: usize,
    pub value_offset: usize,
    pub value_length: usize,
}
impl Node {
    pub fn leaf(id: u32, generation: u64) -> Self {
        Self {
            id,
            generation,
            level: 0,
            contents: Contents::Leaf {
                entries: vec![],
                next: 0,
            },
        }
    }
    pub fn kind(&self) -> &'static str {
        match self.contents {
            Contents::Leaf { .. } => "leaf",
            Contents::Internal { .. } => "internal",
        }
    }
    pub fn count(&self) -> usize {
        match &self.contents {
            Contents::Leaf { entries, .. } => entries.len(),
            Contents::Internal { keys, .. } => keys.len(),
        }
    }
    pub fn used_bytes(&self) -> usize {
        HEADER_SIZE
            + match &self.contents {
                Contents::Leaf { entries, .. } => entries
                    .iter()
                    .map(|(k, v)| 4 + k.len() + v.len())
                    .sum::<usize>(),
                Contents::Internal { keys, .. } => keys.iter().map(|k| 6 + k.len()).sum::<usize>(),
            }
    }
    pub fn records(&self) -> Vec<Record> {
        let Contents::Leaf { entries, .. } = &self.contents else {
            return vec![];
        };
        let mut at = HEADER_SIZE;
        entries
            .iter()
            .map(|(k, v)| {
                let length = 4 + k.len() + v.len();
                let r = Record {
                    key: k.clone(),
                    value: v.clone(),
                    offset: at,
                    length,
                    key_offset: at + 4,
                    key_length: k.len(),
                    value_offset: at + 4 + k.len(),
                    value_length: v.len(),
                };
                at += length;
                r
            })
            .collect()
    }
    pub fn encode(&self) -> Result<Image> {
        if self.id == 0 || self.id > MAX_PAGES {
            return Err(bad("Node ID is outside allocation bounds."));
        }
        let mut b = header(
            if self.level == 0 { 1 } else { 2 },
            self.level,
            self.id,
            self.generation,
            self.count(),
            self.used_bytes(),
        )?;
        let mut at = HEADER_SIZE;
        match &self.contents {
            Contents::Leaf { entries, next } => {
                if self.level != 0 || *next > MAX_PAGES {
                    return Err(bad("Leaf level or next-leaf ID is invalid."));
                }
                b[32..36].copy_from_slice(&next.to_le_bytes());
                for (k, v) in entries {
                    validate_key(k)?;
                    validate_value(v)?;
                    b[at..at + 2].copy_from_slice(&(k.len() as u16).to_le_bytes());
                    b[at + 2..at + 4].copy_from_slice(&(v.len() as u16).to_le_bytes());
                    b[at + 4..at + 4 + k.len()].copy_from_slice(k.as_bytes());
                    b[at + 4 + k.len()..at + 4 + k.len() + v.len()].copy_from_slice(v.as_bytes());
                    at += 4 + k.len() + v.len();
                }
            }
            Contents::Internal { keys, children } => {
                if self.level == 0
                    || self.level as u32 >= MAX_HEIGHT
                    || keys.is_empty()
                    || children.len() != keys.len() + 1
                    || children.iter().any(|c| *c == 0 || *c > MAX_PAGES)
                {
                    return Err(bad("Invalid internal page layout."));
                }
                b[32..36].copy_from_slice(&children[0].to_le_bytes());
                for (key, child) in keys.iter().zip(&children[1..]) {
                    validate_key(key)?;
                    b[at..at + 2].copy_from_slice(&(key.len() as u16).to_le_bytes());
                    b[at + 2..at + 6].copy_from_slice(&child.to_le_bytes());
                    b[at + 6..at + 6 + key.len()].copy_from_slice(key.as_bytes());
                    at += 6 + key.len();
                }
            }
        }
        let b = seal(b);
        Self::decode(&b)?;
        Ok(b)
    }
    pub fn decode(b: &[u8]) -> Result<Self> {
        check(b)?;
        let id = n32(b, 12);
        let level = b[11];
        let count = n16(b, 24);
        let used = n16(b, 26);
        if id == 0
            || id > MAX_PAGES
            || b[36..64].iter().any(|b| *b != 0)
            || !matches!((b[10], level), (1, 0) | (2, 1..=15))
        {
            return Err(bad("Invalid node header."));
        }
        let mut at = HEADER_SIZE;
        let mut prior: Option<String> = None;
        let mut entries = vec![];
        let mut keys = vec![];
        let mut children = vec![n32(b, 32)];
        for _ in 0..count {
            let prefix = if level == 0 { 4 } else { 6 };
            if at + prefix > used {
                return Err(bad("Truncated record header."));
            }
            let klen = n16(b, at);
            let vlen = if level == 0 { n16(b, at + 2) } else { 0 };
            if klen == 0
                || klen > KEY_LIMIT
                || vlen > VALUE_LIMIT
                || at + prefix + klen + vlen > used
            {
                return Err(bad("Invalid record byte bounds."));
            }
            let key = std::str::from_utf8(&b[at + prefix..at + prefix + klen])
                .map_err(|_| bad("Key is not UTF-8."))?
                .to_owned();
            if prior.as_ref().is_some_and(|p| p >= &key) {
                return Err(bad("Page keys must be strictly ordered."));
            }
            prior = Some(key.clone());
            if level == 0 {
                let value = std::str::from_utf8(&b[at + prefix + klen..at + prefix + klen + vlen])
                    .map_err(|_| bad("Value is not UTF-8."))?
                    .to_owned();
                entries.push((key, value));
            } else {
                keys.push(key);
                children.push(n32(b, at + 2));
            }
            at += prefix + klen + vlen;
        }
        if at != used {
            return Err(bad("Count and used bytes disagree."));
        }
        let contents = if level == 0 {
            if n32(b, 32) > MAX_PAGES {
                return Err(bad("Next leaf ID is out of bounds."));
            }
            Contents::Leaf {
                entries,
                next: n32(b, 32),
            }
        } else {
            if keys.is_empty() || children.iter().any(|c| *c == 0 || *c > MAX_PAGES) {
                return Err(bad(
                    "Internal page must have valid children and separators.",
                ));
            }
            Contents::Internal { keys, children }
        };
        Ok(Self {
            id,
            generation: n64(b, 16),
            level,
            contents,
        })
    }
}
