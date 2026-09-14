mod server;
use std::{env, path::Path};
use walnut_core::{Engine, Error, FileStorage, Result};

fn open(path: &Path) -> Result<Engine<FileStorage>> {
    Engine::open(FileStorage::open(path)?, true)
}

fn run(args: &[String]) -> Result<()> {
    match args {
        [command, path] if command == "create" => {
            let engine = Engine::create(FileStorage::create(Path::new(path))?, true)?;
            println!("{}", serde_json::to_string(&engine.snapshot()?).unwrap());
        }
        [command, path, key, value] if command == "put" => {
            let mut engine = open(Path::new(path))?;
            engine.put(key, value)?;
            println!(
                "{}",
                serde_json::json!({"key": key, "value": value, "generation":engine.snapshot()?.generation})
            );
        }
        [command, path, key] if command == "get" => {
            let mut engine = open(Path::new(path))?;
            let value = engine.get(key)?;
            println!(
                "{}",
                serde_json::json!({"key":key,"found":value.is_some(),"value":value})
            );
        }
        [command, path] if command == "inspect" => {
            println!(
                "{}",
                serde_json::to_string(&open(Path::new(path))?.snapshot()?).unwrap()
            );
        }
        [command, rest @ ..] if command == "serve" => {
            server::serve(rest)?;
        }
        [command] if command == "--version" => println!(
            "WALnut {} (page format 1, stage 1)",
            env!("CARGO_PKG_VERSION")
        ),
        _ => {
            return Err(Error::new(
                "usage",
                "walnut create <file> | put <file> <key> <value> | get <file> <key> | inspect <file> | serve <file> [--port 7878] [--ui dist]",
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
