//! The box `boite window point` shows the user: a transparent, click-through
//! window above every other, whose page (`index.html?view=pointer`) draws the
//! ring and the label with the app's own stylesheet, accent and motion. The
//! core decides where a box goes and when it goes away (`windows.pointer`); the
//! main UI hands each event to `pointer_show` or `pointer_hide`.
//!
//! The window never takes the focus, has no taskbar button and lets every click
//! through to the control under it. A box that goes away leaves its window
//! hidden for the next one: a page is a WebView2 renderer, and building one
//! costs a few hundred milliseconds. A window nobody used for `IDLE_RELEASE`
//! is closed. While a box shows, a thread puts its window back on top every
//! `RAISE_EVERY`, since the taskbar raises itself above topmost windows when
//! it is clicked.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, Runtime, Webview, WebviewUrl, WebviewWindow};

pub const LABEL_PREFIX: &str = "pointer-";
/// Room around the control for the ring's glow and its pulse, in CSS pixels.
const MARGIN: f64 = 28.0;
/// Room above or below the box for the label, in CSS pixels.
const LABEL_ROOM: f64 = 40.0;
/// The narrowest window, so a short control still has room for a long label.
const MIN_WIDTH: f64 = 420.0;
const RAISE_EVERY: Duration = Duration::from_millis(250);
const IDLE_RELEASE: Duration = Duration::from_secs(45);

/// A control on the screen, in physical pixels, as the core sends it.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq)]
pub struct ScreenRect {
    pub left: i32,
    pub top: i32,
    pub width: i32,
    pub height: i32,
}

/// What the page draws, in its own CSS pixels.
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Layout {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub label: String,
    /// The label goes under the box: there was no room above it on the monitor.
    pub below: bool,
}

/// Where the window goes in physical pixels, and the box inside it. `scale`
/// is the monitor's, `monitor` its whole area `(left, top, right, bottom)`.
pub fn place(rect: ScreenRect, label: &str, scale: f64, monitor: (i32, i32, i32, i32)) -> ((i32, i32, u32, u32), Layout) {
    let scale = if scale.is_finite() && scale > 0.0 { scale } else { 1.0 };
    let px = |css: f64| (css * scale).round() as i32;
    let width = (rect.width + 2 * px(MARGIN)).max(px(MIN_WIDTH));
    let height = rect.height + 2 * px(MARGIN) + px(LABEL_ROOM);
    let below = rect.top - px(MARGIN) - px(LABEL_ROOM) < monitor.1;
    let top = if below { rect.top - px(MARGIN) } else { rect.top - px(MARGIN) - px(LABEL_ROOM) };
    // The window stays on the monitor sideways, so a label near the right edge is not cut.
    let left = (rect.left - px(MARGIN)).min(monitor.2 - width).max(monitor.0);
    let layout = Layout {
        x: f64::from(rect.left - left) / scale,
        y: f64::from(rect.top - top) / scale,
        width: f64::from(rect.width) / scale,
        height: f64::from(rect.height) / scale,
        label: label.to_owned(),
        below,
    };
    ((left, top, width.max(1) as u32, height.max(1) as u32), layout)
}

/// The boxes shown and the windows kept for the next ones.
#[derive(Default)]
pub struct PointerState {
    inner: Mutex<Windows>,
    built: AtomicU64,
    raising: AtomicU64,
}

#[derive(Default)]
struct Windows {
    /// Box id to the label of the window showing it.
    shown: HashMap<String, String>,
    /// What each window's page draws, by label.
    layouts: HashMap<String, Layout>,
    /// Hidden windows and since when.
    spare: Vec<(String, Instant)>,
}

/// Only the main UI relays the core's boxes.
fn only_main(webview: &Webview) -> Result<(), String> { crate::browser::only_main(webview) }

fn build<R: Runtime>(app: &AppHandle<R>, label: &str) -> tauri::Result<WebviewWindow<R>> {
    let mut builder = tauri::WebviewWindowBuilder::new(app, label, WebviewUrl::App("index.html?view=pointer".into()))
        .title("Boite pointer").decorations(false).transparent(true).shadow(false)
        .skip_taskbar(true).always_on_top(true).resizable(false)
        .visible(false).focused(false).focusable(false)
        .background_color(tauri::window::Color(0, 0, 0, 0))
        .on_navigation(|url| matches!(url.scheme(), "tauri" | "http" | "https") && matches!(url.host_str(), Some("tauri.localhost") | Some("localhost")));
    if let Some(profile) = crate::window::webview_profile() { builder = builder.data_directory(profile); }
    builder = builder.additional_browser_args(&crate::window::browser_args());
    let window = builder.build()?;
    window.set_ignore_cursor_events(true)?;
    #[cfg(windows)]
    if let Ok(hwnd) = window.hwnd() {
        if let Err(error) = crate::platform::overlay::never_activate(hwnd.0) { eprintln!("[shell] the pointer window may take the focus: {error}"); }
    }
    Ok(window)
}

fn monitor_of<R: Runtime>(app: &AppHandle<R>, rect: ScreenRect) -> (f64, (i32, i32, i32, i32)) {
    let x = f64::from(rect.left + rect.width / 2);
    let y = f64::from(rect.top + rect.height / 2);
    match app.monitor_from_point(x, y).ok().flatten().or_else(|| app.primary_monitor().ok().flatten()) {
        Some(monitor) => {
            let at = monitor.position();
            let size = monitor.size();
            (monitor.scale_factor(), (at.x, at.y, at.x + size.width as i32, at.y + size.height as i32))
        }
        None => (1.0, (i32::MIN / 2, i32::MIN / 2, i32::MAX / 2, i32::MAX / 2)),
    }
}

/// Draws the box `id` around `rect`, or moves it there.
#[tauri::command]
pub fn pointer_show(app: AppHandle, webview: Webview, id: String, rect: ScreenRect, label: String) -> Result<(), String> {
    only_main(&webview)?;
    if id.is_empty() || id.len() > 64 { return Err("pointer id must be 1 to 64 characters".into()); }
    if rect.width <= 0 || rect.height <= 0 || rect.width > 32768 || rect.height > 32768 {
        return Err(format!("pointer rect must have a width and height from 1 to 32768, not {}x{}", rect.width, rect.height));
    }
    let label: String = label.chars().filter(|c| !c.is_control()).take(80).collect();
    let state = app.state::<PointerState>();
    let window_label = {
        let mut windows = state.inner.lock().map_err(|_| "the pointer state is poisoned")?;
        match windows.shown.get(&id) {
            Some(existing) => existing.clone(),
            None => {
                let reused = windows.spare.pop().map(|(label, _)| label).filter(|label| app.get_webview_window(label).is_some());
                let label = reused.unwrap_or_else(|| format!("{LABEL_PREFIX}{}", state.built.fetch_add(1, Ordering::AcqRel) + 1));
                windows.shown.insert(id.clone(), label.clone());
                label
            }
        }
    };
    let window = match app.get_webview_window(&window_label) {
        Some(window) => window,
        None => build(&app, &window_label).map_err(|error| format!("the pointer window could not be built: {error}"))?,
    };
    let (scale, monitor) = monitor_of(&app, rect);
    let ((x, y, width, height), layout) = place(rect, &label, scale, monitor);
    window.set_position(PhysicalPosition::new(x, y)).map_err(|error| error.to_string())?;
    window.set_size(PhysicalSize::new(width, height)).map_err(|error| error.to_string())?;
    if let Ok(mut windows) = state.inner.lock() { windows.layouts.insert(window_label.clone(), layout.clone()); }
    // A page still loading reads its layout with `pointer_layout` once it runs.
    let _ = app.emit_to(window_label.as_str(), "pointer://layout", layout);
    window.show().map_err(|error| error.to_string())?;
    #[cfg(windows)]
    if let Ok(hwnd) = window.hwnd() { crate::platform::overlay::raise(hwnd.0); }
    keep_on_top(&app);
    Ok(())
}

/// Takes the box `id` away; its window waits hidden for the next one.
#[tauri::command]
pub fn pointer_hide(app: AppHandle, webview: Webview, id: String) -> Result<(), String> {
    only_main(&webview)?;
    let state = app.state::<PointerState>();
    let label = {
        let mut windows = state.inner.lock().map_err(|_| "the pointer state is poisoned")?;
        let Some(label) = windows.shown.remove(&id) else { return Ok(()) };
        windows.layouts.remove(&label);
        windows.spare.push((label.clone(), Instant::now()));
        label
    };
    if let Some(window) = app.get_webview_window(&label) {
        let _ = app.emit_to(label.as_str(), "pointer://hide", ());
        window.hide().map_err(|error| error.to_string())?;
    }
    release_later(&app);
    Ok(())
}

/// The layout of the calling pointer page, or null while it shows no box.
#[tauri::command]
pub fn pointer_layout(app: AppHandle, webview: Webview) -> Result<Option<Layout>, String> {
    if !webview.label().starts_with(LABEL_PREFIX) { return Err("only a pointer window may read its layout".into()); }
    let windows = app.state::<PointerState>().inner.lock().map_err(|_| "the pointer state is poisoned")?.layouts.get(webview.label()).cloned();
    Ok(windows)
}

/// One thread while any box shows: back on top of the taskbar every `RAISE_EVERY`.
fn keep_on_top<R: Runtime>(app: &AppHandle<R>) {
    let state = app.state::<PointerState>();
    if state.raising.swap(1, Ordering::AcqRel) == 1 { return; }
    let handle = app.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(RAISE_EVERY);
        let labels: Vec<String> = match handle.state::<PointerState>().inner.lock() {
            Ok(windows) => windows.shown.values().cloned().collect(),
            Err(_) => Vec::new(),
        };
        if labels.is_empty() {
            handle.state::<PointerState>().raising.store(0, Ordering::Release);
            break;
        }
        #[cfg(windows)]
        {
            let app = handle.clone();
            let _ = handle.run_on_main_thread(move || {
                for label in labels {
                    if let Some(hwnd) = app.get_webview_window(&label).and_then(|window| window.hwnd().ok()) { crate::platform::overlay::raise(hwnd.0); }
                }
            });
        }
        #[cfg(not(windows))]
        drop(labels);
    });
}

/// Closes the spare windows nobody used for `IDLE_RELEASE`.
fn release_later<R: Runtime>(app: &AppHandle<R>) {
    let handle = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(IDLE_RELEASE + Duration::from_millis(100));
        let stale: Vec<String> = match handle.state::<PointerState>().inner.lock() {
            Ok(mut windows) => {
                let (stale, kept): (Vec<_>, Vec<_>) = windows.spare.drain(..).partition(|(_, since)| since.elapsed() >= IDLE_RELEASE);
                windows.spare = kept;
                stale.into_iter().map(|(label, _)| label).collect()
            }
            Err(_) => Vec::new(),
        };
        if stale.is_empty() { return; }
        let app = handle.clone();
        let _ = handle.run_on_main_thread(move || {
            for label in stale {
                if let Some(window) = app.get_webview_window(&label) { let _ = window.close(); }
            }
        });
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    const FULL_HD: (i32, i32, i32, i32) = (0, 0, 1920, 1080);

    #[test]
    fn the_label_goes_above_the_box_where_there_is_room() {
        let ((x, y, width, height), layout) = place(ScreenRect { left: 400, top: 300, width: 100, height: 30 }, "Click Build", 1.0, FULL_HD);
        assert_eq!((x, y, width, height), (372, 232, 420, 126));
        assert_eq!(layout, Layout { x: 28.0, y: 68.0, width: 100.0, height: 30.0, label: "Click Build".into(), below: false });
    }

    #[test]
    fn a_box_at_the_top_of_the_monitor_puts_its_label_below() {
        let (_, layout) = place(ScreenRect { left: 400, top: 10, width: 100, height: 30 }, "File", 1.0, FULL_HD);
        assert!(layout.below);
        assert_eq!(layout.y, 28.0);
    }

    #[test]
    fn at_150_percent_the_window_is_in_physical_pixels_and_the_box_in_css_pixels() {
        let ((x, y, width, height), layout) = place(ScreenRect { left: 600, top: 600, width: 150, height: 45 }, "", 1.5, (0, 0, 2880, 1620));
        assert_eq!((x, y, width, height), (558, 498, 630, 189));
        assert_eq!((layout.x, layout.y, layout.width, layout.height), (28.0, 68.0, 100.0, 30.0));
    }

    #[test]
    fn the_window_stays_on_the_monitor_near_its_right_edge() {
        let ((x, _, width, _), layout) = place(ScreenRect { left: 1880, top: 1032, width: 40, height: 48 }, "Notifications", 1.0, FULL_HD);
        assert_eq!(x + width as i32, 1920);
        assert_eq!(layout.x, f64::from(1880 - x));
    }

    #[test]
    fn a_monitor_left_of_the_primary_keeps_its_negative_coordinates() {
        let ((x, _, _, _), layout) = place(ScreenRect { left: -1900, top: 400, width: 60, height: 30 }, "Play", 1.0, (-1920, 0, 0, 1080));
        assert_eq!(x, -1920);
        assert_eq!(layout.x, 20.0);
    }
}
