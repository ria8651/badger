//! This Mac as one of the hub's runners (server/remote.ts), so chats in its folders run here, next to their files,
//! while the board stays on the hub. Kept running while the app's on the hub with "Run Chats on This Mac" ticked;
//! remote.ts reconnects by itself when the hub drops, and is started again if it exits.

use std::{
    process::Child,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

use tauri::{AppHandle, Manager, Url};

use crate::node;

/// How long after exiting it's started again.
const RESTART_DELAY: Duration = Duration::from_secs(5);
const POLL: Duration = Duration::from_millis(200);

#[derive(Default)]
pub struct Runner(Mutex<Option<Supervised>>);

struct Supervised {
    /// What it was started with, so asking again for the same is a no-op.
    started_with: (Url, String),
    stop: Arc<AtomicBool>,
    thread: JoinHandle<()>,
}

/// Runs this Mac as a runner for `hub`, unless it already is with this token.
pub fn ensure(app: &AppHandle, hub: &Url, token: &str, workspace: String) -> Result<(), String> {
    let started_with = (hub.clone(), token.to_string());
    if app.state::<Runner>().0.lock().unwrap().as_ref().is_some_and(|s| s.started_with == started_with) {
        return Ok(());
    }
    stop(app);

    let log = node::log_path(app, "runner.log")?;
    let env = [("BADGER_HUB", hub.to_string()), ("BADGER_TOKEN", token.to_string()), ("WORKSPACE_DIR", workspace)];
    let spawn = {
        let app = app.clone();
        move || node::spawn(&app, "server/remote.ts", &env, &log)
    };
    // The first start is here, so a build that can't run it says so.
    let first = spawn()?;
    let stop = Arc::new(AtomicBool::new(false));
    let thread = {
        let stop = stop.clone();
        thread::spawn(move || supervise(first, spawn, &stop))
    };
    *app.state::<Runner>().0.lock().unwrap() = Some(Supervised { started_with, stop, thread });
    Ok(())
}

/// Stops it, if it's running.
pub fn stop(app: &AppHandle) {
    let Some(s) = app.state::<Runner>().0.lock().unwrap().take() else { return };
    s.stop.store(true, Ordering::Relaxed);
    let _ = s.thread.join();
}

fn supervise(mut child: Child, spawn: impl Fn() -> Result<Child, String>, stop: &AtomicBool) {
    loop {
        while !matches!(child.try_wait(), Ok(Some(_))) {
            if stop.load(Ordering::Relaxed) {
                return node::terminate(child);
            }
            thread::sleep(POLL);
        }
        let again = Instant::now() + RESTART_DELAY;
        while Instant::now() < again {
            if stop.load(Ordering::Relaxed) {
                return;
            }
            thread::sleep(POLL);
        }
        match spawn() {
            Ok(next) => child = next,
            Err(_) => return,
        }
    }
}
