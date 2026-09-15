use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, Runtime, Webview, WebviewUrl};

pub const LABEL: &str = "quotas";
#[derive(Default)]
pub struct HoverState {
    generation: AtomicU64,
    over_icon: AtomicBool,
}

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
    let window = if let Some(window) = app.get_webview_window(LABEL) { window } else {
        let mut builder = tauri::WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("index.html?view=quotas".into()))
            .title("Boite quotas").inner_size(380.0, 460.0).resizable(false)
            .decorations(false).skip_taskbar(true).always_on_top(true)
            .transparent(cfg!(windows))
            .visible(false).focused(false).focusable(false)
            .on_navigation(|url| matches!(url.scheme(), "tauri" | "http" | "https") && matches!(url.host_str(), Some("tauri.localhost") | Some("localhost")));
        if let Some(profile) = crate::webview_profile() { builder = builder.data_directory(profile); }
        builder.build()?
    };
    if let Some(monitor) = window.monitor_from_point(point.x, point.y)? {
        let scale = monitor.scale_factor();
        let origin = monitor.position(); let size = monitor.size();
        let (x, y) = position(point.x, point.y, 380.0 * scale, 460.0 * scale,
            (origin.x as f64, origin.y as f64, origin.x as f64 + size.width as f64, origin.y as f64 + size.height as f64));
        window.set_position(PhysicalPosition::new(x as i32, y as i32))?;
    }
    // Test shells create and render the same page without ever showing a window.
    if !crate::hidden() {
        window.set_focusable(false)?;
        window.show()?;
        // Showing cannot activate the popup; a later deliberate click can.
        window.set_focusable(true)?;
    }
    window.emit("tray://open", ())?;
    Ok(())
}

pub fn enter<R: Runtime>(app: &AppHandle<R>, point: PhysicalPosition<f64>) {
    let state = app.state::<HoverState>();
    state.over_icon.store(true, Ordering::Release);
    state.generation.fetch_add(1, Ordering::AcqRel);
    if let Err(error) = show(app, point) { eprintln!("[shell] quota window: {error}"); }
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
            let Some(window) = handle.get_webview_window(LABEL) else { break; };
            let inside = match (handle.cursor_position(), window.outer_position(), window.outer_size()) {
                (Ok(cursor), Ok(origin), Ok(size)) => cursor.x >= origin.x as f64 && cursor.y >= origin.y as f64
                    && cursor.x < origin.x as f64 + size.width as f64 && cursor.y < origin.y as f64 + size.height as f64,
                _ => false,
            };
            if !inside { let _ = window.hide(); let _ = window.emit("tray://closed", ()); break; }
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
            if let Some(window) = app.get_webview_window(LABEL) { window.hide().map_err(|e| e.to_string())?; window.emit("tray://closed", ()).map_err(|e| e.to_string())?; }
            Ok(())
        }
        "providers" => {
            if let Some(window) = app.get_webview_window(LABEL) { let _ = window.hide(); let _ = window.emit("tray://closed", ()); }
            crate::show_main(&app);
            app.emit_to(crate::browser::MAIN_LABEL, "tray://providers", ()).map_err(|e| e.to_string())
        }
        _ => Err("quota window action must be show, hide or providers".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::position;
    #[test]
    fn popup_stays_on_the_icon_monitor_at_every_edge() {
        for (x,y) in [(-1920.0, 0.0), (-1.0, 0.0), (-1920.0, 1080.0), (-1.0, 1080.0)] {
            let (px,py) = position(x,y,380.0,460.0,(-1920.0,0.0,0.0,1080.0));
            assert!(px >= -1912.0 && px + 380.0 <= -8.0);
            assert!(py >= 8.0 && py + 460.0 <= 1072.0);
        }
    }
}
