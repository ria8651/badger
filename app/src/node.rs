//! Scripts from the Badger checkout bundled in the app (server/index.ts, server/remote.ts), run on the Node bundled
//! with it, in your login shell's environment.

use std::{
    collections::HashMap,
    fs::{self, File},
    io::Read,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::OnceLock,
    thread,
    time::{Duration, Instant},
};

use tauri::{AppHandle, Manager};

/// How long a script gets to exit after SIGTERM before it's killed.
const STOP_TIMEOUT: Duration = Duration::from_secs(3);
/// How long the login shell gets to print its environment.
const SHELL_ENV_TIMEOUT: Duration = Duration::from_secs(10);
const ENV_MARKER: &str = "__BADGER_ENV__";

/// Starts `script` with `env` on top of your login shell's, its output appended to `log`. Fails with a hint when
/// this build has no Badger bundled (`pnpm app:dev`).
pub fn spawn(app: &AppHandle, script: &str, env: &[(&str, String)], log: &Path) -> Result<Child, String> {
    // Tauri won't say where they are when the app was started by a path through a symlink, like /tmp.
    let resources =
        app.path().resource_dir().map_err(|_| format!("The app couldn't find its own files, in {}.", exe_dir()))?;
    let (node, root) = (resources.join("node"), resources.join("badger"));
    if !node.exists() {
        return Err("This build has no Badger of its own to run: build the app with `pnpm app:build`.".into());
    }
    let out = File::options().create(true).append(true).open(log).map_err(|e| e.to_string())?;
    let err = out.try_clone().map_err(|e| e.to_string())?;
    Command::new(node)
        // Run from the checkout so `--import tsx` finds its tsx.
        .current_dir(&root)
        .args(["--import", "tsx", script])
        .env_clear()
        .envs(login_env())
        .envs(env.iter().map(|(k, v)| (*k, v)))
        .stdin(Stdio::null())
        .stdout(out)
        .stderr(err)
        .spawn()
        .map_err(|e| format!("Couldn't start {script}: {e}"))
}

fn exe_dir() -> String {
    std::env::current_exe().ok().and_then(|p| p.parent().map(|d| d.display().to_string())).unwrap_or_default()
}

/// Asks it to stop, and makes it if it doesn't.
pub fn terminate(mut child: Child) {
    unsafe { libc::kill(child.id() as i32, libc::SIGTERM) };
    let deadline = Instant::now() + STOP_TIMEOUT;
    while Instant::now() < deadline {
        if let Ok(Some(_)) = child.try_wait() {
            return;
        }
        thread::sleep(Duration::from_millis(50));
    }
    let _ = child.kill();
    let _ = child.wait();
}

/// `name` in the app's logs folder, e.g. ~/Library/Logs/com.ria8651.badger/server.log.
pub fn log_path(app: &AppHandle, name: &str) -> Result<PathBuf, String> {
    let dir = app.path().app_log_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join(name))
}

/// The end of a log, to show when something fails to start.
pub fn tail(log: &Path) -> String {
    let text = fs::read_to_string(log).unwrap_or_default();
    let lines: Vec<&str> = text.lines().collect();
    format!("{}\n\n(from {})", lines[lines.len().saturating_sub(20)..].join("\n"), log.display())
}

/// Your login shell's environment, read once. Apps opened from the Finder get a bare PATH, without Homebrew, nvm
/// and the like, so `claude`, `git` and `gh` wouldn't be found otherwise.
pub fn login_env() -> &'static HashMap<String, String> {
    static ENV: OnceLock<HashMap<String, String>> = OnceLock::new();
    ENV.get_or_init(|| read_login_env().unwrap_or_else(fallback_env))
}

fn fallback_env() -> HashMap<String, String> {
    let mut env: HashMap<String, String> = std::env::vars().collect();
    let path = env.get("PATH").cloned().unwrap_or_default();
    env.insert("PATH".into(), format!("/opt/homebrew/bin:/usr/local/bin:{path}"));
    env
}

fn read_login_env() -> Option<HashMap<String, String>> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let mut child = Command::new(shell)
        .args(["-l", "-i", "-c", &format!("printf '\\n{ENV_MARKER}\\n'; /usr/bin/env -0")])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let mut stdout = child.stdout.take().expect("piped");
    let reader = thread::spawn(move || {
        let mut out = Vec::new();
        let _ = stdout.read_to_end(&mut out);
        out
    });
    let deadline = Instant::now() + SHELL_ENV_TIMEOUT;
    while !matches!(child.try_wait(), Ok(Some(_))) {
        if Instant::now() > deadline {
            let _ = child.kill();
            let _ = child.wait();
            return None;
        }
        thread::sleep(Duration::from_millis(20));
    }
    let out = String::from_utf8_lossy(&reader.join().unwrap_or_default()).into_owned();
    let (_, vars) = out.split_once(&format!("\n{ENV_MARKER}\n"))?;
    let env: HashMap<String, String> = vars
        .split('\0')
        .filter_map(|kv| kv.split_once('='))
        .filter(|(k, _)| !matches!(*k, "SHLVL" | "PWD" | "OLDPWD" | "_"))
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();
    env.contains_key("PATH").then_some(env)
}

/// The folder new chats are offered: the one configured, or your home.
pub fn workspace(configured: Option<&Path>) -> String {
    configured
        .map(|p| p.display().to_string())
        .or_else(|| login_env().get("HOME").cloned())
        .unwrap_or_else(|| "/".into())
}
