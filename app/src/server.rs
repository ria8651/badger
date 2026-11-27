//! The app's own Badger: the one bundled in it, started on its port and stopped when it quits.

use std::{
    fs,
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    process::Child,
    sync::Mutex,
    thread,
    time::{Duration, Instant},
};

use tauri::{AppHandle, Manager, Url};

use crate::{config::Config, node};

const DEFAULT_PORT: u16 = 3001;
/// How long the server gets to start answering. Its first start compiles the server with tsx.
const START_TIMEOUT: Duration = Duration::from_secs(60);

/// The server the app started, if it did. It runs until the app quits, even while the window shows a hub, so
/// switching back is quick and its chats carry on.
#[derive(Default)]
pub struct Server(Mutex<Option<Child>>);

/// The app's own Badger's address, once it's started. `status` says what's happening meanwhile.
pub fn local(app: &AppHandle, config: &Config, status: impl Fn(&str)) -> Result<Url, String> {
    let port = config.port.unwrap_or(DEFAULT_PORT);
    // Something else on its port, even another Badger, is left alone rather than opened: that's a hub to connect to.
    if TcpListener::bind(("127.0.0.1", port)).is_err() {
        return Err(format!(
            "Something's already using port {port}, so the app can't run its Badger there.\n\n\
             If it's a Badger you started, open it with Connection → Connect to a Hub… at localhost:{port}, or stop it \
             and Try Again."
        ));
    }
    let url = Url::parse(&format!("http://localhost:{port}/")).expect("a valid url");

    status("Starting the server…");
    let server = app.state::<Server>();
    let log = node::log_path(app, "server.log")?;
    let data = app.path().app_data_dir().map_err(|e| e.to_string())?.join("data");
    fs::create_dir_all(&data).map_err(|e| e.to_string())?;
    let env = [
        ("PORT", port.to_string()),
        ("HOST", "127.0.0.1".into()),
        ("DATA_DIR", data.display().to_string()),
        ("WORKSPACE_DIR", node::workspace(config.workspace.as_deref())),
    ];
    let child = node::spawn(app, "server/index.ts", &env, &log)
        .map_err(|e| format!("Nothing answers on port {port}, and the app can't start its own Badger.\n\n{e}"))?;
    *server.0.lock().unwrap() = Some(child);

    let deadline = Instant::now() + START_TIMEOUT;
    loop {
        if answers(port) {
            return Ok(url);
        }
        let mut guard = server.0.lock().unwrap();
        let Some(child) = guard.as_mut() else { return Err("The app is quitting.".into()) };
        if let Ok(Some(status)) = child.try_wait() {
            guard.take();
            return Err(format!("The server stopped ({status}).\n\n{}", node::tail(&log)));
        }
        if Instant::now() > deadline {
            drop(guard);
            stop(app);
            return Err(format!(
                "The server didn't start within {}s.\n\n{}",
                START_TIMEOUT.as_secs(),
                node::tail(&log)
            ));
        }
        drop(guard);
        thread::sleep(Duration::from_millis(250));
    }
}

/// Stops the server the app started. Its PTY host lives on, as it does outside the app, so terminals survive until
/// the next start.
pub fn stop(app: &AppHandle) {
    if let Some(child) = app.state::<Server>().0.lock().unwrap().take() {
        node::terminate(child);
    }
}

/// How many chats are working on the app's Badger, as its machines say; 0 if it doesn't answer.
pub fn running_chats(config: &Config) -> u64 {
    let port = config.port.unwrap_or(DEFAULT_PORT);
    let Ok(mut s) = TcpStream::connect_timeout(&([127, 0, 0, 1], port).into(), Duration::from_millis(500)) else {
        return 0;
    };
    let _ = s.set_read_timeout(Some(Duration::from_secs(2)));
    // HTTP/1.0, so the answer comes whole rather than chunked, and ends when the connection does.
    let origin = format!("localhost:{port}");
    let request = format!("GET /api/machines HTTP/1.0\r\nHost: {origin}\r\nOrigin: http://{origin}\r\n\r\n");
    let mut response = String::new();
    if s.write_all(request.as_bytes()).is_err() || s.read_to_string(&mut response).is_err() {
        return 0;
    }
    let body = response.split_once("\r\n\r\n").map_or("", |(_, body)| body);
    let machines: Vec<serde_json::Value> = serde_json::from_str(body).unwrap_or_default();
    machines.iter().filter_map(|m| m["running"].as_u64()).sum()
}

/// Whether a Badger answers on the port: its config endpoint, not just anything listening.
fn answers(port: u16) -> bool {
    let Ok(mut s) = TcpStream::connect_timeout(&([127, 0, 0, 1], port).into(), Duration::from_millis(500)) else {
        return false;
    };
    let _ = s.set_read_timeout(Some(Duration::from_secs(2)));
    let request = format!("GET /api/config HTTP/1.1\r\nHost: localhost:{port}\r\nConnection: close\r\n\r\n");
    if s.write_all(request.as_bytes()).is_err() {
        return false;
    }
    let mut head = [0u8; 12];
    s.read_exact(&mut head).is_ok() && head.ends_with(b" 200")
}
