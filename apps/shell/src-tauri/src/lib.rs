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

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

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

// ---------------------------------------------------------------------------
// The Job Object that owns the core.
// ---------------------------------------------------------------------------

/// A Windows Job Object with `KILL_ON_JOB_CLOSE`, holding the core this shell
/// started. `kill_child` covers a clean quit; this covers everything else, a
/// crash or a `Stop-Process -Force` on the shell included: the last handle to
/// the job dies with the process, the kernel closes it, and the core goes with
/// it. An orphan `boite-core.exe` used to survive that and keep
/// `%LOCALAPPDATA%\Boite\boite-core.exe` open, which the installer then could
/// not overwrite.
///
/// The core creates Job Objects of its own (`boite-agents` and one per thread,
/// `packages/core/src/platform/jobs.ts`), and a shell launched from a terminal
/// that is itself in a job is in one too. Both are fine: jobs nest on Windows 8
/// and later, and closing this one kills the whole tree underneath it.
#[cfg(windows)]
mod job {
    use std::os::windows::io::AsRawHandle;
    use std::process::Child;

    use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    /// Owns the job handle and closes it on drop.
    pub struct CoreJob(HANDLE);

    // A job handle is a kernel handle: valid from every thread of the process,
    // and this one is only moved into the shell state and dropped from there.
    unsafe impl Send for CoreJob {}

    impl Drop for CoreJob {
        fn drop(&mut self) {
            unsafe { CloseHandle(self.0) };
        }
    }

    fn last_error() -> u32 {
        unsafe { GetLastError() }
    }

    pub fn create_core_job() -> Result<CoreJob, String> {
        let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if handle.is_null() {
            return Err(format!("CreateJobObjectW failed, error {}", last_error()));
        }
        let job = CoreJob(handle);

        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let set = unsafe {
            SetInformationJobObject(
                job.0,
                JobObjectExtendedLimitInformation,
                std::ptr::addr_of!(limits).cast(),
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        };
        if set == 0 {
            return Err(format!(
                "SetInformationJobObject(JobObjectExtendedLimitInformation) failed, error {}",
                last_error()
            ));
        }
        Ok(job)
    }

    pub fn assign(job: &CoreJob, child: &Child) -> Result<(), String> {
        let assigned =
            unsafe { AssignProcessToJobObject(job.0, child.as_raw_handle() as HANDLE) };
        if assigned == 0 {
            return Err(format!(
                "AssignProcessToJobObject failed, error {}",
                last_error()
            ));
        }
        Ok(())
    }
}

/// Nothing to own outside Windows: the core is killed on quit and on exit, and
/// a process group is the story a later pass writes here.
#[cfg(not(windows))]
mod job {
    use std::process::Child;

    pub struct CoreJob;

    pub fn create_core_job() -> Result<CoreJob, String> {
        Ok(CoreJob)
    }

    pub fn assign(_job: &CoreJob, _child: &Child) -> Result<(), String> {
        Ok(())
    }
}

use job::CoreJob;

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
                let _ = child.kill();
                let _ = child.wait();
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

#[cfg(windows)]
fn default_data_dir(channel: Channel) -> Result<PathBuf, String> {
    let local = std::env::var("LOCALAPPDATA")
        .map_err(|_| "LOCALAPPDATA is not set, so the data directory cannot be found".to_string())?;
    Ok(PathBuf::from(local).join(channel.data_dir_name()))
}

#[cfg(target_os = "macos")]
fn default_data_dir(channel: Channel) -> Result<PathBuf, String> {
    let home = std::env::var("HOME")
        .map_err(|_| "HOME is not set, so the data directory cannot be found".to_string())?;
    Ok(PathBuf::from(home)
        .join("Library")
        .join("Application Support")
        .join(channel.data_dir_name()))
}

#[cfg(all(not(windows), not(target_os = "macos")))]
fn default_data_dir(channel: Channel) -> Result<PathBuf, String> {
    let home = std::env::var("HOME")
        .map_err(|_| "HOME is not set, so the data directory cannot be found".to_string())?;
    Ok(PathBuf::from(home)
        .join(".local")
        .join("share")
        .join(channel.data_dir_name()))
}

fn data_dir(channel: Channel) -> Result<PathBuf, String> {
    match std::env::var("BOITE_DATA_DIR") {
        Ok(value) if !value.trim().is_empty() => Ok(PathBuf::from(value.trim())),
        _ => default_data_dir(channel),
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
    check_workers(directory)?;
    Ok(Some(path))
}

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

fn spawn_core(channel: Channel) -> Result<(Child, Arc<AtomicBool>, CoreJob), String> {
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
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(CREATE_NO_WINDOW);
    }

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
) -> Result<CoreEndpoint, String> {
    let directory = data_dir(channel)?;
    let file = directory.join("core.json");

    match read_core_file(&file) {
        Ok(Some(existing)) if health(existing.port) => return Ok(endpoint_of(&existing)),
        Ok(_) => {}
        Err(error) => eprintln!("[shell] {error}"),
    }

    let (child, ready, job) = spawn_core(channel)?;
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
    let job_slot = state.job.clone();
    let channel = state.channel;
    let handle = app.clone();

    std::thread::spawn(move || {
        let outcome = resolve_core(channel, &child_slot, &job_slot);
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
            // The compositor draws the material behind the window, so the window
            // has to let it through. The page paints its own ground back over it
            // unless the UI stamps `data-glass`, which it only does in the shell.
            .transparent(cfg!(windows))
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
    // elsewhere the window is merely transparent under an opaque page.
    #[cfg(windows)]
    {
        builder = builder.effects(WindowEffectsConfig {
            effects: vec![Effect::Acrylic, Effect::Mica, Effect::Blur],
            state: None,
            radius: None,
            color: None,
        });
    }
    if let Some(directory) = webview_profile() {
        builder = builder.data_directory(directory);
    }
    builder.build()
}

/// The window is created hidden and only reaches the screen here, once the
/// core endpoint resolved, so an empty frame never flashes.
fn show_main<R: Runtime>(app: &AppHandle<R>) {
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
            use tauri::tray::{MouseButton, MouseButtonState, TrayIconEvent};
            match event {
                TrayIconEvent::Enter { position, .. } => quota_window::enter(tray.app_handle(), position),
                TrayIconEvent::Leave { .. } => quota_window::leave(tray.app_handle()),
                TrayIconEvent::Click { position, button: MouseButton::Left, button_state: MouseButtonState::Up, .. } => {
                    quota_window::enter(tray.app_handle(), position);
                }
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
    // is the only thing that says which install this executable is.
    let context = tauri::generate_context!();
    let channel = Channel::of_identifier(&context.config().identifier);
    let directory = data_dir(channel).expect("the shell data directory could not be resolved");
    let Some(_instance) = instance::acquire(&directory).expect("the shell instance lock could not be acquired") else {
        return;
    };
    let preferences_path = directory.join("shell-settings.json");
    let close_to_tray = read_close_behavior(&preferences_path).expect("shell settings could not be read");

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .manage(CoreState::new(channel))
        .manage(quota_window::HoverState::default())
        .manage(CloseBehavior { enabled: AtomicBool::new(close_to_tray), path: preferences_path })
        .invoke_handler(tauri::generate_handler![
            core_endpoint,
            quit_shell,
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
