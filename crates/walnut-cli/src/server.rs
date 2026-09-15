use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    fs,
    io::Read,
    path::{Path, PathBuf},
};
use tiny_http::{Header, Method, Request, Response, Server};
use walnut_core::{Error, FileEngine, Result, WriteOp, create_file, open_file};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Put {
    key: String,
    value: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Get {
    key: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Empty {}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Batch {
    writes: Vec<WriteOp>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Lab {
    boundary: String,
}

struct State {
    engine: Option<FileEngine>,
    path: PathBuf,
}

impl State {
    fn engine(&mut self) -> Result<&mut FileEngine> {
        self.engine.as_mut().ok_or_else(|| {
            Error::new(
                "needs_reopen",
                "The database is closed. Reopen it to continue.",
            )
        })
    }
    fn snapshot(&mut self) -> Result<Value> {
        let mut value = serde_json::to_value(self.engine()?.snapshot()?).unwrap();
        value["database_name"] = json!(self.path.file_name().unwrap_or_default().to_string_lossy());
        Ok(value)
    }
    fn reopen(&mut self) -> Result<Value> {
        drop(self.engine.take());
        self.engine = Some(open_file(&self.path, true)?);
        self.snapshot()
    }
}

fn header(request: &Request, name: &'static str) -> Option<String> {
    request
        .headers()
        .iter()
        .find(|h| h.field.equiv(name))
        .map(|h| h.value.to_string())
}

fn response(request: Request, status: u16, value: Value) {
    let response = Response::from_string(value.to_string())
        .with_status_code(status)
        .with_header(Header::from_bytes("Content-Type", "application/json; charset=utf-8").unwrap())
        .with_header(Header::from_bytes("Cache-Control", "no-store").unwrap())
        .with_header(Header::from_bytes("X-Content-Type-Options", "nosniff").unwrap());
    let _ = request.respond(response);
}

fn fail(request: Request, status: u16, error: Error) {
    response(
        request,
        status,
        json!({"error":{"code":error.code,"message":error.message}}),
    );
}

fn body<T: serde::de::DeserializeOwned>(request: &mut Request) -> Result<T> {
    if header(request, "Content-Type").as_deref() != Some("application/json") {
        return Err(Error::new("invalid_request", "Send application/json."));
    }
    if request.body_length().is_some_and(|len| len > 131072) {
        return Err(Error::new("invalid_request", "Request exceeds 128 KB."));
    }
    let mut bytes = Vec::new();
    request.as_reader().take(131073).read_to_end(&mut bytes)?;
    if bytes.len() > 131072 {
        return Err(Error::new("invalid_request", "Request exceeds 128 KB."));
    }
    serde_json::from_slice(&bytes)
        .map_err(|_| Error::new("invalid_request", "Invalid command JSON."))
}

fn api(request: &mut Request, state: &mut State) -> Result<Value> {
    let route = request.url().split('?').next().unwrap_or("").to_owned();
    match (request.method(), route.as_str()) {
        (&Method::Get, "/api/snapshot") => state.snapshot(),
        (&Method::Post, "/api/put") => {
            let input: Put = body(request)?;
            state.engine()?.put(&input.key, &input.value)?;
            Ok(
                json!({"snapshot":state.snapshot()?, "result":{"key":input.key,"value":input.value,"found":true}}),
            )
        }
        (&Method::Post, "/api/get") => {
            let input: Get = body(request)?;
            let value = state.engine()?.get(&input.key)?;
            Ok(
                json!({"snapshot":state.snapshot()?,"result":{"key":input.key,"found":value.is_some(),"value":value}}),
            )
        }
        (&Method::Post, "/api/reopen") => {
            let _: Empty = body(request)?;
            Ok(json!({"snapshot":state.reopen()?}))
        }
        (&Method::Post, "/api/stage") => {
            let input: Put = body(request)?;
            state.engine()?.stage(&input.key, &input.value)?;
            Ok(json!({"snapshot":state.snapshot()?}))
        }
        (&Method::Post, "/api/batch") => {
            let input: Batch = body(request)?;
            state.engine()?.batch(input.writes)?;
            Ok(json!({"snapshot":state.snapshot()?}))
        }
        (&Method::Post, route @ ("/api/commit" | "/api/discard" | "/api/checkpoint")) => {
            let _: Empty = body(request)?;
            match route {
                "/api/commit" => state.engine()?.commit()?,
                "/api/discard" => state.engine()?.discard()?,
                _ => state.engine()?.checkpoint()?,
            }
            Ok(json!({"snapshot":state.snapshot()?}))
        }
        (&Method::Post, "/api/lab") => {
            let input: Lab = body(request)?;
            let directory = state
                .path
                .parent()
                .unwrap_or(Path::new("."))
                .join("recovery-lab");
            Ok(
                json!({"lab":crate::lab::run(&directory,&input.boundary)?,"snapshot":state.snapshot()?}),
            )
        }
        _ => Err(Error::new("not_found", "Unknown API route or method.")),
    }
}

fn static_file(request: Request, ui: &Path) {
    let path = request.url().split('?').next().unwrap_or("/");
    let relative = if path == "/" {
        "index.html"
    } else {
        path.trim_start_matches('/')
    };
    if request.method() != &Method::Get || relative.contains("..") || relative.contains('\\') {
        fail(request, 404, Error::new("not_found", "File not found."));
        return;
    }
    let file = ui.join(relative).canonicalize();
    let Ok(file) = file else {
        fail(
            request,
            404,
            Error::new("not_found", "Build the inspector with npm run build first."),
        );
        return;
    };
    if !file.starts_with(ui) {
        fail(request, 404, Error::new("not_found", "File not found."));
        return;
    }
    let mime = match file.extension().and_then(|s| s.to_str()).unwrap_or("") {
        "html" => "text/html; charset=utf-8",
        "js" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "svg" => "image/svg+xml",
        "woff2" => "font/woff2",
        _ => "application/octet-stream",
    };
    match fs::read(file) {
        Ok(bytes) => {
            let response = Response::from_data(bytes)
                .with_header(Header::from_bytes("Content-Type", mime).unwrap())
                .with_header(Header::from_bytes("X-Content-Type-Options", "nosniff").unwrap())
                .with_header(Header::from_bytes("Cache-Control", "no-cache").unwrap());
            let _ = request.respond(response);
        }
        Err(_) => fail(request, 404, Error::new("not_found", "File not found.")),
    }
}

pub fn serve(args: &[String]) -> Result<()> {
    let Some(path) = args.first() else {
        return Err(Error::new("usage", "serve requires a database file."));
    };
    let path = PathBuf::from(path);
    let mut port: u16 = 7878;
    let mut ui = PathBuf::from("dist");
    let mut i = 1;
    while i < args.len() {
        match (args[i].as_str(), args.get(i + 1)) {
            ("--port", Some(value)) => {
                port = value
                    .parse()
                    .map_err(|_| Error::new("usage", "Invalid port."))?
            }
            ("--ui", Some(value)) => ui = PathBuf::from(value),
            _ => {
                return Err(Error::new(
                    "usage",
                    "Expected --port <number> or --ui <directory>.",
                ));
            }
        }
        i += 2;
    }
    if port == 0 {
        return Err(Error::new("usage", "Choose a nonzero port."));
    }
    let server = Server::http(("127.0.0.1", port))
        .map_err(|e| Error::new("listen_failed", e.to_string()))?;
    let engine = if path.exists() {
        open_file(&path, true)?
    } else {
        create_file(&path, true)?
    };
    let mut state = State {
        engine: Some(engine),
        path,
    };
    let ui = ui.canonicalize().unwrap_or(ui);
    println!("WALnut inspector: http://127.0.0.1:{port}");
    let own_host = format!("127.0.0.1:{port}");
    let local_host = format!("localhost:{port}");
    let allowed_origins = [
        format!("http://{own_host}"),
        format!("http://{local_host}"),
        "http://127.0.0.1:5173".into(),
    ];
    for mut request in server.incoming_requests() {
        let host = header(&request, "Host").unwrap_or_default();
        if host != own_host && host != local_host {
            fail(
                request,
                403,
                Error::new("forbidden", "Unexpected Host header."),
            );
            continue;
        }
        if request.url().starts_with("/api/") {
            if header(&request, "Origin").is_some_and(|o| !allowed_origins.contains(&o))
                || (request.method() == &Method::Post
                    && header(&request, "X-Walnut-Client").as_deref() != Some("inspector-v1"))
            {
                fail(
                    request,
                    403,
                    Error::new("forbidden", "This API accepts local WALnut commands only."),
                );
                continue;
            }
            match api(&mut request, &mut state) {
                Ok(value) => response(request, 200, value),
                Err(error) => {
                    let status = match error.code {
                        "not_found" => 404,
                        "io"
                        | "needs_reopen"
                        | "corrupt_page"
                        | "corrupt_wal"
                        | "unrecoverable_page"
                        | "verification_failed" => 503,
                        "database_locked" | "batch_pending" | "checkpoint_required" => 409,
                        _ => 400,
                    };
                    fail(request, status, error);
                }
            }
        } else {
            static_file(request, &ui);
        }
    }
    Ok(())
}
