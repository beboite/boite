//! The tray icon, its menu, and quitting the client.

use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    AppHandle, Manager, Runtime, Webview,
};

use crate::browser;
use crate::channel::Channel;
use crate::local_core::CoreState;
use crate::quota_window;
use crate::window::{product_label, show_main};

/// Quits the client. The resident engine has a separate authenticated stop action.
/// `tests/e2e/shell.test.ts` invokes this.
#[tauri::command]
pub(crate) fn quit_shell(app: AppHandle, webview: Webview) -> Result<(), String> {
    quota_window::only_ui(&webview)?;
    quit(&app);
    Ok(())
}

pub(crate) fn quit<R: Runtime>(app: &AppHandle<R>) {
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
