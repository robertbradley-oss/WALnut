use std::{cell::RefCell, io, rc::Rc};
use walnut_core::{Engine, Storage, WriteOp};
#[derive(Clone, Copy, Default)]
pub enum Fault {
    #[default]
    None,
    Write(usize),
    Sync,
    Read,
    Mismatch,
    Truncate(usize),
}
#[derive(Default)]
pub struct Memory {
    pub live: Vec<u8>,
    pub stable: Vec<u8>,
    pub fault: Fault,
}
#[derive(Clone, Default)]
pub struct Disk(pub Rc<RefCell<Memory>>);
impl Disk {
    pub fn crash(&self, power: bool) {
        let mut m = self.0.borrow_mut();
        if power {
            m.live = m.stable.clone();
        }
        m.fault = Fault::None;
    }
    pub fn fail(&self, fault: Fault) {
        self.0.borrow_mut().fault = fault;
    }
    pub fn bytes(&self) -> Vec<u8> {
        self.0.borrow().live.clone()
    }
    pub fn replace(&self, bytes: Vec<u8>) {
        self.0.borrow_mut().live = bytes;
    }
}
impl Storage for Disk {
    fn size(&mut self) -> io::Result<u64> {
        Ok(self.0.borrow().live.len() as u64)
    }
    fn read_exact_at(&mut self, offset: u64, bytes: &mut [u8]) -> io::Result<()> {
        let m = self.0.borrow();
        if matches!(m.fault, Fault::Read) {
            return Err(io::Error::other("injected read failure"));
        }
        let at = offset as usize;
        bytes.copy_from_slice(
            m.live
                .get(at..at + bytes.len())
                .ok_or(io::ErrorKind::UnexpectedEof)?,
        );
        if matches!(m.fault, Fault::Mismatch) {
            bytes[0] ^= 1;
        }
        Ok(())
    }
    fn write_all_at(&mut self, offset: u64, bytes: &[u8]) -> io::Result<()> {
        let mut m = self.0.borrow_mut();
        let count = if let Fault::Write(n) = m.fault {
            n.min(bytes.len())
        } else {
            bytes.len()
        };
        let at = offset as usize;
        let length = m.live.len().max(at + count);
        m.live.resize(length, 0);
        m.live[at..at + count].copy_from_slice(&bytes[..count]);
        if matches!(m.fault, Fault::Write(_)) {
            return Err(io::Error::other("injected partial write"));
        }
        Ok(())
    }
    fn sync(&mut self) -> io::Result<()> {
        let mut m = self.0.borrow_mut();
        if matches!(m.fault, Fault::Sync) {
            return Err(io::Error::other("injected sync failure"));
        }
        m.stable = m.live.clone();
        Ok(())
    }
    fn truncate(&mut self, length: u64) -> io::Result<()> {
        let mut m = self.0.borrow_mut();
        if let Fault::Truncate(n) = m.fault {
            m.live.truncate(n);
            return Err(io::Error::other("injected truncate failure"));
        }
        m.live.resize(length as usize, 0);
        Ok(())
    }
}
pub type TestEngine = Engine<Disk, Disk>;
pub fn key(i: usize) -> String {
    format!("item/{i:05}/{}", "k".repeat(53))
}
pub fn writes(start: usize, count: usize) -> Vec<WriteOp> {
    (start..start + count)
        .map(|i| WriteOp {
            key: key(i),
            value: format!("{i:04}{}", "v".repeat(996)),
        })
        .collect()
}
pub fn fresh(count: usize, checkpoint: bool) -> (Disk, Disk, TestEngine) {
    let d = Disk::default();
    let w = Disk::default();
    let mut e = Engine::create(d.clone(), w.clone(), [7; 16], true).unwrap();
    for batch in writes(0, count).chunks(64) {
        e.batch(batch.to_vec()).unwrap();
    }
    if checkpoint {
        e.checkpoint().unwrap();
    }
    (d, w, e)
}
pub fn assert_records<D: Storage, W: Storage>(engine: &mut Engine<D, W>, count: usize) {
    let records = engine.range("", None, 256).unwrap().records;
    assert_eq!(records.len(), count);
    for (record, expected) in records.iter().zip(writes(0, count)) {
        assert_eq!(record.key, expected.key);
        assert_eq!(record.value, expected.value);
    }
    assert_eq!(engine.snapshot().unwrap().record_count, count as u64);
}
