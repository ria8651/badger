//! What the window opens, and the Connection menu that changes it: this Mac's Badger, or a hub, optionally with this
//! Mac as one of the hub's runners. The loading page (loading/) shows progress and errors, and the form for
//! connecting to a hub.

use std::{
    collections::HashSet,
    net::{TcpStream, ToSocketAddrs},
    process::Command,
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
    thread,
    time::Duration,
};

use serde::Serialize;
use tauri::{
    ipc::CapabilityBuilder,
    menu::{CheckMenuItem, Menu, MenuEvent, MenuItem, MenuItemKind, PredefinedMenuItem, Submenu},
    AppHandle, Manager, Runtime, Url,
};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};

use crate::{
    config::{self, Config, Connection},
    node, runner, server, updater, window,
};

/// What Badger's page may ask of the app, wherever it's served from (capabilities/default.json says so for localhost).
const PAGE_PERMISSIONS: [&str; 7] = [
    "core:window:allow-start-dragging",
    "core:window:allow-internal-toggle-maximize",
    "allow-set-badge",
    "allow-notify",
    "allow-place-traffic-lights",
    "allow-update-ready",
    "allow-restart-for-update",
];
/// How long a hub gets to answer before the window says it can't reach it.
const REACH_TIMEOUT: Duration = Duration::from_secs(5);
/// Where the Connection menu goes in the menu bar: after the app, File, Edit and View menus.
const MENU_POSITION: usize = 4;

#[derive(Default)]
pub struct State {
    /// The loading page's address, to go back to.
    loading: Mutex<Option<Url>>,
    /// What the loading page shows: progress, or what went wrong.
    status: Mutex<Status>,
    /// Bumped by each open, so a slow one that's been overtaken doesn't navigate.
    opening: AtomicU64,
    /// Hubs already let use the app's commands.
    allowed: Mutex<HashSet<String>>,
}

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
struct Status {
    text: String,
    error: Option<String>,
}

pub fn remember_loading_page(app: &AppHandle, url: Url) {
    *app.state::<State>().loading.lock().unwrap() = Some(url);
}

/// Opens what app.json says, after showing the loading page. Called at start and after every change.
pub fn open(app: &AppHandle) {
    let config = Config::read(app);
    let state = app.state::<State>();
    let ticket = state.opening.fetch_add(1, Ordering::SeqCst) + 1;
    set_status(app, "Starting Badger…", None);
    rebuild_menu(app, &config);
    show_loading(app, "");

    let app = app.clone();
    thread::spawn(move || {
        if let Err(e) = apply_runner(&app, &config) {
            error_dialog(&app, &e);
        }
        let url = match config.open_hub() {
            Some(hub) => reach_hub(&app, &hub),
            None => server::local(&app, &config, |text| set_status(&app, text, None)),
        };
        if app.state::<State>().opening.load(Ordering::SeqCst) != ticket {
            return;
        }
        match url {
            Ok(url) => {
                if let Some(window) = window::main(&app) {
                    let _ = window.navigate(url);
                }
            }
            Err(message) => set_status(&app, "", Some(message)),
        }
    });
}

/// Runs this Mac as the hub's runner when that's ticked and there's a token for it, and stops it otherwise.
fn apply_runner(app: &AppHandle, config: &Config) -> Result<(), String> {
    match (config.open_hub(), config.runner) {
        (Some(hub), true) => {
            let token = config::token(&hub).ok_or_else(|| format!("There's no runner token for {hub} yet."))?;
            runner::ensure(app, &hub, &token, node::workspace(config.workspace.as_deref()))
                .map_err(|e| format!("Couldn't run chats on this Mac: {e}"))
        }
        _ => Ok(runner::stop(app)),
    }
}

/// The hub's address, once it answers and may use the app's commands as the local Badger does.
fn reach_hub(app: &AppHandle, hub: &Url) -> Result<Url, String> {
    let host = hub.host_str().unwrap_or_default();
    set_status(app, &format!("Connecting to {host}…"), None);
    let port = hub.port_or_known_default().unwrap_or(443);
    let reachable = (host, port)
        .to_socket_addrs()
        .map(|mut addrs| addrs.any(|a| TcpStream::connect_timeout(&a, REACH_TIMEOUT).is_ok()))
        .unwrap_or(false);
    if !reachable {
        return Err(format!("Can't reach {host}. Check it's running and that this Mac can get to it."));
    }
    let origin = hub.origin().ascii_serialization();
    if app.state::<State>().allowed.lock().unwrap().insert(origin.clone()) {
        let id = format!("hub-{}", app.state::<State>().allowed.lock().unwrap().len());
        let capability = PAGE_PERMISSIONS
            .into_iter()
            .fold(CapabilityBuilder::new(id).window("main-*").remote(format!("{origin}/*")), |c, p| c.permission(p));
        app.add_capability(capability).map_err(|e| format!("Couldn't let {host} use the app: {e}"))?;
    }
    Ok(hub.clone())
}

fn set_status(app: &AppHandle, text: &str, error: Option<String>) {
    let status = Status { text: text.into(), error };
    *app.state::<State>().status.lock().unwrap() = status.clone();
    if let Some(window) = window::main(&app) {
        let json = serde_json::to_string(&status).expect("status serializes");
        let _ = window.eval(format!("window.__badgerStatus?.({json})"));
    }
}

/// Shows the loading page, at `hash`: empty for progress, or `connect` for the hub form.
fn show_loading(app: &AppHandle, hash: &str) {
    let Some(mut url) = app.state::<State>().loading.lock().unwrap().clone() else { return };
    url.set_fragment((!hash.is_empty()).then_some(hash));
    if let Some(window) = window::main(&app) {
        let _ = window.navigate(url);
    }
}

fn error_dialog(app: &AppHandle, message: &str) {
    app.dialog().message(message).title("Badger").kind(MessageDialogKind::Error).show(|_| {});
}

// ── The Connection menu ──

pub fn rebuild_menu(app: &AppHandle, config: &Config) {
    let build = || -> tauri::Result<Menu<_>> {
        let menu = Menu::default(app)?;
        menu.insert(&connection_menu(app, config)?, MENU_POSITION)?;
        // Under About in the app's own menu, once an update's downloaded.
        if let (Some(version), Some(MenuItemKind::Submenu(app_menu))) = (updater::version(app), menu.items()?.first()) {
            let label = format!("Restart to Update to {version}…");
            app_menu.insert(&MenuItem::with_id(app, "update", label, true, None::<&str>)?, 1)?;
        }
        Ok(menu)
    };
    if let Ok(menu) = build() {
        let _ = app.set_menu(menu);
    }
}

fn connection_menu<R: Runtime>(app: &AppHandle<R>, config: &Config) -> tauri::Result<Submenu<R>> {
    let on_hub = config.open_hub().is_some();
    let menu = Submenu::new(app, "Connection", true)?;
    menu.append(&CheckMenuItem::with_id(app, "local", "This Mac", true, !on_hub, None::<&str>)?)?;
    if let Some(hub) = config.hub.as_deref().and_then(|h| Url::parse(h).ok()) {
        let label = hub.host_str().unwrap_or("Hub").to_string();
        menu.append(&CheckMenuItem::with_id(app, "hub", label, true, on_hub, None::<&str>)?)?;
    }
    menu.append(&MenuItem::with_id(app, "connect", "Connect to a Hub…", true, None::<&str>)?)?;
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    let runs_here = on_hub && config.runner;
    menu.append(&CheckMenuItem::with_id(app, "runner", "Run Chats on This Mac", on_hub, runs_here, None::<&str>)?)?;
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    menu.append(&MenuItem::with_id(app, "logs", "Show Logs", true, None::<&str>)?)?;
    Ok(menu)
}

pub fn on_menu(app: &AppHandle, event: MenuEvent) {
    let mut config = Config::read(app);
    match event.id().as_ref() {
        "local" => {
            config.connection = Connection::Local;
            save_and_open(app, &config);
        }
        "hub" => {
            config.connection = Connection::Hub;
            save_and_open(app, &config);
        }
        "connect" => show_loading(app, "connect"),
        "runner" => {
            let Some(hub) = config.open_hub() else { return rebuild_menu(app, &config) };
            if !config.runner && config::token(&hub).is_none() {
                // The form asks for the token, with the box ticked.
                rebuild_menu(app, &config);
                return show_loading(app, "connect-runner");
            }
            config.runner = !config.runner;
            rebuild_menu(app, &config);
            // Stopping it waits for it to exit, which mustn't hold up the menu.
            let app = app.clone();
            thread::spawn(move || {
                if let Err(e) = config.save(&app).and_then(|()| apply_runner(&app, &config)) {
                    error_dialog(&app, &e);
                }
            });
        }
        "update" => updater::restart_to_update(app),
        "logs" => {
            if let Ok(dir) = node::log_path(app, "") {
                let _ = Command::new("/usr/bin/open").arg(dir).spawn();
            }
        }
        _ => {}
    }
}

fn save_and_open(app: &AppHandle, config: &Config) {
    match config.save(app) {
        Ok(()) => open(app),
        Err(e) => error_dialog(app, &format!("Couldn't save the connection: {e}")),
    }
}

// ── Commands for the loading page ──

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Form {
    hub: Option<String>,
    runner: bool,
    /// Whether the Keychain has a runner token for `hub`, so the box can be left empty.
    has_token: bool,
    status: Status,
}

/// What the loading page shows when it loads: the hub form's values, and the progress or error.
#[tauri::command]
pub fn loading_state(app: AppHandle) -> Form {
    let config = Config::read(&app);
    let hub = config.hub.as_deref().and_then(|h| Url::parse(h).ok());
    Form {
        has_token: hub.as_ref().is_some_and(|h| config::token(h).is_some()),
        hub: hub.map(|h| h.to_string()),
        runner: config.runner,
        status: app.state::<State>().status.lock().unwrap().clone(),
    }
}

/// Whether the Keychain has a runner token for the hub typed into the form.
#[tauri::command]
pub fn has_token(hub: String) -> bool {
    config::parse_hub(&hub).is_ok_and(|h| config::token(&h).is_some())
}

/// The hub form, submitted: keeps the token, if one's given, and opens the hub.
#[tauri::command]
pub fn connect(app: AppHandle, hub: String, runner: bool, token: String) -> Result<(), String> {
    let hub = config::parse_hub(&hub)?;
    let token = token.trim();
    if !token.is_empty() {
        config::set_token(&hub, token)?;
    } else if runner && config::token(&hub).is_none() {
        return Err("To run chats on this Mac, paste a runner token from the hub's Settings → Runners.".into());
    }
    let mut config = Config::read(&app);
    config.connection = Connection::Hub;
    config.hub = Some(hub.to_string());
    config.runner = runner;
    config.save(&app)?;
    open(&app);
    Ok(())
}

/// Opens what's configured again: after an error, or when the form's cancelled.
#[tauri::command]
pub fn reopen(app: AppHandle) {
    open(&app);
}
