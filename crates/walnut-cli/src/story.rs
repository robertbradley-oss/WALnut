//! Recorded operation checkpoints captured from a disposable, real file engine.
//! Playback never supplies engine state and never rewinds a live database.
use serde_json::{Value, json};
use std::{
    io::{BufRead, BufReader, Read, Write},
    path::Path,
    process::{Child, Command, ExitStatus, Stdio},
    sync::mpsc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use walnut_core::{Error, FileEngine, Result, create_file, open_file};

const WORKER_PREFIX: &[u8] = b"WALNUT_STORY_COMMITTED:";
const WORKER_OUTPUT_LIMIT: u64 = 1_048_576;

fn validate(scenario: &str) -> Result<&'static str> {
    match scenario {
        "split" => Ok("One leaf becomes a tree"),
        "recovery" => Ok("A committed split survives a crash"),
        "checkpoint" => Ok("From the log into the main file"),
        _ => Err(Error::new(
            "invalid_scenario",
            "Choose split, recovery, or checkpoint.",
        )),
    }
}

pub(crate) fn capture(engine: &FileEngine, path: &Path, focus: u32) -> Result<Value> {
    let selected = engine.snapshot_page(focus)?;
    let mut pages = Vec::with_capacity(selected.page_count + 1);
    for id in std::iter::once(0).chain(selected.pages.iter().map(|page| page.id)) {
        let page = engine.snapshot_page(id)?;
        pages.push(json!({
            "page_id":page.page_id,"page_kind":page.page_kind,
            "page_generation":page.page_generation,"used_bytes":page.used_bytes,
            "checksum":page.checksum,"records":page.records,"bytes":page.bytes,
            "checkpoint_bytes":page.checkpoint_bytes
        }));
    }
    let mut snapshot = serde_json::to_value(selected).unwrap();
    snapshot["database_name"] = json!(path.file_name().unwrap_or_default().to_string_lossy());
    Ok(json!({"snapshot":snapshot,"pages":pages}))
}

/// Validate all records without adding a read operation to the recorded trace.
fn verify(capture: &Value, count: usize) -> Result<()> {
    let Some(pages) = capture["pages"].as_array() else {
        return Err(Error::new(
            "story_failed",
            "The recorded pages are missing.",
        ));
    };
    let mut records: Vec<(&str, &str)> = pages
        .iter()
        .filter_map(|page| page["records"].as_array())
        .flatten()
        .filter_map(|record| Some((record["key"].as_str()?, record["value"].as_str()?)))
        .collect();
    records.sort_unstable_by_key(|record| record.0);
    let expected = crate::workload::split_writes(0, count);
    let snapshot = &capture["snapshot"];
    if records.len() != count
        || records
            .iter()
            .zip(&expected)
            .any(|(actual, expected)| actual.0 != expected.key || actual.1 != expected.value)
        || snapshot["record_count"] != count
        || snapshot["page_count"] != if count == 3 { 1 } else { 3 }
        || snapshot["tree_height"] != if count == 3 { 1 } else { 2 }
        || pages.len() != if count == 3 { 2 } else { 4 }
    {
        return Err(Error::new(
            "story_invariant_failed",
            "The recorded tree does not contain the complete expected workload.",
        ));
    }
    Ok(())
}

fn frame(kind: &str, title: &str, explanation: &str, command: &str, capture: Value) -> Value {
    json!({"id":kind,"kind":kind,"title":title,"explanation":explanation,
        "command":command,"focus_page_id":capture["snapshot"]["page_id"],"capture":capture})
}

fn committed(capture: Value) -> Value {
    frame(
        "committed",
        "The split is committed",
        "Commit returned after synchronizing and verifying the WAL. Both puts, both leaves, and the new root committed as one transaction. The main file still contains the three-record checkpoint.",
        "commit 2 puts",
        capture,
    )
}

fn lookup(engine: &mut FileEngine, path: &Path) -> Result<Value> {
    let target = &crate::workload::split_writes(4, 1)[0];
    if engine.get(&target.key)?.as_deref() != Some(&target.value) {
        return Err(Error::new(
            "story_invariant_failed",
            "The point lookup did not return its expected value.",
        ));
    }
    let selected = *engine.snapshot()?.last_search_path.last().ok_or_else(|| {
        Error::new(
            "story_invariant_failed",
            "The lookup did not record a page path.",
        )
    })?;
    let capture = capture(engine, path, selected)?;
    verify(&capture, 5)?;
    Ok(frame(
        "lookup",
        "Follow the key to its leaf",
        "The completed point lookup followed the recorded root-to-leaf path and returned the full 1,000-byte value. Select either page to inspect its captured bytes.",
        &format!("get {}", target.key),
        capture,
    ))
}

/// A worker must be killed and reaped even if its protocol or output fails.
struct Worker(Child);
impl Worker {
    fn terminate(&mut self) -> Result<ExitStatus> {
        let killed = self.0.kill();
        let status = self.0.wait()?;
        killed?;
        Ok(status)
    }
}
impl Drop for Worker {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn terminate_after_commit(path: &Path) -> Result<(Value, Value)> {
    let mut command = Command::new(std::env::current_exe()?);
    command
        .arg("__story-crash-worker")
        .arg(path)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    let mut worker = Worker(command.spawn()?);
    let process_id = worker.0.id();
    let stdout = worker.0.stdout.take().unwrap();
    let (sender, receiver) = mpsc::channel();
    let reader = std::thread::spawn(move || {
        let mut line = Vec::new();
        let result = BufReader::new(stdout)
            .take(WORKER_OUTPUT_LIMIT + 1)
            .read_until(b'\n', &mut line)
            .map(|_| line);
        let _ = sender.send(result);
    });
    let reported = receiver.recv_timeout(Duration::from_secs(10));
    let status = worker.terminate();
    let _ = reader.join();
    let status = status?;
    let line = reported.map_err(|_| {
        Error::new(
            "story_timeout",
            "The story worker did not report its committed capture within 10 seconds.",
        )
    })??;
    if line.len() as u64 > WORKER_OUTPUT_LIMIT || !line.ends_with(b"\n") {
        return Err(Error::new(
            "story_failed",
            "The story worker returned an incomplete or oversized capture.",
        ));
    }
    let encoded = line.strip_prefix(WORKER_PREFIX).ok_or_else(|| {
        Error::new(
            "story_failed",
            "The worker did not confirm a returned commit.",
        )
    })?;
    let capture: Value = serde_json::from_slice(encoded).map_err(|_| {
        Error::new(
            "story_failed",
            "The worker returned an invalid committed capture.",
        )
    })?;
    verify(&capture, 5)?;
    Ok((
        capture,
        json!({"process_id":process_id,"process_terminated":true,"process_exit":status.to_string()}),
    ))
}

pub fn worker(path: &Path) -> Result<()> {
    let mut engine = open_file(path, true)?;
    let baseline = capture(&engine, path, 1)?;
    verify(&baseline, 3)?;
    engine.batch(crate::workload::split_writes(3, 2))?;
    let committed = capture(&engine, path, engine.snapshot()?.root_page_id)?;
    verify(&committed, 5)?;
    let mut stdout = std::io::stdout().lock();
    stdout.write_all(WORKER_PREFIX)?;
    serde_json::to_writer(&mut stdout, &committed)
        .map_err(|error| Error::new("story_failed", error.to_string()))?;
    stdout.write_all(b"\n")?;
    stdout.flush()?;
    drop(stdout);
    // The parent terminates us here. If it disappears, do not leave an orphan owner.
    std::thread::sleep(Duration::from_secs(20));
    std::process::exit(2);
}

pub fn run(directory: &Path, scenario: &str) -> Result<Value> {
    // Validation precedes all file creation, including the containing directory.
    let title = validate(scenario)?;
    std::fs::create_dir_all(directory)?;
    let run_id = format!(
        "{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    );
    let run_dir = directory.join(&run_id);
    std::fs::create_dir(&run_dir)?;
    let path = run_dir.canonicalize()?.join("story.db");
    let mut engine = create_file(&path, true)?;
    engine.batch(crate::workload::split_writes(0, 3))?;
    engine.checkpoint()?;
    let baseline = capture(&engine, &path, 1)?;
    verify(&baseline, 3)?;
    let mut frames = vec![frame(
        "baseline",
        "Three records fill one leaf",
        "Three 64-byte keys and three 1,000-byte values fit in page 1. These fixed sizes make the next split reproducible. The main file holds this checkpoint; the WAL contains only its permanent header.",
        "batch 3 puts; checkpoint",
        baseline,
    )];
    let mut process = None;
    if scenario == "recovery" {
        drop(engine);
        let (committed_capture, result) = terminate_after_commit(&path)?;
        frames.push(committed(committed_capture.clone()));
        frames.push(frame(
            "crashed",
            "The database process was terminated",
            "The worker was terminated after commit returned. This frame holds its last-known committed pages, captured before termination; it is not a fresh post-crash snapshot.",
            "terminate worker after commit returns",
            committed_capture.clone(),
        ));
        engine = open_file(&path, true)?;
        let recovered = capture(&engine, &path, engine.snapshot()?.root_page_id)?;
        verify(&recovered, 5)?;
        if recovered["pages"] != committed_capture["pages"]
            || recovered["snapshot"]["state_checksum"]
                != committed_capture["snapshot"]["state_checksum"]
            || recovered["snapshot"]["recovery"]["replayed_transactions"] != 1
        {
            return Err(Error::new(
                "story_invariant_failed",
                "Recovery did not reproduce the acknowledged committed pages.",
            ));
        }
        frames.push(frame(
            "recovered",
            "Recovery restores the whole split",
            "Reopen replayed one committed WAL transaction and validated the tree. All five records and the exact committed page bytes survived. The main file still contains the earlier checkpoint.",
            "reopen story.db",
            recovered,
        ));
        frames.push(lookup(&mut engine, &path)?);
        process = Some(result);
    } else {
        if scenario == "split" {
            for write in crate::workload::split_writes(3, 2) {
                engine.stage(&write.key, &write.value)?;
            }
            let staged = capture(&engine, &path, 1)?;
            verify(&staged, 3)?;
            frames.push(frame(
                "staged",
                "Two puts wait for commit",
                "Both puts are staged in memory. Reads and the captured committed pages still contain three records. The candidate needs three node pages, but none of its changes are committed yet.",
                "stage 2 puts",
                staged,
            ));
            engine.commit()?;
        } else {
            engine.batch(crate::workload::split_writes(3, 2))?;
        }
        let captured = capture(&engine, &path, engine.snapshot()?.root_page_id)?;
        verify(&captured, 5)?;
        frames.push(committed(captured));
        if scenario == "split" {
            frames.push(lookup(&mut engine, &path)?);
        } else {
            engine.checkpoint()?;
            let checkpoint = capture(&engine, &path, engine.snapshot()?.root_page_id)?;
            verify(&checkpoint, 5)?;
            frames.push(frame(
                "checkpointed",
                "The main file catches up",
                "Checkpoint synchronized and verified every committed page in the main file before clearing the WAL. The main-file bytes now match the committed tree, including its root and metadata.",
                "checkpoint",
                checkpoint,
            ));
            drop(engine);
            engine = open_file(&path, true)?;
            let reopened = capture(&engine, &path, engine.snapshot()?.root_page_id)?;
            verify(&reopened, 5)?;
            frames.push(frame(
                "reopened",
                "Reopen reads the checkpoint",
                "A fresh engine opened the same file pair and validated all five records. No WAL transactions needed replaying because the main file already contains this generation.",
                "reopen story.db",
                reopened,
            ));
        }
    }
    let mut result = json!({"schema_version":1,"run_id":run_id,"scenario":scenario,"title":title,
        "source":{"engine_version":env!("CARGO_PKG_VERSION"),"storage_format_version":3,
            "page_format_version":2,"database_path":path,"workload":crate::workload::split_writes(0,5),
            "failure_model":if scenario == "recovery" {"process_termination"} else {"none"}},
        "frames":frames});
    if let Some(process) = process {
        result["process"] = process;
    }
    Ok(result)
}
