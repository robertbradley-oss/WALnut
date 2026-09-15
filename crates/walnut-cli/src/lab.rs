use serde_json::{Value, json};
use std::{
    io::{BufRead, BufReader, Write},
    path::Path,
    process::{Command, Stdio},
    sync::mpsc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use walnut_core::{Error, Result, create_file, open_file};

pub const BOUNDARIES: &[&str] = &[
    "before_frame",
    "after_wal_header",
    "after_wal_page:0",
    "after_frame",
    "after_commit_marker",
    "after_wal_sync",
    "after_commit_return",
    "before_checkpoint_write",
    "after_checkpoint_page:3",
    "after_checkpoint_write",
    "after_checkpoint_sync",
    "after_wal_truncate",
    "after_reset_sync",
];

fn validate(boundary: &str, scenario: &str) -> Result<usize> {
    if !BOUNDARIES.contains(&boundary) {
        return Err(Error::new(
            "invalid_boundary",
            "Unknown recovery-lab boundary.",
        ));
    }
    match scenario {
        "leaf_split" => Ok(3),
        "root_split" => Ok(116),
        _ => Err(Error::new(
            "invalid_scenario",
            "Choose leaf_split or root_split.",
        )),
    }
}
fn pause(boundary: &str) {
    println!("WALNUT_PAUSED:{boundary}");
    std::io::stdout()
        .flush()
        .expect("flush diagnostic boundary");
    // Bound worker lifetime if its parent is terminated before it can reap us.
    std::thread::sleep(Duration::from_secs(20));
    std::process::exit(2);
}

pub fn worker(path: &Path, boundary: &str, scenario: &str) -> Result<()> {
    let count = validate(boundary, scenario)?;
    let mut engine = open_file(path, true)?;
    let selected = boundary.to_owned();
    engine.set_boundary_hook(move |name| {
        if name == selected {
            pause(name);
        }
    });
    engine.batch(crate::workload::split_writes(count, 2))?;
    if boundary == "after_commit_return" {
        pause(boundary);
    }
    engine.checkpoint()?;
    Err(Error::new(
        "lab_missed_boundary",
        "The worker did not reach its requested boundary.",
    ))
}

pub fn run(directory: &Path, boundary: &str, scenario: &str) -> Result<Value> {
    let count = validate(boundary, scenario)?;
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
    let path = run_dir.join("scenario.db");
    let baseline = {
        let mut seed = create_file(&path, true)?;
        for writes in crate::workload::split_writes(0, count).chunks(64) {
            seed.batch(writes.to_vec())?;
        }
        seed.checkpoint()?;
        let state = seed.snapshot()?;
        json!({"record_count":state.record_count,"page_count":state.page_count,
            "tree_height":state.tree_height,"root_page_id":state.root_page_id,"generation":state.generation})
    };
    let mut command = Command::new(std::env::current_exe()?);
    command
        .args([
            "__crash-worker",
            path.to_str()
                .ok_or_else(|| Error::new("invalid_path", "Lab path must be UTF-8."))?,
            boundary,
            scenario,
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    let mut child = command.spawn()?;
    let pid = child.id();
    let stdout = child.stdout.take().unwrap();
    let (sender, receiver) = mpsc::channel();
    let reader = std::thread::spawn(move || {
        let mut line = String::new();
        let result = BufReader::new(stdout).read_line(&mut line).map(|_| line);
        let _ = sender.send(result);
    });
    let paused = receiver.recv_timeout(Duration::from_secs(10));
    // Always reap the disposable worker, including timeout/error paths.
    let killed = child.kill();
    let status = child.wait()?;
    let _ = reader.join();
    killed?;
    let line = paused.map_err(|_| {
        Error::new(
            "lab_timeout",
            "The worker did not report its pause point within 10 seconds.",
        )
    })??;
    if line.trim() != format!("WALNUT_PAUSED:{boundary}") {
        return Err(Error::new(
            "lab_failed",
            "The worker exited without confirming the requested pause point.",
        ));
    }
    let mut engine = open_file(&path, true)?;
    let records = engine.range("", None, 256)?.records;
    let outcome = match records.len() {
        n if n == count => "batch_absent",
        n if n == count + 2 => "batch_recovered",
        _ => "invariant_failed",
    };
    let expected = crate::workload::split_writes(0, records.len());
    if outcome == "invariant_failed"
        || records
            .iter()
            .zip(&expected)
            .any(|(actual, want)| actual.key != want.key || actual.value != want.value)
    {
        return Err(Error::new(
            "lab_invariant_failed",
            "The recovered records violate batch atomicity or lost the baseline.",
        ));
    }
    let attempted: Vec<Value> = crate::workload::split_writes(count, 2).iter().map(|write| {
        let record = records.iter().find(|r| r.key == write.key);
        json!({"key":write.key,"found":record.is_some(),"value_bytes":record.map(|r|r.value.len()),"page_id":record.map(|r|r.page_id)})
    }).collect();
    let state = engine.snapshot()?;
    let expected_height = if scenario == "root_split" { 3 } else { 2 };
    if state.tree_height != expected_height - u32::from(outcome == "batch_absent") {
        return Err(Error::new(
            "lab_invariant_failed",
            "The recovered tree has an unexpected height.",
        ));
    }
    let mut snapshot = serde_json::to_value(state).unwrap();
    snapshot["database_name"] = json!("scenario.db");
    Ok(
        json!({"run_id":run_id,"scenario":scenario,"boundary":boundary,"process_id":pid,"process_terminated":true,
        "process_exit":status.to_string(),"outcome":outcome,"database_path":path,"snapshot":snapshot,
        "baseline":baseline,"attempted":attempted,"verified_records":records.len(),
        "failure_model":"process_termination","commit_returned":BOUNDARIES.iter().position(|b| *b == boundary).unwrap() >= BOUNDARIES.iter().position(|b| *b == "after_commit_return").unwrap()}),
    )
}
