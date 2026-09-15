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
    "after_frame",
    "after_commit_marker",
    "after_wal_sync",
    "after_commit_return",
    "before_checkpoint_write",
    "after_checkpoint_write",
    "after_checkpoint_sync",
    "after_wal_truncate",
    "after_reset_sync",
];

fn validate(boundary: &str) -> Result<()> {
    if !BOUNDARIES.contains(&boundary) {
        return Err(Error::new(
            "invalid_boundary",
            "Unknown recovery-lab boundary.",
        ));
    }
    Ok(())
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

pub fn worker(path: &Path, boundary: &str) -> Result<()> {
    validate(boundary)?;
    let mut engine = open_file(path, true)?;
    let selected = boundary.to_owned();
    engine.set_boundary_hook(move |name| {
        if name == selected {
            pause(name);
        }
    });
    engine.stage("alpha", "one")?;
    engine.stage("beta", "two")?;
    engine.commit()?;
    if boundary == "after_commit_return" {
        pause(boundary);
    }
    engine.checkpoint()?;
    Err(Error::new(
        "lab_missed_boundary",
        "The worker did not reach its requested boundary.",
    ))
}

pub fn run(directory: &Path, boundary: &str) -> Result<Value> {
    validate(boundary)?;
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
    {
        let mut seed = create_file(&path, true)?;
        seed.put("seed", "kept")?;
        seed.checkpoint()?;
    }
    let mut command = Command::new(std::env::current_exe()?);
    command
        .args([
            "__crash-worker",
            path.to_str()
                .ok_or_else(|| Error::new("invalid_path", "Lab path must be UTF-8."))?,
            boundary,
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
    let engine = open_file(&path, true)?;
    let snapshot = engine.snapshot()?;
    let alpha = snapshot
        .records
        .iter()
        .find(|r| r.key == "alpha")
        .map(|r| r.value.as_str());
    let beta = snapshot
        .records
        .iter()
        .find(|r| r.key == "beta")
        .map(|r| r.value.as_str());
    let seed = snapshot
        .records
        .iter()
        .find(|r| r.key == "seed")
        .map(|r| r.value.as_str());
    let outcome = match (alpha, beta, seed) {
        (None, None, Some("kept")) => "batch_absent",
        (Some("one"), Some("two"), Some("kept")) => "batch_recovered",
        _ => "invariant_failed",
    };
    if outcome == "invariant_failed" {
        return Err(Error::new(
            "lab_invariant_failed",
            "The recovered records violate batch atomicity or lost the baseline.",
        ));
    }
    let mut snapshot = serde_json::to_value(snapshot).unwrap();
    snapshot["database_name"] = json!("scenario.db");
    Ok(
        json!({"run_id":run_id,"boundary":boundary,"process_id":pid,"process_terminated":true,
        "process_exit":status.to_string(),"outcome":outcome,"database_path":path,"snapshot":snapshot,
        "failure_model":"process_termination","commit_returned":BOUNDARIES.iter().position(|b| *b == boundary).unwrap() >= 4}),
    )
}
