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
