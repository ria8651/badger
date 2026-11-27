//! What the app opens, kept in `app.json` in its data folder and changed from its Connection menu. Runner tokens
//! are kept in the Keychain instead, one per hub.

use std::{fs, path::PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Url};

#[derive(Serialize, Deserialize, Default, Clone, Copy, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Connection {
    /// This Mac's own Badger: one already running on the port, or the one in the app.
    #[default]
    Local,
    /// The hub, e.g. on a NAS: the app only opens it.
    Hub,
}

#[derive(Serialize, Deserialize, Default, Clone)]
#[serde(default)]
pub struct Config {
    pub connection: Connection,
    /// The hub last connected to, kept while on this Mac so it's one click away.
    pub hub: Option<String>,
    /// While on the hub, run its chats in this Mac's folders here too, as one of its runners.
    pub runner: bool,
    /// The port the app runs its own Badger on. Defaults to 3001; if something else has it, the app says so.
    pub port: Option<u16>,
    /// The folder new chats are offered when the app starts a server or runner. Defaults to your home.
    pub workspace: Option<PathBuf>,
    /// Where the traffic lights go, as the page last said (window::place_traffic_lights).
    pub traffic_lights: Option<TrafficLights>,
}

/// The traffic lights' inset from the window's corner, in points.
#[derive(Serialize, Deserialize, Clone, Copy)]
pub struct TrafficLights {
    pub x: f64,
    pub y: f64,
}

impl TrafficLights {
    /// In from the sidebar bar's left edge, and centred on its middle (the inset is to the buttons' top, less a
    /// little macOS adds).
    pub fn beside(left: f64, middle: f64) -> TrafficLights {
        TrafficLights { x: left + 16.0, y: middle + 2.0 }
    }
}

impl Default for TrafficLights {
    /// The modern frame's: a 6pt margin around a 48pt bar.
    fn default() -> TrafficLights {
        TrafficLights::beside(6.0, 30.0)
    }
}

impl Config {
    /// A missing or broken file means the defaults.
    pub fn read(app: &AppHandle) -> Config {
        let Ok(dir) = app.path().app_data_dir() else { return Config::default() };
        fs::read_to_string(dir.join("app.json")).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
    }

    pub fn save(&self, app: &AppHandle) -> Result<(), String> {
        let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let json = serde_json::to_string_pretty(self).expect("config serializes");
        fs::write(dir.join("app.json"), json + "\n").map_err(|e| e.to_string())
    }

    /// The hub, if that's what's open.
    pub fn open_hub(&self) -> Option<Url> {
        (self.connection == Connection::Hub).then(|| self.hub.as_deref().and_then(|u| Url::parse(u).ok())).flatten()
    }
}

/// A hub's address as typed: an http(s) URL, `https://` assumed when there's no scheme, or `http://` for one on this
/// Mac (like localhost:3001).
pub fn parse_hub(typed: &str) -> Result<Url, String> {
    let typed = typed.trim();
    let local = ["localhost", "127.0.0.1"].iter().any(|h| typed == *h || typed.starts_with(&format!("{h}:")));
    let full = if typed.contains("://") {
        typed.to_string()
    } else if local {
        format!("http://{typed}")
    } else {
        format!("https://{typed}")
    };
    let url = Url::parse(&full).map_err(|_| format!("\"{typed}\" isn't an address."))?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return Err(format!("\"{typed}\" isn't a web address."));
    }
    Ok(url)
}

// ── Runner tokens, in the Keychain ──

const KEYCHAIN_SERVICE: &str = "Badger runner token";

fn account(hub: &Url) -> String {
    hub.origin().ascii_serialization()
}

pub fn token(hub: &Url) -> Option<String> {
    let bytes = security_framework::passwords::get_generic_password(KEYCHAIN_SERVICE, &account(hub)).ok()?;
    String::from_utf8(bytes).ok().filter(|t| !t.is_empty())
}

pub fn set_token(hub: &Url, token: &str) -> Result<(), String> {
    security_framework::passwords::set_generic_password(KEYCHAIN_SERVICE, &account(hub), token.as_bytes())
        .map_err(|e| format!("Couldn't keep the token in the Keychain: {e}"))
}
