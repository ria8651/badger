//! Badger as a macOS app: a window (window.rs) onto this Mac's Badger, which it starts itself unless one is already
//! running, or onto a hub elsewhere (connection.rs). The page is the same web app a browser gets; inject.js tells it
//! what the app can do, and src/app.ts is the page's side of that.

mod config;
mod connection;
mod node;
mod runner;
mod server;
mod window;

use std::thread;

use tauri::{Manager, RunEvent, WebviewWindow, WindowEvent};

fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(server::Server::default())
        .manage(runner::Runner::default())
        .manage(connection::State::default())
        .invoke_handler(tauri::generate_handler![
            set_badge,
            notify,
            window::place_traffic_lights,
            connection::loading_state,
            connection::has_token,
            connection::connect,
            connection::reopen,
        ])
        .setup(|app| {
            let _ = mac_notification_sys::set_application(&app.config().identifier);
            let window = window::build(app.handle(), None, None)?;
            connection::remember_loading_page(app.handle(), window.url()?);
            connection::open(app.handle());
            Ok(())
        })
        .on_menu_event(connection::on_menu)
        // Closing the window keeps the app, and the chats on its server or runner, going; Cmd-Q quits.
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .build(tauri::generate_context!())
        .expect("couldn't build the app");

    app.run(|app, event| match event {
        RunEvent::Reopen { .. } => window::show(app),
        RunEvent::Exit => {
            runner::stop(app);
            server::stop(app);
        }
        _ => {}
    });
}

// ── Commands for the page (window.badgerApp, from inject.js) ──

#[tauri::command]
fn set_badge(window: WebviewWindow, count: i64) {
    let _ = window.set_badge_count((count > 0).then_some(count));
}

/// Shows a notification, and tells the page whether it was clicked, so its handler runs.
#[tauri::command]
fn notify(window: WebviewWindow, id: u64, title: String, body: String) {
    thread::spawn(move || {
        use mac_notification_sys::{send_notification, Notification, NotificationResponse};
        let response = send_notification(&title, None, &body, Some(Notification::new().wait_for_click(true)));
        let clicked = matches!(response, Ok(NotificationResponse::Click | NotificationResponse::ActionButton(_)));
        if clicked {
            window::show(window.app_handle());
        }
        let _ = window.eval(format!("window.__badgerNotification?.({id}, {clicked})"));
    });
}
