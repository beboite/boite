//! The desktop companion experiment: a small transparent window that stays in
//! front of every other one, on the screen and at the place the user picked.
//! Clicks go through it everywhere except over the areas its page announces,
//! so it never blocks what is underneath. The main UI opens and closes it as
//! the experiment is switched; the page itself places it, reads the media and
//! hears what the pointer, the keyboard and the app in front are doing.

use crate::platform::desktop;
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, LogicalSize, Manager, Monitor, PhysicalPosition, Runtime, State, Webview, WebviewUrl, WebviewWindow};

pub const LABEL: &str = "companion";
/// Room for the character, the reply beside it and the panel. Clicks pass
/// through whatever of it is empty.
const WIDTH: f64 = 440.0;
const HEIGHT: f64 = 600.0;
/// How often the pointer is read to decide whether clicks go through.
const WATCH_EVERY: Duration = Duration::from_millis(40);
/// 25 × 40 ms: the window is lifted back on top once a second.
const RAISE_EVERY_TICKS: u32 = 25;
/// 12 × 40 ms: about twice a second, whether a full-screen app came in front.
const SCREEN_EVERY_TICKS: u32 = 12;
/// Every tenth of those reads, about every 5 s, the app in front is told again.
const FRONT_AGAIN_SCREENS: u32 = 10;
/// Space kept between the window and a side of the screen, in logical pixels.
const SIDE_MARGIN: f64 = 16.0;
/// Where the page draws the character's centre, in logical pixels: this far
/// from the side it is aligned on, from the top on the top edge, from the
/// bottom on the bottom edge. `CompanionApp.svelte` lays it out the same way.
const CHARACTER_SIDE: f64 = 48.0;
const CHARACTER_TOP: f64 = 56.0;
const CHARACTER_BOTTOM: f64 = 44.0;
/// Input while the pointer stays still reads as typing for this long.
const TYPING_FOR: Duration = Duration::from_millis(1500);
/// No input for five minutes and the user is away.
const AWAY_AFTER_MS: u64 = 5 * 60 * 1000;
/// The longest side of a screen capture: what the model reads at full detail.
const CAPTURE_SIDE: i32 = 1568;
/// Long enough for the screen to be composed again without the companion.
const CAPTURE_SETTLE: Duration = Duration::from_millis(120);

/// One clickable area of the page, in CSS pixels from the window's top left.
#[derive(Deserialize, Clone, Copy, Debug, PartialEq)]
pub struct HitRect { x: f64, y: f64, w: f64, h: f64 }

/// What the pointer watch shares with the commands.
#[derive(Clone, Default)]
struct Shared {
    rects: Arc<Mutex<Vec<HitRect>>>,
    /// Bumped by every opening, so the pointer watch of a closed window stops
    /// even when another window opened since.
    generation: Arc<AtomicU64>,
    /// Settings: step aside while an app fills the screen.
    hide_fullscreen: Arc<AtomicBool>,
    /// Hidden now, for such an app.
    hidden: Arc<AtomicBool>,
    /// The screen the window covers while the user picks a part of it.
    covering: Arc<Mutex<Option<String>>>,
}

#[derive(Default)]
pub struct CompanionState {
    shared: Shared,
    /// The last placement's layout, to find the character after a drag.
    layout: Mutex<Layout>,
    /// The global shortcut while one is set, under the name Settings gave it.
    hotkey: Mutex<Option<(String, desktop::Hotkey)>>,
}

/// Where on the screen the companion sits: the side the character is
/// aligned on, against the top edge unless it was dropped lower.
#[derive(Deserialize, Serialize, Clone, Copy, Debug, PartialEq, Default)]
#[serde(rename_all = "lowercase")]
pub enum Anchor { Left, #[default] Center, Right }

/// The edge of the window the character sits on; the panel opens away from it.
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Default)]
#[serde(rename_all = "lowercase")]
pub enum Edge { #[default] Top, Bottom }

/// How the page lays itself out in the window, so the character lands where
/// it was placed.
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Default)]
pub struct Layout { align: Anchor, edge: Edge }

/// Where the user dropped the character: its centre, in fractions of the
/// screen's work area.
#[derive(Deserialize, Serialize, Clone, Copy, Debug, PartialEq)]
pub struct Spot { x: f64, y: f64 }

/// The screen and the spot a drag ended on, for the page to keep.
#[derive(Serialize, Debug, PartialEq)]
pub struct Dropped { monitor: String, spot: Spot }

/// The pointer, in CSS pixels from the window's top left.
#[derive(Serialize, Clone, Copy)]
struct Pointer { x: f64, y: f64 }

/// A screen the settings can offer, `name` being what the placement asks for.
#[derive(Serialize, Debug, PartialEq)]
pub struct MonitorInfo { name: String, primary: bool, width: u32, height: u32 }

/// `(x, y, width, height)` in physical pixels.
type Area = (i32, i32, u32, u32);

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

/// The window's top left on a work area, physical pixels: against the top
/// edge, centered or `margin` from a side.
fn origin(area: Area, width: u32, anchor: Anchor, margin: i32) -> (i32, i32) {
    let (left, top, area_width, _) = area;
    let free = area_width as i32 - width as i32;
    let x = match anchor {
        Anchor::Left => left + margin.min(free.max(0)),
        Anchor::Center => left + free / 2,
        Anchor::Right => left + (free - margin).max(0),
    };
    (x, top)
}

/// A dropped character keeps to the side and the edge it is nearest to, so
/// the reply and the panel open towards the middle of the screen.
fn spot_layout(spot: Spot) -> Layout {
    let align = if spot.x < 0.25 { Anchor::Left } else if spot.x > 0.75 { Anchor::Right } else { Anchor::Center };
    Layout { align, edge: if spot.y > 0.5 { Edge::Bottom } else { Edge::Top } }
}

/// The character's centre in the window, logical pixels.
fn character_in_window(layout: Layout) -> (f64, f64) {
    let x = match layout.align { Anchor::Left => CHARACTER_SIDE, Anchor::Center => WIDTH / 2.0, Anchor::Right => WIDTH - CHARACTER_SIDE };
    let y = match layout.edge { Edge::Top => CHARACTER_TOP, Edge::Bottom => HEIGHT - CHARACTER_BOTTOM };
    (x, y)
}

/// The window's top left that puts the character's centre, `inset` into the
/// window, on `spot` of the work area, the window kept inside the area.
fn free_origin(area: Area, window: (u32, u32), spot: Spot, inset: (i32, i32)) -> (i32, i32) {
    let along = |start: i32, length: u32, size: u32, fraction: f64, inset: i32| {
        let wanted = start + (fraction.clamp(0.0, 1.0) * f64::from(length)).round() as i32 - inset;
        wanted.min(start + length as i32 - size as i32).max(start)
    };
    (along(area.0, area.2, window.0, spot.x, inset.0), along(area.1, area.3, window.1, spot.y, inset.1))
}

/// Where `point` is on the work area, in fractions of it.
fn spot_at(area: Area, point: (i32, i32)) -> Spot {
    let fraction = |at: i32, start: i32, length: u32| (f64::from(at - start) / f64::from(length.max(1))).clamp(0.0, 1.0);
    Spot { x: fraction(point.0, area.0, area.2), y: fraction(point.1, area.1, area.3) }
}

fn holds(monitor: &Monitor, point: (i32, i32)) -> bool {
    let (position, size) = (monitor.position(), monitor.size());
    point.0 >= position.x && point.1 >= position.y && point.0 < position.x + size.width as i32 && point.1 < position.y + size.height as i32
}

fn work_area(monitor: &Monitor) -> Area {
    let work = monitor.work_area();
    (work.position.x, work.position.y, work.size.width, work.size.height)
}

fn monitor_name(monitor: &Monitor) -> String { monitor.name().cloned().unwrap_or_default() }

/// A whole screen, `(x, y, width, height)` in physical pixels.
fn bounds(monitor: &Monitor) -> (i32, i32, i32, i32) {
    (monitor.position().x, monitor.position().y, monitor.size().width as i32, monitor.size().height as i32)
}

/// `rect`, in CSS pixels from the window's top left, on the screen in physical pixels.
fn on_screen(rect: HitRect, origin: (i32, i32), scale: f64) -> Result<(i32, i32, i32, i32), String> {
    let pixels = |value: f64| (value * scale).round() as i32;
    let (width, height) = (pixels(rect.w), pixels(rect.h));
    if width < 1 || height < 1 { return Err("the area to capture is empty".into()); }
    Ok((origin.0 + pixels(rect.x), origin.1 + pixels(rect.y), width, height))
}

fn monitor_under_pointer<R: Runtime>(window: &WebviewWindow<R>) -> tauri::Result<Option<Monitor>> {
    let cursor = window.cursor_position()?;
    let point = (cursor.x.round() as i32, cursor.y.round() as i32);
    Ok(window.available_monitors()?.into_iter().find(|monitor| holds(monitor, point)).or(window.current_monitor()?))
}

/// The window over the whole of `monitor`, the taskbar included.
fn cover_monitor<R: Runtime>(window: &WebviewWindow<R>, monitor: &Monitor) -> tauri::Result<()> {
    // Onto the screen first: a screen of another scale resizes the window as it arrives.
    window.set_position(*monitor.position())?;
    window.set_size(*monitor.size())?;
    window.set_position(*monitor.position())
}

/// While the window covers a screen, it moves to the screen the pointer went
/// to, once no button is down: a part being dragged over stays where it is.
fn follow_cover<R: Runtime>(window: &WebviewWindow<R>, shared: &Shared) {
    if crate::platform::mouse_down() { return; }
    // Held while the window moves: `companion_cover(false)` waits, so the
    // placement after it is not undone.
    let mut covering = shared.covering.lock().unwrap_or_else(PoisonError::into_inner);
    let Some(covered) = covering.as_deref() else { return };
    let Ok(Some(monitor)) = monitor_under_pointer(window) else { return };
    let name = monitor_name(&monitor);
    if name == covered { return; }
    if let Err(error) = cover_monitor(window, &monitor) {
        eprintln!("[shell] companion cover: {error}");
        return;
    }
    *covering = Some(name);
}

/// The screen named `name`, the primary one when it is gone or none is named.
fn pick_monitor<R: Runtime>(window: &WebviewWindow<R>, name: Option<&str>) -> tauri::Result<Option<Monitor>> {
    if let Some(name) = name {
        if let Some(found) = window.available_monitors()?.into_iter().find(|monitor| monitor_name(monitor) == name) {
            return Ok(Some(found));
        }
    }
    Ok(window.primary_monitor()?.or(window.current_monitor()?))
}

/// Puts the window on the screen named `monitor`: at `spot` when the user
/// dropped the character somewhere, else against the top edge at `anchor`.
fn place<R: Runtime>(window: &WebviewWindow<R>, monitor: Option<&str>, anchor: Anchor, spot: Option<Spot>) -> tauri::Result<Layout> {
    let layout = spot.map_or(Layout { align: anchor, edge: Edge::Top }, spot_layout);
    let Some(monitor) = pick_monitor(window, monitor)? else { return Ok(layout) };
    let area = work_area(&monitor);
    // Onto the screen first: a screen of another scale resizes the window as it arrives.
    window.set_position(PhysicalPosition::new(area.0, area.1))?;
    window.set_size(LogicalSize::new(WIDTH, HEIGHT))?;
    let size = window.outer_size()?;
    let scale = monitor.scale_factor();
    let (x, y) = match spot {
        Some(spot) => {
            let (x, y) = character_in_window(layout);
            free_origin(area, (size.width, size.height), spot, ((x * scale).round() as i32, (y * scale).round() as i32))
        }
        None => origin(area, size.width, anchor, (SIDE_MARGIN * scale).round() as i32),
    };
    window.set_position(PhysicalPosition::new(x, y))?;
    Ok(layout)
}

fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<WebviewWindow<R>> {
    let mut builder = tauri::WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("index.html?view=companion".into()))
        .title("Boite companion").inner_size(WIDTH, HEIGHT).resizable(false)
        .decorations(false).shadow(false).skip_taskbar(true).always_on_top(true)
        .visible(false).focused(false)
        // Files dropped on the companion reach the page as HTML drops, with
        // their contents (`drop.svelte.ts`); Tauri's own handler would take
        // them first and hand over bare paths.
        .disable_drag_drop_handler()
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

/// What the pointer watch remembers from one tick to the next.
#[derive(Default)]
struct Senses {
    ignoring: Option<bool>,
    pressed: bool,
    /// The press held now, if any: true while it began away from the areas and never crossed them.
    press_away: Option<bool>,
    point: Option<(f64, f64)>,
    sent: Option<(f64, f64)>,
    input: Option<u32>,
    typed_at: Option<Instant>,
    typing: bool,
    away: bool,
    fullscreen: bool,
    front: Option<crate::platform::games::FrontApp>,
}

fn distance(a: (f64, f64), b: (f64, f64)) -> f64 { (a.0 - b.0).hypot(a.1 - b.1) }

/// One tick of the button for `companion://outside`: the press held next, and
/// whether a click went to another application. Heard on release, of a press
/// that began away from the areas and never crossed them: a file dragged from
/// the Explorer onto the companion starts with a press elsewhere, and the
/// panel it is dropped on stays open.
fn outside_click(away: Option<bool>, down: bool, over: bool) -> (Option<bool>, bool) {
    match (away, down) {
        (None, true) => (Some(!over), false),
        (Some(away), true) => (Some(away && !over), false),
        (Some(away), false) => (None, away),
        (None, false) => (None, false),
    }
}

impl Senses {
    /// An app filling the screen came in front or left it: the window hides
    /// or comes back, without taking the focus. Only the change counts, so the
    /// shortcut can call the companion over a game until the game is in front
    /// again.
    fn screen<R: Runtime>(&mut self, window: &WebviewWindow<R>, shared: &Shared) {
        let full = shared.hide_fullscreen.load(Ordering::Acquire) && window.current_monitor().ok().flatten().is_some_and(|monitor| {
            let (position, size) = (monitor.position(), monitor.size());
            desktop::fullscreen_in_front(window, (position.x, position.y, position.x + size.width as i32, position.y + size.height as i32))
        });
        if full == self.fullscreen { return; }
        self.fullscreen = full;
        shared.hidden.store(full, Ordering::Release);
        desktop::show_quietly(window, !full);
        if !full { crate::platform::keep_on_top(window); }
        let _ = window.emit("companion://fullscreen", full);
    }

    /// Five minutes without a key or the mouse: away, and the character dozes.
    fn presence<R: Runtime>(&mut self, window: &WebviewWindow<R>) {
        let away = crate::platform::idle_ms().is_some_and(|idle| idle >= AWAY_AFTER_MS);
        if away == self.away { return; }
        self.away = away;
        let _ = window.emit("companion://away", away);
    }

    /// The app in front: its executable's name and whether it is a game, for
    /// the gaming headset; never a window title. This shell in front changes
    /// nothing. Sent when it changes, and with `again` for a page that reloaded.
    fn front<R: Runtime>(&mut self, window: &WebviewWindow<R>, again: bool) {
        let front = crate::platform::games::front_app().or_else(|| self.front.clone());
        if front == self.front && !again { return; }
        self.front = front;
        if let Some(front) = &self.front { let _ = window.emit("companion://foreground", front); }
    }

    /// Clicks go through unless the pointer is over one of the page's areas;
    /// the page hears `companion://hover` when that changes, since it cannot
    /// see the pointer leave a window that has just stopped taking it. A press
    /// elsewhere goes to another application, heard as `companion://outside`
    /// once released (`outside_click`).
    /// The page also hears where the pointer is, for the eyes, and whether the
    /// user is typing: input came while the pointer stayed still and no button
    /// is down. Which key never reaches the shell.
    fn pointer<R: Runtime>(&mut self, window: &WebviewWindow<R>, shared: &Shared, point: (f64, f64), tick: u32) {
        // A covering window takes every click: the user is picking a part of the screen.
        let whole = shared.covering.lock().unwrap_or_else(PoisonError::into_inner).is_some();
        let over = whole || inside(&shared.rects.lock().unwrap_or_else(PoisonError::into_inner), point.0, point.1);
        let down = crate::platform::mouse_down();
        let (press_away, outside) = outside_click(self.press_away, down, over);
        self.press_away = press_away;
        if outside { let _ = window.emit("companion://outside", ()); }
        let input = desktop::last_input();
        if input != self.input {
            let still = self.point.is_some_and(|last| distance(last, point) < 0.5);
            if still && !down && !self.pressed && self.input.is_some() { self.typed_at = Some(Instant::now()); }
            self.input = input;
        }
        let typing = self.typed_at.is_some_and(|at| at.elapsed() < TYPING_FOR);
        if typing != self.typing {
            self.typing = typing;
            let _ = window.emit("companion://typing", typing);
        }
        self.pressed = down;
        self.point = Some(point);
        if tick % 2 == 0 && self.sent.is_none_or(|sent| distance(sent, point) >= 2.0) {
            self.sent = Some(point);
            let _ = window.emit("companion://cursor", Pointer { x: point.0, y: point.1 });
        }
        if self.ignoring == Some(!over) { return; }
        self.ignoring = Some(!over);
        if let Err(error) = window.set_ignore_cursor_events(!over) { eprintln!("[shell] companion click-through: {error}"); }
        let _ = window.emit("companion://hover", over);
    }
}

/// Reads the pointer, the input and the app in front for the page. Every
/// second it also lifts the window back over whatever opened since.
fn watch<R: Runtime>(app: AppHandle<R>, shared: Shared, mine: u64) {
    std::thread::spawn(move || {
        let mut senses = Senses::default();
        let mut tick: u32 = 0;
        loop {
            std::thread::sleep(WATCH_EVERY);
            if shared.generation.load(Ordering::Acquire) != mine { break; }
            let Some(window) = app.get_webview_window(LABEL) else { break };
            tick = tick.wrapping_add(1);
            if tick % SCREEN_EVERY_TICKS == 0 {
                senses.screen(&window, &shared);
                // Read while hidden too: the shortcut can call the companion over a game.
                senses.front(&window, tick % (SCREEN_EVERY_TICKS * FRONT_AGAIN_SCREENS) == 0);
            }
            if shared.hidden.load(Ordering::Acquire) { continue; }
            if tick % RAISE_EVERY_TICKS == 0 {
                crate::platform::keep_on_top(&window);
                senses.presence(&window);
            }
            follow_cover(&window, &shared);
            let (Ok(cursor), Ok(origin), Ok(scale)) = (window.cursor_position(), window.inner_position(), window.scale_factor()) else { continue };
            let point = ((cursor.x - f64::from(origin.x)) / scale, (cursor.y - f64::from(origin.y)) / scale);
            senses.pointer(&window, &shared, point, tick);
        }
    });
}

/// The shortcut: the companion comes forward, over a full-screen app too,
/// and the page opens its question bar.
fn summon<R: Runtime>(app: &AppHandle<R>) {
    let Some(window) = app.get_webview_window(LABEL) else { return };
    app.state::<CompanionState>().shared.hidden.store(false, Ordering::Release);
    let _ = window.show();
    crate::platform::keep_on_top(&window);
    let _ = window.set_focus();
    let _ = window.emit("companion://summon", ());
}

fn open<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    if app.get_webview_window(LABEL).is_some() { return Ok(()); }
    let state = app.state::<CompanionState>();
    state.shared.rects.lock().unwrap_or_else(PoisonError::into_inner).clear();
    *state.shared.covering.lock().unwrap_or_else(PoisonError::into_inner) = None;
    state.shared.hidden.store(false, Ordering::Release);
    let mine = state.shared.generation.fetch_add(1, Ordering::AcqRel) + 1;
    let window = build(app)?;
    *state.layout.lock().unwrap_or_else(PoisonError::into_inner) = place(&window, None, Anchor::Center, None)?;
    // A test shell renders the page without ever putting it on the screen.
    if crate::window::hidden() { return Ok(()); }
    window.show()?;
    // A window built hidden loses `always_on_top` on Windows: lift it once shown.
    crate::platform::keep_on_top(&window);
    window.set_ignore_cursor_events(true)?;
    watch(app.clone(), state.shared.clone(), mine);
    Ok(())
}

fn close<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let state = app.state::<CompanionState>();
    state.shared.generation.fetch_add(1, Ordering::AcqRel);
    state.shared.hidden.store(false, Ordering::Release);
    // Gives the keys back to the other applications.
    state.hotkey.lock().unwrap_or_else(PoisonError::into_inner).take();
    match app.get_webview_window(LABEL) { Some(window) => window.destroy(), None => Ok(()) }
}

fn window_of(app: &AppHandle) -> Result<WebviewWindow, String> {
    app.get_webview_window(LABEL).ok_or_else(|| "the companion window is closed".into())
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
/// null or gone): to `spot` when given, else against its top edge at
/// `anchor`. Answers the layout the page takes so the character lands there.
#[tauri::command]
pub async fn companion_place(app: AppHandle, webview: Webview, monitor: Option<String>, anchor: Anchor, spot: Option<Spot>) -> Result<Layout, String> {
    only_companion(&webview)?;
    let layout = place(&window_of(&app)?, monitor.as_deref(), anchor, spot).map_err(|error| error.to_string())?;
    *app.state::<CompanionState>().layout.lock().unwrap_or_else(PoisonError::into_inner) = layout;
    Ok(layout)
}

/// Carries the window with the button the user is holding on the character,
/// then answers where the character was dropped, or nothing when it did not move.
#[tauri::command]
pub async fn companion_drag(app: AppHandle, webview: Webview) -> Result<Option<Dropped>, String> {
    only_companion(&webview)?;
    let window = window_of(&app)?;
    let before = window.outer_position().map_err(|error| error.to_string())?;
    window.start_dragging().map_err(|error| error.to_string())?;
    tauri::async_runtime::spawn_blocking(|| {
        // The system's move loop takes the button on the window's own thread first.
        std::thread::sleep(Duration::from_millis(50));
        let deadline = Instant::now() + Duration::from_secs(120);
        while crate::platform::mouse_down() && Instant::now() < deadline { std::thread::sleep(Duration::from_millis(16)); }
    }).await.map_err(|error| error.to_string())?;
    let after = window.outer_position().map_err(|error| error.to_string())?;
    if after == before { return Ok(None); }
    let layout = *app.state::<CompanionState>().layout.lock().unwrap_or_else(PoisonError::into_inner);
    let scale = window.scale_factor().map_err(|error| error.to_string())?;
    let (x, y) = character_in_window(layout);
    let centre = (after.x + (x * scale).round() as i32, after.y + (y * scale).round() as i32);
    let monitors = window.available_monitors().map_err(|error| error.to_string())?;
    let monitor = match monitors.into_iter().find(|monitor| holds(monitor, centre)) {
        Some(monitor) => monitor,
        None => window.current_monitor().map_err(|error| error.to_string())?.ok_or("the companion is on no screen")?,
    };
    Ok(Some(Dropped { monitor: monitor_name(&monitor), spot: spot_at(work_area(&monitor), centre) }))
}

/// Settings the page follows: hiding for a full-screen app, and the global
/// shortcut, `None` for none. A shortcut another application holds is an error.
#[tauri::command]
pub async fn companion_configure(app: AppHandle, webview: Webview, state: State<'_, CompanionState>, hide_fullscreen: bool, hotkey: Option<String>) -> Result<(), String> {
    only_companion(&webview)?;
    state.shared.hide_fullscreen.store(hide_fullscreen, Ordering::Release);
    let mut current = state.hotkey.lock().unwrap_or_else(PoisonError::into_inner);
    if current.as_ref().map(|(name, _)| name) == hotkey.as_ref() { return Ok(()); }
    // The old keys go back before new ones are taken.
    *current = None;
    let Some(name) = hotkey else { return Ok(()) };
    let (modifiers, key) = desktop::parse_hotkey(&name)?;
    let caller = app.clone();
    let registered = desktop::Hotkey::register(modifiers, key, move || summon(&caller))?;
    *current = Some((name, registered));
    Ok(())
}

/// A picture of a screen, without the companion: the screen named `monitor`,
/// the one the companion is on when none is named, or `area` of the window, in
/// CSS pixels, while the window covers a screen for the user to pick a part
/// of it. An 8-byte header (width, height, little-endian u32) then top-down
/// BGRA rows.
#[tauri::command]
pub async fn companion_capture(app: AppHandle, webview: Webview, monitor: Option<String>, area: Option<HitRect>) -> Result<tauri::ipc::Response, String> {
    only_companion(&webview)?;
    let window = window_of(&app)?;
    let area = match (area, monitor) {
        (Some(rect), _) => {
            let origin = window.inner_position().map_err(|error| error.to_string())?;
            on_screen(rect, (origin.x, origin.y), window.scale_factor().map_err(|error| error.to_string())?)?
        }
        (None, Some(name)) => {
            let monitors = window.available_monitors().map_err(|error| error.to_string())?;
            bounds(&monitors.into_iter().find(|monitor| monitor_name(monitor) == name).ok_or_else(|| format!("no screen is named {name:?}"))?)
        }
        (None, None) => bounds(&match window.current_monitor().map_err(|error| error.to_string())? {
            Some(monitor) => monitor,
            None => window.primary_monitor().map_err(|error| error.to_string())?.ok_or("no screen to capture")?,
        }),
    };
    let exclude = |excluded: bool| {
        let window = window.clone();
        let _ = app.run_on_main_thread(move || desktop::exclude_from_capture(&window, excluded));
    };
    exclude(true);
    let shot = tauri::async_runtime::spawn_blocking(move || {
        std::thread::sleep(CAPTURE_SETTLE);
        desktop::capture(area, CAPTURE_SIDE)
    }).await;
    exclude(false);
    let (width, height, pixels) = shot.map_err(|error| error.to_string())??;
    let mut bytes = Vec::with_capacity(8 + pixels.len());
    bytes.extend_from_slice(&width.to_le_bytes());
    bytes.extend_from_slice(&height.to_le_bytes());
    bytes.extend_from_slice(&pixels);
    Ok(tauri::ipc::Response::new(bytes))
}

/// While the user picks a part of a screen to show: the window covers the
/// screen under the pointer and takes every click, and follows the pointer
/// to another screen (`follow_cover`). `false` ends it; the page then places
/// the window again, which gives it back its size.
#[tauri::command]
pub async fn companion_cover(app: AppHandle, webview: Webview, state: State<'_, CompanionState>, cover: bool) -> Result<(), String> {
    only_companion(&webview)?;
    let mut covering = state.shared.covering.lock().unwrap_or_else(PoisonError::into_inner);
    if !cover {
        *covering = None;
        return Ok(());
    }
    let window = window_of(&app)?;
    let monitor = monitor_under_pointer(&window).map_err(|error| error.to_string())?.ok_or("no screen to cover")?;
    cover_monitor(&window, &monitor).map_err(|error| error.to_string())?;
    *covering = Some(monitor_name(&monitor));
    // The keyboard too, for Escape.
    let _ = window.set_focus();
    Ok(())
}

/// Files were dropped on the companion: Windows leaves the keyboard where the
/// drag began, and the page wants it for the question that goes with them.
#[tauri::command]
pub fn companion_focus(app: AppHandle, webview: Webview) -> Result<(), String> {
    only_companion(&webview)?;
    window_of(&app)?.set_focus().map_err(|error| error.to_string())
}

/// The folder, in the app's cache, where the files a request carries wait for
/// the agent to open them: the user's own, where a shared temporary folder
/// (Linux's `/tmp`) would let another account read or swap them.
const KEPT_DIR: &str = "boite-companion";
/// Kept files older than this go when the next one is kept.
const KEPT_FOR: Duration = Duration::from_secs(24 * 60 * 60);
static KEPT: AtomicU64 = AtomicU64::new(0);

/// Keeps a file a request carries (a capture, a dropped file) where the
/// companion's agent can open it, and says where: an agent's turn takes paths,
/// not attachments. The body is the file's bytes; the `x-name` header its
/// name, percent-encoded.
#[tauri::command]
pub async fn companion_keep(webview: Webview, request: tauri::ipc::Request<'_>) -> Result<String, String> {
    only_companion(&webview)?;
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("the file comes as raw bytes".into());
    };
    let name = request.headers().get("x-name").and_then(|value| value.to_str().ok()).map(percent_decoded).unwrap_or_default();
    let dir = webview.path().app_cache_dir().map_err(|error| error.to_string())?.join(KEPT_DIR);
    keep_file(&dir, &name, bytes, SystemTime::now()).map(|path| path.to_string_lossy().into_owned()).map_err(|error| error.to_string())
}

fn keep_file(dir: &Path, name: &str, bytes: &[u8], now: SystemTime) -> std::io::Result<PathBuf> {
    std::fs::create_dir_all(dir)?;
    for entry in std::fs::read_dir(dir)?.flatten() {
        let stale = entry.metadata().and_then(|meta| meta.modified()).is_ok_and(|at| now.duration_since(at).unwrap_or_default() > KEPT_FOR);
        if stale {
            let _ = std::fs::remove_file(entry.path());
        }
    }
    let stamp = now.duration_since(UNIX_EPOCH).unwrap_or_default().as_millis();
    let path = dir.join(format!("{stamp}-{}-{}", KEPT.fetch_add(1, Ordering::Relaxed), safe_name(name)));
    std::fs::write(&path, bytes)?;
    Ok(path)
}

/// A file name that stays inside the folder and that every system accepts.
fn safe_name(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or_default();
    let clean: String = base.chars().map(|c| if c.is_alphanumeric() || matches!(c, '.' | '-' | '_' | ' ') { c } else { '_' }).take(80).collect();
    let clean = clean.trim_matches(['.', ' ']);
    if clean.is_empty() { "file".into() } else { clean.into() }
}

fn percent_decoded(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        let hex = (bytes[index] == b'%').then(|| text.get(index + 1..index + 3)).flatten().and_then(|pair| u8::from_str_radix(pair, 16).ok());
        match hex {
            Some(byte) => {
                out.push(byte);
                index += 3;
            }
            None => {
                out.push(bytes[index]);
                index += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// The areas that take clicks, whole, each time the page's layout changes.
#[tauri::command]
pub fn companion_hit_rects(webview: Webview, state: State<'_, CompanionState>, rects: Vec<HitRect>) -> Result<(), String> {
    only_companion(&webview)?;
    *state.shared.rects.lock().unwrap_or_else(PoisonError::into_inner) = rects;
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

/// Brings the main window forward on the companion's settings, on the agent
/// `agent_id` in the Agents page, or on the thread `thread_id` (the same event
/// a notification click sends).
#[tauri::command]
pub async fn companion_show_main(app: AppHandle, webview: Webview, thread_id: Option<String>, agent_id: Option<String>) -> Result<(), String> {
    only_companion(&webview)?;
    crate::window::show_main(&app);
    let sent = match (thread_id, agent_id) {
        (_, Some(agent)) => app.emit_to(crate::browser::MAIN_LABEL, "companion://agent", agent),
        (Some(thread), None) => app.emit_to(crate::browser::MAIN_LABEL, "notification://open", thread),
        (None, None) => app.emit_to(crate::browser::MAIN_LABEL, "companion://settings", ()),
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
    fn kept_files_stay_in_their_folder_under_a_safe_name() {
        assert_eq!(safe_name("..\\..\\Windows\\win.ini"), "win.ini");
        assert_eq!(safe_name("../etc/pass:wd"), "pass_wd");
        assert_eq!(safe_name(".."), "file");
        assert_eq!(safe_name(""), "file");
        assert_eq!(percent_decoded("%C3%A9t%C3%A9 1.png"), "été 1.png");
        assert_eq!(percent_decoded("50%"), "50%");
        let dir = std::env::temp_dir().join(format!("boite-companion-test-{}", std::process::id()));
        let now = SystemTime::now();
        let old = keep_file(&dir, "old.txt", b"old", now - KEPT_FOR - Duration::from_secs(60)).unwrap();
        let file = std::fs::File::options().write(true).open(&old).unwrap();
        file.set_modified(now - KEPT_FOR - Duration::from_secs(60)).unwrap();
        drop(file);
        let kept = keep_file(&dir, "shot.jpg", b"jpeg", now).unwrap();
        assert_eq!(kept.parent(), Some(dir.as_path()));
        assert_eq!(std::fs::read(&kept).unwrap(), b"jpeg");
        assert!(!old.exists(), "a file older than a day goes");
        let _ = std::fs::remove_dir_all(&dir);
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

    #[test]
    fn a_dropped_character_opens_towards_the_middle_of_the_screen() {
        assert_eq!(spot_layout(Spot { x: 0.1, y: 0.2 }), Layout { align: Anchor::Left, edge: Edge::Top });
        assert_eq!(spot_layout(Spot { x: 0.5, y: 0.9 }), Layout { align: Anchor::Center, edge: Edge::Bottom });
        assert_eq!(spot_layout(Spot { x: 0.8, y: 0.5 }), Layout { align: Anchor::Right, edge: Edge::Top });
        assert_eq!(character_in_window(Layout { align: Anchor::Right, edge: Edge::Bottom }), (392.0, 556.0));
    }

    #[test]
    fn the_character_lands_where_it_was_dropped_unless_the_window_would_leave_the_screen() {
        let area = (0, 0, 1920, 1040);
        assert_eq!(free_origin(area, (440, 600), Spot { x: 0.5, y: 0.25 }, (220, 56)), (740, 204));
        assert_eq!(free_origin(area, (440, 600), Spot { x: 0.5, y: 0.9 }, (220, 556)), (740, 380));
        assert_eq!(free_origin(area, (440, 600), Spot { x: 0.0, y: 0.0 }, (48, 56)), (0, 0), "kept on the screen");
        assert_eq!(free_origin(area, (440, 600), Spot { x: 1.0, y: 1.0 }, (392, 556)), (1480, 440));
        // A second screen, on the left, at twice the scale.
        assert_eq!(free_origin((-3840, 0, 3840, 2080), (880, 1200), Spot { x: 0.5, y: 0.25 }, (440, 112)), (-2360, 408));
    }

    #[test]
    fn a_drop_is_read_back_as_the_same_spot() {
        let area = (-3840, 0, 3840, 2080);
        assert_eq!(spot_at(area, (-1920, 520)), Spot { x: 0.5, y: 0.25 });
        assert_eq!(spot_at(area, (100, -5)), Spot { x: 1.0, y: 0.0 }, "kept inside the area");
    }

    #[test]
    fn a_picked_area_is_captured_where_it_is_on_the_screen() {
        // A window covering a 150% screen left of the primary one.
        let rect = HitRect { x: 100.0, y: 40.5, w: 200.0, h: 120.0 };
        assert_eq!(on_screen(rect, (-2560, 0), 1.5), Ok((-2410, 61, 300, 180)));
        assert!(on_screen(HitRect { x: 10.0, y: 10.0, w: 0.2, h: 50.0 }, (0, 0), 1.0).is_err(), "an empty area");
    }

    /// The button's samples, (down, over), through `outside_click`: the ticks a click outside was heard on.
    fn outside_ticks(samples: &[(bool, bool)]) -> Vec<usize> {
        let mut away = None;
        samples.iter().enumerate().filter_map(|(tick, &(down, over))| {
            let (next, outside) = outside_click(away, down, over);
            away = next;
            outside.then_some(tick)
        }).collect()
    }

    #[test]
    fn a_click_elsewhere_is_heard_once_released() {
        assert_eq!(outside_ticks(&[(false, false), (true, false), (true, false), (false, false)]), vec![3]);
        assert_eq!(outside_ticks(&[(true, false), (false, false), (true, false), (false, false)]), vec![1, 3], "each click once");
    }

    #[test]
    fn a_drag_onto_the_companion_is_no_click_elsewhere() {
        // Pressed on a file in the Explorer, carried over the panel, let go there.
        assert!(outside_ticks(&[(true, false), (true, false), (true, true), (false, true)]).is_empty());
        // Carried over the panel and back out before letting go: still not a click elsewhere.
        assert!(outside_ticks(&[(true, false), (true, true), (true, false), (false, false)]).is_empty());
    }

    #[test]
    fn a_press_on_the_companion_is_no_click_elsewhere() {
        assert!(outside_ticks(&[(true, true), (true, false), (false, false)]).is_empty(), "dragging the character away");
        assert!(outside_ticks(&[(false, true), (false, false)]).is_empty(), "no press at all");
    }
}
