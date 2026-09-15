use crate::{Engine, Error, FileStorage, PAGE_SIZE, Result, Storage, Tree, legacy};
use std::{
    io,
    path::{Path, PathBuf},
};
pub type FileEngine = Engine<FileStorage, FileStorage>;
pub fn wal_path(path: &Path) -> PathBuf {
    let mut p = path.as_os_str().to_os_string();
    p.push(".wal");
    PathBuf::from(p)
}
fn create_tree(path: &Path, tree: Tree, tracing: bool) -> Result<FileEngine> {
    let mut id = [0; 16];
    getrandom::fill(&mut id).map_err(|e| Error::new("random_failed", e.to_string()))?;
    let data = FileStorage::create(path)?;
    let wal = FileStorage::create(&wal_path(path))?;
    let engine = Engine::create_from_tree(data, wal, id, tree, tracing)?;
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
    create_tree(path, Tree::empty(), tracing)
}
pub fn open_file(path: &Path, tracing: bool) -> Result<FileEngine> {
    let mut data = FileStorage::open(path)?;
    let size = data.size()?;
    if size == PAGE_SIZE as u64 {
        return Err(Error::new(
            "migration_required",
            "Legacy page-sized file. Run walnut upgrade <source> <new-target> to validate and copy it.",
        ));
    }
    if size >= 8 {
        let mut magic = [0; 8];
        data.read_exact_at(0, &mut magic)?;
        if &magic == b"WALNDB02" {
            return Err(Error::new(
                "migration_required",
                "Storage format 2 requires explicit upgrade into a new format-3 pair.",
            ));
        }
    }
    let companion = wal_path(path);
    if !companion.exists() {
        return Err(Error::new(
            "missing_wal",
            "The companion WAL is missing. Restore the matching pair.",
        ));
    }
    Engine::open(data, FileStorage::open(&companion)?, tracing)
}

// Recovery for migration works on a memory copy. The locked source pair is never
// shortened or synchronized as a side effect of opening the legacy engine.
struct CopyStorage(Vec<u8>);
impl Storage for CopyStorage {
    fn size(&mut self) -> io::Result<u64> {
        Ok(self.0.len() as u64)
    }
    fn read_exact_at(&mut self, offset: u64, bytes: &mut [u8]) -> io::Result<()> {
        let at = offset as usize;
        bytes.copy_from_slice(
            self.0
                .get(at..at + bytes.len())
                .ok_or(io::ErrorKind::UnexpectedEof)?,
        );
        Ok(())
    }
    fn write_all_at(&mut self, offset: u64, bytes: &[u8]) -> io::Result<()> {
        let at = offset as usize;
        self.0.resize(self.0.len().max(at + bytes.len()), 0);
        self.0[at..at + bytes.len()].copy_from_slice(bytes);
        Ok(())
    }
    fn sync(&mut self) -> io::Result<()> {
        Ok(())
    }
    fn truncate(&mut self, length: u64) -> io::Result<()> {
        self.0.resize(length as usize, 0);
        Ok(())
    }
}
fn copy(storage: &mut FileStorage, limit: u64) -> Result<Vec<u8>> {
    let size = storage.size()?;
    if size > limit {
        return Err(Error::new(
            "migration_source",
            "Legacy source exceeds its format bounds.",
        ));
    }
    let mut bytes = vec![0; size as usize];
    storage.read_exact_at(0, &mut bytes)?;
    Ok(bytes)
}
pub fn upgrade_file(source: &Path, target: &Path, tracing: bool) -> Result<FileEngine> {
    let mut data = FileStorage::open(source)?;
    let bytes = copy(&mut data, (PAGE_SIZE + 64) as u64)?;
    let (entries, generation, _companion) = if bytes.len() == PAGE_SIZE {
        let page = legacy::Page::decode(&bytes)?;
        (
            page.entries.into_iter().collect::<Vec<_>>(),
            page.generation,
            None,
        )
    } else if bytes.starts_with(b"WALNDB02") {
        let mut log = FileStorage::open(&wal_path(source))?;
        let log_bytes = copy(
            &mut log,
            (legacy::wal::FILE_HEADER + legacy::wal::FRAME_SIZE * legacy::wal::MAX_FRAMES) as u64,
        )?;
        let recovered = legacy::Engine::open(CopyStorage(bytes), CopyStorage(log_bytes), false)?;
        let snapshot = recovered.snapshot()?;
        (
            snapshot
                .records
                .into_iter()
                .map(|r| (r.key, r.value))
                .collect(),
            snapshot.generation,
            Some(log),
        )
    } else {
        return Err(Error::new(
            "migration_source",
            "Upgrade accepts legacy standalone pages or format-2 pairs.",
        ));
    };
    create_tree(target, Tree::from_entries(entries, generation)?, tracing)
}
