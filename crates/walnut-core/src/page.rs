use crate::{Error, Result};
use serde::Serialize;
use std::collections::BTreeMap;

pub const PAGE_SIZE: usize = 4096;
pub const HEADER_SIZE: usize = 32;
pub const KEY_LIMIT: usize = 64;
pub const VALUE_LIMIT: usize = 1024;
const MAGIC: &[u8; 8] = b"WALNUT\0\0";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Page {
    pub generation: u64,
    pub entries: BTreeMap<String, String>,
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

fn invalid(message: &str) -> Error {
    Error::new("corrupt_page", message)
}
fn u16_at(bytes: &[u8], at: usize) -> usize {
    u16::from_le_bytes([bytes[at], bytes[at + 1]]) as usize
}

fn checksum(bytes: &[u8]) -> u32 {
    let mut hash = crc32fast::Hasher::new();
    hash.update(&bytes[..28]);
    hash.update(&[0; 4]);
    hash.update(&bytes[32..]);
    hash.finalize()
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

impl Page {
    pub fn empty() -> Self {
        Self {
            generation: 0,
            entries: BTreeMap::new(),
        }
    }

    pub fn used_bytes(&self) -> usize {
        HEADER_SIZE
            + self
                .entries
                .iter()
                .map(|(k, v)| 4 + k.len() + v.len())
                .sum::<usize>()
    }

    pub fn with_put(&self, key: &str, value: &str) -> Result<Self> {
        validate_key(key)?;
        if value.len() > VALUE_LIMIT {
            return Err(Error::new(
                "invalid_value",
                "Values may contain at most 1,024 UTF-8 bytes.",
            ));
        }
        let mut next = self.clone();
        next.entries.insert(key.into(), value.into());
        if next.used_bytes() > PAGE_SIZE {
            return Err(Error::new(
                "page_full",
                "This 4 KB page is full. Try a shorter value or update an existing key.",
            ));
        }
        next.generation = self.generation.checked_add(1).ok_or_else(|| {
            Error::new(
                "generation_limit",
                "The page generation limit has been reached.",
            )
        })?;
        Ok(next)
    }

    pub fn records(&self) -> Vec<Record> {
        let mut offset = HEADER_SIZE;
        self.entries
            .iter()
            .map(|(key, value)| {
                let length = 4 + key.len() + value.len();
                let record = Record {
                    key: key.clone(),
                    value: value.clone(),
                    offset,
                    length,
                    key_offset: offset + 4,
                    key_length: key.len(),
                    value_offset: offset + 4 + key.len(),
                    value_length: value.len(),
                };
                offset += length;
                record
            })
            .collect()
    }

    pub fn encode(&self) -> Result<[u8; PAGE_SIZE]> {
        if self.used_bytes() > PAGE_SIZE {
            return Err(Error::new("page_full", "Page exceeds 4 KB."));
        }
        let mut bytes = [0u8; PAGE_SIZE];
        bytes[..8].copy_from_slice(MAGIC);
        bytes[8..10].copy_from_slice(&1u16.to_le_bytes());
        bytes[10..12].copy_from_slice(&(HEADER_SIZE as u16).to_le_bytes());
        bytes[16..24].copy_from_slice(&self.generation.to_le_bytes());
        bytes[24..26].copy_from_slice(&(self.entries.len() as u16).to_le_bytes());
        bytes[26..28].copy_from_slice(&(self.used_bytes() as u16).to_le_bytes());
        for record in self.records() {
            validate_key(&record.key)?;
            if record.value_length > VALUE_LIMIT {
                return Err(Error::new("invalid_value", "Value exceeds 1,024 bytes."));
            }
            bytes[record.offset..record.offset + 2]
                .copy_from_slice(&(record.key_length as u16).to_le_bytes());
            bytes[record.offset + 2..record.offset + 4]
                .copy_from_slice(&(record.value_length as u16).to_le_bytes());
            bytes[record.key_offset..record.value_offset].copy_from_slice(record.key.as_bytes());
            bytes[record.value_offset..record.offset + record.length]
                .copy_from_slice(record.value.as_bytes());
        }
        let crc = checksum(&bytes);
        bytes[28..32].copy_from_slice(&crc.to_le_bytes());
        Ok(bytes)
    }

    pub fn decode(bytes: &[u8]) -> Result<Self> {
        if bytes.len() != PAGE_SIZE {
            return Err(invalid("Expected exactly one 4,096-byte page."));
        }
        if &bytes[..8] != MAGIC {
            return Err(invalid("WALnut magic bytes do not match."));
        }
        if u16_at(bytes, 8) != 1 {
            return Err(Error::new(
                "unsupported_format",
                "Only page format version 1 is supported.",
            ));
        }
        if u16_at(bytes, 10) != HEADER_SIZE || bytes[12..16] != [0; 4] {
            return Err(invalid("Invalid header size or page ID."));
        }
        let crc = u32::from_le_bytes(bytes[28..32].try_into().unwrap());
        if checksum(bytes) != crc {
            return Err(invalid(
                "Page checksum does not match; the bytes have changed.",
            ));
        }
        let used = u16_at(bytes, 26);
        if !(HEADER_SIZE..=PAGE_SIZE).contains(&used) {
            return Err(invalid("Used-byte boundary is outside the page."));
        }
        let mut entries = BTreeMap::new();
        let mut offset = HEADER_SIZE;
        let mut previous: Option<String> = None;
        for _ in 0..u16_at(bytes, 24) {
            if offset + 4 > used {
                return Err(invalid("Truncated record header."));
            }
            let klen = u16_at(bytes, offset);
            let vlen = u16_at(bytes, offset + 2);
            if klen == 0
                || klen > KEY_LIMIT
                || vlen > VALUE_LIMIT
                || offset + 4 + klen + vlen > used
            {
                return Err(invalid("Invalid record length."));
            }
            let start = offset + 4;
            let key = std::str::from_utf8(&bytes[start..start + klen])
                .map_err(|_| invalid("Key is not valid UTF-8."))?;
            let value = std::str::from_utf8(&bytes[start + klen..start + klen + vlen])
                .map_err(|_| invalid("Value is not valid UTF-8."))?;
            if previous.as_deref().is_some_and(|p| p >= key) {
                return Err(invalid("Keys must be strictly ordered and unique."));
            }
            previous = Some(key.into());
            entries.insert(key.into(), value.into());
            offset = start + klen + vlen;
        }
        if offset != used || bytes[used..].iter().any(|byte| *byte != 0) {
            return Err(invalid("Record boundaries or unused bytes are invalid."));
        }
        Ok(Self {
            generation: u64::from_le_bytes(bytes[16..24].try_into().unwrap()),
            entries,
        })
    }
}
