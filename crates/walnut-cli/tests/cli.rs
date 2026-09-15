use std::process::{Command, Output};
fn run(args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_walnut"))
        .args(args)
        .output()
        .unwrap()
}
fn json(output: &Output) -> serde_json::Value {
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).unwrap()
}

#[test]
fn commands_persist_across_separate_processes() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("db.bin");
    let path = path.to_str().unwrap();
    assert_eq!(json(&run(&["create", path]))["generation"], 0);
    json(&run(&["put", path, "hello", "world"]));
    assert_eq!(json(&run(&["get", path, "hello"]))["value"], "world");
    json(&run(&["put", path, "hello", "updated"]));
    assert_eq!(
        json(&run(&["inspect", path]))["records"][0]["value"],
        "updated"
    );
    assert_eq!(json(&run(&["get", path, "absent"]))["found"], false);
    assert!(!run(&["create", path]).status.success());
    assert_eq!(json(&run(&["get", path, "hello"]))["value"], "updated");
}

#[test]
fn corrupt_file_and_bad_commands_have_structured_errors() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("bad.db");
    std::fs::write(&path, [1, 2, 3]).unwrap();
    for args in [vec!["inspect", path.to_str().unwrap()], vec!["unknown"]] {
        let output = run(&args);
        assert!(!output.status.success());
        let error: serde_json::Value = serde_json::from_slice(&output.stderr).unwrap();
        assert!(error["error"]["code"].is_string());
    }
}

#[test]
fn actual_process_termination_at_all_commit_and_checkpoint_boundaries() {
    let boundaries = [
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
    let temp = tempfile::tempdir().unwrap();
    for (index, boundary) in boundaries.into_iter().enumerate() {
        let report = json(&run(&["lab", temp.path().to_str().unwrap(), boundary]));
        assert_eq!(report["boundary"], boundary);
        assert_eq!(report["process_terminated"], true);
        assert_eq!(report["commit_returned"], index >= 4);
        assert_eq!(
            report["outcome"],
            if index < 2 {
                "batch_absent"
            } else {
                "batch_recovered"
            }
        );
        assert_eq!(
            report["snapshot"]["records"].as_array().unwrap().len(),
            if index < 2 { 1 } else { 3 }
        );
        if index == 1 {
            assert_eq!(report["snapshot"]["recovery"]["discarded_tail_bytes"], 4132);
        }
        let path = report["database_path"].as_str().unwrap();
        let again = json(&run(&["inspect", path]));
        assert_eq!(again["records"], report["snapshot"]["records"]);
        json(&run(&["put", path, "continued", "yes"]));
        json(&run(&["checkpoint", path]));
        assert_eq!(json(&run(&["get", path, "continued"]))["value"], "yes");
    }
}

#[test]
fn cli_batches_increment_once_and_checkpoint_resets_wal() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("batch.db");
    let path = path.to_str().unwrap();
    json(&run(&["create", path]));
    let batch = json(&run(&[
        "batch",
        path,
        r#"[{"key":"alpha","value":"one"},{"key":"beta","value":"two"}]"#,
    ]));
    assert_eq!(batch["generation"], 1);
    assert_eq!(batch["records"].as_array().unwrap().len(), 2);
    assert_eq!(batch["checkpoint_generation"], 0);
    let checkpoint = json(&run(&["checkpoint", path]));
    assert_eq!(checkpoint["checkpoint_generation"], 1);
    assert_eq!(checkpoint["wal_bytes"], 64);
    assert_eq!(json(&run(&["get", path, "alpha"]))["value"], "one");
}
