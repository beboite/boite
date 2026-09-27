use std::sync::atomic::{AtomicBool, AtomicU64, AtomicU8, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, Runtime, Webview, WebviewUrl, WebviewWindow};

pub const LABEL: &str = "quotas";
const HOVER_DELAY: Duration = Duration::from_millis(100);
/// How often an open popup reads where the pointer is.
const WATCH_EVERY: Duration = Duration::from_millis(150);
/// Samples in a row the pointer must spend away before the popup closes, so a
/// pointer cutting a corner between the icon and the popup does not close it.
const AWAY_SAMPLES: u8 = 2;
/// How long a hidden popup keeps its page. The page is a WebView2 renderer of
/// its own, about 85 MB, plus a second socket to the core: a popup nobody
/// opened again for this long gives both back, and the next hover builds it
/// again after its 100 ms delay.
const IDLE_RELEASE: Duration = Duration::from_secs(45);

#[derive(Default)]
pub struct HoverState {
    generation: AtomicU64,
    over_icon: AtomicBool,
    /// Whether the popup is open: set by `show`, cleared by `hide` and when the
    /// window goes away. A hover while it is open leaves it exactly as it is.
    open: AtomicBool,
    /// Counts every opening, so a release planned at a hide knows whether the
    /// popup was opened again since.
    opened: AtomicU64,
}

impl HoverState {
    /// The pointer reached the icon. The generation a delayed show must still
    /// find, or `None` when there is nothing to show: the pointer was already
    /// counted over the icon, or the popup is open, so coming back to the icon
    /// of an open popup keeps it open without showing it again.
    fn entered(&self) -> Option<u64> {
        if self.over_icon.swap(true, Ordering::AcqRel) { return None; }
        let generation = self.generation.fetch_add(1, Ordering::AcqRel) + 1;
        (!self.open.load(Ordering::Acquire)).then_some(generation)
    }

    fn ready(&self, generation: u64, elapsed: Duration) -> bool {
        elapsed >= HOVER_DELAY && self.over_icon.load(Ordering::Acquire)
            && self.generation.load(Ordering::Acquire) == generation && !self.open.load(Ordering::Acquire)
    }

    pub fn cancel_open(&self) {
        self.generation.fetch_add(1, Ordering::AcqRel);
    }

    /// Marks the popup open. False when it already was: that show then does
    /// nothing, no second `show()` and no second `tray://open`, whose handler
    /// replays the page's opening.
    fn opening(&self) -> bool {
        if self.open.swap(true, Ordering::AcqRel) { return false; }
        self.opened.fetch_add(1, Ordering::AcqRel);
        true
    }

    /// However the popup closed, the next hover opens it again: the pointer
    /// may still count over the icon when tray-icon never reported it leaving.
    fn closed(&self) {
        self.open.store(false, Ordering::Release);
        self.over_icon.store(false, Ordering::Release);
    }

    /// Whether the popup hidden when `opened` was the count stayed hidden.
    fn still_closed(&self, opened: u64) -> bool {
        self.opened.load(Ordering::Acquire) == opened
    }

    /// Whether the popup opened as number `opened` is still the one open.
    fn watching(&self, opened: u64) -> bool {
        self.open.load(Ordering::Acquire) && self.opened.load(Ordering::Acquire) == opened
    }
}

/// Counts one sample of the pointer: true once it has been away for
/// [`AWAY_SAMPLES`] samples in a row. Coming back resets the count.
fn away_long_enough(away: &AtomicU8, inside: bool) -> bool {
    if inside { away.store(0, Ordering::Release); return false; }
    away.fetch_add(1, Ordering::AcqRel).saturating_add(1) >= AWAY_SAMPLES
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
    let state = app.state::<HoverState>();
    state.closed();
    window.emit("tray://closed", ())?;
    let opened = state.opened.load(Ordering::Acquire);
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

/// The popup's page. `frame=native` tells it Windows draws the corners and the
/// border, so the page draws no border of its own.
fn page_url(native_frame: bool) -> &'static str {
    if native_frame { "index.html?view=quotas&frame=native" } else { "index.html?view=quotas" }
}

/// The ground `index.html` paints first, so an opaque popup shown before its
/// page has painted is not a white rectangle.
fn ground(dark: bool) -> tauri::window::Color {
    if dark { tauri::window::Color(16, 16, 19, 255) } else { tauri::window::Color(243, 243, 246, 255) }
}

/// The popup is an opaque window. It used to be transparent with a CSS radius
/// on its page, which Windows 10 drew as square corners and a light edge around
/// the rounded card. Windows 11 now rounds it and draws its border and shadow;
/// Windows 10 gets square corners and no shadow band (`undecorated_shadow`).
fn build_popup<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<WebviewWindow<R>> {
    #[cfg(windows)]
    let native_frame = crate::window::undecorated_shadow(crate::material::windows_build());
    #[cfg(not(windows))]
    let native_frame = false;
    let dark = app.get_webview_window(crate::browser::MAIN_LABEL).and_then(|main| main.theme().ok())
        .is_none_or(|theme| theme == tauri::Theme::Dark);
    let mut builder = tauri::WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App(page_url(native_frame).into()))
        .title("Boite quotas").inner_size(380.0, 460.0).resizable(false)
        .decorations(false).skip_taskbar(true).always_on_top(true)
        .visible(false).focused(false).focusable(false)
        .background_color(ground(dark))
        .on_navigation(|url| matches!(url.scheme(), "tauri" | "http" | "https") && matches!(url.host_str(), Some("tauri.localhost") | Some("localhost")));
    #[cfg(windows)]
    if !native_frame { builder = builder.shadow(false); }
    if let Some(profile) = crate::window::webview_profile() { builder = builder.data_directory(profile); }
    if let Some(args) = crate::window::test_browser_args() { builder = builder.additional_browser_args(&args); }
    let window = builder.build()?;
    #[cfg(windows)]
    if native_frame {
        let rounded = window.hwnd().map_err(|error| error.to_string()).and_then(|hwnd| crate::platform::dwm::round_corners(hwnd.0));
        if let Err(error) = rounded { eprintln!("[shell] the quota window keeps square corners: {error}"); }
    }
    Ok(window)
}

/// Opens the popup at `point`. A popup already open is left exactly as it is.
pub fn show<R: Runtime>(app: &AppHandle<R>, point: PhysicalPosition<f64>) -> tauri::Result<()> {
    let state = app.state::<HoverState>();
    forget_a_closed_window(app);
    if !state.opening() { return Ok(()); }
    let shown = present(app, point);
    match shown {
        Err(_) => state.closed(),
        // A test shell never shows the window, and the pointer is the user's.
        Ok(()) if !crate::window::hidden() => watch(app, state.opened.load(Ordering::Acquire)),
        Ok(()) => {}
    }
    shown
}

/// Closes the open popup once the pointer has left it, the icon and the gap
/// between them. It runs for as long as the popup is open rather than waiting
/// for the tray's `Leave`, which Windows often never sends (tray-icon 0.24):
/// the popup then stayed up, and the pointer still counted over the icon kept
/// the next hover from opening it. Closing here clears that mark too.
fn watch<R: Runtime>(app: &AppHandle<R>, opened: u64) {
    let handle = app.clone();
    let away = Arc::new(AtomicU8::new(0));
    std::thread::spawn(move || loop {
        std::thread::sleep(WATCH_EVERY);
        if !handle.state::<HoverState>().watching(opened) { break; }
        let app = handle.clone();
        let away = away.clone();
        // Opening and closing share the UI thread. Recheck after dispatch so a
        // sample taken for an older opening cannot close a newer one.
        if handle.run_on_main_thread(move || {
            let state = app.state::<HoverState>();
            if !state.watching(opened) { return; }
            let Some(window) = app.get_webview_window(LABEL) else { return };
            if !away_long_enough(&away, pointer_keeps_open(&app, &window)) { return; }
            state.over_icon.store(false, Ordering::Release);
            state.cancel_open();
            let _ = hide(&app, &window);
        }).is_err() { break; }
    });
}

fn pointer_keeps_open<R: Runtime>(app: &AppHandle<R>, window: &WebviewWindow<R>) -> bool {
    match (app.cursor_position(), window.outer_position(), window.outer_size()) {
        (Ok(cursor), Ok(origin), Ok(size)) => keeps_open(
            (cursor.x, cursor.y),
            (origin.x as f64, origin.y as f64, origin.x as f64 + size.width as f64, origin.y as f64 + size.height as f64),
            icon_bounds(app, cursor),
        ),
        _ => false,
    }
}

/// A popup closed without `hide` (Alt+F4 destroys it) is not open any more.
/// Only once: every Move over the icon comes through here, and a released
/// popup has no window either.
fn forget_a_closed_window<R: Runtime>(app: &AppHandle<R>) {
    let state = app.state::<HoverState>();
    if state.open.load(Ordering::Acquire) && app.get_webview_window(LABEL).is_none() { state.closed(); }
}

fn present<R: Runtime>(app: &AppHandle<R>, point: PhysicalPosition<f64>) -> tauri::Result<()> {
    let window = match app.get_webview_window(LABEL) { Some(window) => window, None => build_popup(app)? };
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

/// `(left, top, right, bottom)` in physical pixels, the right and bottom edges
/// outside.
type Rect = (f64, f64, f64, f64);

fn contains(rect: Rect, (x, y): (f64, f64)) -> bool {
    x >= rect.0 && y >= rect.1 && x < rect.2 && y < rect.3
}

/// Whether the pointer at `cursor` still belongs to the open popup: over the
/// popup, over the tray icon, or in the gap between them that the pointer
/// crosses going from one to the other, as wide as the icon. A close in that
/// gap was the popup closing, then opening again, when the pointer went back
/// from the popup to the icon.
fn keeps_open(cursor: (f64, f64), popup: Rect, icon: Option<Rect>) -> bool {
    if contains(popup, cursor) { return true; }
    let Some(icon) = icon else { return false };
    if contains(icon, cursor) { return true; }
    let (top, bottom) = if popup.3 <= icon.1 { (popup.3, icon.1) } else if icon.3 <= popup.1 { (icon.3, popup.1) } else { return false };
    contains((icon.0, top, icon.2, bottom), cursor)
}

/// The tray icon's bounds in physical pixels, read now: the taskbar may have
/// moved it since the last event (auto-hide reveal).
fn icon_bounds<R: Runtime>(app: &AppHandle<R>, cursor: PhysicalPosition<f64>) -> Option<Rect> {
    let rect = app.tray_by_id("boite")?.rect().ok()??;
    let scale = app.monitor_from_point(cursor.x, cursor.y).ok().flatten().map(|monitor| monitor.scale_factor()).unwrap_or(1.0);
    let origin = rect.position.to_physical::<f64>(scale);
    let size = rect.size.to_physical::<f64>(scale);
    Some((origin.x, origin.y, origin.x + size.width, origin.y + size.height))
}

pub fn enter<R: Runtime>(app: &AppHandle<R>) {
    forget_a_closed_window(app);
    let Some(generation) = app.state::<HoverState>().entered() else { return };
    let started = Instant::now();
    let handle = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(HOVER_DELAY);
        let app = handle.clone();
        if let Err(error) = handle.run_on_main_thread(move || {
            if !app.state::<HoverState>().ready(generation, started.elapsed()) { return; }
            // Read the current icon bounds after the taskbar reveal animation.
            // This also catches a missing Leave event when auto-hide moves it.
            let Ok(cursor) = app.cursor_position() else { return; };
            let Some(icon) = icon_bounds(&app, cursor) else { return; };
            if !contains(icon, (cursor.x, cursor.y)) {
                app.state::<HoverState>().over_icon.store(false, Ordering::Release);
                return;
            }
            let anchor = PhysicalPosition::new((icon.0 + icon.2) / 2.0, icon.1);
            if let Err(error) = show(&app, anchor) { eprintln!("[shell] quota window: {error}"); }
        }) { eprintln!("[shell] quota hover: {error}"); }
    });
}

/// The pointer left the icon: a show still waiting out its delay is cancelled.
/// Closing an open popup is [`watch`]'s job, which does not count on this event.
pub fn leave<R: Runtime>(app: &AppHandle<R>) {
    let state = app.state::<HoverState>();
    state.over_icon.store(false, Ordering::Release);
    state.cancel_open();
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
    fn hover_requires_100ms_and_cannot_survive_leave_or_reentry() {
        let state = HoverState::default();
        state.over_icon.store(true, Ordering::Release);
        assert!(!state.ready(0, Duration::from_millis(99)));
        assert!(state.ready(0, Duration::from_millis(100)));
        state.over_icon.store(false, Ordering::Release);
        assert!(!state.ready(0, Duration::from_millis(200)));
        state.generation.fetch_add(1, Ordering::AcqRel);
        state.over_icon.store(true, Ordering::Release);
        assert!(!state.ready(0, Duration::from_millis(400)));
        assert!(!state.ready(1, Duration::from_millis(99)));
    }
    /// What `leave` does to the state.
    fn pointer_leaves(state: &HoverState) {
        state.over_icon.store(false, Ordering::Release);
        state.generation.fetch_add(1, Ordering::AcqRel);
    }
    #[test]
    fn the_icon_of_an_open_popup_keeps_it_open_and_shows_it_only_once() {
        let state = HoverState::default();
        let first = state.entered().expect("a closed popup is shown after the delay");
        assert!(state.ready(first, HOVER_DELAY));
        assert!(state.opening(), "the first show opens the popup");
        // The pointer goes up to the popup, then back down to the icon.
        pointer_leaves(&state);
        let planned_close = state.generation.load(Ordering::Acquire);
        assert_eq!(state.entered(), None, "no second show is scheduled");
        assert_ne!(state.generation.load(Ordering::Acquire), planned_close, "the close the leave planned is cancelled");
        // A show that still arrives, from the command or an older hover, does nothing.
        assert!(!state.ready(first, Duration::from_secs(1)));
        assert!(!state.opening(), "no second show and no second tray://open");
        assert_eq!(state.opened.load(Ordering::Acquire), 1);
        // Moving over the icon while it is open schedules nothing either.
        assert_eq!(state.entered(), None);
    }
    #[test]
    fn a_closed_popup_opens_again_on_the_next_hover() {
        let state = HoverState::default();
        assert!(state.opening());
        state.closed();
        let next = state.entered().expect("a hover over a closed popup opens it");
        assert!(state.ready(next, HOVER_DELAY));
        assert!(state.opening());
        assert_eq!(state.opened.load(Ordering::Acquire), 2);
    }
    #[test]
    fn a_popup_closed_before_any_leave_still_opens_on_the_next_hover() {
        let state = HoverState::default();
        let first = state.entered().expect("a closed popup is shown after the delay");
        assert!(state.ready(first, HOVER_DELAY));
        assert!(state.opening());
        // tray-icon never reports the pointer leaving; the popup's own button closes it.
        state.closed();
        let next = state.entered().expect("the pointer still counted over the icon must not block the next hover");
        assert!(state.ready(next, HOVER_DELAY));
        // Further Moves over the icon while that show waits schedule nothing more.
        assert_eq!(state.entered(), None);
    }
    #[test]
    fn the_pointer_keeps_the_popup_open_on_its_way_between_icon_and_popup() {
        // A 24 px icon on a bottom taskbar, the popup 12 px above it.
        let icon = (1800.0, 1044.0, 1824.0, 1068.0);
        let popup = (1622.0, 572.0, 2002.0, 1032.0);
        assert!(keeps_open((1700.0, 700.0), popup, Some(icon)), "over the popup");
        assert!(keeps_open((1812.0, 1038.0), popup, Some(icon)), "in the gap above the icon");
        assert!(keeps_open((1812.0, 1050.0), popup, Some(icon)), "over the icon");
        assert!(!keeps_open((1700.0, 1038.0), popup, Some(icon)), "in the gap but beside the icon");
        assert!(!keeps_open((1850.0, 1050.0), popup, Some(icon)), "on the taskbar beside the icon");
        assert!(!keeps_open((1812.0, 1038.0), popup, None), "with no icon, the popup alone counts");
        // A taskbar at the top puts the popup below the icon.
        let icon = (1800.0, 12.0, 1824.0, 36.0);
        let popup = (1622.0, 60.0, 2002.0, 520.0);
        assert!(keeps_open((1812.0, 48.0), popup, Some(icon)));
        assert!(!keeps_open((1812.0, 540.0), popup, Some(icon)));
    }
    #[test]
    fn the_popup_closes_only_after_the_pointer_stays_away() {
        let away = AtomicU8::new(0);
        assert!(!away_long_enough(&away, false), "one sample away is a corner cut");
        assert!(!away_long_enough(&away, true), "back over the popup resets the count");
        assert!(!away_long_enough(&away, false));
        assert!(away_long_enough(&away, false), "two samples in a row close it");
        let state = HoverState::default();
        assert!(state.opening());
        let opened = state.opened.load(Ordering::Acquire);
        assert!(state.watching(opened));
        state.closed();
        assert!(!state.watching(opened), "a closed popup stops its watch");
        assert!(state.opening());
        assert!(!state.watching(opened), "a reopened popup has a watch of its own");
    }
    #[test]
    fn the_page_learns_whether_windows_draws_its_frame() {
        assert_eq!(page_url(true), "index.html?view=quotas&frame=native");
        assert_eq!(page_url(false), "index.html?view=quotas");
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
