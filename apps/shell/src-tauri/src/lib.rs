//! The Boite desktop shell. Nothing here but the window, the tray, and the
//! local core: every decision the product makes lives in the core or the UI.

use std::sync::atomic::{AtomicBool, Ordering};
#[cfg(test)]
use std::sync::Mutex;
mod attachments;
mod attachment_download;
mod browser;
mod channel;
mod closing;
mod failure;
mod instance;
mod local_core;
mod local_files;
mod material;
mod platform;
mod quota_window;
mod resident;
mod update_stop;
mod tray;
mod updater;
mod window;
mod whip;

// Tauri links its manifest into binaries, but not the library test executable.
// Native updater tests import TaskDialogIndirect, which needs Common Controls v6.
#[cfg(all(test, target_os = "windows"))]
#[link(name = "resource", kind = "static", modifiers = "-bundle")]
unsafe extern "C" {}

use tauri::{AppHandle, Manager, Webview, WindowEvent};

use channel::Channel;
use closing::{close_to_tray_or_default, hides_on_close, CloseBehavior};
use failure::{record_failure, FAILURE_LOG};
use local_core::{resolve_data_dir, start_core, CoreState, Launch};
use tray::{build_tray, quit};
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

fn acquire_after_update(directory: &std::path::Path) -> std::io::Result<Option<std::fs::File>> {
    let restarted = std::env::var_os(RESTARTED_AFTER_UPDATE).is_some();
    std::env::remove_var(RESTARTED_AFTER_UPDATE);
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    loop {
        let acquired = instance::acquire(directory)?;
        if acquired.is_some() || !restarted || std::time::Instant::now() >= deadline { return Ok(acquired); }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
}

pub fn run() {
    platform::before_webview();
    // The channel is read here and nowhere else: the compiled bundle identifier
    // is the only thing that says which install this executable is. Nothing
    // from here to the end of this block may panic: there is no window yet,
    // so a panic here is the app not starting with nothing the user can see.
    let context = tauri::generate_context!();
    let channel = Channel::of_identifier(&context.config().identifier);
    let directory = resolve_data_dir(channel);
    let _instance = match acquire_after_update(&directory) {
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
        updater::replaceable_package() && !cfg!(debug_assertions)
            && channel == Channel::Stable && !hidden());

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(app_updater)
        .manage(Reveal::default())
        .manage(whip::WhipState::default())
        .manage(quota_window::HoverState::default())
        .manage(CloseBehavior { enabled: AtomicBool::new(close_to_tray), path: preferences_path })
        .invoke_handler(tauri::generate_handler![
            local_core::core_endpoint,
            local_files::open_local_file,
            attachments::save_attachment,
            attachment_download::save_attachment_url,
            window::shell_ready,
            whip::whip_window,
            tray::quit_shell,
            notify,
            closing::close_behavior,
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
            #[cfg(target_os = "macos")]
            window::install_macos_menu(&handle)?;
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
                let repair = if cfg!(windows) {
                    "\n\nRepairing or reinstalling the Microsoft Edge WebView2 Runtime often fixes it: https://developer.microsoft.com/microsoft-edge/webview2/"
                } else { "" };
                platform::alert("Boite", &format!("{text}\n\nThis is written in {}.{repair}", failures.join(FAILURE_LOG).display()));
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
