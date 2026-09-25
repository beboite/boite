use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, Runtime, Webview, WebviewUrl, WebviewWindow};

pub const LABEL: &str = "quotas";
const HOVER_DELAY: Duration = Duration::from_millis(500);
/// How long a hidden popup keeps its page. The page is a WebView2 renderer of
/// its own, about 85 MB, plus a second socket to the core: a popup nobody
/// opened again for this long gives both back, and the next hover builds it
/// again during its 500 ms delay.
const IDLE_RELEASE: Duration = Duration::from_secs(45);

#[derive(Default)]
pub struct HoverState {
    generation: AtomicU64,
    over_icon: AtomicBool,
    /// Counts every show, so a release planned at a hide knows whether the
    /// popup was opened again since.
    opened: AtomicU64,
}

impl HoverState {
    fn ready(&self, generation: u64, elapsed: Duration) -> bool {
        elapsed >= HOVER_DELAY && self.over_icon.load(Ordering::Acquire) && self.generation.load(Ordering::Acquire) == generation
    }

    pub fn cancel_open(&self) {
        self.generation.fetch_add(1, Ordering::AcqRel);
    }

    /// Whether the popup hidden when `opened` was the count stayed hidden.
    fn still_closed(&self, opened: u64) -> bool {
        self.opened.load(Ordering::Acquire) == opened
    }
}

/// The popup's page stays alive while it is hidden for this long. Tests shorten it.
fn idle_release() -> Duration {
    std::env::var("BOITE_QUOTA_IDLE_MS").ok().and_then(|ms| ms.parse().ok()).map(Duration::from_millis).unwrap_or(IDLE_RELEASE)
}

/// Every way the popup closes goes through here: hide it, tell its page, and
/// destroy it once it stayed hidden for [`IDLE_RELEASE`]. `destroy` rather
/// than `close`, so no close handler can turn the release into another hide.
pub fn hide<R: Runtime>(app: &AppHandle<R>, window: &WebviewWindow<R>) -> tauri::Result<()> {
    window.hide()?;
    window.emit("tray://closed", ())?;
    let opened = app.state::<HoverState>().opened.load(Ordering::Acquire);
    let handle = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(idle_release());
        let app = handle.clone();
        let _ = handle.run_on_main_thread(move || {
            if !app.state::<HoverState>().still_closed(opened) { return; }
            let Some(window) = app.get_webview_window(LABEL) else { return };
            if !window.is_visible().unwrap_or(true) {
                if let Err(error) = window.destroy() { eprintln!("[shell] the hidden quota window could not be released: {error}"); }
            }
        });
    });
    Ok(())
}

type Bounds = (f64, f64, f64, f64);

// Work area plus the full extent of any auto-hidden appbars on this monitor.
fn available_area(monitor: Bounds, work: Bounds, hidden: &[(u32, f64)]) -> Bounds {
    let mut area = (work.0.max(monitor.0), work.1.max(monitor.1), work.2.min(monitor.2), work.3.min(monitor.3));
    for &(edge, thickness) in hidden {
        match edge {
            0 => area.0 = area.0.max(monitor.0 + thickness),
            1 => area.1 = area.1.max(monitor.1 + thickness),
            2 => area.2 = area.2.min(monitor.2 - thickness),
            3 => area.3 = area.3.min(monitor.3 - thickness),
            _ => {}
        }
    }
    area
}

use crate::platform::appbars::hidden_appbars;

pub fn only_ui(webview: &Webview) -> Result<(), String> {
    match webview.label() {
        crate::browser::MAIN_LABEL | LABEL => Ok(()),
        _ => Err("only the Boite UI may invoke this command".into()),
    }
}

pub fn position(icon_x: f64, icon_y: f64, width: f64, height: f64, monitor: (f64, f64, f64, f64)) -> (f64, f64) {
    let (left, top, right, bottom) = monitor;
    let x = (icon_x - width / 2.0).clamp(left + 8.0, (right - width - 8.0).max(left + 8.0));
    let y = if icon_y - height - 12.0 >= top { icon_y - height - 12.0 } else { icon_y + 24.0 };
    (x, y.clamp(top + 8.0, (bottom - height - 8.0).max(top + 8.0)))
}

pub fn show<R: Runtime>(app: &AppHandle<R>, point: PhysicalPosition<f64>) -> tauri::Result<()> {
    app.state::<HoverState>().opened.fetch_add(1, Ordering::AcqRel);
    let window = if let Some(window) = app.get_webview_window(LABEL) { window } else {
        let mut builder = tauri::WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("index.html?view=quotas".into()))
            .title("Boite quotas").inner_size(380.0, 460.0).resizable(false)
            .decorations(false).skip_taskbar(true).always_on_top(true)
            .visible(false).focused(false).focusable(false)
            .on_navigation(|url| matches!(url.scheme(), "tauri" | "http" | "https") && matches!(url.host_str(), Some("tauri.localhost") | Some("localhost")));
        #[cfg(windows)]
        { builder = builder.transparent(true); }
        if let Some(profile) = crate::window::webview_profile() { builder = builder.data_directory(profile); }
        if let Some(args) = crate::window::test_browser_args() { builder = builder.additional_browser_args(&args); }
        builder.build()?
    };
    if let Some(monitor) = window.monitor_from_point(point.x, point.y)? {
        let scale = monitor.scale_factor();
        let origin = monitor.position(); let size = monitor.size();
        let bounds = (origin.x as f64, origin.y as f64, origin.x as f64 + size.width as f64, origin.y as f64 + size.height as f64);
        let work = monitor.work_area();
        let area = available_area(bounds, (work.position.x as f64, work.position.y as f64,
            work.position.x as f64 + work.size.width as f64, work.position.y as f64 + work.size.height as f64), &hidden_appbars(bounds));
        // Windows can retain invisible frame borders on undecorated windows.
        // Reserve those too: set_size takes an inner size, placement an outer one.
        let inner = window.inner_size()?;
        let outer = window.outer_size()?;
        let frame_width = outer.width.saturating_sub(inner.width) as f64;
        let frame_height = outer.height.saturating_sub(inner.height) as f64;
        let width = (380.0 * scale).min((area.2 - area.0 - 16.0 - frame_width).max(1.0));
        let height = (460.0 * scale).min((area.3 - area.1 - 16.0 - frame_height).max(1.0));
        window.set_size(tauri::PhysicalSize::new(width as u32, height as u32))?;
        let outer = window.outer_size()?;
        let (x, y) = position(point.x, point.y, outer.width as f64, outer.height as f64, area);
        window.set_position(PhysicalPosition::new(x as i32, y as i32))?;
    }
    // Test shells create and render the same page without ever showing a window.
    if !crate::window::hidden() {
        window.set_focusable(false)?;
        window.show()?;
        // Showing cannot activate the popup; a later deliberate click can.
        window.set_focusable(true)?;
    }
    window.emit("tray://open", ())?;
    Ok(())
}

pub fn enter<R: Runtime>(app: &AppHandle<R>) {
    let state = app.state::<HoverState>();
    if state.over_icon.swap(true, Ordering::AcqRel) { return; }
    let generation = state.generation.fetch_add(1, Ordering::AcqRel) + 1;
    let started = Instant::now();
    let handle = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(HOVER_DELAY);
        let app = handle.clone();
        if let Err(error) = handle.run_on_main_thread(move || {
            if !app.state::<HoverState>().ready(generation, started.elapsed()) { return; }
            // Read the current icon bounds after the taskbar reveal animation.
            // This also catches a missing Leave event when auto-hide moves it.
            let Some(tray) = app.tray_by_id("boite") else { return; };
            let Ok(Some(rect)) = tray.rect() else { return; };
            let Ok(cursor) = app.cursor_position() else { return; };
            let scale = app.monitor_from_point(cursor.x, cursor.y).ok().flatten().map(|monitor| monitor.scale_factor()).unwrap_or(1.0);
            let origin = rect.position.to_physical::<f64>(scale);
            let size = rect.size.to_physical::<f64>(scale);
            if cursor.x < origin.x || cursor.x >= origin.x + size.width || cursor.y < origin.y || cursor.y >= origin.y + size.height {
                app.state::<HoverState>().over_icon.store(false, Ordering::Release);
                return;
            }
            let anchor = PhysicalPosition::new(origin.x + size.width / 2.0, origin.y);
            if let Err(error) = show(&app, anchor) { eprintln!("[shell] quota window: {error}"); }
        }) { eprintln!("[shell] quota hover: {error}"); }
    });
}

pub fn leave<R: Runtime>(app: &AppHandle<R>) {
    let state = app.state::<HoverState>();
    state.over_icon.store(false, Ordering::Release);
    let generation = state.generation.fetch_add(1, Ordering::AcqRel) + 1;
    let handle = app.clone();
    // Only runs while the pointer is travelling from the icon to the popup.
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(350));
        loop {
            let state = handle.state::<HoverState>();
            if state.generation.load(Ordering::Acquire) != generation || state.over_icon.load(Ordering::Acquire) { break; }
            if handle.get_webview_window(LABEL).is_none() { break; }
            let app = handle.clone();
            // Opening and closing share the UI thread. Recheck after dispatch
            // so an old Leave cannot close a newly entered or opened popup.
            if handle.run_on_main_thread(move || {
                let state = app.state::<HoverState>();
                if state.generation.load(Ordering::Acquire) != generation || state.over_icon.load(Ordering::Acquire) { return; }
                let Some(window) = app.get_webview_window(LABEL) else { return; };
                let inside = match (app.cursor_position(), window.outer_position(), window.outer_size()) {
                    (Ok(cursor), Ok(origin), Ok(size)) => cursor.x >= origin.x as f64 && cursor.y >= origin.y as f64
                        && cursor.x < origin.x as f64 + size.width as f64 && cursor.y < origin.y as f64 + size.height as f64,
                    _ => false,
                };
                if !inside {
                    state.cancel_open();
                    let _ = hide(&app, &window);
                }
            }).is_err() { break; }
            std::thread::sleep(Duration::from_millis(200));
        }
    });
}

#[tauri::command]
pub async fn quota_window(app: AppHandle, webview: Webview, action: String) -> Result<(), String> {
    only_ui(&webview)?;
    match action.as_str() {
        "show" => show(&app, app.cursor_position().map_err(|e| e.to_string())?).map_err(|e| e.to_string()),
        "hide" => {
            app.state::<HoverState>().generation.fetch_add(1, Ordering::AcqRel);
            if let Some(window) = app.get_webview_window(LABEL) { hide(&app, &window).map_err(|e| e.to_string())?; }
            Ok(())
        }
        "providers" => {
            if let Some(window) = app.get_webview_window(LABEL) { let _ = hide(&app, &window); }
            crate::window::show_main(&app);
            app.emit_to(crate::browser::MAIN_LABEL, "tray://providers", ()).map_err(|e| e.to_string())
        }
        _ => Err("quota window action must be show, hide or providers".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn hover_requires_500ms_and_cannot_survive_leave_or_reentry() {
        let state = HoverState::default();
        state.over_icon.store(true, Ordering::Release);
        assert!(!state.ready(0, Duration::from_millis(499)));
        assert!(state.ready(0, Duration::from_millis(500)));
        state.over_icon.store(false, Ordering::Release);
        assert!(!state.ready(0, Duration::from_millis(600)));
        state.generation.fetch_add(1, Ordering::AcqRel);
        state.over_icon.store(true, Ordering::Release);
        assert!(!state.ready(0, Duration::from_millis(900)));
        assert!(!state.ready(1, Duration::from_millis(499)));
    }
    #[test]
    fn a_hidden_popup_is_released_only_when_nothing_opened_it_since() {
        let state = HoverState::default();
        let at_hide = state.opened.load(Ordering::Acquire);
        assert!(state.still_closed(at_hide));
        state.opened.fetch_add(1, Ordering::AcqRel);
        assert!(!state.still_closed(at_hide));
    }
    #[test]
    fn visible_and_auto_hidden_taskbars_reserve_the_same_space() {
        let screen = (0.0, 0.0, 1920.0, 1080.0);
        let desktop = (0.0, 0.0, 1920.0, 1032.0);
        assert_eq!(available_area(screen, desktop, &[]), desktop);
        // Auto-hide restores the work area to almost the entire screen.
        assert_eq!(available_area(screen, screen, &[(3, 48.0)]), desktop);
        let (_, y) = position(1890.0, 1060.0, 380.0, 460.0, available_area(screen, screen, &[(3, 48.0)]));
        assert!(y + 460.0 <= 1032.0 - 8.0);
    }
    #[test]
    fn hidden_taskbars_use_their_own_monitor_and_physical_scale() {
        let screen = (-2560.0, -1440.0, 0.0, 0.0);
        for scale in [1.0, 1.25, 1.5, 2.0] {
            let area = available_area(screen, screen, &[(3, 48.0 * scale)]);
            let (x, y) = position(-20.0, -12.0, 380.0 * scale, 460.0 * scale, area);
            assert!(y + 460.0 * scale <= -48.0 * scale - 8.0);
            assert!(x >= -2560.0 && x + 380.0 * scale <= 0.0);
        }
        assert_eq!(available_area(screen, screen, &[(0, 60.0), (1, 40.0), (2, 50.0)]), (-2500.0, -1400.0, -50.0, 0.0));
    }
    #[test]
    fn popup_stays_on_the_icon_monitor_at_every_edge() {
        for (x,y) in [(-1920.0, 0.0), (-1.0, 0.0), (-1920.0, 1080.0), (-1.0, 1080.0)] {
            let (px,py) = position(x,y,380.0,460.0,(-1920.0,0.0,0.0,1080.0));
            assert!(px >= -1912.0 && px + 380.0 <= -8.0);
            assert!(py >= 8.0 && py + 460.0 <= 1072.0);
        }
    }
}
