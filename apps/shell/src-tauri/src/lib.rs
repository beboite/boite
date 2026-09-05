//! The Boite desktop shell. Nothing here but the window, the tray, and the
//! local core: every decision the product makes lives in the core or the UI.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    AppHandle, Manager, Runtime, State, WindowEvent,
};

/// The line the core prints on stdout once its RPC server accepts connections.
const READY_LINE: &str = "boite-core ready";
const HEALTH_TIMEOUT: Duration = Duration::from_millis(500);
const START_TIMEOUT: Duration = Duration::from_secs(15);
const POLL_INTERVAL: Duration = Duration::from_millis(120);

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Clone, Serialize)]
pub struct CoreEndpoint {
    pub url: String,
    pub token: String,
}

/// `<dataDir>/core.json`, written by the core on start.
#[derive(Deserialize)]
struct CoreFile {
    port: u16,
    #[serde(default)]
    host: Option<String>,
    token: String,
    #[serde(default)]
    #[allow(dead_code)]
    pid: Option<u32>,
}

#[derive(Default)]
struct Slot {
    endpoint: Option<CoreEndpoint>,
    error: Option<String>,
    done: bool,
}

pub struct CoreState {
    slot: Arc<(Mutex<Slot>, Condvar)>,
    child: Arc<Mutex<Option<Child>>>,
}

impl CoreState {
    fn new() -> Self {
        Self {
            slot: Arc::new((Mutex::new(Slot::default()), Condvar::new())),
            child: Arc::new(Mutex::new(None)),
        }
    }

    /// Kills the core this shell started. A core that was already running when
    /// the shell opened is left alone.
    fn kill_child(&self) {
        if let Ok(mut guard) = self.child.lock() {
            if let Some(mut child) = guard.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }
}

// ---------------------------------------------------------------------------
// The one command the UI invokes.
// ---------------------------------------------------------------------------

#[tauri::command]
async fn core_endpoint(state: State<'_, CoreState>) -> Result<CoreEndpoint, String> {
    let slot = state.slot.clone();
    tauri::async_runtime::spawn_blocking(move || wait_for_endpoint(&slot))
        .await
        .map_err(|error| format!("the endpoint task did not finish: {error}"))?
}

fn wait_for_endpoint(slot: &(Mutex<Slot>, Condvar)) -> Result<CoreEndpoint, String> {
    let (lock, ready) = slot;
    let deadline = Instant::now() + START_TIMEOUT + Duration::from_secs(2);
    let mut guard = lock
        .lock()
        .map_err(|_| "the core state is poisoned".to_string())?;

    while !guard.done {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err("no core answered within the start timeout".to_string());
        }
        let (next, timeout) = ready
            .wait_timeout(guard, remaining)
            .map_err(|_| "the core state is poisoned".to_string())?;
        guard = next;
        if timeout.timed_out() && !guard.done {
            return Err("no core answered within the start timeout".to_string());
        }
    }

    match (guard.endpoint.as_ref(), guard.error.as_ref()) {
        (Some(endpoint), _) => Ok(endpoint.clone()),
        (None, Some(error)) => Err(error.clone()),
        (None, None) => Err("the core resolved to nothing".to_string()),
    }
}

// ---------------------------------------------------------------------------
// Finding or starting the core.
// ---------------------------------------------------------------------------

fn hidden() -> bool {
    std::env::var("BOITE_SHELL_HIDDEN").ok().as_deref() == Some("1")
}

#[cfg(windows)]
fn default_data_dir() -> Result<PathBuf, String> {
    let local = std::env::var("LOCALAPPDATA")
        .map_err(|_| "LOCALAPPDATA is not set, so the data directory cannot be found".to_string())?;
    Ok(PathBuf::from(local).join("boite2"))
}

#[cfg(target_os = "macos")]
fn default_data_dir() -> Result<PathBuf, String> {
    let home = std::env::var("HOME")
        .map_err(|_| "HOME is not set, so the data directory cannot be found".to_string())?;
    Ok(PathBuf::from(home)
        .join("Library")
        .join("Application Support")
        .join("boite2"))
}

#[cfg(all(not(windows), not(target_os = "macos")))]
fn default_data_dir() -> Result<PathBuf, String> {
    let home = std::env::var("HOME")
        .map_err(|_| "HOME is not set, so the data directory cannot be found".to_string())?;
    Ok(PathBuf::from(home)
        .join(".local")
        .join("share")
        .join("boite2"))
}

fn data_dir() -> Result<PathBuf, String> {
    match std::env::var("BOITE_DATA_DIR") {
        Ok(value) if !value.trim().is_empty() => Ok(PathBuf::from(value.trim())),
        _ => default_data_dir(),
    }
}

fn read_core_file(path: &Path) -> Result<Option<CoreFile>, String> {
    let text = match std::fs::read_to_string(path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("{} could not be read: {error}", path.display())),
    };
    serde_json::from_str::<CoreFile>(&text)
        .map(Some)
        .map_err(|error| {
            format!(
                "{} is not a core.json: expected {{ port, host, token, pid }}, {error}",
                path.display()
            )
        })
}

fn endpoint_of(file: &CoreFile) -> CoreEndpoint {
    let host = match file.host.as_deref() {
        Some("0.0.0.0") | Some("::") | None => "127.0.0.1",
        Some(host) => host,
    };
    CoreEndpoint {
        url: format!("http://{host}:{}", file.port),
        token: file.token.clone(),
    }
}

/// A plain GET on `/health`, because one request does not deserve an HTTP crate.
fn health(port: u16) -> bool {
    let address = SocketAddr::from(([127, 0, 0, 1], port));
    let Ok(mut stream) = TcpStream::connect_timeout(&address, HEALTH_TIMEOUT) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(HEALTH_TIMEOUT));
    let _ = stream.set_write_timeout(Some(HEALTH_TIMEOUT));

    let request =
        format!("GET /health HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n");
    if stream.write_all(request.as_bytes()).is_err() {
        return false;
    }

    let mut head = [0u8; 32];
    let read = stream.read(&mut head).unwrap_or(0);
    let status = String::from_utf8_lossy(&head[..read]);
    status.starts_with("HTTP/1.1 200") || status.starts_with("HTTP/1.0 200")
}

fn repo_root() -> Option<PathBuf> {
    let mut starts: Vec<PathBuf> = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            starts.push(parent.to_path_buf());
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        starts.push(cwd);
    }

    for start in starts {
        let mut current: Option<&Path> = Some(start.as_path());
        while let Some(directory) = current {
            if let Ok(text) = std::fs::read_to_string(directory.join("package.json")) {
                if let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) {
                    if value.get("name").and_then(serde_json::Value::as_str) == Some("boite") {
                        return Some(directory.to_path_buf());
                    }
                }
            }
            current = directory.parent();
        }
    }
    None
}

fn sidecar() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let name = if cfg!(windows) {
        "boite-core.exe"
    } else {
        "boite-core"
    };
    let path = exe.parent()?.join(name);
    path.exists().then_some(path)
}

fn core_command() -> Result<(String, Vec<String>, Option<PathBuf>), String> {
    if let Ok(raw) = std::env::var("BOITE_CORE_COMMAND") {
        let mut parts = raw.split_whitespace().map(str::to_string);
        let program = parts
            .next()
            .ok_or_else(|| "BOITE_CORE_COMMAND is set but empty".to_string())?;
        return Ok((program, parts.collect(), None));
    }

    if let Some(path) = sidecar() {
        return Ok((path.display().to_string(), Vec::new(), None));
    }

    let repo = repo_root().ok_or_else(|| {
        "no boite-core sidecar next to the executable, and no package.json named \"boite\" above it"
            .to_string()
    })?;
    let entry = repo.join("packages").join("core").join("src").join("main.ts");
    Ok((
        "bun".to_string(),
        vec!["run".to_string(), entry.display().to_string()],
        Some(repo),
    ))
}

fn spawn_core() -> Result<(Child, Arc<AtomicBool>), String> {
    let (program, args, working_directory) = core_command()?;

    let mut command = Command::new(&program);
    command
        .args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    if let Some(directory) = working_directory {
        command.current_dir(directory);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = command
        .spawn()
        .map_err(|error| format!("the core could not be started with `{program}`: {error}"))?;

    let ready = Arc::new(AtomicBool::new(false));
    if let Some(stdout) = child.stdout.take() {
        let flag = ready.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { break };
                if line.contains(READY_LINE) {
                    flag.store(true, Ordering::Release);
                }
                eprintln!("[core] {line}");
            }
        });
    }

    Ok((child, ready))
}

fn resolve_core(child_slot: &Mutex<Option<Child>>) -> Result<CoreEndpoint, String> {
    let directory = data_dir()?;
    let file = directory.join("core.json");

    match read_core_file(&file) {
        Ok(Some(existing)) if health(existing.port) => return Ok(endpoint_of(&existing)),
        Ok(_) => {}
        Err(error) => eprintln!("[shell] {error}"),
    }

    let (child, ready) = spawn_core()?;
    if let Ok(mut guard) = child_slot.lock() {
        *guard = Some(child);
    }

    let started = Instant::now();
    while started.elapsed() < START_TIMEOUT {
        if ready.load(Ordering::Acquire) || started.elapsed() > Duration::from_secs(1) {
            if let Ok(Some(found)) = read_core_file(&file) {
                if health(found.port) {
                    return Ok(endpoint_of(&found));
                }
            }
        }
        std::thread::sleep(POLL_INTERVAL);
    }

    Err(format!(
        "the core did not write {} and answer /health within {} s",
        file.display(),
        START_TIMEOUT.as_secs()
    ))
}

fn start_core<R: Runtime>(app: &AppHandle<R>, state: &CoreState) {
    let slot = state.slot.clone();
    let child_slot = state.child.clone();
    let handle = app.clone();

    std::thread::spawn(move || {
        let outcome = resolve_core(&child_slot);
        {
            let (lock, ready) = &*slot;
            if let Ok(mut guard) = lock.lock() {
                match &outcome {
                    Ok(endpoint) => guard.endpoint = Some(endpoint.clone()),
                    Err(error) => guard.error = Some(error.clone()),
                }
                guard.done = true;
            }
            ready.notify_all();
        }
        if let Err(error) = outcome {
            eprintln!("[shell] {error}");
        }
        show_main(&handle);
    });
}

// ---------------------------------------------------------------------------
// Window and tray.
// ---------------------------------------------------------------------------

/// The window is created hidden by `tauri.conf.json` and only reaches the screen
/// here, once the core endpoint resolved, so an empty frame never flashes.
fn show_main<R: Runtime>(app: &AppHandle<R>) {
    if hidden() {
        return;
    }
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn hide_main<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }
}

fn quit<R: Runtime>(app: &AppHandle<R>) {
    if let Some(state) = app.try_state::<CoreState>() {
        state.kill_child();
    }
    app.exit(0);
}

fn build_tray<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "Show", true, None::<&str>)?;
    let leave = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &leave])?;

    let mut builder = TrayIconBuilder::with_id("boite")
        .tooltip("Boite")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => show_main(app),
            "quit" => quit(app),
            _ => {}
        });
    if let Some(icon) = app.default_window_icon().cloned() {
        builder = builder.icon(icon);
    }
    builder.build(app)?;
    Ok(())
}

pub fn run() {
    tauri::Builder::default()
        .manage(CoreState::new())
        .invoke_handler(tauri::generate_handler![core_endpoint])
        .setup(|app| {
            let handle = app.handle().clone();
            build_tray(&handle)?;
            start_core(&handle, &app.state::<CoreState>());

            let closing = handle.clone();
            if let Some(window) = app.get_webview_window("main") {
                window.on_window_event(move |event| {
                    if let WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        hide_main(&closing);
                    }
                });
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("the Boite shell could not be built")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                if let Some(state) = app.try_state::<CoreState>() {
                    state.kill_child();
                }
            }
        });
}
