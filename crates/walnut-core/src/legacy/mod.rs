//! Historical single-page engine, retained for explicit migration and regression tests.
mod engine;
mod files;
mod page;
pub mod wal;
pub use engine::{Engine, Event, Recovery, Snapshot, WriteOp};
pub use files::{FileEngine, create_file, open_file, upgrade_file, wal_path};
pub use page::{HEADER_SIZE, KEY_LIMIT, PAGE_SIZE, Page, Record, VALUE_LIMIT};
