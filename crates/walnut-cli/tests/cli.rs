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
    let temp = tempfile::tempdir().unwrap();
    for scenario in ["leaf_split", "root_split"] {
        for (index, boundary) in boundaries.into_iter().enumerate() {
            let report = json(&run(&[
                "lab",
                temp.path().to_str().unwrap(),
                boundary,
                scenario,
            ]));
            assert_eq!(report["boundary"], boundary);
            assert_eq!(report["process_terminated"], true);
            assert_eq!(report["commit_returned"], index >= 6);
            assert_eq!(
                report["outcome"],
                if index < 4 {
                    "batch_absent"
                } else {
                    "batch_recovered"
                }
            );
            assert_eq!(
                report["snapshot"]["record_count"],
                (if scenario == "leaf_split" { 3 } else { 116 }) + if index < 4 { 0 } else { 2 }
            );
            if index == 3 {
                assert!(
                    report["snapshot"]["recovery"]["discarded_tail_bytes"]
                        .as_u64()
                        .unwrap()
                        > 4 * 4096
                );
            }
            let path = report["database_path"].as_str().unwrap();
            let again = json(&run(&["inspect", path]));
            assert_eq!(again["records"], report["snapshot"]["records"]);
            assert_eq!(
                again["state_checksum"],
                report["snapshot"]["state_checksum"]
            );
            assert_eq!(again["root_page_id"], report["snapshot"]["root_page_id"]);
            json(&run(&["put", path, "continued", "yes"]));
            json(&run(&["checkpoint", path]));
            assert_eq!(json(&run(&["get", path, "continued"]))["value"], "yes");
        }
    }
}

#[test]
fn cli_grows_real_tree_and_ranges_across_leaves() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("tree.db");
    let path = path.to_str().unwrap();
    json(&run(&["create", path]));
    assert_eq!(json(&run(&["grow", path]))["tree_height"], 2);
    let grown = json(&run(&["grow", path]));
    assert_eq!(grown["tree_height"], 3);
    assert_eq!(grown["record_count"], 128);
    let all = json(&run(&["range", path, "", "--limit", "256"]));
    assert_eq!(all["records"].as_array().unwrap().len(), 128);
    assert!(all["next_key"].is_null());
    let key = all["records"][90]["key"].as_str().unwrap();
    assert_eq!(
        json(&run(&["get", path, key]))["value"],
        all["records"][90]["value"]
    );
    let first = json(&run(&["range", path, "", "--limit", "17"]));
    assert_eq!(first["records"].as_array().unwrap().len(), 17);
    let second = json(&run(&[
        "range",
        path,
        first["next_key"].as_str().unwrap(),
        "--end",
        key,
        "--limit",
        "256",
    ]));
    assert_eq!(second["records"].as_array().unwrap().len(), 73);
    let root = grown["root_page_id"].as_u64().unwrap().to_string();
    assert_eq!(
        json(&run(&["inspect", path, &root]))["page_kind"],
        "internal"
    );
    assert_eq!(json(&run(&["inspect", path, "0"]))["page_kind"], "metadata");
    assert!(!run(&["range", path, "", "--limit", "257"]).status.success());
    assert!(!run(&["range", path, "", "--end"]).status.success());
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
