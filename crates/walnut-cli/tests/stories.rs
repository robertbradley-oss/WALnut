use serde_json::{Value, json};
use std::{
    fs,
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    path::Path,
    process::{Child, Command, Stdio},
    time::{Duration, Instant},
};
use walnut_core::{FileEngine, WriteOp, create_file, open_file};

fn run(args: &[&str]) -> Value {
    let output = Command::new(env!("CARGO_BIN_EXE_walnut"))
        .args(args)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).unwrap()
}

fn recording(directory: &Path, scenario: &str) -> Value {
    run(&["story", directory.to_str().unwrap(), scenario])
}

fn writes(start: usize, count: usize) -> Vec<WriteOp> {
    (start..start + count)
        .map(|index| WriteOp {
            key: format!("item/{index:05}/{}", "k".repeat(53)),
            value: format!("{index:04}{}", "v".repeat(996)),
        })
        .collect()
}

fn check_capture(capture: &Value, engine: &FileEngine) {
    let pages = capture["pages"].as_array().unwrap();
    let selected = engine
        .snapshot_page(capture["snapshot"]["page_id"].as_u64().unwrap() as u32)
        .unwrap();
    assert_eq!(pages.len(), selected.page_count + 1);
    for (id, page) in pages.iter().enumerate() {
        assert_eq!(page["page_id"], id);
        let actual = engine.snapshot_page(id as u32).unwrap();
        assert_eq!(page["page_kind"], actual.page_kind);
        assert_eq!(page["page_generation"], actual.page_generation);
        assert_eq!(page["used_bytes"], actual.used_bytes);
        assert_eq!(page["checksum"], actual.checksum);
        assert_eq!(page["records"], json!(actual.records));
        assert_eq!(page["bytes"], json!(actual.bytes));
        assert_eq!(page["checkpoint_bytes"], json!(actual.checkpoint_bytes));
    }
    let actual = serde_json::to_value(selected).unwrap();
    for field in [
        "schema_version",
        "format_version",
        "storage_format_version",
        "page_id",
        "page_kind",
        "page_generation",
        "generation",
        "bytes",
        "records",
        "record_count",
        "page_count",
        "tree_height",
        "root_page_id",
        "state_checksum",
        "checkpoint_bytes",
        "checkpoint_generation",
        "database_bytes",
        "wal_bytes",
        "wal_frames",
        "staged",
        "staged_used_bytes",
        "staged_page_count",
        "pages",
        "last_search_path",
    ] {
        assert_eq!(capture["snapshot"][field], actual[field], "{field}");
    }
}

fn bytes(value: &Value) -> Vec<u8> {
    value
        .as_array()
        .unwrap()
        .iter()
        .map(|byte| byte.as_u64().unwrap() as u8)
        .collect()
}

fn check_final_files(story: &Value) {
    let path = story["source"]["database_path"].as_str().unwrap();
    let capture = &story["frames"].as_array().unwrap().last().unwrap()["capture"];
    let main = fs::read(path).unwrap();
    let wal = fs::read(walnut_core::wal_path(Path::new(path))).unwrap();
    for page in capture["pages"].as_array().unwrap() {
        let id = page["page_id"].as_u64().unwrap();
        let offset = 64 + id as usize * 4096;
        if !page["checkpoint_bytes"].is_null() {
            assert_eq!(
                &main[offset..offset + 4096],
                bytes(&page["checkpoint_bytes"])
            );
        } else {
            assert!(offset >= main.len());
        }
        let inspected = run(&["inspect", path, &id.to_string()]);
        assert_eq!(inspected["bytes"], page["bytes"]);
        assert_eq!(inspected["records"], page["records"]);
    }
    if story["scenario"] == "checkpoint" {
        assert_eq!(wal.len(), 64);
        for page in capture["pages"].as_array().unwrap() {
            assert_eq!(page["bytes"], page["checkpoint_bytes"]);
        }
    } else {
        // One actual transaction: metadata and all three changed node images.
        assert_eq!(wal.len(), 64 + 64 + 4 * 4096 + 4 + 32);
        for (index, page) in capture["pages"].as_array().unwrap().iter().enumerate() {
            let offset = 64 + 64 + index * 4096;
            assert_eq!(&wal[offset..offset + 4096], bytes(&page["bytes"]));
        }
    }
    let all = run(&["range", path, "", "--limit", "256"]);
    for (actual, expected) in all["records"].as_array().unwrap().iter().zip(writes(0, 5)) {
        assert_eq!(actual["key"], expected.key);
        assert_eq!(actual["value"], expected.value);
    }
    assert_eq!(all["records"].as_array().unwrap().len(), 5);
}

#[test]
fn split_and_checkpoint_frames_match_independent_completed_engine_operations() {
    let temp = tempfile::tempdir().unwrap();
    for scenario in ["split", "checkpoint"] {
        let story = recording(temp.path(), scenario);
        assert_eq!(story["schema_version"], 1);
        assert_eq!(story["source"]["failure_model"], "none");
        assert_eq!(story["source"]["workload"], json!(writes(0, 5)));
        assert!(story.get("process").is_none());
        let path = temp.path().join(format!("reference-{scenario}.db"));
        let mut engine = create_file(&path, true).unwrap();
        engine.batch(writes(0, 3)).unwrap();
        engine.checkpoint().unwrap();
        let frames = story["frames"].as_array().unwrap();
        for frame in frames {
            match frame["kind"].as_str().unwrap() {
                "baseline" => {}
                "staged" => {
                    for write in writes(3, 2) {
                        engine.stage(&write.key, &write.value).unwrap();
                    }
                }
                "committed" => {
                    if scenario == "split" {
                        engine.commit().unwrap();
                    } else {
                        engine.batch(writes(3, 2)).unwrap();
                    }
                }
                "lookup" => {
                    engine.get(&writes(4, 1)[0].key).unwrap();
                }
                "checkpointed" => engine.checkpoint().unwrap(),
                "reopened" => {
                    drop(engine);
                    engine = open_file(&path, true).unwrap();
                }
                other => panic!("Unexpected frame {other}"),
            }
            assert_eq!(frame["id"], frame["kind"]);
            assert_eq!(
                frame["focus_page_id"],
                frame["capture"]["snapshot"]["page_id"]
            );
            check_capture(&frame["capture"], &engine);
        }
        assert_eq!(frames.len(), 4);
        check_final_files(&story);
    }
}

#[test]
fn recovery_story_reaps_a_real_worker_and_reproduces_its_exact_committed_pages() {
    let temp = tempfile::tempdir().unwrap();
    let story = recording(temp.path(), "recovery");
    assert_eq!(story["source"]["failure_model"], "process_termination");
    assert_eq!(story["process"]["process_terminated"], true);
    let pid = story["process"]["process_id"].as_u64().unwrap();
    assert_ne!(pid, std::process::id() as u64);
    assert!(
        !story["process"]["process_exit"]
            .as_str()
            .unwrap()
            .is_empty()
    );
    let frames = story["frames"].as_array().unwrap();
    assert_eq!(
        frames
            .iter()
            .map(|frame| frame["kind"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["baseline", "committed", "crashed", "recovered", "lookup"]
    );
    assert_eq!(frames[1]["capture"], frames[2]["capture"]);
    assert!(
        frames[2]["explanation"]
            .as_str()
            .unwrap()
            .contains("last-known")
    );
    assert_eq!(frames[1]["capture"]["pages"], frames[3]["capture"]["pages"]);
    assert_ne!(
        frames[1]["capture"]["snapshot"]["session_id"],
        frames[3]["capture"]["snapshot"]["session_id"]
    );
    assert_eq!(
        frames[3]["capture"]["snapshot"]["recovery"]["replayed_transactions"],
        1
    );
    assert_eq!(frames[3]["capture"]["snapshot"]["record_count"], 5);
    assert_eq!(frames[3]["capture"]["snapshot"]["tree_height"], 2);
    // Opening every final page in fresh processes also proves the killed owner
    // released its exclusive file locks before a successful story was returned.
    check_final_files(&story);
}

fn normalize(value: &mut Value) {
    match value {
        Value::Object(fields) => {
            for key in [
                "run_id",
                "session_id",
                "database_id",
                "process_id",
                "process_exit",
                "database_path",
            ] {
                fields.remove(key);
            }
            for field in fields.values_mut() {
                normalize(field);
            }
        }
        Value::Array(values) => {
            for value in values {
                normalize(value);
            }
        }
        _ => {}
    }
}

#[test]
fn stories_repeat_exact_structural_records_bytes_commands_and_event_sequences() {
    let temp = tempfile::tempdir().unwrap();
    for scenario in ["split", "recovery", "checkpoint"] {
        let mut first = recording(temp.path(), scenario);
        let mut second = recording(temp.path(), scenario);
        assert_ne!(first["run_id"], second["run_id"]);
        assert_ne!(
            first["source"]["database_path"],
            second["source"]["database_path"]
        );
        normalize(&mut first);
        normalize(&mut second);
        assert_eq!(first, second, "{scenario}");
    }
}

#[test]
fn invalid_scenarios_create_no_directory_or_database() {
    let temp = tempfile::tempdir().unwrap();
    let directory = temp.path().join("not-created");
    for scenario in ["", "../split", "leaf_split", "SPLIT"] {
        let output = Command::new(env!("CARGO_BIN_EXE_walnut"))
            .args(["story", directory.to_str().unwrap(), scenario])
            .output()
            .unwrap();
        assert!(!output.status.success());
        let error: Value = serde_json::from_slice(&output.stderr).unwrap();
        assert_eq!(error["error"]["code"], "invalid_scenario");
        assert!(!directory.exists());
    }
}

struct Server(Child);
impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn request(port: u16, route: &str, body: Option<&str>) -> (u16, Value) {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(10)))
        .unwrap();
    stream
        .set_write_timeout(Some(Duration::from_secs(10)))
        .unwrap();
    let method = if body.is_some() { "POST" } else { "GET" };
    let body = body.unwrap_or("");
    write!(
        stream,
        "{method} {route} HTTP/1.0\r\nHost: 127.0.0.1:{port}\r\nContent-Type: application/json\r\nX-Walnut-Client: inspector-v1\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    ).unwrap();
    let mut response = String::new();
    stream.read_to_string(&mut response).unwrap();
    let (head, body) = response.split_once("\r\n\r\n").unwrap();
    let status = head.split_whitespace().nth(1).unwrap().parse().unwrap();
    (status, serde_json::from_str(body).unwrap())
}

#[test]
fn api_validates_before_creation_and_preserves_the_primary_pages_log_and_staged_batch() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("primary.db");
    let mut primary = create_file(&path, true).unwrap();
    primary.put("keep", "untouched").unwrap();
    drop(primary);
    let main_bytes = fs::read(&path).unwrap();
    let wal_bytes = fs::read(walnut_core::wal_path(&path)).unwrap();
    let reservation = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let port = reservation.local_addr().unwrap().port();
    drop(reservation);
    let mut command = Command::new(env!("CARGO_BIN_EXE_walnut"));
    command
        .args(["serve", path.to_str().unwrap(), "--port", &port.to_string()])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut server = Server(command.spawn().unwrap());
    let deadline = Instant::now() + Duration::from_secs(5);
    while TcpStream::connect(("127.0.0.1", port)).is_err() {
        assert!(Instant::now() < deadline, "Server did not start");
        assert!(server.0.try_wait().unwrap().is_none(), "Server exited");
        std::thread::sleep(Duration::from_millis(20));
    }
    let story_directory = temp.path().join("recorded-stories");
    for body in [
        r#"{"scenario":"invalid"}"#,
        r#"{"scenario":"split","extra":true}"#,
        r#"{}"#,
        r#"{"scenario":1}"#,
        r#"["split"]"#,
        r#"{"scenario":"split","scenario":"checkpoint"}"#,
    ] {
        let (status, _) = request(port, "/api/story", Some(body));
        assert_eq!(status, 400, "{body}");
        assert!(!story_directory.exists());
    }
    let (status, _) = request(port, "/api/story?page=999", Some(r#"{"scenario":"split"}"#));
    assert_eq!(status, 400);
    assert!(!story_directory.exists());
    let (status, staged) = request(
        port,
        "/api/stage?page=0",
        Some(r#"{"key":"pending","value":"still staged"}"#),
    );
    assert_eq!(status, 200);
    let before = staged["snapshot"].clone();
    assert_eq!(before["page_id"], 0);
    for scenario in ["split", "recovery", "checkpoint"] {
        let body = json!({"scenario":scenario}).to_string();
        let (status, response) = request(port, "/api/story?page=0", Some(&body));
        assert_eq!(status, 200, "{response}");
        assert_eq!(response["snapshot"], before);
        assert_eq!(response["story"]["scenario"], scenario);
        let story_path = Path::new(
            response["story"]["source"]["database_path"]
                .as_str()
                .unwrap(),
        );
        assert!(story_path.starts_with(story_directory.canonicalize().unwrap()));
        assert_ne!(story_path, path.canonicalize().unwrap());
    }
    let (status, after) = request(port, "/api/snapshot?page=0", None);
    assert_eq!(status, 200);
    assert_eq!(after, before);
    drop(server);
    assert_eq!(fs::read(&path).unwrap(), main_bytes);
    assert_eq!(fs::read(walnut_core::wal_path(&path)).unwrap(), wal_bytes);
}
