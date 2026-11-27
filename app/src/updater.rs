//! Updates from the GitHub releases (.github/workflows/release.yml publishes latest.json): checked at start and every
//! few hours, downloaded in the background, and installed when the app quits, or now from "Restart to Update".
//! Restarting stops the app's Badger and runner, and their chats with them, so it's never done unasked.

use std::{sync::Mutex, thread, time::Duration};

use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::{config::Config, connection, runner, server, window};

const CHECK_EVERY: Duration = Duration::from_secs(6 * 60 * 60);
/// The version builds made outside a release have (releases set theirs): they don't update.
const UNRELEASED: &str = "0.0.0";

/// An update downloaded and waiting to be installed.
#[derive(Default)]
pub struct Pending(Mutex<Option<(Update, Vec<u8>)>>);

/// Looks for an update now and then, downloading one when there is.
pub fn start(app: &AppHandle) {
    if app.package_info().version.to_string() == UNRELEASED {
        return;
    }
    let app = app.clone();
    thread::spawn(move || loop {
        if version(&app).is_none() {
            match tauri::async_runtime::block_on(fetch(&app)) {
                Ok(Some(update)) => {
                    let version = update.0.version.clone();
                    *app.state::<Pending>().0.lock().unwrap() = Some(update);
                    let handle = app.clone();
                    let _ = app.run_on_main_thread(move || connection::rebuild_menu(&handle, &Config::read(&handle)));
                    // The page shows a button for it too (src/app.ts).
                    if let Some(window) = window::main(&app) {
                        let _ = window.eval(format!("window.__badgerUpdateReady?.({})", serde_json::json!(version)));
                    }
                }
                Ok(None) => {}
                Err(e) => eprintln!("checking for an update failed: {e}"),
            }
        }
        thread::sleep(CHECK_EVERY);
    });
}

async fn fetch(app: &AppHandle) -> tauri_plugin_updater::Result<Option<(Update, Vec<u8>)>> {
    let Some(update) = app.updater()?.check().await? else { return Ok(None) };
    let bytes = update.download(|_, _| {}, || {}).await?;
    Ok(Some((update, bytes)))
}

/// The version downloaded and waiting, if one is.
pub fn version(app: &AppHandle) -> Option<String> {
    app.state::<Pending>().0.lock().unwrap().as_ref().map(|(update, _)| update.version.clone())
}

/// Puts the downloaded update in place of this app, so the next start is the new version. Called as it quits.
pub fn install(app: &AppHandle) {
    if let Some((update, bytes)) = app.state::<Pending>().0.lock().unwrap().take() {
        if let Err(e) = update.install(bytes) {
            eprintln!("installing the update failed: {e}");
        }
    }
}

/// From the menu: installs the update and starts again, after asking if that would stop chats.
pub fn restart_to_update(app: &AppHandle) {
    let Some(version) = version(app) else { return };
    let app = app.clone();
    thread::spawn(move || {
        if busy(&app) {
            let go = app
                .dialog()
                .message("Chats running on this Mac will stop. You can carry on with them once Badger's back.")
                .title(format!("Restart to update to {version}?"))
                .buttons(MessageDialogButtons::OkCancelCustom("Restart".into(), "Not Now".into()))
                .blocking_show();
            if !go {
                return;
            }
        }
        runner::stop(&app);
        server::stop(&app);
        install(&app);
        app.restart();
    });
}

/// Whether restarting would stop chats: ones working on the app's Badger, or any this Mac runs for a hub.
fn busy(app: &AppHandle) -> bool {
    let config = Config::read(app);
    (config.open_hub().is_some() && config.runner) || server::running_chats(&config) > 0
}

// ── Commands for the page (window.badgerApp, from inject.js) ──

/// The version downloaded and waiting, for the page's button: asked as it loads.
#[tauri::command]
pub fn update_ready(app: AppHandle) -> Option<String> {
    version(&app)
}

/// The page's button: as the menu's Restart to Update.
#[tauri::command]
pub fn restart_for_update(app: AppHandle) {
    restart_to_update(&app);
}
