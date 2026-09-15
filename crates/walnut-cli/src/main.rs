mod lab;
mod server;
use std::{env, path::Path};
use walnut_core::{Error, Result, WriteOp, create_file, open_file, upgrade_file};

fn run(args: &[String]) -> Result<()> {
    match args {
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
            println!("{}", lab::run(Path::new(directory), boundary)?);
        }
        [command, path, boundary] if command == "__crash-worker" => {
            lab::worker(Path::new(path), boundary)?
        }
        [command, rest @ ..] if command == "serve" => {
            server::serve(rest)?;
        }
        [command] if command == "--version" => println!(
            "WALnut {} (storage format 2, page format 1, phase 2)",
            env!("CARGO_PKG_VERSION")
        ),
        _ => {
            return Err(Error::new(
                "usage",
                "walnut create <file> | put <file> <key> <value> | batch <file> <json-array> | get <file> <key> | inspect <file> | checkpoint <file> | upgrade <source> <new-target> | lab <directory> <boundary> | serve <file> [--port 7878] [--ui dist]",
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
