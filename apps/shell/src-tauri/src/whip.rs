//! The Whip experiment moves the native window and returns it to its origin.

use std::sync::{atomic::{AtomicBool, Ordering}, Arc};
use std::time::Duration;
use tauri::{Manager, PhysicalPosition, State, Webview, WebviewWindow};

#[derive(Default)]
pub(crate) struct WhipState(Arc<AtomicBool>);

struct Restore {
    window: WebviewWindow,
    origin: PhysicalPosition<i32>,
    running: Arc<AtomicBool>,
}

impl Drop for Restore {
    fn drop(&mut self) {
        if !self.window.is_maximized().unwrap_or(false) && !self.window.is_fullscreen().unwrap_or(false) {
            if let Err(error) = self.window.set_position(self.origin) {
                eprintln!("[shell] could not restore the window after a whip: {error}");
            }
        }
        self.running.store(false, Ordering::SeqCst);
    }
}

fn shake(origin: PhysicalPosition<i32>, scale: f64,
    mut step: impl FnMut(PhysicalPosition<i32>) -> Result<Option<PhysicalPosition<i32>>, String>,
) -> Result<bool, String> {
    let mut moved = false;
    for (x, y) in [(-12.0, 3.0), (10.0, -3.0), (-8.0, 2.0), (6.0, -2.0), (-4.0, 1.0), (2.0, -1.0), (0.0, 0.0)] {
        let target = PhysicalPosition::new(
            origin.x.saturating_add((x * scale).round() as i32),
            origin.y.saturating_add((y * scale).round() as i32),
        );
        let Some(actual) = step(target)? else { break; };
        moved |= actual != origin;
    }
    Ok(moved)
}

/// Only the main UI can shake its window. Maximized and fullscreen windows
/// keep their geometry; the caller animates its whole interface instead.
#[tauri::command]
pub(crate) async fn whip_window(webview: Webview, state: State<'_, WhipState>) -> Result<bool, String> {
    crate::browser::only_main(&webview)?;
    let window = webview.app_handle().get_webview_window(crate::browser::MAIN_LABEL)
        .ok_or("main window is missing")?;
    if window.is_maximized().map_err(|error| error.to_string())?
        || window.is_fullscreen().map_err(|error| error.to_string())? {
        return Ok(false);
    }
    let origin = window.outer_position().map_err(|error| error.to_string())?;
    let scale = window.scale_factor().map_err(|error| error.to_string())?;
    if state.0.swap(true, Ordering::SeqCst) {
        return Err("a window whip is already running".into());
    }
    let restore = Restore { window, origin, running: state.0.clone() };
    tauri::async_runtime::spawn_blocking(move || {
        let restore = restore;
        shake(origin, scale, |target| {
            // Keep a maximize/fullscreen action made during the hit intact.
            if restore.window.is_maximized().map_err(|error| error.to_string())?
                || restore.window.is_fullscreen().map_err(|error| error.to_string())? {
                return Ok(None);
            }
            restore.window.set_position(target).map_err(|error| error.to_string())?;
            std::thread::sleep(Duration::from_millis(50));
            // Some window managers accept positioning but leave the window in place.
            Ok(Some(restore.window.outer_position().map_err(|error| error.to_string())?))
        })
    }).await.map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepted_positions_without_movement_use_the_interface_fallback() {
        let origin = PhysicalPosition::new(100, 200);
        assert!(!shake(origin, 1.0, |_| Ok(Some(origin))).unwrap());
    }

    #[test]
    fn a_moving_window_keeps_the_native_shake() {
        let origin = PhysicalPosition::new(100, 200);
        assert!(shake(origin, 1.0, |target| Ok(Some(target))).unwrap());
    }
}
