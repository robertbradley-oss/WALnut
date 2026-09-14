use crate::{Error, Result};
use std::{
    fs::{File, OpenOptions, TryLockError},
    io::{Read, Seek, SeekFrom, Write},
    path::Path,
};

/// A synchronous I/O boundary. Implementations must complete each operation or
/// return an error; an error may follow a partial write. The engine handles both.
pub trait Storage {
    fn size(&mut self) -> std::io::Result<u64>;
    fn read_exact_at(&mut self, offset: u64, bytes: &mut [u8]) -> std::io::Result<()>;
    fn write_all_at(&mut self, offset: u64, bytes: &[u8]) -> std::io::Result<()>;
    fn sync(&mut self) -> std::io::Result<()>;
}

pub struct FileStorage {
    file: File,
}

impl FileStorage {
    pub fn create(path: &Path) -> Result<Self> {
        Self::lock(
            OpenOptions::new()
                .read(true)
                .write(true)
                .create_new(true)
                .open(path)?,
        )
    }

    pub fn open(path: &Path) -> Result<Self> {
        Self::lock(OpenOptions::new().read(true).write(true).open(path)?)
    }

    fn lock(file: File) -> Result<Self> {
        file.try_lock().map_err(|error| match error {
            TryLockError::WouldBlock => Error::new(
                "database_locked",
                "Another WALnut process owns this database. Close it before opening this file.",
            ),
            TryLockError::Error(error) => Error::from(error),
        })?;
        Ok(Self { file })
    }
}

impl Storage for FileStorage {
    fn size(&mut self) -> std::io::Result<u64> {
        Ok(self.file.metadata()?.len())
    }
    fn read_exact_at(&mut self, offset: u64, bytes: &mut [u8]) -> std::io::Result<()> {
        self.file.seek(SeekFrom::Start(offset))?;
        self.file.read_exact(bytes)
    }
    fn write_all_at(&mut self, offset: u64, bytes: &[u8]) -> std::io::Result<()> {
        self.file.seek(SeekFrom::Start(offset))?;
        self.file.write_all(bytes)
    }
    fn sync(&mut self) -> std::io::Result<()> {
        self.file.sync_all()
    }
}
