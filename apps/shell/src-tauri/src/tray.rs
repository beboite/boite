//! The tray icon, its menu, and quitting the client.

use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    AppHandle, Emitter, Manager, Runtime, Webview,
};
use std::sync::atomic::{AtomicBool, Ordering};

use crate::browser;
use crate::channel::Channel;
use crate::local_core::CoreState;
use crate::quota_window;
use crate::window::{product_label, show_main};

#[derive(Default)]
pub(crate) struct QuitGuard(AtomicBool);

pub(crate) fn reset_quit_guard<R: Runtime>(app: &AppHandle<R>) {
    if let Some(guard) = app.try_state::<QuitGuard>() {
        guard.0.store(false, Ordering::Release);
    }
}

/// Enabled only after the main UI has installed its confirmation listener.
#[tauri::command]
pub(crate) fn quit_guard(app: AppHandle, webview: Webview) -> Result<(), String> {
    browser::only_main(&webview)?;
    app.state::<QuitGuard>().0.store(true, Ordering::Release);
    Ok(())
}

pub(crate) fn request_quit<R: Runtime>(app: &AppHandle<R>) {
    let guarded = app.state::<QuitGuard>().0.load(Ordering::Acquire);
    crate::shell_log::info("shell", "shell.quit-requested",
        if guarded { "quit requested; the UI asks for confirmation first" } else { "quit requested; quitting now" },
        serde_json::json!({ "confirm": guarded }));
    if guarded {
        if let Err(error) = app.emit_to("main", "boite:quit-requested", ()) {
            eprintln!("[shell] quit confirmation could not be requested: {error}");
            crate::shell_log::warn("shell", "shell.quit-confirm-failed", format!("quit confirmation could not be requested, quitting now: {error}"), serde_json::json!({}));
            quit(app);
            return;
        }
        show_main(app);
    } else {
        quit(app);
    }
}

/// Quits the client. The resident engine has a separate authenticated stop action.
/// `tests/e2e/shell.test.ts` invokes this.
#[tauri::command]
pub(crate) fn quit_shell(app: AppHandle, webview: Webview) -> Result<(), String> {
    quota_window::only_ui(&webview)?;
    quit(&app);
    Ok(())
}

pub(crate) fn quit<R: Runtime>(app: &AppHandle<R>) {
    crate::shell_log::info("shell", "shell.quit", "quitting the shell", serde_json::json!({}));
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
pub(crate) fn tray_labels(app: AppHandle, webview: Webview, show: String, quit: String) -> Result<(), String> {
    browser::only_main(&webview)?;
    if show.trim().is_empty() || quit.trim().is_empty() {
        return Err(format!("tray labels must not be empty: show {show:?}, quit {quit:?}"));
    }
    let Some(menu) = app.try_state::<TrayMenu<tauri::Wry>>() else { return Ok(()) };
    menu.show.set_text(show).map_err(|error| format!("the tray's Show item kept its label: {error}"))?;
    menu.quit.set_text(quit).map_err(|error| format!("the tray's Quit item kept its label: {error}"))
}

pub(crate) fn build_tray<R: Runtime>(app: &AppHandle<R>, channel: Channel) -> tauri::Result<()> {
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
                // tray-icon 0.24 sends Enter again only after its own Leave, which
                // never comes when the pointer rests on the icon and then jumps
                // away. Every later hover is Moves alone, so a Move counts as the
                // Enter that did not come; `enter` ignores the repeats.
                TrayIconEvent::Enter { .. } | TrayIconEvent::Move { .. } => quota_window::enter(tray.app_handle()),
                TrayIconEvent::Leave { .. } => quota_window::leave(tray.app_handle()),
                TrayIconEvent::DoubleClick { button: MouseButton::Left, .. } => {
                    crate::watchdog::saw(crate::watchdog::Seen::TrayEvent);
                    crate::shell_log::info("tray", "shell.tray.action", "tray icon double-clicked: showing the window", serde_json::json!({ "action": "double-click" }));
                    show_main(tray.app_handle())
                }
                _ => crate::watchdog::saw(crate::watchdog::Seen::TrayEvent),
            }
        })
        .on_menu_event(|app, event| {
            crate::watchdog::saw(crate::watchdog::Seen::MenuEvent);
            match event.id().as_ref() {
                "show" => {
                    crate::shell_log::info("tray", "shell.tray.action", "tray menu Show chosen", serde_json::json!({ "action": "show" }));
                    show_main(app)
                }
                "quit" => {
                    crate::shell_log::info("tray", "shell.tray.action", "tray menu Quit chosen", serde_json::json!({ "action": "quit" }));
                    request_quit(app)
                }
                _ => {}
            }
        });
    if let Some(icon) = app.default_window_icon().cloned() {
        builder = builder.icon(icon);
    }
    // Keep an explicit app-owned reference for the entire shell lifetime.
    app.manage(builder.build(app)?);
    Ok(())
}
