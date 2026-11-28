// The app's commands, declared so each gets a permission (allow-<command>): without that, Tauri won't let a page
// served over http, as Badger's is, call any of them. capabilities/ and connection.rs grant them.
const COMMANDS: &[&str] = &[
    "set_badge",
    "notify",
    "place_traffic_lights",
    "update_ready",
    "restart_for_update",
    "loading_state",
    "has_token",
    "connect",
    "reopen",
];

fn main() {
    let manifest = tauri_build::AppManifest::new().commands(COMMANDS);
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(manifest)).expect("couldn't run tauri-build");
}
