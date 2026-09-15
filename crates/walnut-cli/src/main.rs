mod benchmark;
mod lab;
mod server;
mod story;
mod workload;
use std::{env, path::Path};
use walnut_core::{Error, Result, WriteOp, create_file, open_file, upgrade_file};

fn run(args: &[String]) -> Result<()> {
    match args {
        [command, directory] if command == "benchmark" || command == "profile-fixture" => {
            let result = if command == "benchmark" {
                benchmark::run(Path::new(directory))?
            } else {
                benchmark::fixture(Path::new(directory))?
            };
            println!("{}", result);
        }
        [command, path] if command == "create" => {
            let engine = create_file(Path::new(path), true)?;
            println!("{}", serde_json::to_string(&engine.snapshot()?).unwrap());
        }
        [command, path, key, value] if command == "put" => {
            let mut engine = open_file(Path::new(path), true)?;
            engine.put(key, value)?;
            println!(
                "{}",
                serde_json::json!({"key": key, "value": value, "generation":engine.snapshot()?.generation})
            );
        }
        [command, path, key] if command == "get" => {
            let mut engine = open_file(Path::new(path), true)?;
            let value = engine.get(key)?;
            println!(
                "{}",
                serde_json::json!({"key":key,"found":value.is_some(),"value":value})
            );
        }
        [command, path] if command == "inspect" => {
            println!(
                "{}",
                serde_json::to_string(&open_file(Path::new(path), true)?.snapshot()?).unwrap()
            );
        }
        [command, path, page] if command == "inspect" => {
            let page = page
                .parse::<u32>()
                .map_err(|_| Error::new("usage", "Page ID must be an unsigned integer."))?;
            println!(
                "{}",
                serde_json::to_string(&open_file(Path::new(path), true)?.snapshot_page(page)?)
                    .unwrap()
            );
        }
        [command, path, start, rest @ ..] if command == "range" => {
            let mut end = None;
            let mut limit = 64;
            let (options, remainder) = rest.as_chunks::<2>();
            for option in options {
                match option[0].as_str() {
                    "--end" => end = Some(option[1].as_str()),
                    "--limit" => {
                        limit = option[1]
                            .parse()
                            .map_err(|_| Error::new("usage", "Range limit must be 1–256."))?
                    }
                    _ => {
                        return Err(Error::new(
                            "usage",
                            "Range accepts --end <exclusive-key> and --limit <1–256>.",
                        ));
                    }
                }
            }
            if !remainder.is_empty() {
                return Err(Error::new("usage", "Each range option requires a value."));
            }
            let result = open_file(Path::new(path), true)?.range(start, end, limit)?;
            println!("{}", serde_json::to_string(&result).unwrap());
        }
        [command, path] if command == "grow" => {
            let mut engine = open_file(Path::new(path), true)?;
            workload::grow(&mut engine)?;
            println!("{}", serde_json::to_string(&engine.snapshot()?).unwrap());
        }
        [command, source, target] if command == "upgrade" => {
            let engine = upgrade_file(Path::new(source), Path::new(target), true)?;
            println!("{}", serde_json::to_string(&engine.snapshot()?).unwrap());
        }
        [command, path, input] if command == "batch" => {
            if input.len() > 131072 {
                return Err(Error::new("invalid_batch", "Batch JSON exceeds 128 KB."));
            }
            let writes: Vec<WriteOp> = serde_json::from_str(input).map_err(|_| {
                Error::new("invalid_batch", "Expected a JSON array of key/value puts.")
            })?;
            let mut engine = open_file(Path::new(path), true)?;
            engine.batch(writes)?;
            println!("{}", serde_json::to_string(&engine.snapshot()?).unwrap());
        }
        [command, path] if command == "checkpoint" => {
            let mut engine = open_file(Path::new(path), true)?;
            engine.checkpoint()?;
            println!("{}", serde_json::to_string(&engine.snapshot()?).unwrap());
        }
        [command, directory, boundary] if command == "lab" => {
            println!(
                "{}",
                lab::run(Path::new(directory), boundary, "root_split")?
            );
        }
        [command, directory, boundary, scenario] if command == "lab" => {
            println!("{}", lab::run(Path::new(directory), boundary, scenario)?);
        }
        [command, path, boundary, scenario] if command == "__crash-worker" => {
            lab::worker(Path::new(path), boundary, scenario)?
        }
        [command, directory, scenario] if command == "story" => {
            println!("{}", story::run(Path::new(directory), scenario)?);
        }
        [command, path] if command == "__story-crash-worker" => {
            story::worker(Path::new(path))?;
        }
        [command, rest @ ..] if command == "serve" => {
            server::serve(rest)?;
        }
        [command] if command == "--version" => println!(
            "WALnut {} (storage format 3, page format 2, phase 5)",
            env!("CARGO_PKG_VERSION")
        ),
        _ => {
            return Err(Error::new(
                "usage",
                "walnut create <file> | put <file> <key> <value> | batch <file> <json-array> | get <file> <key> | range <file> <start> [--end <exclusive-key>] [--limit <1–256>] | inspect <file> [page-id] | grow <file> | checkpoint <file> | upgrade <source> <new-target> | lab <directory> <boundary> [leaf_split|root_split] | story <directory> <split|recovery|checkpoint> | benchmark <new-directory> | profile-fixture <new-directory> | serve <file> [--port 7878] [--ui dist]",
            ));
        }
    }
    Ok(())
}

fn main() {
    if let Err(error) = run(&env::args().skip(1).collect::<Vec<_>>()) {
        eprintln!(
            "{}",
            serde_json::json!({"error":{"code":error.code,"message":error.message}})
        );
        std::process::exit(1);
    }
}
