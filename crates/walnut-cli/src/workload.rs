use walnut_core::{Error, FileEngine, Result, WriteOp};

/// Full-size keys and 1,000-byte values reach real byte-capacity splits quickly.
pub fn split_writes(start: usize, count: usize) -> Vec<WriteOp> {
    (start..start + count)
        .map(|i| WriteOp {
            key: format!("item/{i:05}/{}", "k".repeat(53)),
            value: format!("{i:04}{}", "v".repeat(996)),
        })
        .collect()
}

pub fn grow(engine: &mut FileEngine) -> Result<()> {
    let generation = engine
        .snapshot()?
        .generation
        .checked_add(1)
        .ok_or_else(|| Error::new("generation_limit", "The generation limit has been reached."))?;
    let writes: Vec<WriteOp> = (0..64)
        .map(|i| WriteOp {
            key: format!("sample/{generation:020}/{i:03}/{}", "k".repeat(32)),
            value: format!("Sample {i:03}. {}", "v".repeat(988)),
        })
        .collect();
    for write in &writes {
        if engine.get(&write.key)?.is_some() {
            return Err(Error::new(
                "sample_exists",
                "A generated sample key already exists. No sample records were written.",
            ));
        }
    }
    engine.batch(writes)
}
