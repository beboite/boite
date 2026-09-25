//! The Boite desktop shell. Nothing here but the window, the tray, and the
//! local core: every decision the product makes lives in the core or the UI.

use std::collections::VecDeque;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};
mod instance;
mod platform;
mod resident;
use platform::{job, default_data_dir};
use platform::job::CoreJob;
mod quota_window;
mod updater;

// Tauri links its manifest into binaries, but not the library test executable.
// Native updater tests import TaskDialogIndirect, which needs Common Controls v6.
#[cfg(all(test, target_os = "windows"))]
#[link(name = "resource", kind = "static", modifiers = "-bundle")]
unsafe extern "C" {}

use serde::{Deserialize, Serialize};
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    utils::config::WindowEffectsConfig,
    window::Effect,
    AppHandle, Manager, Runtime, State, Webview, WindowEvent,
};

mod browser;

use browser::MAIN_LABEL;

/// The line the core prints on stdout once its RPC server accepts connections.
const READY_LINE: &str = "boite-core ready";
const HEALTH_TIMEOUT: Duration = Duration::from_millis(500);
/// How long a core the shell started gets to answer. A warm start takes about
/// a second; the first start of a freshly installed sidecar, scanned by the
/// antivirus on a slow disk, took several times that, so the margin is wide.
const START_TIMEOUT: Duration = Duration::from_secs(60);
/// How often the wait on a starting core looks again. The check is a flag read
/// until the ready line came, so 10 ms costs nothing, and at 120 ms the window
/// opened 60 ms late on average for a core that is up in about as long.
const POLL_INTERVAL: Duration = Duration::from_millis(10);

// A concurrent POSIX spawn can briefly inherit a flock until exec closes its
// descriptor. Keep process creation separate from tests asserting lock release.
#[cfg(test)]
pub(crate) static PROCESS_TEST_LOCK: Mutex<()> = Mutex::new(());

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

impl CoreFile {
    /// What tells one run of a core from another: a new run binds a new port
    /// under a new pid, so a `core.json` with the same pair is the same run.
    fn identity(&self) -> (Option<u32>, u16) {
        (self.pid, self.port)
    }
}

#[derive(Default)]
struct Slot {
    endpoint: Option<CoreEndpoint>,
    /// The process behind `endpoint`, to notice once it has exited.
    pid: Option<u32>,
    error: Option<String>,
    done: bool,
    /// Bumped each time a new resolution starts, so that of several callers
    /// who find the same dead core only the first starts another.
    generation: u64,
}

/// The command line that starts the core.
#[derive(Clone, Debug)]
struct CoreCommand {
    program: String,
    args: Vec<String>,
    working_directory: Option<PathBuf>,
}

/// Everything a start of the core depends on, decided once when the app is
/// set up and never read from the environment again.
#[derive(Clone)]
struct Launch {
    /// The data directory, resolved once: the core is told it with
    /// `--data-dir`, so the shell and the core can never look in two places.
    directory: PathBuf,
    /// An error here is only reported when a core has to be started, since a
    /// running core can be adopted without one.
    command: Result<CoreCommand, String>,
    resources: Option<PathBuf>,
    resident: bool,
    /// The shell's own version. A running core that reports another version
    /// belongs to the install an update replaced, and is stopped.
    version: String,
    /// How long a started core gets to answer `/health`.
    timeout: Duration,
}

impl Launch {
    fn new(channel: Channel, directory: PathBuf, resources: Option<PathBuf>, version: String) -> Self {
        Self {
            command: core_command(channel, &directory),
            directory,
            resources,
            resident: resident_core(),
            version,
            timeout: START_TIMEOUT,
        }
    }

    /// How long a caller of `core_endpoint` may wait on one resolution: the
    /// start itself, plus stopping an older core first.
    fn patience(&self) -> Duration {
        self.timeout + resident::GRACE + Duration::from_secs(5)
    }
}

/// What a core this shell started said on its way up, kept to explain an
/// early exit or a start that never answered.
enum Output {
    /// The last lines of stdout and stderr, for a core the shell owns.
    Ring(Arc<Mutex<VecDeque<String>>>),
    /// A resident core writes to `core-output.log`: what it wrote since `from`.
    Log { path: PathBuf, from: u64 },
}

/// How many lines of the core's output an error quotes.
const TAIL_LINES: usize = 20;

impl Output {
    fn tail(&self) -> Vec<String> {
        match self {
            Output::Ring(lines) => lines.lock().map(|lines| lines.iter().cloned().collect()).unwrap_or_default(),
            Output::Log { path, from } => {
                use std::io::{Seek, SeekFrom};
                let mut text = Vec::new();
                if let Ok(mut file) = std::fs::File::open(path) {
                    // The tail only: a log that grew by megabytes still costs one small read.
                    let length = file.metadata().map(|m| m.len()).unwrap_or(0);
                    let start = (*from).max(length.saturating_sub(64 * 1024));
                    if file.seek(SeekFrom::Start(start)).is_ok() {
                        let _ = file.read_to_end(&mut text);
                    }
                }
                let text = String::from_utf8_lossy(&text);
                let lines: Vec<String> = text.lines().filter(|line| !line.trim().is_empty()).map(str::to_string).collect();
                lines[lines.len().saturating_sub(TAIL_LINES)..].to_vec()
            }
        }
    }

    /// `: <what it printed>` for an error message, or a note that it printed nothing.
    fn quoted(&self) -> String {
        let lines = self.tail();
        if lines.is_empty() {
            return match self {
                Output::Ring(_) => "; it printed nothing".to_string(),
                Output::Log { path, .. } => format!("; it wrote nothing to {}", path.display()),
            };
        }
        format!(":\n{}", lines.join("\n"))
    }
}

fn remember(lines: &Mutex<VecDeque<String>>, line: &str) {
    if let Ok(mut lines) = lines.lock() {
        if lines.len() == TAIL_LINES {
            lines.pop_front();
        }
        lines.push_back(line.to_string());
    }
}

/// A core this shell started.
struct Spawned {
    child: Child,
    /// Set once the core printed `READY_LINE` (owned cores only: a resident
    /// core's stdout goes to its log file).
    ready: Arc<AtomicBool>,
    output: Output,
    readers: Vec<std::thread::JoinHandle<()>>,
}

impl Spawned {
    /// Lets the pipe readers take what the core wrote before it exited, for a
    /// moment at most: a process the core started can hold the pipe open.
    fn settle(&self) {
        let deadline = Instant::now() + Duration::from_millis(300);
        while self.readers.iter().any(|reader| !reader.is_finished()) && Instant::now() < deadline {
            std::thread::sleep(POLL_INTERVAL);
        }
    }
}

pub struct CoreState {
    slot: (Mutex<Slot>, Condvar),
    child: Mutex<Option<Spawned>>,
    /// Held for the life of the shell process: see `job::CoreJob`.
    job: Mutex<Option<CoreJob>>,
    launch: Launch,
    /// Set while an update installs: the core was stopped so the installer can
    /// replace its files, and nothing may start it again from the old ones.
    held: AtomicBool,
}

/// The refusal a caller gets while an update installs.
const HELD: &str = "the core is stopped while the app update installs";

/// Normal installations keep the core alive. Automation can request owned lifetime.
fn resident_core() -> bool { std::env::var("BOITE_CORE_RESIDENT").as_deref() != Ok("0") }

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
    fn new(launch: Launch) -> Self {
        Self {
            slot: (Mutex::new(Slot::default()), Condvar::new()),
            child: Mutex::new(None),
            job: Mutex::new(None),
            launch,
            held: AtomicBool::new(false),
        }
    }

    /// Stops the local core before an installer replaces its files, and keeps
    /// it stopped: the window notices the lost core within seconds and asks for
    /// it again, which would otherwise start the old executable and lock it.
    /// An error leaves the core running and the hold released.
    pub(crate) fn stop_for_install(&self) -> Result<(), String> {
        self.held.store(true, Ordering::SeqCst);
        let stopped = resident::stop_local_core(&self.launch.directory, resident::GRACE);
        if stopped.is_err() {
            self.release_hold();
        }
        stopped.map(|_| ())
    }

    /// The install did not happen: the next caller starts the core again.
    pub(crate) fn release_hold(&self) {
        self.held.store(false, Ordering::SeqCst);
    }

    /// Closing a client leaves a resident core running. Automation may own its child.
    fn kill_child(&self) {
        if let Ok(mut guard) = self.child.lock() {
            if let Some(mut spawned) = guard.take() {
                if !self.launch.resident { job::stop_core(&mut spawned.child); }
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

/// Quits the client. The resident engine has a separate authenticated stop action.
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

/// The Windows build number, 0 off Windows.
fn windows_build() -> u32 {
    #[cfg(windows)]
    { windows_version::OsVersion::current().build }
    #[cfg(not(windows))]
    { 0 }
}

/// The materials this Windows build draws without a cost the user feels. Mica
/// exists from Windows 11 (22000). Acrylic before 22523 is the
/// `SetWindowCompositionAttribute` path that `window_vibrancy` itself warns
/// makes the window lag on every drag and resize; from 22523 DWM draws it as a
/// system backdrop, as cheap as mica. So acrylic is offered from 22523 only,
/// and Windows 10 gets solid alone. Pure, so every build is a test.
fn supported_materials(build: u32) -> Vec<&'static str> {
    let mut kinds = Vec::with_capacity(3);
    if build >= 22523 { kinds.push("acrylic"); }
    if build >= 22000 { kinds.push("mica"); }
    kinds.push("solid");
    kinds
}

/// The material the window wears, changed from the settings page while the app
/// runs. Async like the browser commands: a synchronous command runs on the main
/// thread, which is the thread the window work has to come back to.
#[tauri::command]
async fn window_material(app: AppHandle, webview: Webview, kind: String) -> Result<(), String> {
    browser::only_main(&webview)?;
    let effects = effects_for(&kind)?;
    // `set_effects` reports success for a material this Windows cannot draw,
    // and the page would then turn transparent over nothing: refuse it here.
    let build = windows_build();
    let supported = supported_materials(build);
    if !supported.contains(&kind.as_str()) {
        return Err(format!(
            "the window material {kind:?} is not offered on Windows build {build}: {}",
            supported.join(", ")
        ));
    }
    let window = app
        .get_webview_window(MAIN_LABEL)
        .ok_or_else(|| format!("the {MAIN_LABEL:?} window is gone: no material was applied"))?;
    window
        .set_effects(effects)
        .map_err(|error| format!("the window material {kind:?} was refused: {error}"))
}

/// The materials the setting may offer, empty off Windows. The setting hides
/// itself when solid is all there is: a control that changes nothing is worse
/// than no control.
#[tauri::command]
fn window_material_supported(webview: Webview) -> Result<Vec<&'static str>, String> {
    browser::only_main(&webview)?;
    Ok(if cfg!(windows) { supported_materials(windows_build()) } else { Vec::new() })
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
async fn core_endpoint(app: AppHandle, webview: Webview) -> Result<CoreEndpoint, String> {
    quota_window::only_ui(&webview)?;
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.try_state::<CoreState>().ok_or("the shell has not set up its core yet")?;
        current_endpoint(&state)
    })
    .await
    .map_err(|error| format!("the endpoint task did not finish: {error}"))?
}

/// What the last resolution settled on.
struct Settled {
    outcome: Result<CoreEndpoint, String>,
    pid: Option<u32>,
    generation: u64,
}

impl Settled {
    /// A failed start, or a core whose process has since exited: a crash, a
    /// kill, "Stop this core". Either way a new resolution is due.
    fn stale(&self) -> bool {
        self.outcome.is_err() || self.pid.is_some_and(|pid| !platform::process::alive(pid))
    }
}

/// The endpoint of a live core. The one found at start while its process runs;
/// otherwise the caller resolves again, which adopts or starts a core, so a
/// reload of the UI or its reconnect brings a stopped core back. Of several
/// callers only the first to see the dead core resolves; the others wait for it.
fn current_endpoint(state: &CoreState) -> Result<CoreEndpoint, String> {
    let patience = state.launch.patience();
    let settled = wait_for_endpoint(&state.slot, patience)?;
    if !settled.stale() {
        return settled.outcome;
    }
    if claim(&state.slot, settled.generation) {
        publish(&state.slot, resolve_core(state));
    }
    wait_for_endpoint(&state.slot, patience)?.outcome
}

/// Takes the slot for a new resolution if nobody did since `generation` settled.
fn claim(slot: &(Mutex<Slot>, Condvar), generation: u64) -> bool {
    let Ok(mut guard) = slot.0.lock() else { return false };
    if !guard.done || guard.generation != generation {
        return false;
    }
    *guard = Slot { generation: generation + 1, ..Slot::default() };
    true
}

fn publish(slot: &(Mutex<Slot>, Condvar), outcome: Result<(CoreEndpoint, Option<u32>), String>) {
    let (lock, ready) = slot;
    if let Ok(mut guard) = lock.lock() {
        match outcome {
            Ok((endpoint, pid)) => {
                guard.endpoint = Some(endpoint);
                guard.pid = pid;
            }
            Err(error) => guard.error = Some(error),
        }
        guard.done = true;
    }
    ready.notify_all();
}

fn wait_for_endpoint(slot: &(Mutex<Slot>, Condvar), patience: Duration) -> Result<Settled, String> {
    let (lock, ready) = slot;
    let deadline = Instant::now() + patience;
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

    let outcome = match (guard.endpoint.as_ref(), guard.error.as_ref()) {
        (Some(endpoint), _) => Ok(endpoint.clone()),
        (None, Some(error)) => Err(error.clone()),
        (None, None) => Err("the core resolved to nothing".to_string()),
    };
    Ok(Settled { outcome, pid: guard.pid, generation: guard.generation })
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
/// (`packages/core/src/server.ts`: `{ ok, version, pid }`). `ok` and `pid`
/// say it is the core `core.json` described; `version` says whether it is this
/// install's core or the one an update left running.
#[derive(Deserialize)]
struct HealthBody {
    #[serde(default)]
    ok: bool,
    #[serde(default)]
    version: Option<String>,
    #[serde(default)]
    pid: Option<u32>,
}

/// What a `core.json` found at start turned out to be.
#[derive(Debug, PartialEq, Eq)]
enum Probe {
    /// This shell's core, running: adopt it.
    Current,
    /// A core of another version, running: the one an update or a reinstall
    /// left behind, which has to stop before this shell starts its own.
    Stale(String),
    /// Nothing running answers as that core.
    Absent,
}

/// The pure half of `probe`: what a `/health` answer means to this shell.
fn judge(answer: Option<HealthBody>, version: &str) -> Probe {
    match answer {
        None => Probe::Absent,
        Some(body) if body.version.as_deref() == Some(version) => Probe::Current,
        Some(body) => Probe::Stale(body.version.unwrap_or_else(|| "(none)".to_string())),
    }
}

/// Whether the core `file` names is running, and whose it is. A pid that is
/// not running is `Absent` without a connection: after a reboot `core.json`
/// names a closed port, and Windows takes 2 s to refuse one, so `health`
/// would spend its whole timeout on it.
fn probe(file: &CoreFile, version: &str) -> Probe {
    let Some(pid) = file.pid else { return Probe::Absent };
    if !platform::process::alive(pid) {
        return Probe::Absent;
    }
    judge(health(file.port, pid), version)
}

/// A bound on how much of a `/health` response is ever read, so a local
/// process that keeps the connection open and streams data cannot be used to
/// tie up the shell's startup past `HEALTH_TIMEOUT` with unbounded memory.
/// The real response is a small JSON object; this is generous over that.
const HEALTH_RESPONSE_LIMIT: usize = 8 * 1024;

/// A GET on `/health`, because one request does not deserve an HTTP crate.
/// The response is read to its end (or to `HEALTH_RESPONSE_LIMIT`, or until
/// `HEALTH_TIMEOUT` elapses) and handed to `health_response`, which is what
/// actually decides whether this is the core `core.json` described.
fn health(port: u16, expected_pid: u32) -> Option<HealthBody> {
    let address = SocketAddr::from(([127, 0, 0, 1], port));
    let mut stream = TcpStream::connect_timeout(&address, HEALTH_TIMEOUT).ok()?;
    let _ = stream.set_read_timeout(Some(HEALTH_TIMEOUT));
    let _ = stream.set_write_timeout(Some(HEALTH_TIMEOUT));

    let request =
        format!("GET /health HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n");
    stream.write_all(request.as_bytes()).ok()?;

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
    health_response(&response, expected_pid)
}

/// The pure parse behind `health`, kept separate from the socket so a crafted
/// response can be checked without one. A response that is not a 200, that
/// carries no blank line ending its headers, whose body is not the JSON
/// `/health` answers with, or whose `pid` is not `expected_pid`, is never a
/// match: a local process squatting the port and merely echoing
/// `HTTP/1.1 200` gets none of these right unless it can also read
/// `core.json`, which is exactly what it is being asked to prove it can.
fn health_response(response: &[u8], expected_pid: u32) -> Option<HealthBody> {
    let text = String::from_utf8_lossy(response);
    if !(text.starts_with("HTTP/1.1 200") || text.starts_with("HTTP/1.0 200")) {
        return None;
    }
    let body_start = text.find("\r\n\r\n")?;
    let body = &text[body_start + 4..];
    serde_json::from_str::<HealthBody>(body)
        .ok()
        .filter(|parsed| parsed.ok && parsed.pid == Some(expected_pid))
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

/// The sidecar beside this executable and the arguments that make it the core.
/// A `core/main.js` beside it means the sidecar is the Bun runtime under the
/// core's name (the Windows installer, see `stage-sidecar.ts`) and the bundle is
/// its script; without one the sidecar is the compiled core and takes nothing.
fn sidecar() -> Result<Option<(PathBuf, Vec<String>)>, String> {
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
    Ok(Some((path, bundle_args(directory))))
}

fn bundle_args(directory: &Path) -> Vec<String> {
    let bundle = directory.join("core").join("main.js");
    if bundle.is_file() {
        vec![bundle.display().to_string()]
    } else {
        Vec::new()
    }
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
/// Whatever the source, the channel and the data directory ride on the argv:
/// the core writes its `core.json` in the directory this shell then reads.
fn core_command(channel: Channel, directory: &Path) -> Result<CoreCommand, String> {
    let (program, mut args, working_directory) = core_program()?;
    args.extend(core_args(channel, directory));
    Ok(CoreCommand { program, args, working_directory })
}

/// What the shell appends to the core's argv. `--data-dir` is the directory the
/// shell resolved, so a fallback the shell took (no `%LOCALAPPDATA%`, a
/// `BOITE_DATA_DIR` padded with spaces) is the core's too.
fn core_args(channel: Channel, directory: &Path) -> Vec<String> {
    let mut args = channel.core_args();
    args.extend(["--data-dir".to_string(), directory.display().to_string()]);
    args
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

    if let Some((path, args)) = sidecar()? {
        return Ok((path.display().to_string(), args, None));
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

/// Tauri keeps resources separate from executables on Linux and macOS.
fn configure_core_resources(command: &mut Command, resources: &Path) {
    let ui = resources.join("ui");
    if ui.join("index.html").is_file() { command.env("BOITE_UI_DIR", ui); }
    #[cfg(not(windows))]
    if resources.join("boite").is_file()
        && Path::new(command.get_program()).is_absolute()
        && Path::new(command.get_program()).file_name().is_some_and(|name| name == "boite-core")
    {
        let executable = command.get_program().to_os_string();
        command.env("BOITE_CORE_EXECUTABLE", executable);
        if std::env::var_os("BOITE_CLI_DIR").filter(|value| !value.is_empty()).is_none() {
            command.env("BOITE_CLI_DIR", resources);
        }
    }
}

fn spawn_core(launch: &Launch) -> Result<(Spawned, Option<CoreJob>), String> {
    let CoreCommand { program, args, working_directory } = launch.command.clone()?;
    let job = if launch.resident { None } else { Some(job::create_core_job()?) };

    let mut command = Command::new(&program);
    command
        .args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let output = if launch.resident {
        // No pipe belongs to the shell after it exits. Broken stdout must not kill the host.
        std::fs::create_dir_all(&launch.directory).map_err(|e| format!("{} could not be created: {e}", launch.directory.display()))?;
        let path = launch.directory.join("core-output.log");
        // An append handle on Windows lacks FILE_WRITE_DATA, so it cannot truncate: a separate write handle does.
        if std::fs::metadata(&path).map(|m| m.len() > 8 * 1024 * 1024).unwrap_or(false) {
            std::fs::OpenOptions::new().write(true).truncate(true).open(&path).map_err(|e| format!("core-output.log could not be truncated: {e}"))?;
        }
        let file = std::fs::OpenOptions::new().create(true).append(true).open(&path).map_err(|e| format!("core-output.log could not be opened: {e}"))?;
        let from = file.metadata().map(|m| m.len()).unwrap_or(0);
        command.stdout(Stdio::from(file.try_clone().map_err(|e| e.to_string())?)).stderr(Stdio::from(file));
        #[cfg(unix)]
        { use std::os::unix::process::CommandExt; command.process_group(0); }
        Output::Log { path, from }
    } else {
        Output::Ring(Arc::new(Mutex::new(VecDeque::with_capacity(TAIL_LINES))))
    };
    if let Some(directory) = working_directory {
        command.current_dir(directory);
    }
    if let Some(resources) = &launch.resources { configure_core_resources(&mut command, resources); }
    platform::prepare_command(&mut command);

    let mut child = command
        .spawn()
        .map_err(|error| format!("the core could not be started with `{program}`: {error}"))?;

    if let Some(ref owned) = job {
        if let Err(error) = job::assign(owned, &child) {
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!("the core could not be put in this shell's job object: {error}"));
        }
    }

    let ready = Arc::new(AtomicBool::new(false));
    let ring = match &output {
        Output::Ring(lines) => Some(lines.clone()),
        Output::Log { .. } => None,
    };
    let mut readers = Vec::new();
    if let Some(stdout) = child.stdout.take() {
        let flag = ready.clone();
        let ring = ring.clone();
        readers.push(std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { break };
                if line.contains(READY_LINE) {
                    flag.store(true, Ordering::Release);
                }
                if let Some(ring) = &ring { remember(ring, &line); }
                eprintln!("[core] {line}");
            }
        }));
    }
    if let Some(stderr) = child.stderr.take() {
        readers.push(std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines() {
                let Ok(line) = line else { break };
                if let Some(ring) = &ring { remember(ring, &line); }
                eprintln!("[core] {line}");
            }
        }));
    }

    Ok((Spawned { child, ready, output, readers }, job))
}

/// The ready flag of a core this shell started earlier and that is still
/// running, so a new resolution waits on it rather than starting a second
/// core the data directory's lock would refuse. A core that has exited is
/// dropped here.
fn running_child(state: &CoreState) -> Option<Arc<AtomicBool>> {
    let mut guard = state.child.lock().ok()?;
    let running = guard.as_mut().is_some_and(|spawned| matches!(spawned.child.try_wait(), Ok(None)));
    if running {
        return guard.as_ref().map(|spawned| spawned.ready.clone());
    }
    guard.take();
    None
}

/// Why the core this shell started is gone, if it exited: its exit status
/// and the last lines it printed, the reason a user or a bug report needs.
fn exited_early(state: &CoreState) -> Option<String> {
    let spawned = {
        let mut guard = state.child.lock().ok()?;
        let status = guard.as_mut()?.child.try_wait().ok()??;
        let spawned = guard.take()?;
        (spawned, status)
    };
    if let Ok(mut job) = state.job.lock() { job.take(); }
    let (spawned, status) = spawned;
    spawned.settle();
    Some(format!("the core exited ({status}) before it was ready{}", spawned.output.quoted()))
}

/// Finds the core this shell talks to: the one `core.json` names when it runs
/// this shell's version, else one this shell starts. A core of another version
/// is the one an update or a reinstall left running: it is stopped first,
/// since it holds the data directory's lock and speaks an older protocol.
fn resolve_core(state: &CoreState) -> Result<(CoreEndpoint, Option<u32>), String> {
    if state.held.load(Ordering::SeqCst) {
        return Err(HELD.to_string());
    }
    let launch = &state.launch;
    let file = launch.directory.join("core.json");

    // The run `core.json` described before this start: the wait below must
    // not take it for the core it is waiting on.
    let mut before = None;
    match read_core_file(&file) {
        Ok(Some(existing)) => {
            match probe(&existing, &launch.version) {
                Probe::Current => return Ok((endpoint_of(&existing), existing.pid)),
                Probe::Stale(version) => {
                    eprintln!("[shell] the running core is version {version} and this shell {}: stopping it", launch.version);
                    resident::stop_local_core(&launch.directory, resident::GRACE).map_err(|error| {
                        format!("the core of version {version} an earlier install left running could not be stopped: {error}")
                    })?;
                }
                Probe::Absent => {}
            }
            before = Some(existing.identity());
        }
        Ok(None) => {}
        Err(error) => eprintln!("[shell] {error}"),
    }

    let ready = match running_child(state) {
        Some(ready) => ready,
        None => {
            // Asked again here: stopping an older core above takes seconds.
            if state.held.load(Ordering::SeqCst) {
                return Err(HELD.to_string());
            }
            let (spawned, job) = spawn_core(launch)?;
            let ready = spawned.ready.clone();
            if let Ok(mut guard) = state.child.lock() { *guard = Some(spawned); }
            if let Ok(mut guard) = state.job.lock() { *guard = job; }
            ready
        }
    };

    let started = Instant::now();
    loop {
        if let Some(reason) = exited_early(state) {
            return Err(reason);
        }
        if launch.resident || ready.load(Ordering::Acquire) || started.elapsed() > Duration::from_secs(1) {
            if let Ok(Some(found)) = read_core_file(&file) {
                let fresh = before != Some(found.identity());
                // Any version: this is the core the shell just started.
                if let Some(pid) = found.pid.filter(|pid| fresh && platform::process::alive(*pid)) {
                    if health(found.port, pid).is_some() {
                        return Ok((endpoint_of(&found), Some(pid)));
                    }
                }
            }
        }
        if started.elapsed() >= launch.timeout {
            break;
        }
        std::thread::sleep(POLL_INTERVAL);
    }

    // A slow resident core is left to finish: killing it would only make the
    // next try start from nothing again. That next try adopts it.
    if launch.resident && running_child(state).is_some() {
        return Err(format!(
            "the core has not answered within {} s; it is still starting, and trying again picks it up",
            launch.timeout.as_secs()
        ));
    }
    let output = match state.child.lock().ok().and_then(|mut guard| guard.take()) {
        Some(mut spawned) => {
            job::stop_core(&mut spawned.child);
            spawned.settle();
            spawned.output.quoted()
        }
        None => String::new(),
    };
    if let Ok(mut guard) = state.job.lock() { drop(guard.take()); }
    Err(format!(
        "the core did not write {} and answer /health within {} s{output}",
        file.display(),
        launch.timeout.as_secs()
    ))
}

/// How long a start may keep the window off the screen before it shows the
/// page's own "connecting" state instead.
const REVEAL_AFTER: Duration = Duration::from_secs(2);
/// When the window is shown even if its page never said it painted: a broken
/// bundle still gets a window, and with it a way to quit.
const REVEAL_ANYWAY: Duration = Duration::from_secs(10);

/// The main window's first appearance. It is built hidden and shown once, when
/// its page has painted and either the core answered or `REVEAL_AFTER` passed:
/// a fast start never flashes an empty frame, and a slow one shows the page
/// saying it is connecting instead of nothing at all.
#[derive(Default)]
struct Reveal {
    painted: AtomicBool,
    due: AtomicBool,
    shown: AtomicBool,
}

impl Reveal {
    /// The page drew its first frame. True when the window should show now.
    fn painted(&self) -> bool {
        self.painted.store(true, Ordering::SeqCst);
        self.settle()
    }

    /// The core answered, or waiting on it took long enough.
    fn due(&self) -> bool {
        self.due.store(true, Ordering::SeqCst);
        self.settle()
    }

    /// True once, for whichever call completes the pair.
    fn settle(&self) -> bool {
        self.painted.load(Ordering::SeqCst) && self.due.load(Ordering::SeqCst) && !self.shown.swap(true, Ordering::SeqCst)
    }

    /// True unless the window was already shown.
    fn anyway(&self) -> bool {
        !self.shown.swap(true, Ordering::SeqCst)
    }
}

/// The page says it has painted its first frame. Only the main page asks.
#[tauri::command]
fn shell_ready(app: AppHandle, webview: Webview) -> Result<(), String> {
    browser::only_main(&webview)?;
    if app.state::<Reveal>().painted() {
        show_main(&app);
    }
    Ok(())
}

fn start_core<R: Runtime>(app: &AppHandle<R>) {
    let handle = app.clone();
    std::thread::spawn(move || {
        let state = handle.state::<CoreState>();
        let outcome = resolve_core(&state);
        if let Err(error) = &outcome {
            eprintln!("[shell] {error}");
        }
        publish(&state.slot, outcome);
        if handle.state::<Reveal>().due() {
            show_main(&handle);
        }
    });
    let handle = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(REVEAL_AFTER);
        if handle.state::<Reveal>().due() {
            show_main(&handle);
        }
        std::thread::sleep(REVEAL_ANYWAY.saturating_sub(REVEAL_AFTER));
        if handle.state::<Reveal>().anyway() {
            show_main(&handle);
        }
    });
}

// ---------------------------------------------------------------------------
// Window and tray.
// ---------------------------------------------------------------------------

/// What a nightly build calls itself in the window title and the tray. The
/// installer keeps `productName` Boite: both tracks are one installation.
const NIGHTLY_LABEL: &str = "boite (de nuit)";

fn product_label<R: Runtime>(app: &AppHandle<R>, channel: Channel) -> &'static str {
    label_for(channel, app.package_info().version.pre.as_str())
}

fn label_for(channel: Channel, prerelease: &str) -> &'static str {
    if channel == Channel::Stable && prerelease.starts_with("nightly.") {
        NIGHTLY_LABEL
    } else { channel.product_name() }
}

/// The size the main window opens at. The height fits the tour's tallest screen
/// without a scrollbar: 808 px (French consent screen, measured 2026-09-23) plus
/// the scrim's 32 px margin and the 44 px title bar left above it.
const MAIN_SIZE: (f64, f64) = (1280.0, 890.0);
const MAIN_MIN_SIZE: (f64, f64) = (880.0, 560.0);

/// Logical `(x, y, width, height)` of a window of `size` centred in `area`
/// (`left, top, width, height`), shrunk to 92% of the area on a smaller screen.
/// An area below the minimum size gets the window at its top left, so the
/// title bar stays on screen.
fn centred(size: (f64, f64), min: (f64, f64), area: (f64, f64, f64, f64)) -> (f64, f64, f64, f64) {
    let width = size.0.min(area.2 * 0.92).max(min.0);
    let height = size.1.min(area.3 * 0.92).max(min.1);
    (area.0 + ((area.2 - width) / 2.0).max(0.0), area.1 + ((area.3 - height) / 2.0).max(0.0), width, height)
}

/// The primary monitor's work area, in logical pixels. Windows puts a window
/// with no position at its cascade spot, the top left of the first launch.
fn work_area<R: Runtime>(app: &AppHandle<R>) -> Option<(f64, f64, f64, f64)> {
    let monitor = app.primary_monitor().ok()??;
    let scale = monitor.scale_factor();
    let area = monitor.work_area();
    Some((area.position.x as f64 / scale, area.position.y as f64 / scale, area.size.width as f64 / scale, area.size.height as f64 / scale))
}

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
            .title(product_label(app, channel))
            .inner_size(MAIN_SIZE.0, MAIN_SIZE.1)
            .min_inner_size(MAIN_MIN_SIZE.0, MAIN_MIN_SIZE.1)
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
    // Acrylic is what a window opens on where DWM draws it, and `lib/glass.ts`
    // re-applies whatever the setting says as soon as the UI mounts. A Windows
    // with no material but solid (Windows 10) gets an opaque window with
    // nothing to composite; elsewhere the window stays opaque too.
    #[cfg(windows)]
    {
        let kinds = supported_materials(windows_build());
        if kinds.contains(&"mica") {
            builder = builder.transparent(true);
        }
        if kinds.contains(&"acrylic") {
            builder = builder.effects(WindowEffectsConfig {
                effects: vec![Effect::Acrylic],
                state: None,
                radius: None,
                color: None,
            });
        }
    }
    builder = match work_area(app) {
        Some(area) => {
            let (x, y, width, height) = centred(MAIN_SIZE, MAIN_MIN_SIZE, area);
            builder.inner_size(width, height).position(x, y)
        }
        None => builder.center(),
    };
    if let Some(directory) = webview_profile() {
        builder = builder.data_directory(directory);
    }
    if let Some(args) = test_browser_args() {
        builder = builder.additional_browser_args(&args);
    }
    builder.build()
}

/// The window is created hidden and only reaches the screen here: at start
/// when `Reveal` says so, later from the tray or a second launch.
fn show_main<R: Runtime>(app: &AppHandle<R>) {
    if let Some(state) = app.try_state::<quota_window::HoverState>() { state.cancel_open(); }
    if let Some(popup) = app.get_webview_window(quota_window::LABEL) {
        let _ = quota_window::hide(app, &popup);
    }
    if hidden() {
        return;
    }
    if let Some(window) = app.get_webview_window(MAIN_LABEL) {
        let _ = window.unminimize();
        let _ = window.set_skip_taskbar(false);
        let _ = window.show();
        browser::unpark_all(app);
        let _ = window.set_focus();
    }
}

fn hide_main<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window(MAIN_LABEL) {
        browser::park_all(app);
        let _ = window.hide();
        let _ = window.set_skip_taskbar(true);
    }
}

/// Where a shell that failed writes why. A release build has no console
/// (`windows_subsystem = "windows"`), so without this file a setup error or a
/// panic was the app starting and vanishing without a word.
const FAILURE_LOG: &str = "shell-error.log";

/// Appends one line to `<dataDir>/shell-error.log` and stderr. It never fails:
/// it runs while the shell is already failing.
fn record_failure(directory: &Path, text: &str) {
    eprintln!("[shell] {text}");
    let seconds = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs())
        .unwrap_or(0);
    let _ = std::fs::create_dir_all(directory);
    if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(directory.join(FAILURE_LOG)) {
        let _ = writeln!(file, "[unix {seconds}] {text}");
    }
}

/// Closing the window hides it only where something can bring it back: the
/// tray icon. Without one, a hidden window is a running app nobody can reach.
/// A test shell has no tray and hides anyway, since nobody sees it either way.
fn hides_on_close(close_to_tray: bool, has_tray: bool, test_shell: bool) -> bool {
    close_to_tray && (has_tray || test_shell)
}

fn quit<R: Runtime>(app: &AppHandle<R>) {
    if let Some(state) = app.try_state::<CoreState>() {
        state.kill_child();
    }
    app.exit(0);
}

/// The tray menu's items, kept so the UI can relabel them in its language.
struct TrayMenu<R: Runtime> {
    show: MenuItem<R>,
    quit: MenuItem<R>,
}

/// The tray menu is native, and the sentences live in the UI's catalogue: the
/// UI sends the two labels at start and on every language change. English
/// until then. A shell with no tray, a test shell say, has nothing to relabel.
#[tauri::command]
fn tray_labels(app: AppHandle, webview: Webview, show: String, quit: String) -> Result<(), String> {
    browser::only_main(&webview)?;
    if show.trim().is_empty() || quit.trim().is_empty() {
        return Err(format!("tray labels must not be empty: show {show:?}, quit {quit:?}"));
    }
    let Some(menu) = app.try_state::<TrayMenu<tauri::Wry>>() else { return Ok(()) };
    menu.show.set_text(show).map_err(|error| format!("the tray's Show item kept its label: {error}"))?;
    menu.quit.set_text(quit).map_err(|error| format!("the tray's Quit item kept its label: {error}"))
}

fn build_tray<R: Runtime>(app: &AppHandle<R>, channel: Channel) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "Show", true, None::<&str>)?;
    let leave = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &leave])?;
    app.manage(TrayMenu { show, quit: leave });

    let mut builder = TrayIconBuilder::with_id("boite")
        .tooltip(product_label(app, channel))
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
        // Another instance already owns this data directory: it shows its
        // window, which may be in the tray or behind others, and this process
        // has nothing left to do. Automation never raises a window.
        Ok(None) => {
            if !hidden() {
                if let Err(error) = instance::wake(&directory) {
                    eprintln!("[shell] Boite is already running, but it could not be asked to show its window: {error}");
                }
            }
            return;
        }
        Err(error) => {
            eprintln!(
                "[shell] the shell instance lock could not be acquired: {error}; continuing without single-instance protection"
            );
            None
        }
    };
    // Only the owner of the lock may answer a second launch: without the lock
    // two shells would share one wake file.
    let owns_directory = _instance.is_some();
    // Every later panic leaves a line where the user can find it.
    let failures = directory.clone();
    let previous_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        record_failure(&failures, &format!("the shell panicked: {info}"));
        previous_hook(info);
    }));
    let failures = directory.clone();
    let preferences_path = directory.join("shell-settings.json");
    let close_to_tray = close_to_tray_or_default(&preferences_path);
    let app_updater = updater::AppUpdater::new(context.package_info().version.to_string(), directory.clone(),
        cfg!(all(windows, target_arch = "x86_64")) && !cfg!(debug_assertions)
            && channel == Channel::Stable && !hidden());

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(app_updater)
        .manage(Reveal::default())
        .manage(quota_window::HoverState::default())
        .manage(CloseBehavior { enabled: AtomicBool::new(close_to_tray), path: preferences_path })
        .invoke_handler(tauri::generate_handler![
            core_endpoint,
            shell_ready,
            quit_shell,
            notify,
            close_behavior,
            updater::app_update_status,
            updater::app_update_check,
            updater::app_update_download,
            updater::app_update_install,
            quota_window::quota_window,
            window_material,
            window_material_supported,
            tray_labels,
            browser::browser_create,
            browser::browser_navigate,
            browser::browser_back,
            browser::browser_forward,
            browser::browser_reload,
            browser::browser_set_bounds,
            browser::browser_set_zoom,
            browser::browser_annotate,
            browser::browser_highlight,
            browser::browser_destroy,
        ])
        .setup(move |app| {
            let handle = app.handle().clone();
            let launch = Launch::new(channel, directory.clone(), handle.path().resource_dir().ok(),
                handle.package_info().version.to_string());
            app.manage(CoreState::new(launch));
            if owns_directory {
                let waking = handle.clone();
                if let Err(error) = instance::listen(&directory, move || show_main(&waking)) {
                    eprintln!("[shell] a second launch will not bring this window back: {error}");
                }
            }
            // First, so the core starts while WebView2 does: building the window
            // holds this thread for several hundred milliseconds, and the core
            // used to wait behind it for no reason (bench/startup.ts).
            start_core(&handle);
            let window = build_main_window(&handle, channel)?;
            if !hidden() {
                // The window works without a tray: closing it then quits.
                if let Err(error) = build_tray(&handle, channel) {
                    record_failure(&directory, &format!("the tray icon could not be created, so closing the window quits Boite: {error}"));
                }
            }

            let closing = handle.clone();
            let resized = window.clone();
            window.on_window_event(move |event| match event {
                WindowEvent::CloseRequested { api, .. } => {
                    api.prevent_close();
                    let enabled = closing.state::<CloseBehavior>().enabled.load(Ordering::Acquire);
                    if hides_on_close(enabled, closing.tray_by_id("boite").is_some(), hidden()) { hide_main(&closing); }
                    else { quit(&closing); }
                }
                // Minimizing hides nothing from WebView2: the page is parked
                // here, and unparked by the resize that restores the window.
                WindowEvent::Resized(_) => {
                    if resized.is_minimized().unwrap_or(false) { browser::park_all(&closing); }
                    else if resized.is_visible().unwrap_or(false) { browser::unpark_all(&closing); }
                }
                _ => {}
            });
            Ok(())
        })
        .build(context);
    // A broken WebView2 install, a profile directory that cannot be written:
    // setup fails with the window never built. Say so where the user looks.
    let app = match app {
        Ok(app) => app,
        Err(error) => {
            let text = format!("Boite could not start: {error}");
            record_failure(&failures, &text);
            if !hidden() {
                platform::alert("Boite", &format!(
                    "{text}\n\nThis is written in {}.\n\nRepairing or reinstalling the Microsoft Edge WebView2 Runtime often fixes it: https://developer.microsoft.com/microsoft-edge/webview2/",
                    failures.join(FAILURE_LOG).display()
                ));
            }
            std::process::exit(1);
        }
    };
    app.run(|app, event| match event {
            tauri::RunEvent::Exit => {
                if let Some(state) = app.try_state::<CoreState>() {
                    state.kill_child();
                }
            }
            // A click on the dock icon.
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Reopen { .. } => show_main(app),
            _ => {}
        });
}

#[cfg(test)]
mod tests {
    use super::{effects_for, hides_on_close, label_for, record_failure, supported_materials, Channel, FAILURE_LOG};

    #[test]
    fn closing_hides_only_where_a_tray_can_bring_the_window_back() {
        assert!(hides_on_close(true, true, false));
        assert!(!hides_on_close(true, false, false), "no tray: a hidden window could never come back");
        assert!(hides_on_close(true, false, true));
        assert!(!hides_on_close(false, true, false));
    }

    #[test]
    fn a_failure_is_appended_to_the_log_in_the_data_directory() {
        let directory = std::env::temp_dir().join(format!("boite-failure-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&directory);
        record_failure(&directory, "first");
        record_failure(&directory, "second");
        let text = std::fs::read_to_string(directory.join(FAILURE_LOG)).unwrap();
        let lines: Vec<_> = text.lines().collect();
        assert_eq!(lines.len(), 2, "{text}");
        assert!(lines[0].starts_with("[unix ") && lines[0].ends_with("] first"), "{text}");
        assert!(lines[1].ends_with("] second"), "{text}");
        std::fs::remove_dir_all(directory).unwrap();
    }
    use tauri::window::Effect;

    #[test]
    fn the_main_window_opens_centred_and_fits_a_small_screen() {
        // 1080p at 100%, taskbar at the bottom: the full size, centred.
        assert_eq!(super::centred((1280.0, 890.0), (880.0, 560.0), (0.0, 0.0, 1920.0, 1032.0)), (320.0, 71.0, 1280.0, 890.0));
        // 1080p at 150%: 1280 x 688 logical, so 92% of it, still centred.
        let (x, y, width, height) = super::centred((1280.0, 890.0), (880.0, 560.0), (0.0, 0.0, 1280.0, 688.0));
        assert_eq!((width.round(), height.round()), (1178.0, 633.0));
        assert_eq!(((x * 2.0).round(), (y * 2.0).round()), (102.0, 55.0));
        // A taskbar on the left moves the centre with the work area.
        assert_eq!(super::centred((1280.0, 890.0), (880.0, 560.0), (60.0, 0.0, 1860.0, 1080.0)).0, 350.0);
        // Never below the minimum size, and then pinned to the top left.
        assert_eq!(super::centred((1280.0, 890.0), (880.0, 560.0), (0.0, 0.0, 800.0, 500.0)), (0.0, 0.0, 880.0, 560.0));
        assert_eq!(super::centred((1280.0, 890.0), (880.0, 560.0), (60.0, 40.0, 800.0, 500.0)), (60.0, 40.0, 880.0, 560.0));
    }

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

    #[test]
    fn a_bundle_beside_the_sidecar_becomes_its_script() {
        let directory = std::env::temp_dir().join(format!("boite-bundle-{}", std::process::id()));
        std::fs::create_dir_all(directory.join("core")).unwrap();
        assert!(super::bundle_args(&directory).is_empty());
        std::fs::write(directory.join("core").join("main.js"), "").unwrap();
        assert_eq!(super::bundle_args(&directory), vec![directory.join("core").join("main.js").display().to_string()]);
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
        assert!(super::health_response(response, 4242).is_some());
    }

    #[test]
    fn health_response_refuses_a_body_naming_a_different_pid() {
        let response = b"HTTP/1.1 200 OK\r\ncontent-type: application/json\r\n\r\n{\"ok\":true,\"version\":\"2.0.0\",\"pid\":1}";
        assert!(super::health_response(response, 4242).is_none());
    }

    #[test]
    fn health_response_refuses_a_body_that_is_not_json() {
        let response = b"HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\n\r\nsquatting this port";
        assert!(super::health_response(response, 4242).is_none());
    }

    #[test]
    fn health_response_refuses_a_bare_200_with_no_body() {
        let response = b"HTTP/1.1 200 OK\r\n\r\n";
        assert!(super::health_response(response, 4242).is_none());
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
    fn a_nightly_build_names_itself_boite_de_nuit() {
        assert_eq!(label_for(Channel::Stable, "nightly.20260923.1"), "boite (de nuit)");
        assert_eq!(label_for(Channel::Stable, "beta.2"), "Boite");
        assert_eq!(label_for(Channel::Stable, ""), "Boite");
        assert_eq!(label_for(Channel::Dev, "nightly.20260923.1"), "Boite Dev");
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
    fn a_material_is_offered_only_where_windows_draws_it_without_lag() {
        // Windows 10 22H2: acrylic there lags on every drag, and mica does not exist.
        assert_eq!(supported_materials(19045), ["solid"]);
        // Windows 11 21H2: mica, and still the lagging acrylic.
        assert_eq!(supported_materials(22000), ["mica", "solid"]);
        assert_eq!(supported_materials(22522), ["mica", "solid"]);
        // From 22523 DWM draws acrylic as a system backdrop.
        assert_eq!(supported_materials(22523), ["acrylic", "mica", "solid"]);
        assert_eq!(supported_materials(26100), ["acrylic", "mica", "solid"]);
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

#[cfg(test)]
mod core_tests {
    use super::*;

    /// A stand-in core. `serve` writes `core.json` into its `--data-dir`,
    /// answers `/health` with its version and pid and stops on an authorised
    /// `POST /shutdown`; `fail` exits at once with a reason on stderr, as the
    /// real core does on a held lock; `hang` never answers.
    const FAKE_CORE: &str = r#"
const [version, mode] = process.argv.slice(2);
const dir = process.argv[process.argv.indexOf('--data-dir') + 1];
if (mode === 'fail') {
  console.error(`error: another core is already running on ${dir} (pid 1)`);
  process.exit(3);
}
if (mode === 'serve') {
  const token = 'test-token';
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/health') return Response.json({ ok: true, version, pid: process.pid });
    if (url.pathname === '/shutdown' && request.method === 'POST' && request.headers.get('authorization') === `Bearer ${token}`) {
      setTimeout(() => process.exit(0), 20);
      return Response.json({ ok: true }, { status: 202 });
    }
    return new Response('no', { status: 404 });
  } });
  await Bun.write(`${dir}/core.json`, JSON.stringify({ port: server.port, host: '127.0.0.1', token, pid: process.pid, version }));
  console.log('boite-core ready');
}
setInterval(() => {}, 1000);
"#;

    fn scratch(name: &str) -> PathBuf {
        let directory = std::env::temp_dir().join(format!("boite-core-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&directory);
        std::fs::create_dir_all(&directory).unwrap();
        std::fs::write(directory.join("fake-core.ts"), FAKE_CORE).unwrap();
        directory
    }

    fn fake_command(directory: &Path, version: &str, mode: &str) -> CoreCommand {
        let mut args = vec![directory.join("fake-core.ts").display().to_string(), version.to_string(), mode.to_string()];
        args.extend(core_args(Channel::Stable, directory));
        CoreCommand { program: "bun".to_string(), args, working_directory: None }
    }

    fn state(directory: &Path, shell_version: &str, core: CoreCommand, resident: bool, timeout: Duration) -> CoreState {
        CoreState::new(Launch {
            directory: directory.to_path_buf(),
            command: Ok(core),
            resources: None,
            resident,
            version: shell_version.to_string(),
            timeout,
        })
    }

    /// Starts a core outside any shell, as an earlier install left it running.
    fn running_core(directory: &Path, version: &str) -> (Child, u32) {
        let core = fake_command(directory, version, "serve");
        let mut command = Command::new(&core.program);
        command.args(&core.args).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
        platform::prepare_command(&mut command);
        let child = command.spawn().expect("bun runs the fake core");
        let pid = child.id();
        let deadline = Instant::now() + Duration::from_secs(20);
        while !matches!(read_core_file(&directory.join("core.json")), Ok(Some(ref file)) if file.pid == Some(pid)) {
            assert!(Instant::now() < deadline, "the fake core never wrote core.json");
            std::thread::sleep(Duration::from_millis(20));
        }
        (child, pid)
    }

    fn spawned_pid(state: &CoreState) -> Option<u32> {
        state.child.lock().unwrap().as_ref().map(|spawned| spawned.child.id())
    }

    #[test]
    fn a_core_of_another_version_is_stale_and_a_silent_one_is_absent() {
        let body = |version: Option<&str>| HealthBody { ok: true, version: version.map(str::to_string), pid: Some(1) };
        assert_eq!(judge(Some(body(Some("2.0.0"))), "2.0.0"), Probe::Current);
        assert_eq!(judge(Some(body(Some("2.0.0-beta.1"))), "2.0.0"), Probe::Stale("2.0.0-beta.1".to_string()));
        assert_eq!(judge(Some(body(None)), "2.0.0"), Probe::Stale("(none)".to_string()));
        assert_eq!(judge(None, "2.0.0"), Probe::Absent);
        let response = b"HTTP/1.1 200 OK\r\n\r\n{\"ok\":true,\"version\":\"1.9.0\",\"pid\":7}";
        assert_eq!(health_response(response, 7).and_then(|body| body.version).as_deref(), Some("1.9.0"));
    }

    #[test]
    fn the_core_is_told_the_data_directory_the_shell_resolved() {
        let directory = Path::new("C:/Users/x/AppData/Local/boite2 dev");
        let expected = ["--data-dir".to_string(), directory.display().to_string()];
        assert_eq!(core_args(Channel::Stable, directory), expected);
        let dev = core_args(Channel::Dev, directory);
        assert_eq!(dev[..2], ["--channel".to_string(), "dev".to_string()]);
        assert!(dev.ends_with(&expected));
    }

    #[test]
    fn the_window_shows_once_when_painted_and_due_in_either_order() {
        let reveal = Reveal::default();
        assert!(!reveal.due());
        assert!(reveal.painted());
        assert!(!reveal.painted() && !reveal.due() && !reveal.anyway());
        let reveal = Reveal::default();
        assert!(!reveal.painted());
        assert!(reveal.due());
        let reveal = Reveal::default();
        assert!(reveal.anyway());
        assert!(!reveal.painted() && !reveal.due());
    }

    #[test]
    fn a_core_json_naming_a_process_that_exited_costs_no_connection() {
        let _process_guard = crate::PROCESS_TEST_LOCK.lock().unwrap();
        let mut gone = Command::new("bun");
        gone.args(["-e", "0"]).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
        platform::prepare_command(&mut gone);
        let mut gone = gone.spawn().unwrap();
        let pid = gone.id();
        gone.wait().unwrap();
        drop(gone);
        let port = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        let file = CoreFile { port, host: None, token: "t".to_string(), pid: Some(pid) };
        let started = Instant::now();
        assert_eq!(probe(&file, "2.0.0"), Probe::Absent);
        // A refused connection alone takes HEALTH_TIMEOUT (500 ms) on Windows.
        assert!(started.elapsed() < Duration::from_millis(100), "probing a dead core took {:?}", started.elapsed());
    }

    #[test]
    fn a_core_that_exits_at_start_is_reported_at_once_with_what_it_said() {
        let _process_guard = crate::PROCESS_TEST_LOCK.lock().unwrap();
        for resident in [false, true] {
            let directory = scratch(if resident { "early-resident" } else { "early-owned" });
            let state = state(&directory, "2.0.0", fake_command(&directory, "2.0.0", "fail"), resident, Duration::from_secs(30));
            let started = Instant::now();
            let error = resolve_core(&state).err().expect("a core that exits cannot be adopted");
            assert!(started.elapsed() < Duration::from_secs(10), "resident {resident}: noticed after {:?}", started.elapsed());
            assert!(error.contains("exited"), "resident {resident}: {error}");
            assert!(error.contains("another core is already running"), "resident {resident}: the core's reason is missing: {error}");
            assert!(spawned_pid(&state).is_none());
            std::fs::remove_dir_all(directory).unwrap();
        }
    }

    #[test]
    fn a_running_core_of_another_version_is_stopped_and_replaced() {
        let _process_guard = crate::PROCESS_TEST_LOCK.lock().unwrap();
        let directory = scratch("stale");
        let (mut old, old_pid) = running_core(&directory, "1.0.0");
        let state = state(&directory, "2.0.0", fake_command(&directory, "2.0.0", "serve"), false, Duration::from_secs(30));
        let outcome = resolve_core(&state);
        let old_status = old.wait().unwrap();
        state.kill_child();
        let (endpoint, pid) = outcome.expect("the shell starts its own core once the old one stopped");
        assert_ne!(pid, Some(old_pid));
        assert!(endpoint.url.starts_with("http://127.0.0.1:"));
        // The old core left on its own, through /shutdown, not by a kill.
        assert_eq!(old_status.code(), Some(0));
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn a_running_core_of_this_version_is_adopted_and_nothing_is_started() {
        let _process_guard = crate::PROCESS_TEST_LOCK.lock().unwrap();
        let directory = scratch("current");
        let (mut core, pid) = running_core(&directory, "2.0.0");
        // A start would fail: adopting is the only way this resolves.
        let state = state(&directory, "2.0.0", fake_command(&directory, "2.0.0", "fail"), false, Duration::from_secs(30));
        let outcome = resolve_core(&state);
        let _ = core.kill();
        let _ = core.wait();
        assert_eq!(outcome.expect("the running core is adopted").1, Some(pid));
        assert!(spawned_pid(&state).is_none());
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn a_core_that_died_is_replaced_by_the_next_caller() {
        let _process_guard = crate::PROCESS_TEST_LOCK.lock().unwrap();
        let directory = scratch("restart");
        let state = state(&directory, "2.0.0", fake_command(&directory, "2.0.0", "serve"), false, Duration::from_secs(30));
        publish(&state.slot, resolve_core(&state));
        let first = current_endpoint(&state).expect("the first core answers");
        let first_pid = spawned_pid(&state).unwrap();
        assert_eq!(current_endpoint(&state).unwrap().url, first.url, "a live core is kept");
        {
            let mut guard = state.child.lock().unwrap();
            let spawned = guard.as_mut().unwrap();
            spawned.child.kill().unwrap();
            spawned.child.wait().unwrap();
        }
        let second = current_endpoint(&state);
        let second_pid = spawned_pid(&state);
        state.kill_child();
        let second = second.expect("a new core is started for the next caller");
        assert_ne!(second_pid, Some(first_pid));
        assert_ne!(second.url, first.url);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn a_core_stopped_for_an_install_stays_stopped_until_the_hold_is_released() {
        let _process_guard = crate::PROCESS_TEST_LOCK.lock().unwrap();
        let directory = scratch("hold");
        let state = state(&directory, "2.0.0", fake_command(&directory, "2.0.0", "serve"), false, Duration::from_secs(30));
        publish(&state.slot, resolve_core(&state));
        let first = current_endpoint(&state).expect("the first core answers");
        let first_pid = spawned_pid(&state).unwrap();
        state.stop_for_install().expect("the core stops on request");
        assert!(!platform::process::alive(first_pid), "the core outlived the stop");
        // The window asks again once it lost the core: nothing may start.
        assert_eq!(current_endpoint(&state).err().as_deref(), Some(HELD));
        assert!(spawned_pid(&state).is_none_or(|pid| pid == first_pid), "a core was started during the install");
        // The installer never ran: the next ask brings the engine back.
        state.release_hold();
        let second = current_endpoint(&state);
        state.kill_child();
        assert_ne!(second.expect("a new core after the hold").url, first.url);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn a_slow_resident_core_is_left_running_and_a_slow_owned_one_is_stopped() {
        let _process_guard = crate::PROCESS_TEST_LOCK.lock().unwrap();
        let directory = scratch("slow");
        let resident = state(&directory, "2.0.0", fake_command(&directory, "2.0.0", "hang"), true, Duration::from_secs(1));
        let error = resolve_core(&resident).err().expect("a core that never answers is not adopted");
        assert!(error.contains("still starting"), "{error}");
        let pid = spawned_pid(&resident).expect("the resident core is kept");
        // The next try waits on that same process rather than starting another.
        let _ = resolve_core(&resident);
        assert_eq!(spawned_pid(&resident), Some(pid));
        if let Some(mut spawned) = resident.child.lock().unwrap().take() {
            let _ = spawned.child.kill();
            let _ = spawned.child.wait();
        }

        let owned = state(&directory, "2.0.0", fake_command(&directory, "2.0.0", "hang"), false, Duration::from_secs(1));
        let error = resolve_core(&owned).err().expect("a core that never answers is not adopted");
        assert!(error.contains("did not write"), "{error}");
        assert!(spawned_pid(&owned).is_none(), "an owned core that never answered is stopped");
        std::fs::remove_dir_all(directory).unwrap();
    }
}
