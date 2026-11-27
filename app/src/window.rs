//! The one window: full bleed, with the traffic lights over the page's sidebar bar. Tauri only places them when a
//! window's made, so a page whose bar moves (another theme's frame) gets a new window, at the same page.

use std::{
    process::Command,
    sync::atomic::{AtomicU32, Ordering},
};

use tauri::{
    webview::NewWindowResponse, AppHandle, LogicalPosition, LogicalSize, Manager, TitleBarStyle, Url, WebviewUrl,
    WebviewWindow, WebviewWindowBuilder,
};

use crate::config::{Config, TrafficLights};

const INJECT: &str = include_str!("../inject.js");
const SIZE: LogicalSize<f64> = LogicalSize { width: 1440.0, height: 900.0 };
/// Points the page's bar moves before it's worth a new window.
const MOVE_THRESHOLD: f64 = 1.0;

/// Numbers each window, as a label can't be reused while the old window's going.
static NEXT: AtomicU32 = AtomicU32::new(0);

/// The window, whichever one it is now.
pub fn main(app: &AppHandle) -> Option<WebviewWindow> {
    app.webview_windows().into_values().next()
}

/// Makes the window, showing `url` (the loading page if none), where `like` is if given.
pub fn build(app: &AppHandle, url: Option<Url>, like: Option<&WebviewWindow>) -> tauri::Result<WebviewWindow> {
    let lights = Config::read(app).traffic_lights.unwrap_or_default();
    let label = format!("main-{}", NEXT.fetch_add(1, Ordering::Relaxed));
    let page = match url {
        Some(url) if url.scheme() != "tauri" => WebviewUrl::External(url),
        _ => WebviewUrl::App("index.html".into()),
    };
    let mut builder = WebviewWindowBuilder::new(app, label, page)
        .title("Badger")
        .inner_size(SIZE.width, SIZE.height)
        // Wide enough that the sidebar stays put; narrower, it becomes a drawer under the traffic lights.
        .min_inner_size(800.0, 480.0)
        // Full bleed: no title bar, the traffic lights over the sidebar's bar. The page does the dragging.
        .title_bar_style(TitleBarStyle::Overlay)
        .hidden_title(true)
        .traffic_light_position(LogicalPosition::new(lights.x, lights.y))
        .initialization_script(INJECT)
        // Files dropped on the page go to the page (the composer, the board), not to Tauri.
        .disable_drag_drop_handler()
        // What the page goes to stays in the window, so a hub's sign-in page works wherever it is; what it opens in a
        // new tab, as Badger's links do, opens in your browser.
        .on_navigation(|url| {
            let web = matches!(url.scheme(), "http" | "https" | "tauri" | "about" | "data" | "blob");
            if !web {
                open_in_browser(url);
            }
            web
        })
        .on_new_window(|url, _| {
            open_in_browser(&url);
            NewWindowResponse::Deny
        });
    if let Some(old) = like {
        let scale = old.scale_factor()?;
        let size = old.inner_size()?.to_logical::<f64>(scale);
        let at = old.outer_position()?.to_logical::<f64>(scale);
        builder = builder.inner_size(size.width, size.height).position(at.x, at.y);
    }
    builder.build()
}

pub fn open_in_browser(url: &Url) {
    let _ = Command::new("/usr/bin/open").arg(url.as_str()).spawn();
}

pub fn show(app: &AppHandle) {
    if let Some(window) = main(app) {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// Where the page's sidebar bar is, in points from the window's corner: its left edge, and its middle. The lights
/// go in from that edge and centred on that middle; if that's not where they are, the window's made again.
#[tauri::command]
pub fn place_traffic_lights(app: AppHandle, window: WebviewWindow, left: f64, middle: f64) {
    let wanted = TrafficLights::beside(left, middle);
    let mut config = Config::read(&app);
    let current = config.traffic_lights.unwrap_or_default();
    if (wanted.x - current.x).abs() < MOVE_THRESHOLD && (wanted.y - current.y).abs() < MOVE_THRESHOLD {
        return;
    }
    config.traffic_lights = Some(wanted);
    if config.save(&app).is_err() {
        return;
    }
    let url = window.url().ok();
    let _ = app.clone().run_on_main_thread(move || {
        if build(&app, url, Some(&window)).is_ok() {
            let _ = window.destroy();
        }
    });
}
