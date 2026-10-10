//! The main window: how it is built, when it first reaches the screen, and
//! how it is shown and hidden afterwards.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use tauri::{AppHandle, Manager, Runtime, Webview};

use crate::browser::{self, MAIN_LABEL};
use crate::channel::Channel;
#[cfg(windows)]
use crate::material::{apply_material, supported_materials, windows_build};
use crate::quota_window;

/// Whether an undecorated window may keep the shadow Tauri gives it by default.
/// Below Windows 11 (22000), tao answers `WM_NCCALCSIZE` for such a window with
/// a client area shrunk by the resize frame on the left, right and bottom
/// (8 px at 100%) and none at the top, and Windows paints its frame into that
/// band: a grey edge on three sides. Windows 11 keeps the band invisible and
/// draws its shadow and rounded corners from it. Pure, so every build is a test.
pub(crate) fn undecorated_shadow(build: u32) -> bool {
    build >= 22000
}

pub(crate) fn hidden() -> bool {
    std::env::var("BOITE_SHELL_HIDDEN").ok().as_deref() == Some("1")
}

// Webviews sharing a profile must also share environment options. Elevated
// hosts ignore WebView2's environment variables, so each builder uses the API.
pub(crate) fn test_browser_args() -> Option<String> {
    if !hidden() { return None; }
    let value = std::env::var("BOITE_SHELL_DEBUG_PORT").ok()?;
    let port: u16 = value.parse().expect("BOITE_SHELL_DEBUG_PORT must be a port number");
    assert!(port > 0, "BOITE_SHELL_DEBUG_PORT must be greater than zero");
    Some(format!("--remote-debugging-port={port} --remote-allow-origins=* --mute-audio --use-angle=d3d11"))
}

/// The WebView2 profile the main window and every browser surface share. `None`
/// leaves it to Tauri, which puts it under the app's own local data directory.
/// One profile means one browser process for the whole shell.
pub(crate) fn webview_profile() -> Option<PathBuf> {
    let value = std::env::var("BOITE_DATA_DIR").ok()?;
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(PathBuf::from(trimmed).join("webview"))
}

/// How long a start may keep the window off the screen before it shows the
/// page's own "connecting" state instead.
pub(crate) const REVEAL_AFTER: Duration = Duration::from_secs(2);
/// When the window is shown even if its page never said it painted: a broken
/// bundle still gets a window, and with it a way to quit.
pub(crate) const REVEAL_ANYWAY: Duration = Duration::from_secs(10);

/// The main window's first appearance. It is built hidden and shown once, when
/// its page has painted and either the core answered or `REVEAL_AFTER` passed:
/// a fast start never flashes an empty frame, and a slow one shows the page
/// saying it is connecting instead of nothing at all.
#[derive(Default)]
pub(crate) struct Reveal {
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
    pub(crate) fn due(&self) -> bool {
        self.due.store(true, Ordering::SeqCst);
        self.settle()
    }

    /// True once, for whichever call completes the pair.
    fn settle(&self) -> bool {
        self.painted.load(Ordering::SeqCst) && self.due.load(Ordering::SeqCst) && !self.shown.swap(true, Ordering::SeqCst)
    }

    /// True unless the window was already shown.
    pub(crate) fn anyway(&self) -> bool {
        !self.shown.swap(true, Ordering::SeqCst)
    }

    /// A start into the tray: no timer and no painted page reveals the window.
    /// The tray, a second launch or the dock still show it with `show_main`.
    pub(crate) fn stay_hidden(&self) {
        self.shown.store(true, Ordering::SeqCst);
    }
}

/// The page says it has painted its first frame. Only the main page asks.
#[tauri::command]
pub(crate) fn shell_ready(app: AppHandle, webview: Webview) -> Result<(), String> {
    browser::only_main(&webview)?;
    if app.state::<Reveal>().painted() {
        show_main(&app);
    }
    Ok(())
}

/// What a nightly build calls itself in the window title and the tray. The
/// installer keeps `productName` Boite: both tracks are one installation.
const NIGHTLY_LABEL: &str = "boite (de nuit)";

pub(crate) fn product_label<R: Runtime>(app: &AppHandle<R>, channel: Channel) -> &'static str {
    label_for(channel, app.package_info().version.pre.as_str())
}

fn label_for(channel: Channel, prerelease: &str) -> &'static str {
    if channel == Channel::Stable && prerelease.starts_with("nightly.") {
        NIGHTLY_LABEL
    } else { channel.product_name() }
}

/// The size the main window opens at when no monitor answers, and what a new
/// window takes of the primary monitor's work area otherwise: 70% of its width
/// and 80% of its height, kept between `MAIN_FLOOR` and `MAIN_CEILING`. A
/// 1920 x 1080 screen gets 1344 x 826, a 2560 x 1440 one 1600 x 1000.
const MAIN_SIZE: (f64, f64) = (1280.0, 800.0);
const MAIN_SHARE: (f64, f64) = (0.7, 0.8);
/// The floor fits the tour's 600 px panel under the 44 px title bar with the
/// scrim's margins, so a first launch shows every screen without scrolling.
const MAIN_FLOOR: (f64, f64) = (1200.0, 720.0);
const MAIN_CEILING: (f64, f64) = (1600.0, 1000.0);
const MAIN_MIN_SIZE: (f64, f64) = (880.0, 560.0);

/// Logical `(x, y, width, height)` of the opening window centred in `area`
/// (`left, top, width, height`). Its size follows `MAIN_SHARE` of the area
/// within `MAIN_FLOOR` and `MAIN_CEILING`, never past 92% of a small screen.
/// An area below the minimum size gets the window at its top left, so the
/// title bar stays on screen.
fn centred(area: (f64, f64, f64, f64)) -> (f64, f64, f64, f64) {
    let side = |length: f64, share: f64, floor: f64, ceiling: f64, min: f64| {
        (length * share).clamp(floor, ceiling).min(length * 0.92).max(min)
    };
    let width = side(area.2, MAIN_SHARE.0, MAIN_FLOOR.0, MAIN_CEILING.0, MAIN_MIN_SIZE.0);
    let height = side(area.3, MAIN_SHARE.1, MAIN_FLOOR.1, MAIN_CEILING.1, MAIN_MIN_SIZE.1);
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
pub(crate) fn build_main_window<R: Runtime>(
    app: &AppHandle<R>,
    channel: Channel,
) -> tauri::Result<tauri::WebviewWindow<R>> {
    let mut builder =
        tauri::WebviewWindowBuilder::new(app, MAIN_LABEL, tauri::WebviewUrl::default())
            .title(product_label(app, channel))
            .inner_size(MAIN_SIZE.0, MAIN_SIZE.1)
            .min_inner_size(MAIN_MIN_SIZE.0, MAIN_MIN_SIZE.1)
            .resizable(true)
            // Linux lets the window manager choose buttons, their order and
            // title-bar actions. Windows draws its captions in the page.
            .decorations(!cfg!(windows))
            .visible(false)
            .focused(!hidden())
            .skip_taskbar(hidden())
            .initialization_script(crate::platform::region::script())
            // The browser surfaces belong to the page that asked for them: a
            // reload of the UI takes every child webview with it.
            .on_page_load(|window, payload| {
                if matches!(payload.event(), tauri::webview::PageLoadEvent::Started) {
                    crate::tray::reset_quit_guard(window.app_handle());
                    browser::close_all(window.app_handle());
                }
            });
    // A window that can wear a material is built transparent, the one thing
    // that cannot change later; the material itself is set once it exists. A
    // Windows with no material but solid (Windows 10) gets an opaque window
    // with nothing to composite, and no shadow band either.
    #[cfg(windows)]
    let build = windows_build();
    #[cfg(windows)]
    {
        if supported_materials(build).contains(&"mica") {
            builder = builder.transparent(true);
        }
        if !undecorated_shadow(build) {
            builder = builder.shadow(false);
        }
    }
    // macOS keeps its own frame, corners and traffic lights, drawn over the
    // top of the page: the title bar leaves them room (`TitleBar.svelte`) and
    // they sit centred in its 44 px, where the Windows caption buttons were.
    // The multi-webview runtime ignores Wry's traffic_light_position: native
    // layout below also reapplies the position after AppKit resizes its frame.
    #[cfg(target_os = "macos")]
    {
        builder = builder.title_bar_style(tauri::TitleBarStyle::Overlay).hidden_title(true);
    }
    builder = match work_area(app) {
        Some(area) => {
            let (x, y, width, height) = centred(area);
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
    let window = builder.build()?;
    #[cfg(target_os = "macos")]
    {
        let arrange = |window: &tauri::WebviewWindow<R>| {
            let native = window.clone();
            let _ = window.run_on_main_thread(move || {
                if let Ok(pointer) = native.ns_window() {
                    // Tauri owns this live NSWindow; AppKit access stays on its main thread.
                    unsafe { crate::platform::macos_window::align_traffic_lights(&*pointer.cast()) };
                }
            });
        };
        arrange(&window);
        let native = window.clone();
        window.on_window_event(move |event| {
            if matches!(event, tauri::WindowEvent::Resized(_) | tauri::WindowEvent::ScaleFactorChanged { .. } | tauri::WindowEvent::Focused(true)) {
                arrange(&native);
            }
        });
    }
    // Acrylic is what a window opens on where DWM draws it, and `lib/glass.ts`
    // applies whatever the setting says as soon as the UI mounts.
    #[cfg(windows)]
    if supported_materials(build).contains(&"acrylic") {
        let applied = window.hwnd().map_err(|error| error.to_string()).and_then(|hwnd| apply_material(hwnd.0, "acrylic", build));
        if let Err(error) = applied {
            eprintln!("[shell] the main window opens without its material: {error}");
        }
    }
    Ok(window)
}

/// The window is created hidden and only reaches the screen here: at start
/// when `Reveal` says so, later from the tray or a second launch.
pub(crate) fn show_main<R: Runtime>(app: &AppHandle<R>) {
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

pub(crate) fn hide_main<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window(MAIN_LABEL) {
        browser::park_all(app);
        let _ = window.hide();
        let _ = window.set_skip_taskbar(true);
    }
}

#[cfg(test)]
mod tests {
    use super::{label_for, Channel, Reveal};

    #[test]
    fn the_main_window_opens_centred_at_a_share_of_the_screen() {
        // 1080p at 100%, taskbar at the bottom: 70% x 80%, centred.
        let (x, y, width, height) = super::centred((0.0, 0.0, 1920.0, 1032.0));
        assert_eq!((x.round(), y.round(), width.round(), height.round()), (288.0, 103.0, 1344.0, 826.0));
        // 1440p at 100%: the ceiling.
        assert_eq!(super::centred((0.0, 0.0, 2560.0, 1392.0)), (480.0, 196.0, 1600.0, 1000.0));
        // 1080p at 125%: the floor, which still leaves the tour unscrolled.
        assert_eq!(super::centred((0.0, 0.0, 1536.0, 824.0)), (168.0, 52.0, 1200.0, 720.0));
        // 1080p at 150%: 1280 x 688 logical, so 92% of it, still centred.
        let (x, y, width, height) = super::centred((0.0, 0.0, 1280.0, 688.0));
        assert_eq!((width.round(), height.round()), (1178.0, 633.0));
        assert_eq!(((x * 2.0).round(), (y * 2.0).round()), (102.0, 55.0));
        // A taskbar on the left moves the centre with the work area.
        assert_eq!(super::centred((60.0, 0.0, 1860.0, 1080.0)).0.round(), 339.0);
        // Never below the minimum size, and then pinned to the top left.
        assert_eq!(super::centred((0.0, 0.0, 800.0, 500.0)), (0.0, 0.0, 880.0, 560.0));
        assert_eq!(super::centred((60.0, 40.0, 800.0, 500.0)), (60.0, 40.0, 880.0, 560.0));
    }

    #[test]
    fn an_undecorated_window_keeps_its_shadow_from_windows_11_only() {
        // Windows 10 22H2 paints its frame into the shadow's band on three sides.
        assert!(!super::undecorated_shadow(19045));
        assert!(!super::undecorated_shadow(21999));
        assert!(super::undecorated_shadow(22000));
        assert!(super::undecorated_shadow(26200));
    }

    #[test]
    fn a_nightly_build_names_itself_boite_de_nuit() {
        assert_eq!(label_for(Channel::Stable, "nightly.20260923.1"), "boite (de nuit)");
        assert_eq!(label_for(Channel::Stable, "beta.2"), "Boite");
        assert_eq!(label_for(Channel::Stable, ""), "Boite");
        assert_eq!(label_for(Channel::Dev, "nightly.20260923.1"), "Boite Dev");
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
        let reveal = Reveal::default();
        reveal.stay_hidden();
        assert!(!reveal.painted() && !reveal.due() && !reveal.anyway(), "a start into the tray revealed the window");
    }
}

/// The id of the macOS menu's Quit item.
#[cfg(target_os = "macos")]
const MENU_QUIT: &str = "boite-menu-quit";

/// The macOS menu bar. Tauri's default one binds Cmd+W to Close Window, which
/// quits Boite when the window does not close to the tray, and Cmd+Q to an
/// immediate quit: both keys belong to the page (`close-surface` and the held
/// quit). This keeps the Edit items WKWebView needs for copy and paste, and the
/// application menu, with Quit on a click only.
#[cfg(target_os = "macos")]
pub(crate) fn install_macos_menu<R: Runtime>(app: &AppHandle<R>, channel: Channel) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItem, PredefinedMenuItem as Item, Submenu};
    let name = product_label(app, channel);
    let quit = MenuItem::with_id(app, MENU_QUIT, format!("Quit {name}"), true, None::<&str>)?;
    let application = Submenu::with_items(app, &name, true, &[
        &Item::about(app, None, None)?, &Item::separator(app)?, &Item::services(app, None)?, &Item::separator(app)?,
        &Item::hide(app, None)?, &Item::hide_others(app, None)?, &Item::show_all(app, None)?, &Item::separator(app)?,
        &quit,
    ])?;
    let edit = Submenu::with_items(app, "Edit", true, &[
        &Item::undo(app, None)?, &Item::redo(app, None)?, &Item::separator(app)?,
        &Item::cut(app, None)?, &Item::copy(app, None)?, &Item::paste(app, None)?, &Item::select_all(app, None)?,
    ])?;
    let window = Submenu::with_items(app, "Window", true, &[
        &Item::minimize(app, None)?, &Item::maximize(app, None)?, &Item::separator(app)?, &Item::fullscreen(app, None)?,
    ])?;
    app.set_menu(Menu::with_items(app, &[&application, &edit, &window])?)?;
    app.on_menu_event(|app, event| if event.id().as_ref() == MENU_QUIT { crate::tray::request_quit(app) });
    Ok(())
}
