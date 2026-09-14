//! WALnut's bounded, single-page storage engine. Stage 1 supports normal reopen,
//! not crash-atomic updates. Failed writes poison the handle until it is reopened.
mod engine;
mod page;
mod storage;

pub use engine::{Engine, Event, Snapshot};
pub use page::{HEADER_SIZE, KEY_LIMIT, PAGE_SIZE, Page, Record, VALUE_LIMIT};
pub use storage::{FileStorage, Storage};

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
