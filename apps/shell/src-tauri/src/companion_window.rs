//! The desktop companion experiment: a small transparent window that stays in
//! front of every other one, at the top of the screen the user picked. Clicks
//! go through it everywhere except over the areas its page announces, so it
//! never blocks what is underneath. The main UI opens and closes it as the
//! experiment is switched; the page itself places it and reads the media.

use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, LogicalSize, Manager, Monitor, PhysicalPosition, Runtime, State, Webview, WebviewUrl, WebviewWindow};

pub const LABEL: &str = "companion";
/// Room for the character, the reply under it and the panel. Clicks pass
/// through whatever of it is empty.
const WIDTH: f64 = 440.0;
const HEIGHT: f64 = 600.0;
/// How often the pointer is read to decide whether clicks go through.
const WATCH_EVERY: Duration = Duration::from_millis(40);
/// Space kept between the window and a side of the screen, in logical pixels.
const SIDE_MARGIN: f64 = 16.0;

/// One clickable area of the page, in CSS pixels from the window's top left.
#[derive(Deserialize, Clone, Copy, Debug, PartialEq)]
pub struct HitRect { x: f64, y: f64, w: f64, h: f64 }

#[derive(Default)]
pub struct CompanionState {
    rects: Arc<Mutex<Vec<HitRect>>>,
    /// Bumped by every opening, so the pointer watch of a closed window stops
    /// even when another window opened since.
    generation: Arc<AtomicU64>,
}

/// Where on the screen the companion sits: the top edge, at one of three places.
#[derive(Deserialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Anchor { Left, Center, Right }

/// A screen the settings can offer, `name` being what the placement asks for.
#[derive(Serialize, Debug, PartialEq)]
pub struct MonitorInfo { name: String, primary: bool, width: u32, height: u32 }

pub fn only_companion(webview: &Webview) -> Result<(), String> {
    if webview.label() == LABEL { return Ok(()); }
    Err(format!("the webview {:?} may not invoke this command: only the companion, in the {LABEL:?} webview, can", webview.label()))
}

/// The main UI or the companion: the two pages that list screens.
fn main_or_companion(webview: &Webview) -> Result<(), String> {
    crate::browser::only_main(webview).or_else(|_| only_companion(webview))
}

fn inside(rects: &[HitRect], x: f64, y: f64) -> bool {
    rects.iter().any(|rect| x >= rect.x && x <= rect.x + rect.w && y >= rect.y && y <= rect.y + rect.h)
}

/// The window's top left on a work area `(x, y, width, height)`, physical
/// pixels: against the top edge, centered or `margin` from a side.
fn origin(area: (i32, i32, u32, u32), width: u32, anchor: Anchor, margin: i32) -> (i32, i32) {
    let (left, top, area_width, _) = area;
    let free = area_width as i32 - width as i32;
    let x = match anchor {
        Anchor::Left => left + margin.min(free.max(0)),
        Anchor::Center => left + free / 2,
        Anchor::Right => left + (free - margin).max(0),
    };
    (x, top)
}

fn monitor_name(monitor: &Monitor) -> String { monitor.name().cloned().unwrap_or_default() }

/// The screen named `name`, the primary one when it is gone or none is named.
fn pick_monitor<R: Runtime>(window: &WebviewWindow<R>, name: Option<&str>) -> tauri::Result<Option<Monitor>> {
    if let Some(name) = name {
        if let Some(found) = window.available_monitors()?.into_iter().find(|monitor| monitor_name(monitor) == name) {
            return Ok(Some(found));
        }
    }
    Ok(window.primary_monitor()?.or(window.current_monitor()?))
}

fn place<R: Runtime>(window: &WebviewWindow<R>, monitor: Option<&str>, anchor: Anchor) -> tauri::Result<()> {
    let Some(monitor) = pick_monitor(window, monitor)? else { return Ok(()) };
    let work = monitor.work_area();
    // Onto the screen first: a screen of another scale resizes the window as it arrives.
    window.set_position(PhysicalPosition::new(work.position.x, work.position.y))?;
    window.set_size(LogicalSize::new(WIDTH, HEIGHT))?;
    let width = window.outer_size()?.width;
    let margin = (SIDE_MARGIN * monitor.scale_factor()).round() as i32;
    let (x, y) = origin((work.position.x, work.position.y, work.size.width, work.size.height), width, anchor, margin);
    window.set_position(PhysicalPosition::new(x, y))
}

fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<WebviewWindow<R>> {
    let mut builder = tauri::WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("index.html?view=companion".into()))
        .title("Boite companion").inner_size(WIDTH, HEIGHT).resizable(false)
        .decorations(false).shadow(false).skip_taskbar(true).always_on_top(true)
        .visible(false).focused(false)
        .initialization_script(crate::platform::region::script())
        .on_navigation(|url| matches!(url.scheme(), "tauri" | "http" | "https") && matches!(url.host_str(), Some("tauri.localhost") | Some("localhost")));
    // A transparent window needs Tauri's private API on macOS, which the shell
    // does not enable: there the companion keeps the page's ground.
    #[cfg(not(target_os = "macos"))]
    { builder = builder.transparent(true); }
    if let Some(profile) = crate::window::webview_profile() { builder = builder.data_directory(profile); }
    if let Some(args) = crate::window::test_browser_args() { builder = builder.additional_browser_args(&args); }
    builder.build()
}

/// Reads the pointer and lets clicks through the window unless it is over one
/// of the page's areas. The page hears `companion://hover` when that changes:
/// it cannot see the pointer leave a window that has just stopped taking it.
fn watch<R: Runtime>(app: AppHandle<R>, rects: Arc<Mutex<Vec<HitRect>>>, generation: Arc<AtomicU64>, mine: u64) {
    std::thread::spawn(move || {
        let mut ignoring: Option<bool> = None;
        loop {
            std::thread::sleep(WATCH_EVERY);
            if generation.load(Ordering::Acquire) != mine { break; }
            let Some(window) = app.get_webview_window(LABEL) else { break };
            let (Ok(cursor), Ok(origin), Ok(scale)) = (window.cursor_position(), window.inner_position(), window.scale_factor()) else { continue };
            let x = (cursor.x - origin.x as f64) / scale;
            let y = (cursor.y - origin.y as f64) / scale;
            let over = inside(&rects.lock().unwrap_or_else(std::sync::PoisonError::into_inner), x, y);
            if ignoring == Some(!over) { continue; }
            ignoring = Some(!over);
            if let Err(error) = window.set_ignore_cursor_events(!over) { eprintln!("[shell] companion click-through: {error}"); }
            let _ = window.emit("companion://hover", over);
        }
    });
}

fn open<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    if app.get_webview_window(LABEL).is_some() { return Ok(()); }
    let state = app.state::<CompanionState>();
    state.rects.lock().unwrap_or_else(std::sync::PoisonError::into_inner).clear();
    let mine = state.generation.fetch_add(1, Ordering::AcqRel) + 1;
    let window = build(app)?;
    place(&window, None, Anchor::Center)?;
    // A test shell renders the page without ever putting it on the screen.
    if crate::window::hidden() { return Ok(()); }
    window.show()?;
    // A window built hidden loses `always_on_top` on Windows: set it once shown.
    window.set_always_on_top(true)?;
    window.set_ignore_cursor_events(true)?;
    watch(app.clone(), state.rects.clone(), state.generation.clone(), mine);
    Ok(())
}

fn close<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    app.state::<CompanionState>().generation.fetch_add(1, Ordering::AcqRel);
    match app.get_webview_window(LABEL) { Some(window) => window.destroy(), None => Ok(()) }
}

/// The main UI follows the experiment's switch: `open` or `close`.
#[tauri::command]
pub async fn companion_window(app: AppHandle, webview: Webview, action: String) -> Result<(), String> {
    crate::browser::only_main(&webview)?;
    match action.as_str() {
        "open" => open(&app).map_err(|error| error.to_string()),
        "close" => close(&app).map_err(|error| error.to_string()),
        _ => Err(format!("companion window action must be open or close, not {action:?}")),
    }
}

/// The screens connected now, for the setting that picks one.
#[tauri::command]
pub async fn companion_monitors(app: AppHandle, webview: Webview) -> Result<Vec<MonitorInfo>, String> {
    main_or_companion(&webview)?;
    let primary = app.primary_monitor().map_err(|error| error.to_string())?.map(|monitor| monitor_name(&monitor));
    Ok(app.available_monitors().map_err(|error| error.to_string())?.into_iter().map(|monitor| {
        let name = monitor_name(&monitor);
        MonitorInfo { primary: primary.as_deref() == Some(name.as_str()), width: monitor.size().width, height: monitor.size().height, name }
    }).collect())
}

/// Moves the companion to the screen named `monitor` (the primary one when
/// null or gone), against its top edge at `anchor`.
#[tauri::command]
pub async fn companion_place(app: AppHandle, webview: Webview, monitor: Option<String>, anchor: Anchor) -> Result<(), String> {
    only_companion(&webview)?;
    let window = app.get_webview_window(LABEL).ok_or("the companion window is closed")?;
    place(&window, monitor.as_deref(), anchor).map_err(|error| error.to_string())
}

/// The areas that take clicks, whole, each time the page's layout changes.
#[tauri::command]
pub fn companion_hit_rects(webview: Webview, state: State<'_, CompanionState>, rects: Vec<HitRect>) -> Result<(), String> {
    only_companion(&webview)?;
    *state.rects.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = rects;
    Ok(())
}

#[tauri::command]
pub async fn companion_media(webview: Webview) -> Result<Option<crate::platform::media::MediaState>, String> {
    only_companion(&webview)?;
    tauri::async_runtime::spawn_blocking(crate::platform::media::media_state).await.map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn companion_media_control(webview: Webview, action: String) -> Result<(), String> {
    only_companion(&webview)?;
    let action = crate::platform::media::MediaAction::parse(&action)?;
    tauri::async_runtime::spawn_blocking(move || crate::platform::media::media_control(action)).await.map_err(|error| error.to_string())?
}

/// Brings the main window forward on the companion's settings, or on the
/// thread `thread_id` (the same event a notification click sends).
#[tauri::command]
pub async fn companion_show_main(app: AppHandle, webview: Webview, thread_id: Option<String>) -> Result<(), String> {
    only_companion(&webview)?;
    crate::window::show_main(&app);
    let sent = match thread_id {
        Some(thread) => app.emit_to(crate::browser::MAIN_LABEL, "notification://open", thread),
        None => app.emit_to(crate::browser::MAIN_LABEL, "companion://settings", ()),
    };
    sent.map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clicks_are_taken_only_over_announced_areas() {
        let rects = [HitRect { x: 180.0, y: 4.0, w: 80.0, h: 80.0 }, HitRect { x: 40.0, y: 120.0, w: 360.0, h: 200.0 }];
        assert!(inside(&rects, 220.0, 40.0), "over the character");
        assert!(inside(&rects, 40.0, 320.0), "on the panel's edge");
        assert!(!inside(&rects, 20.0, 40.0), "beside the character");
        assert!(!inside(&[], 220.0, 40.0), "a page that announced nothing takes no click");
    }

    #[test]
    fn the_window_sits_on_the_top_edge_of_the_chosen_side() {
        let area = (0, 0, 1920, 1040);
        assert_eq!(origin(area, 440, Anchor::Center, 16), (740, 0));
        assert_eq!(origin(area, 440, Anchor::Left, 16), (16, 0));
        assert_eq!(origin(area, 440, Anchor::Right, 16), (1464, 0));
        // A screen left of the primary one, under a taskbar at its top.
        assert_eq!(origin((-2560, 48, 2560, 1392), 880, Anchor::Center, 32), (-1720, 48));
        assert_eq!(origin((-2560, 48, 2560, 1392), 880, Anchor::Right, 32), (-912, 48));
    }

    #[test]
    fn a_screen_narrower_than_the_window_keeps_it_on_its_left_edge() {
        assert_eq!(origin((100, 0, 300, 800), 440, Anchor::Left, 16), (100, 0));
        assert_eq!(origin((100, 0, 300, 800), 440, Anchor::Right, 16), (100, 0));
    }
}
