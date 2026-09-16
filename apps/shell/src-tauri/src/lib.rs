//! The Boite desktop shell. Nothing here but the window, the tray, and the
//! local core: every decision the product makes lives in the core or the UI.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};
mod instance;
mod platform;
use platform::{job, default_data_dir};
use platform::job::CoreJob;
mod quota_window;

use serde::{Deserialize, Serialize};
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    utils::config::WindowEffectsConfig,
    window::Effect,
    AppHandle, Emitter, Manager, Runtime, State, Webview, WindowEvent,
};

mod browser;

use browser::MAIN_LABEL;

/// The line the core prints on stdout once its RPC server accepts connections.
const READY_LINE: &str = "boite-core ready";
const HEALTH_TIMEOUT: Duration = Duration::from_millis(500);
const START_TIMEOUT: Duration = Duration::from_secs(15);
const POLL_INTERVAL: Duration = Duration::from_millis(120);

// ---------------------------------------------------------------------------
// The install channel.
// ---------------------------------------------------------------------------

/// Which install of Boite this executable is. Stable and dev are two installs
/// on one machine, and three things separate them: the bundle identifier, the
/// product name, and the data directory. Only the identifier decides, read once
/// from the compiled config, so no environment variable can move a build to
/// another channel and no dev shell can adopt the stable core.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Channel {
    Stable,
    Dev,
}

impl Channel {
    /// `com.boite.two` is stable, `com.boite.two.dev` is dev.
    pub fn of_identifier(identifier: &str) -> Self {
        if identifier.ends_with(".dev") {
            Channel::Dev
        } else {
            Channel::Stable
        }
    }

    /// The directory name under the OS data root. It is the same name
    /// `dataDirName` returns in `packages/core/src/paths.ts`: the shell reads
    /// `core.json` where the core writes it, or it adopts the wrong core.
    pub fn data_dir_name(self) -> &'static str {
        match self {
            Channel::Stable => "boite2",
            Channel::Dev => "boite2-dev",
        }
    }

    /// What the window title and the tray tooltip read.
    pub fn product_name(self) -> &'static str {
        match self {
            Channel::Stable => "Boite",
            Channel::Dev => "Boite Dev",
        }
    }

    /// What this shell appends to the core's argv, so the core it starts picks
    /// the same default data directory the shell will look in.
    pub fn core_args(self) -> Vec<String> {
        match self {
            Channel::Stable => Vec::new(),
            Channel::Dev => vec!["--channel".to_string(), "dev".to_string()],
        }
    }
}

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
    /// Held for the life of the shell process: see `job::CoreJob`.
    job: Arc<Mutex<Option<CoreJob>>>,
    /// Read once from the bundle identifier, then carried everywhere the data
    /// directory and the core's argv are decided.
    channel: Channel,
}

#[derive(Default, Serialize, Deserialize)]
struct ShellPreferences { close_to_tray: bool }

struct CloseBehavior { enabled: AtomicBool, path: PathBuf }

fn read_close_behavior(path: &Path) -> Result<bool, String> {
    match std::fs::read_to_string(path) {
        Ok(text) => serde_json::from_str::<ShellPreferences>(&text).map(|p| p.close_to_tray)
            .map_err(|e| format!("{} must contain a boolean close_to_tray: {e}", path.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(format!("{} could not be read: {e}", path.display())),
    }
}

/// `read_close_behavior` for `run()`, which starts before any window exists: a
/// malformed `shell-settings.json` must never take the app down with it. The
/// same default `read_close_behavior` already uses for a missing file, logged
/// rather than turned into a panic, exactly what `read_core_file`'s caller
/// already does for a corrupt `core.json`.
fn close_to_tray_or_default(path: &Path) -> bool {
    match read_close_behavior(path) {
        Ok(value) => value,
        Err(error) => {
            eprintln!("[shell] {error}; using the default close behavior (close_to_tray: false)");
            false
        }
    }
}

#[tauri::command]
fn close_behavior(webview: Webview, state: State<'_, CloseBehavior>, enabled: Option<bool>) -> Result<bool, String> {
    browser::only_main(&webview)?;
    if let Some(enabled) = enabled {
        let text = serde_json::to_string(&ShellPreferences { close_to_tray: enabled }).map_err(|e| e.to_string())?;
        let temporary = state.path.with_extension("tmp");
        std::fs::write(&temporary, text).map_err(|e| format!("close behavior could not be saved: {e}"))?;
        std::fs::rename(&temporary, &state.path).map_err(|e| format!("close behavior could not be saved: {e}"))?;
        state.enabled.store(enabled, Ordering::Release);
    }
    Ok(state.enabled.load(Ordering::Acquire))
}

impl CoreState {
    fn new(channel: Channel) -> Self {
        Self {
            slot: Arc::new((Mutex::new(Slot::default()), Condvar::new())),
            child: Arc::new(Mutex::new(None)),
            job: Arc::new(Mutex::new(None)),
            channel,
        }
    }

    /// Kills the core this shell started. A core that was already running when
    /// the shell opened is left alone.
    fn kill_child(&self) {
        if let Ok(mut guard) = self.child.lock() {
            if let Some(mut child) = guard.take() {
                job::stop_core(&mut child);
            }
        }
        // Dropping the job closes its handle, which kills whatever is still in
        // it: a core that ignored the kill, and anything it had spawned.
        if let Ok(mut guard) = self.job.lock() {
            drop(guard.take());
        }
    }
}

// ---------------------------------------------------------------------------
// The commands the shell's own page can invoke.
// ---------------------------------------------------------------------------

/// The clean quit, the very one the tray's Quit item runs: `kill_child` first,
/// then the app. Closing the window takes this path too, unless the saved
/// close behavior explicitly keeps the shell in the notification area.
/// `tests/e2e/shell.test.ts` invokes this.
#[tauri::command]
fn quit_shell(app: AppHandle, webview: Webview) -> Result<(), String> {
    quota_window::only_ui(&webview)?;
    quit(&app);
    Ok(())
}

/// What the UI's "Window material" setting asks of the window, as the effects
/// Tauri hands to `window_vibrancy`. `None` is the answer for "solid": it clears
/// whatever the window wears. Pure, so every case is a test, and a value nobody
/// defined is refused with the value in the message rather than quietly falling
/// back on a material the user never picked.
fn effects_for(kind: &str) -> Result<Option<WindowEffectsConfig>, String> {
    let effects = match kind {
        // Tauri applies the first effect of the list and ignores the rest, so
        // the order is the choice: acrylic, and blur behind it for a Windows
        // that has no acrylic to give.
        "acrylic" => vec![Effect::Acrylic, Effect::Blur],
        "mica" => vec![Effect::Mica],
        "solid" => return Ok(None),
        other => {
            return Err(format!(
                "unknown window material {other:?}: acrylic, mica or solid"
            ))
        }
    };
    Ok(Some(WindowEffectsConfig {
        effects,
        state: None,
        radius: None,
        color: None,
    }))
}

/// The material the window wears, changed from the settings page while the app
/// runs. Async like the browser commands: a synchronous command runs on the main
/// thread, which is the thread the window work has to come back to.
#[tauri::command]
async fn window_material(app: AppHandle, webview: Webview, kind: String) -> Result<(), String> {
    browser::only_main(&webview)?;
    let effects = effects_for(&kind)?;
    let window = app
        .get_webview_window(MAIN_LABEL)
        .ok_or_else(|| format!("the {MAIN_LABEL:?} window is gone: no material was applied"))?;
    window
        .set_effects(effects)
        .map_err(|error| format!("the window material {kind:?} was refused: {error}"))
}

/// Whether this platform has a window material at all. Windows does and nothing
/// else here does, and the setting hides itself on a false: a control that
/// changes nothing is worse than no control.
#[tauri::command]
fn window_material_supported(webview: Webview) -> Result<bool, String> {
    browser::only_main(&webview)?;
    Ok(cfg!(windows))
}

/// A system toast for a thread. A click brings the window back and tells the
/// UI which thread through `notification://open`; the UI opens it.
#[tauri::command]
fn notify(app: AppHandle, webview: Webview, title: String, body: String, thread_id: String) -> Result<(), String> {
    quota_window::only_ui(&webview)?;
    platform::notify(app, title, body, thread_id)
}

/// The core token rides in this answer, so the caller is checked like every
/// other: a page a browser surface loaded asks and is told no.
#[tauri::command]
async fn core_endpoint(
    webview: Webview,
    state: State<'_, CoreState>,
) -> Result<CoreEndpoint, String> {
    quota_window::only_ui(&webview)?;
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

// Webviews sharing a profile must also share environment options. Elevated
// hosts ignore WebView2's environment variables, so each builder uses the API.
fn test_browser_args() -> Option<String> {
    if !hidden() { return None; }
    let value = std::env::var("BOITE_SHELL_DEBUG_PORT").ok()?;
    let port: u16 = value.parse().expect("BOITE_SHELL_DEBUG_PORT must be a port number");
    assert!(port > 0, "BOITE_SHELL_DEBUG_PORT must be greater than zero");
    Some(format!("--remote-debugging-port={port} --remote-allow-origins=* --mute-audio --use-angle=d3d11"))
}


fn data_dir(channel: Channel) -> Result<PathBuf, String> {
    match std::env::var("BOITE_DATA_DIR") {
        Ok(value) if !value.trim().is_empty() => Ok(PathBuf::from(value.trim())),
        _ => default_data_dir(channel),
    }
}

/// `data_dir` for `run()`: an unresolvable `%APPDATA%` (or `HOME`) no longer
/// panics before any window exists. The OS temp directory is the fallback,
/// present on every platform this ships to, so the shell still starts and
/// says, in a line an attached terminal or log redirection can show, why its
/// data now lives there instead.
fn resolve_data_dir(channel: Channel) -> PathBuf {
    match data_dir(channel) {
        Ok(directory) => directory,
        Err(error) => {
            eprintln!("[shell] {error}; falling back to a data directory under the OS temp directory");
            std::env::temp_dir().join(channel.data_dir_name())
        }
    }
}

/// The WebView2 profile the main window and every browser surface share. `None`
/// leaves it to Tauri, which puts it under the app's own local data directory.
/// One profile means one browser process for the whole shell.
fn webview_profile() -> Option<PathBuf> {
    let value = std::env::var("BOITE_DATA_DIR").ok()?;
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(PathBuf::from(trimmed).join("webview"))
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

/// The JSON body the real core answers `/health` with
/// (`packages/core/src/server.ts:209-211`: `{ ok, version, pid }`). Only `ok`
/// and `pid` matter here; `version` rides along unread.
#[derive(Deserialize)]
struct HealthBody {
    #[serde(default)]
    ok: bool,
    #[serde(default)]
    pid: Option<u32>,
}

/// A bound on how much of a `/health` response is ever read, so a local
/// process that keeps the connection open and streams data cannot be used to
/// tie up the shell's startup past `HEALTH_TIMEOUT` with unbounded memory.
/// The real response is a small JSON object; this is generous over that.
const HEALTH_RESPONSE_LIMIT: usize = 8 * 1024;

/// A GET on `/health`, because one request does not deserve an HTTP crate.
/// The response is read to its end (or to `HEALTH_RESPONSE_LIMIT`, or until
/// `HEALTH_TIMEOUT` elapses) and handed to `health_response_matches`, which is
/// what actually decides whether this is the core `core.json` described.
fn health(port: u16, expected_pid: u32) -> bool {
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

    let mut response = Vec::new();
    let mut chunk = [0u8; 1024];
    loop {
        if response.len() >= HEALTH_RESPONSE_LIMIT {
            break;
        }
        match stream.read(&mut chunk) {
            Ok(0) => break,
            Ok(read) => response.extend_from_slice(&chunk[..read]),
            Err(_) => break,
        }
    }
    health_response_matches(&response, expected_pid)
}

/// The pure parse behind `health`, kept separate from the socket so a crafted
/// response can be checked without one. A response that is not a 200, that
/// carries no blank line ending its headers, whose body is not the JSON
/// `/health` answers with, or whose `pid` is not `expected_pid`, is never a
/// match: a local process squatting the port and merely echoing
/// `HTTP/1.1 200` gets none of these right unless it can also read
/// `core.json`, which is exactly what it is being asked to prove it can.
fn health_response_matches(response: &[u8], expected_pid: u32) -> bool {
    let text = String::from_utf8_lossy(response);
    if !(text.starts_with("HTTP/1.1 200") || text.starts_with("HTTP/1.0 200")) {
        return false;
    }
    let Some(body_start) = text.find("\r\n\r\n") else {
        return false;
    };
    let body = &text[body_start + 4..];
    match serde_json::from_str::<HealthBody>(body) {
        Ok(parsed) => parsed.ok && parsed.pid == Some(expected_pid),
        Err(_) => false,
    }
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

fn sidecar() -> Result<Option<PathBuf>, String> {
    let exe = std::env::current_exe().map_err(|error| error.to_string())?;
    let name = if cfg!(windows) {
        "boite-core.exe"
    } else {
        "boite-core"
    };
    let directory = exe.parent().ok_or("the shell executable has no parent directory")?;
    let path = directory.join(name);
    if !path.exists() { return Ok(None); }
    #[cfg(windows)]
    check_workers(directory)?;
    Ok(Some(path))
}

#[cfg(any(windows, test))]
fn check_workers(directory: &Path) -> Result<(), String> {
    for name in ["jobs-worker.js", "guard-worker.js"] {
        let worker = directory.join(name);
        if !worker.is_file() {
            return Err(format!("missing core worker: {}. Reinstall or run bun run stage:core", worker.display()));
        }
    }
    Ok(())
}

/// In order: `BOITE_CORE_COMMAND`, the `boite-core` sidecar next to this
/// executable, the core bundle a repository above it has built, its sources.
/// Whatever the source, the channel rides on the argv: a dev shell starts a dev
/// core, which writes its `core.json` in the directory this shell then reads.
fn core_command(channel: Channel) -> Result<(String, Vec<String>, Option<PathBuf>), String> {
    let (program, mut args, working_directory) = core_program()?;
    args.extend(channel.core_args());
    Ok((program, args, working_directory))
}

/// Where the core comes from, with no opinion on the channel.
fn core_program() -> Result<(String, Vec<String>, Option<PathBuf>), String> {
    if let Ok(raw) = std::env::var("BOITE_CORE_COMMAND") {
        let mut parts = raw.split_whitespace().map(str::to_string);
        let program = parts
            .next()
            .ok_or_else(|| "BOITE_CORE_COMMAND is set but empty".to_string())?;
        return Ok((program, parts.collect(), None));
    }

    if let Some(path) = sidecar()? {
        return Ok((path.display().to_string(), Vec::new(), None));
    }

    let repo = repo_root().ok_or_else(|| {
        "no boite-core sidecar next to the executable, and no package.json named \"boite\" above it"
            .to_string()
    })?;
    let core = repo.join("packages").join("core");
    let bundle = core.join("dist").join("main.js");
    let entry = if bundle.exists() {
        bundle
    } else {
        core.join("src").join("main.ts")
    };
    Ok((
        "bun".to_string(),
        vec!["run".to_string(), entry.display().to_string()],
        Some(repo),
    ))
}

fn spawn_core(channel: Channel, resources: Option<&Path>) -> Result<(Child, Arc<AtomicBool>, CoreJob), String> {
    let (program, args, working_directory) = core_command(channel)?;
    let job = job::create_core_job()?;

    let mut command = Command::new(&program);
    command
        .args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    if let Some(directory) = working_directory {
        command.current_dir(directory);
    }
    if let Some(ui) = resources.map(|path| path.join("ui")).filter(|path| path.join("index.html").is_file()) {
        command.env("BOITE_UI_DIR", ui);
    }
    platform::prepare_command(&mut command);

    let mut child = command
        .spawn()
        .map_err(|error| format!("the core could not be started with `{program}`: {error}"))?;

    if let Err(error) = job::assign(&job, &child) {
        let _ = child.kill();
        let _ = child.wait();
        return Err(format!("the core could not be put in this shell's job object: {error}"));
    }

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

    Ok((child, ready, job))
}

fn resolve_core(
    channel: Channel,
    child_slot: &Mutex<Option<Child>>,
    job_slot: &Mutex<Option<CoreJob>>,
    resources: Option<&Path>,
) -> Result<CoreEndpoint, String> {
    let directory = data_dir(channel)?;
    let file = directory.join("core.json");

    match read_core_file(&file) {
        Ok(Some(existing)) if existing.pid.map_or(false, |pid| health(existing.port, pid)) => {
            return Ok(endpoint_of(&existing))
        }
        Ok(_) => {}
        Err(error) => eprintln!("[shell] {error}"),
    }

    let (child, ready, job) = spawn_core(channel, resources)?;
    if let Ok(mut guard) = child_slot.lock() {
        *guard = Some(child);
    }
    if let Ok(mut guard) = job_slot.lock() {
        *guard = Some(job);
    }

    let started = Instant::now();
    while started.elapsed() < START_TIMEOUT {
        if ready.load(Ordering::Acquire) || started.elapsed() > Duration::from_secs(1) {
            if let Ok(Some(found)) = read_core_file(&file) {
                if found.pid.map_or(false, |pid| health(found.port, pid)) {
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
    let job_slot = state.job.clone();
    let channel = state.channel;
    let handle = app.clone();
    let resources = app.path().resource_dir().ok();

    std::thread::spawn(move || {
        let outcome = resolve_core(channel, &child_slot, &job_slot, resources.as_deref());
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

/// The main window, built here rather than in `tauri.conf.json` so a run on its
/// own data directory (a test, a bench) keeps its WebView2 profile there too.
/// WebView2 runs one browser process per profile: on the default profile the
/// test's shell would attach to the browser the installed app already started,
/// which carries no debugging port.
fn build_main_window<R: Runtime>(
    app: &AppHandle<R>,
    channel: Channel,
) -> tauri::Result<tauri::WebviewWindow<R>> {
    let mut builder =
        tauri::WebviewWindowBuilder::new(app, MAIN_LABEL, tauri::WebviewUrl::default())
            .title(channel.product_name())
            .inner_size(1280.0, 800.0)
            .min_inner_size(880.0, 560.0)
            .resizable(true)
            .decorations(false)
            .visible(false)
            .focused(!hidden())
            .skip_taskbar(hidden())
            // The browser surfaces belong to the page that asked for them: a
            // reload of the UI takes every child webview with it.
            .on_page_load(|window, payload| {
                if matches!(payload.event(), tauri::webview::PageLoadEvent::Started) {
                    browser::close_all(window.app_handle());
                }
            });
    // Acrylic is what a window opens on, and `lib/glass.ts` re-applies whatever
    // the setting says as soon as the UI mounts. Only Windows has a material;
    // elsewhere the window stays opaque.
    #[cfg(windows)]
    {
        builder = builder.transparent(true).effects(WindowEffectsConfig {
            effects: vec![Effect::Acrylic, Effect::Mica, Effect::Blur],
            state: None,
            radius: None,
            color: None,
        });
    }
    if let Some(directory) = webview_profile() {
        builder = builder.data_directory(directory);
    }
    if let Some(args) = test_browser_args() {
        builder = builder.additional_browser_args(&args);
    }
    builder.build()
}

/// The window is created hidden and only reaches the screen here, once the
/// core endpoint resolved, so an empty frame never flashes.
fn show_main<R: Runtime>(app: &AppHandle<R>) {
    if let Some(state) = app.try_state::<quota_window::HoverState>() { state.cancel_open(); }
    if let Some(popup) = app.get_webview_window(quota_window::LABEL) {
        let _ = popup.hide();
        let _ = popup.emit("tray://closed", ());
    }
    if hidden() {
        return;
    }
    if let Some(window) = app.get_webview_window(MAIN_LABEL) {
        let _ = window.unminimize();
        let _ = window.set_skip_taskbar(false);
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn hide_main<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window(MAIN_LABEL) {
        let _ = window.hide();
        let _ = window.set_skip_taskbar(true);
    }
}

fn quit<R: Runtime>(app: &AppHandle<R>) {
    if let Some(state) = app.try_state::<CoreState>() {
        state.kill_child();
    }
    app.exit(0);
}

fn build_tray<R: Runtime>(app: &AppHandle<R>, channel: Channel) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "Show", true, None::<&str>)?;
    let leave = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &leave])?;

    let mut builder = TrayIconBuilder::with_id("boite")
        .tooltip(channel.product_name())
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_tray_icon_event(|tray, event| {
            use tauri::tray::{MouseButton, TrayIconEvent};
            match event {
                TrayIconEvent::Enter { .. } => quota_window::enter(tray.app_handle()),
                TrayIconEvent::Leave { .. } => quota_window::leave(tray.app_handle()),
                TrayIconEvent::DoubleClick { button: MouseButton::Left, .. } => show_main(tray.app_handle()),
                _ => {}
            }
        })
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => show_main(app),
            "quit" => quit(app),
            _ => {}
        });
    if let Some(icon) = app.default_window_icon().cloned() {
        builder = builder.icon(icon);
    }
    // Keep an explicit app-owned reference for the entire shell lifetime.
    app.manage(builder.build(app)?);
    Ok(())
}

pub fn run() {
    // The channel is read here and nowhere else: the compiled bundle identifier
    // is the only thing that says which install this executable is. Nothing
    // from here to the end of this block may panic: there is no window yet,
    // so a panic here is the app not starting with nothing the user can see.
    let context = tauri::generate_context!();
    let channel = Channel::of_identifier(&context.config().identifier);
    let directory = resolve_data_dir(channel);
    let _instance = match instance::acquire(&directory) {
        Ok(Some(file)) => Some(file),
        // Another instance already owns this data directory: it has the
        // window, so this process has nothing left to do.
        Ok(None) => return,
        Err(error) => {
            eprintln!(
                "[shell] the shell instance lock could not be acquired: {error}; continuing without single-instance protection"
            );
            None
        }
    };
    let preferences_path = directory.join("shell-settings.json");
    let close_to_tray = close_to_tray_or_default(&preferences_path);

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(CoreState::new(channel))
        .manage(quota_window::HoverState::default())
        .manage(CloseBehavior { enabled: AtomicBool::new(close_to_tray), path: preferences_path })
        .invoke_handler(tauri::generate_handler![
            core_endpoint,
            quit_shell,
            notify,
            close_behavior,
            quota_window::quota_window,
            window_material,
            window_material_supported,
            browser::browser_create,
            browser::browser_navigate,
            browser::browser_back,
            browser::browser_forward,
            browser::browser_reload,
            browser::browser_set_bounds,
            browser::browser_set_zoom,
            browser::browser_destroy,
        ])
        .setup(move |app| {
            let handle = app.handle().clone();
            let window = build_main_window(&handle, channel)?;
            if !hidden() {
                build_tray(&handle, channel)?;
            }
            start_core(&handle, &app.state::<CoreState>());

            let closing = handle.clone();
            window.on_window_event(move |event| {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    if closing.state::<CloseBehavior>().enabled.load(Ordering::Acquire) { hide_main(&closing); }
                    else { quit(&closing); }
                }
            });
            Ok(())
        })
        .build(context)
        .expect("the Boite shell could not be built")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                if let Some(state) = app.try_state::<CoreState>() {
                    state.kill_child();
                }
            }
        });
}

#[cfg(test)]
mod tests {
    use super::{effects_for, Channel};
    use tauri::window::Effect;

    #[test]
    fn both_sidecar_workers_are_required() {
        let directory = std::env::temp_dir().join(format!("boite-workers-{}", std::process::id()));
        std::fs::create_dir_all(&directory).unwrap();
        assert!(super::check_workers(&directory).unwrap_err().contains("jobs-worker.js"));
        std::fs::write(directory.join("jobs-worker.js"), "").unwrap();
        assert!(super::check_workers(&directory).unwrap_err().contains("guard-worker.js"));
        std::fs::write(directory.join("guard-worker.js"), "").unwrap();
        assert!(super::check_workers(&directory).is_ok());
        std::fs::remove_dir_all(directory).unwrap();
    }

    // -----------------------------------------------------------------------
    // Finding 4 (security audit, 2026-09-12): `health` used to accept any
    // local listener that merely echoed `HTTP/1.1 200`. These are the four
    // cases the fix is required to tell apart, all through the pure parse
    // rather than a real socket.
    // -----------------------------------------------------------------------

    #[test]
    fn health_response_matches_the_real_core_body_with_the_matching_pid() {
        let response = b"HTTP/1.1 200 OK\r\ncontent-type: application/json;charset=utf-8\r\ncontent-length: 40\r\n\r\n{\"ok\":true,\"version\":\"2.0.0\",\"pid\":4242}";
        assert!(super::health_response_matches(response, 4242));
    }

    #[test]
    fn health_response_refuses_a_body_naming_a_different_pid() {
        let response = b"HTTP/1.1 200 OK\r\ncontent-type: application/json\r\n\r\n{\"ok\":true,\"version\":\"2.0.0\",\"pid\":1}";
        assert!(!super::health_response_matches(response, 4242));
    }

    #[test]
    fn health_response_refuses_a_body_that_is_not_json() {
        let response = b"HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\n\r\nsquatting this port";
        assert!(!super::health_response_matches(response, 4242));
    }

    #[test]
    fn health_response_refuses_a_bare_200_with_no_body() {
        let response = b"HTTP/1.1 200 OK\r\n\r\n";
        assert!(!super::health_response_matches(response, 4242));
    }

    // -----------------------------------------------------------------------
    // Finding 6 (security audit) / finding 2 (platform audit, 2026-09-12): a
    // malformed `shell-settings.json` used to panic `run()` before any window
    // existed. `close_to_tray_or_default` must answer a plain bool for all
    // four shapes the file can be in, never an `Err` that only `.expect()` was
    // there to turn into a crash.
    // -----------------------------------------------------------------------

    fn settings_path(name: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "boite-shell-settings-{}-{name}.json",
            std::process::id()
        ))
    }

    #[test]
    fn close_behavior_reads_a_valid_file() {
        let path = settings_path("valid");
        std::fs::write(&path, r#"{"close_to_tray":true}"#).unwrap();
        assert_eq!(super::close_to_tray_or_default(&path), true);
        std::fs::remove_file(&path).unwrap();
    }

    #[test]
    fn close_behavior_falls_back_to_the_default_on_malformed_json() {
        let path = settings_path("malformed");
        std::fs::write(&path, "{not json").unwrap();
        assert_eq!(super::close_to_tray_or_default(&path), false);
        std::fs::remove_file(&path).unwrap();
    }

    #[test]
    fn close_behavior_falls_back_to_the_default_on_the_wrong_type() {
        let path = settings_path("wrong-type");
        std::fs::write(&path, r#"{"close_to_tray":"yes"}"#).unwrap();
        assert_eq!(super::close_to_tray_or_default(&path), false);
        std::fs::remove_file(&path).unwrap();
    }

    #[test]
    fn close_behavior_falls_back_to_the_default_on_a_missing_file() {
        let path = settings_path("missing");
        let _ = std::fs::remove_file(&path);
        assert_eq!(super::close_to_tray_or_default(&path), false);
    }

    #[cfg(windows)]
    #[test]
    fn a_toast_carries_the_identifier_once_installed_and_powershells_id_under_target() {
        use crate::platform::windows::toast_app_id;
        use std::path::Path;
        let id = "com.boite.two";
        assert_eq!(toast_app_id(Path::new(r"C:\Users\x\AppData\Local\Boite"), id), id);
        assert_eq!(toast_app_id(Path::new(r"D:\src\boite\apps\shell\src-tauri\target\release"), id).contains("powershell.exe"), true);
        assert_eq!(toast_app_id(Path::new(r"D:\src\boite\apps\shell\src-tauri\target\debug"), id).contains("powershell.exe"), true);
        // A directory merely named release, not under target, is an install.
        assert_eq!(toast_app_id(Path::new(r"D:\apps\release"), id), id);
    }

    #[test]
    fn the_identifier_is_the_only_thing_that_names_the_channel() {
        assert_eq!(Channel::of_identifier("com.boite.two"), Channel::Stable);
        assert_eq!(Channel::of_identifier("com.boite.two.dev"), Channel::Dev);
        // A name that merely mentions dev is not a channel: only the suffix is.
        assert_eq!(Channel::of_identifier("com.boite.devtwo"), Channel::Stable);
    }

    #[test]
    fn a_channel_names_its_own_data_directory_and_product() {
        assert_eq!(Channel::Stable.data_dir_name(), "boite2");
        assert_eq!(Channel::Dev.data_dir_name(), "boite2-dev");
        assert_eq!(Channel::Stable.product_name(), "Boite");
        assert_eq!(Channel::Dev.product_name(), "Boite Dev");
    }

    #[test]
    fn only_the_dev_channel_puts_anything_on_the_cores_argv() {
        assert!(Channel::Stable.core_args().is_empty());
        assert_eq!(Channel::Dev.core_args(), vec!["--channel", "dev"]);
    }

    #[test]
    fn acrylic_asks_for_acrylic_first_and_blur_behind_it() {
        let config = effects_for("acrylic")
            .expect("acrylic is a material")
            .expect("acrylic paints something");
        assert_eq!(config.effects, vec![Effect::Acrylic, Effect::Blur]);
    }

    #[test]
    fn mica_asks_for_mica_alone() {
        let config = effects_for("mica")
            .expect("mica is a material")
            .expect("mica paints something");
        assert_eq!(config.effects, vec![Effect::Mica]);
    }

    #[test]
    fn solid_clears_the_material_rather_than_painting_one() {
        assert!(effects_for("solid").expect("solid is a material").is_none());
    }

    #[test]
    fn a_material_nobody_defined_is_refused_by_name() {
        let error = effects_for("frosted").expect_err("frosted is not a material");
        assert!(error.contains("frosted"), "the refusal never named it: {error}");
    }
}
