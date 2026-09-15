//! A paged B+ tree with atomic redo transactions and recoverable checkpoints.
//! See docs/tree-contract.md for format 3 and its failure model.
mod engine;
mod files;
pub mod legacy;
pub mod page;
mod storage;
pub mod tree;
pub mod wal;

pub use engine::{Engine, Event, Recovery, Snapshot, WriteOp};
pub use files::{FileEngine, create_file, open_file, upgrade_file, wal_path};
pub use page::{HEADER_SIZE, KEY_LIMIT, MAX_PAGES, Meta, Node, PAGE_SIZE, Record, VALUE_LIMIT};
pub use storage::{FileStorage, Storage};
pub use tree::{PageSummary, RangeRecord, RangeResult, Tree};

#[derive(Debug)]
pub struct Error {
    pub code: &'static str,
    pub message: String,
}

impl Error {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for Error {}

impl From<std::io::Error> for Error {
    fn from(error: std::io::Error) -> Self {
        Self::new("io", error.to_string())
    }
}

pub type Result<T> = std::result::Result<T, Error>;
