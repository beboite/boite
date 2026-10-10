//! The Boite desktop shell. Nothing here but the window, the tray, and the
//! local core: every decision the product makes lives in the core or the UI.

use std::sync::atomic::{AtomicBool, Ordering};
#[cfg(test)]
use std::sync::Mutex;
mod attachments;
#[cfg(test)]
mod acl;
mod attachment_download;
mod autostart;
mod browser;
mod browser_control;
mod channel;
mod closing;
mod failure;
mod instance;
mod local_core;
mod local_files;
mod material;
mod platform;
mod presence;
mod quota_window;
mod resident;
mod shell_log;
mod update_stop;
mod tray;
mod updater;
mod watchdog;
mod window;
mod whip;

// Tauri links its manifest into binaries, but not the library test executable.
// Native updater tests import TaskDialogIndirect, which needs Common Controls v6.
#[cfg(all(test, target_os = "windows"))]
#[link(name = "resource", kind = "static", modifiers = "-bundle")]
unsafe extern "C" {}

use serde_json::json;
use tauri::{AppHandle, Manager, Webview, WindowEvent};
use watchdog::Seen;

use channel::Channel;
use closing::{close_to_tray_or_default, hides_on_close, CloseBehavior};
use failure::{record_failure, FAILURE_LOG};
use local_core::{resolve_data_dir, start_core, CoreState, Launch};
use tray::{build_tray, request_quit};
use window::{build_main_window, hidden, hide_main, show_main, Reveal};

// A concurrent POSIX spawn can briefly inherit a flock until exec closes its
// descriptor. Keep process creation separate from tests asserting lock release.
#[cfg(test)]
pub(crate) static PROCESS_TEST_LOCK: Mutex<()> = Mutex::new(());

/// One failed test must not fail every later one with a poisoned lock.
#[cfg(test)]
pub(crate) fn process_test_guard() -> std::sync::MutexGuard<'static, ()> {
    PROCESS_TEST_LOCK.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// A system toast for a thread. A click brings the window back and tells the
/// UI which thread through `notification://open`; the UI opens it.
#[tauri::command]
fn notify(app: AppHandle, webview: Webview, title: String, body: String, thread_id: String) -> Result<(), String> {
    quota_window::only_ui(&webview)?;
    platform::notify(app, title, body, thread_id)
}

/// Set by an update just before `app.restart()`. On Linux and macOS the
/// restart starts the new shell while the old one still holds `shell.lock`:
/// the new one would wake the exiting one and quit, leaving no window. It
/// waits for the lock instead, and the variable goes no further than here.
const RESTARTED_AFTER_UPDATE: &str = "BOITE_RESTARTED_AFTER_UPDATE";

fn acquire_after_update(directory: &std::path::Path, restarted: bool) -> std::io::Result<Option<std::fs::File>> {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    loop {
        let acquired = instance::acquire(directory)?;
        if acquired.is_some() || !restarted || std::time::Instant::now() >= deadline { return Ok(acquired); }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
}

/// The invoke handler, plus the command names the watchdog reports, from one
/// list so a new command cannot be registered without being timed.
macro_rules! shell_commands {
    ($($first:ident $(:: $rest:ident)*),* $(,)?) => {
        (invoke_handler(tauri::generate_handler![$($first $(:: $rest)*),*]), [$(stringify!($first $(:: $rest)*)),*])
    };
}

/// Gives the handler closure the type `invoke_handler` would have inferred.
fn invoke_handler<F: Fn(tauri::ipc::Invoke) -> bool + Send + Sync + 'static>(handler: F) -> F { handler }

fn channel_label(channel: Channel) -> &'static str {
    match channel { Channel::Stable => "stable", Channel::Dev => "dev" }
}

/// One startup step, with how long it held the main thread.
fn phase(name: &'static str, started: std::time::Instant) {
    let took = started.elapsed();
    shell_log::timed(shell_log::Level::Info, "startup", "shell.startup.phase",
        format!("startup phase {name} took {} ms", took.as_millis()), took, json!({ "phase": name }));
}

// One expansion: on macOS generate_context also embeds the application plist.
fn shell_context<R: tauri::Runtime>() -> tauri::Context<R> {
    tauri::generate_context!()
}

pub fn run() {
    let launched = std::time::Instant::now();
    platform::before_webview();
    // The channel is read here and nowhere else: the compiled bundle identifier
    // is the only thing that says which install this executable is. Nothing
    // from here to the end of this block may panic: there is no window yet,
    // so a panic here is the app not starting with nothing the user can see.
    let context = shell_context();
    let channel = Channel::of_identifier(&context.config().identifier);
    let directory = resolve_data_dir(channel);
    shell_log::init(&directory);
    let (os, os_build) = platform::watch::os_build();
    shell_log::info("startup", "shell.start", format!("Boite shell {} ({}) starting on {os} {os_build} {}",
        context.package_info().version, channel_label(channel), std::env::consts::ARCH), json!({
        "version": context.package_info().version.to_string(), "channel": channel_label(channel), "os": os, "osBuild": os_build,
        "arch": std::env::consts::ARCH, "pid": std::process::id(), "hidden": hidden(),
    }));
    phase("context", launched);
    let restarted = std::env::var_os(RESTARTED_AFTER_UPDATE).is_some();
    std::env::remove_var(RESTARTED_AFTER_UPDATE);
    // Started by the login entry: the core starts, the window waits in the tray.
    let at_login = autostart::launched_at_login(std::env::args_os(), restarted);
    let _instance = match acquire_after_update(&directory, restarted) {
        Ok(Some(file)) => Some(file),
        // Another instance already owns this data directory: it shows its
        // window, which may be in the tray or behind others, and this process
        // has nothing left to do. Automation never raises a window, and
        // neither does a login start finding Boite already running.
        Ok(None) => {
            shell_log::info("startup", "shell.instance.forwarded",
                "another shell already owns this data directory; asking it to show its window and exiting", json!({ "atLogin": at_login }));
            shell_log::flush(std::time::Duration::from_millis(300));
            if !hidden() && !at_login {
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
            shell_log::warn("startup", "shell.instance.unlocked",
                format!("the shell instance lock could not be acquired: {error}; continuing without single-instance protection"), json!({}));
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
        let thread = std::thread::current();
        let name = thread.name().unwrap_or("unnamed");
        shell_log::error("shell", "shell.panic", format!("the shell panicked on thread {name}: {info}"), json!({ "thread": name }));
        shell_log::flush(std::time::Duration::from_millis(500));
        record_failure(&failures, &format!("the shell panicked: {info}"));
        previous_hook(info);
    }));
    phase("instance", launched);
    let failures = directory.clone();
    let preferences_path = directory.join("shell-settings.json");
    let close_to_tray = close_to_tray_or_default(&preferences_path);
    let login_item = platform::login::login_program().map(|program| platform::login::LoginItem {
        name: context.package_info().name.clone(),
        identifier: context.config().identifier.clone(),
        program,
    });
    let app_updater = updater::AppUpdater::new(context.package_info().version.to_string(), directory.clone(),
        updater::replaceable_package() && !cfg!(debug_assertions)
            && channel == Channel::Stable && !hidden());

    let (commands, command_names) = shell_commands![
        local_core::core_endpoint,
        local_files::open_local_file,
        local_files::open_chat_file,
        attachments::save_attachment,
        attachment_download::save_attachment_url,
        window::shell_ready,
        whip::whip_window,
        tray::quit_shell,
        tray::quit_guard,
        notify,
        presence::user_presence,
        closing::close_behavior,
        autostart::launch_at_login,
        updater::app_update_status,
        updater::app_update_check,
        updater::app_update_download,
        updater::app_update_install,
        updater::app_update_cancel_install,
        quota_window::quota_window,
        material::window_material,
        material::window_material_supported,
        tray::tray_labels,
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
        browser::browser_profile_delete,
        browser_control::browser_protocol,
        browser_control::browser_protocol_events,
        browser_control::browser_cookies,
        browser_control::browser_set_cookies,
        browser_control::browser_screencast_start,
        browser_control::browser_screencast_stop,
    ];
    watchdog::register_commands(&command_names);
    let built = std::time::Instant::now();
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(app_updater)
        .manage(Reveal::default())
        .manage(whip::WhipState::default())
        .manage(quota_window::HoverState::default())
        .manage(CloseBehavior { enabled: AtomicBool::new(close_to_tray), path: preferences_path })
        .invoke_handler(move |invoke| {
            // A synchronous command runs inside this call, on the main thread.
            let _running = watchdog::begin(invoke.message.command());
            commands(invoke)
        })
        .setup(move |app| {
            let setup = std::time::Instant::now();
            let handle = app.handle().clone();
            match tauri::webview_version() {
                Ok(version) => shell_log::info("startup", "shell.webview", format!("web view runtime {version}"), json!({ "webviewVersion": version })),
                Err(error) => shell_log::warn("startup", "shell.webview", format!("the web view runtime version is unknown: {error}"), json!({})),
            }
            match login_item {
                Ok(item) => { app.manage(item); }
                Err(error) => eprintln!("[shell] starting at login cannot be offered: {error}"),
            }
            // Decided before anything can reveal the window: the tray is built
            // after it, and a start with no tray shows the window below.
            let in_tray = autostart::starts_in_tray(at_login, true, hidden());
            if in_tray { handle.state::<Reveal>().stay_hidden(); }
            let launch = Launch::new(channel, directory.clone(), handle.path().resource_dir().ok(),
                handle.package_info().version.to_string());
            app.manage(CoreState::new(launch));
            app.manage(tray::QuitGuard::default());
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
            phase("core-dispatch", setup);
            #[cfg(target_os = "macos")]
            window::install_macos_menu(&handle, channel)?;
            let building = std::time::Instant::now();
            let window = build_main_window(&handle, channel)?;
            phase("main-window", building);
            platform::watch::remember_main_window(&window);
            platform::watch::watch_webview(&window);
            watchdog::start(handle.clone(), platform::watch::main_window_hung);
            if !hidden() {
                let tray = std::time::Instant::now();
                // The window works without a tray: closing it then quits.
                if let Err(error) = build_tray(&handle, channel) {
                    record_failure(&directory, &format!("the tray icon could not be created, so closing the window quits Boite: {error}"));
                    shell_log::error("tray", "shell.tray.failed",
                        format!("the tray icon could not be created, so closing the window quits Boite: {error}"), json!({}));
                }
                phase("tray", tray);
            }
            if in_tray {
                if autostart::starts_in_tray(at_login, handle.tray_by_id("boite").is_some(), hidden()) {
                    // Nothing on screen: the page does not paint until the tray shows it.
                    browser::park_all(&handle);
                } else { show_main(&handle); }
            }

            let closing = handle.clone();
            let resized = window.clone();
            let monitor = std::sync::Mutex::new(None::<String>);
            let minimized = AtomicBool::new(false);
            window.on_window_event(move |event| match event {
                WindowEvent::CloseRequested { api, .. } => {
                    watchdog::saw(Seen::CloseRequested);
                    api.prevent_close();
                    let enabled = closing.state::<CloseBehavior>().enabled.load(Ordering::Acquire);
                    let hides = hides_on_close(enabled, closing.tray_by_id("boite").is_some(), hidden());
                    shell_log::info("window", "shell.window.close-requested",
                        if hides { "closing the window hides it to the tray" } else { "closing the window quits Boite" },
                        json!({ "behavior": if hides { "hide" } else { "quit" }, "closeToTray": enabled }));
                    if hides { hide_main(&closing); }
                    else { request_quit(&closing); }
                }
                // Minimizing hides nothing from WebView2: the page is parked
                // here, and unparked by the resize that restores the window.
                WindowEvent::Resized(size) => {
                    watchdog::saw(Seen::Resized);
                    let now_minimized = resized.is_minimized().unwrap_or(false);
                    if now_minimized != minimized.swap(now_minimized, Ordering::Relaxed) {
                        watchdog::saw(Seen::Minimized);
                        shell_log::info("window", if now_minimized { "shell.window.minimized" } else { "shell.window.restored" },
                            if now_minimized { "the window was minimized".to_string() } else { format!("the window was restored at {}x{}", size.width, size.height) },
                            json!({ "width": size.width, "height": size.height }));
                    }
                    if now_minimized { browser::park_all(&closing); }
                    else if resized.is_visible().unwrap_or(false) { browser::unpark_all(&closing); }
                }
                WindowEvent::Focused(focused) => {
                    watchdog::saw(if *focused { Seen::Focused } else { Seen::Blurred });
                    shell_log::debug("window", "shell.window.focus", if *focused { "the window gained focus" } else { "the window lost focus" },
                        json!({ "focused": focused }));
                }
                WindowEvent::Moved(_) => {
                    watchdog::saw(Seen::Moved);
                    // A monitor change without a scale change says nothing else.
                    let name = resized.current_monitor().ok().flatten().map(|found| found.name().cloned().unwrap_or_default());
                    if let (Some(name), Ok(mut last)) = (name, monitor.try_lock()) {
                        if last.as_deref() != Some(name.as_str()) {
                            if last.is_some() {
                                shell_log::info("window", "shell.window.monitor", format!("the window moved to monitor {name}"), json!({ "monitor": name }));
                            }
                            *last = Some(name);
                        }
                    }
                }
                WindowEvent::ScaleFactorChanged { scale_factor, new_inner_size, .. } => {
                    watchdog::saw(Seen::ScaleChanged);
                    shell_log::info("window", "shell.window.scale", format!("the window scale changed to {scale_factor}, inner size {}x{}",
                        new_inner_size.width, new_inner_size.height),
                        json!({ "scale": scale_factor, "width": new_inner_size.width, "height": new_inner_size.height }));
                }
                WindowEvent::ThemeChanged(_) => watchdog::saw(Seen::ThemeChanged),
                _ => watchdog::saw(Seen::Other),
            });
            phase("setup", setup);
            Ok(())
        })
        .build(context);
    phase("build", built);
    // A broken WebView2 install, a profile directory that cannot be written:
    // setup fails with the window never built. Say so where the user looks.
    let app = match app {
        Ok(app) => app,
        Err(error) => {
            let text = format!("Boite could not start: {error}");
            record_failure(&failures, &text);
            shell_log::error("startup", "shell.startup.failed", text.clone(), json!({}));
            shell_log::flush(std::time::Duration::from_secs(1));
            if !hidden() {
                let repair = if cfg!(windows) {
                    "\n\nRepairing or reinstalling the Microsoft Edge WebView2 Runtime often fixes it: https://developer.microsoft.com/microsoft-edge/webview2/"
                } else { "" };
                platform::alert("Boite", &format!("{text}\n\nThis is written in {}.{repair}", failures.join(FAILURE_LOG).display()));
            }
            std::process::exit(1);
        }
    };
    app.run(move |app, event| match event {
            tauri::RunEvent::ExitRequested { api, code, .. } if code.is_none() => {
                shell_log::info("shell", "shell.exit-requested", "the last window closed; asking whether to quit", json!({}));
                api.prevent_exit();
                request_quit(app);
            }
            tauri::RunEvent::Exit => {
                if let Some(state) = app.try_state::<CoreState>() {
                    state.kill_child();
                }
                shell_log::info("shell", "shell.exit", format!("the shell exits after {} s", launched.elapsed().as_secs()),
                    json!({ "uptimeMs": launched.elapsed().as_millis() as u64 }));
                shell_log::flush(std::time::Duration::from_secs(1));
            }
            // A click on the dock icon.
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Reopen { .. } => show_main(app),
            _ => {}
        });
}
