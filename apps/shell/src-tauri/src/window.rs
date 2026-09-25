//! The main window: how it is built, when it first reaches the screen, and
//! how it is shown and hidden afterwards.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use tauri::{AppHandle, Manager, Runtime, Webview};
#[cfg(windows)]
use tauri::{utils::config::WindowEffectsConfig, window::Effect};

use crate::browser::{self, MAIN_LABEL};
use crate::channel::Channel;
#[cfg(windows)]
use crate::material::{supported_materials, windows_build};
use crate::quota_window;

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
    }
}
