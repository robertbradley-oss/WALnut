use super::{Engine, PAGE_SIZE, Page};
use crate::{Error, FileStorage, Result, Storage};
use std::path::{Path, PathBuf};

pub type FileEngine = Engine<FileStorage, FileStorage>;

pub fn wal_path(path: &Path) -> PathBuf {
    let mut name = path.as_os_str().to_os_string();
    name.push(".wal");
    PathBuf::from(name)
}

fn create_with_page(path: &Path, page: Page, tracing: bool) -> Result<FileEngine> {
    let mut id = [0; 16];
    getrandom::fill(&mut id).map_err(|e| Error::new("random_failed", e.to_string()))?;
    let data = FileStorage::create(path)?;
    let wal = FileStorage::create(&wal_path(path))?;
    let engine = Engine::create_from_page(data, wal, id, page, tracing)?;
    #[cfg(unix)]
    std::fs::File::open(
        path.parent()
            .filter(|p| !p.as_os_str().is_empty())
            .unwrap_or(Path::new(".")),
    )?
    .sync_all()?;
    Ok(engine)
}

pub fn create_file(path: &Path, tracing: bool) -> Result<FileEngine> {
    create_with_page(path, Page::empty(), tracing)
}

pub fn open_file(path: &Path, tracing: bool) -> Result<FileEngine> {
    let mut data = FileStorage::open(path)?;
    if data.size()? == PAGE_SIZE as u64 {
        return Err(Error::new(
            "migration_required",
            "This is a stage 1 file. Run walnut upgrade <source> <new-target>; the source is preserved.",
        ));
    }
    let companion = wal_path(path);
    if !companion.exists() {
        return Err(Error::new(
            "missing_wal",
            "The companion WAL is missing. Restore the matching database/WAL pair.",
        ));
    }
    Engine::open(data, FileStorage::open(&companion)?, tracing)
}

pub fn upgrade_file(source: &Path, target: &Path, tracing: bool) -> Result<FileEngine> {
    let mut old = FileStorage::open(source)?;
    if old.size()? != PAGE_SIZE as u64 {
        return Err(Error::new(
            "migration_source",
            "Upgrade requires a stage 1 file containing exactly one page.",
        ));
    }
    let mut bytes = [0; PAGE_SIZE];
    old.read_exact_at(0, &mut bytes)?;
    create_with_page(target, Page::decode(&bytes)?, tracing)
}
