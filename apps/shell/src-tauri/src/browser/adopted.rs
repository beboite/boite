//! A window a page of an agent's tab opens becomes an agent surface of its
//! own, which the UI hands to the core's agent browser as a new tab of the
//! same conversation, opened by that tab. WebView2 only gives a popup its
//! `window.opener`, and with it the sign-ins and dialogs that answer the page
//! that asked, when the new-window handler returns a webview of the opener's
//! environment inside a window. So the popup's webview is built as the only
//! child of a hidden window of the same label, which Tauri takes for a
//! `WebviewWindow`, and once WebView2 holds it, it moves into the Boite window
//! and waits off screen like every agent surface (`settle`).

use super::{announce, checked_url, page_events, Event, AGENT_SIZE, BLANK, LABEL_PREFIX, MAIN_LABEL};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, LazyLock, Mutex};
use std::time::Duration;
use tauri::webview::{NewWindowFeatures, WebviewBuilder};
use tauri::window::WindowBuilder;
use tauri::{AppHandle, LogicalSize, Manager, PhysicalPosition, Url, Webview, WebviewUrl, WebviewWindow};

static COUNT: AtomicU64 = AtomicU64::new(0);

/// Popups made but not announced yet, and whether their page already closed
/// them: the UI cannot close a tab it has not heard of, so one that closes
/// itself that early is closed by `settle` instead.
static PENDING: LazyLock<Mutex<HashMap<String, bool>>> = LazyLock::new(Mutex::default);

fn pending() -> std::sync::MutexGuard<'static, HashMap<String, bool>> {
    PENDING.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// A popup's surface id: an agent surface's, which the host's own never
/// collide with, numbered within this shell.
fn popup_id() -> String {
    format!("{}popup-{}-{}", crate::browser_control::AGENT_SURFACE_PREFIX, std::process::id(), COUNT.fetch_add(1, Ordering::Relaxed))
}

/// Builds the webview a page of the agent surface `opener` asked for, in a
/// hidden window WebView2 is handed. Runs in the new-window handler, on the
/// main thread.
pub(super) fn adopt(app: &AppHandle, opener: &str, private: bool, url: &Url, features: &NewWindowFeatures) -> Result<WebviewWindow, String> {
    let id = popup_id();
    let label = format!("{LABEL_PREFIX}{id}");
    let size = LogicalSize::new(AGENT_SIZE.0, AGENT_SIZE.1);
    let window = WindowBuilder::new(app, &label)
        .visible(false)
        .focused(false)
        .skip_taskbar(true)
        .decorations(false)
        .inner_size(size.width, size.height)
        .build()
        .map_err(|error| format!("its window could not be made: {error}"))?;
    let builder = WebviewBuilder::new(&label, WebviewUrl::External(checked_url(&id, BLANK)?))
        .disable_drag_drop_handler()
        .focused(false)
        .with_environment(features.opener().environment.clone())
        .incognito(private);
    let builder = page_events(builder, app, id.clone(), private);
    pending().insert(id.clone(), false);
    let made = window.add_child(builder, PhysicalPosition::new(0, 0), size)
        .map_err(|error| format!("its webview could not be made: {error}"))
        .and_then(|view| crate::platform::browser_page::adopted(&view, super::muted(&label), closed(app, &id)))
        .and_then(|_| app.get_webview_window(&label).ok_or_else(|| "its window holds more than its webview".to_owned()));
    match made {
        Ok(popup) => {
            tauri::async_runtime::spawn(settle(app.clone(), opener.to_owned(), id, url.to_string()));
            Ok(popup)
        }
        Err(error) => {
            pending().remove(&id);
            let _ = window.destroy();
            Err(error)
        }
    }
}

/// What the page's `window.close()` does: the UI closes the tab it knows, or
/// `settle` the popup the UI does not know yet.
fn closed(app: &AppHandle, id: &str) -> impl Fn() + Send + 'static {
    let app = app.clone();
    let id = id.to_owned();
    move || {
        let announced = pending().get_mut(&id).map(|closed| *closed = true).is_none();
        if announced {
            let app = app.clone();
            let id = id.clone();
            // Off the WebView2 callback this runs in.
            tauri::async_runtime::spawn(async move { announce(&app, Event::Closed { id }) });
        }
    }
}

/// Moves the popup into the Boite window, off screen, once WebView2 holds it,
/// then tells the UI. Spawned from the new-window handler: the move is queued
/// to the event loop behind the handler that returns the popup to WebView2.
async fn settle(app: AppHandle, opener: String, id: String, url: String) {
    let label = format!("{LABEL_PREFIX}{id}");
    let (sender, receiver) = mpsc::channel();
    let handle = app.clone();
    let moved = handle.run_on_main_thread({
        let app = app.clone();
        let label = label.clone();
        move || {
            let empty = app.get_window(&label);
            let outcome = (|| -> Result<Webview, String> {
                let view = app.get_webview(&label).ok_or("its webview closed before it moved")?;
                let main = app.get_window(MAIN_LABEL).ok_or("the Boite window is gone")?;
                view.reparent(&main).map_err(|error| format!("it could not move into the Boite window: {error}"))?;
                view.set_bounds(super::off_screen(AGENT_SIZE.0, AGENT_SIZE.1)).and_then(|_| view.show())
                    .map_err(|error| format!("it could not be placed: {error}"))?;
                Ok(view)
            })();
            // Empty once its webview moved; with the webview in it when it could not.
            if let Some(window) = empty { let _ = window.destroy(); }
            let _ = sender.send(outcome);
        }
    });
    let outcome = match moved {
        Err(error) => Err(error.to_string()),
        Ok(()) => tauri::async_runtime::spawn_blocking(move || receiver.recv_timeout(Duration::from_secs(10)))
            .await
            .map_err(|error| error.to_string())
            .and_then(|received| received.map_err(|_| "it was not moved within 10 seconds".to_owned()))
            .and_then(|outcome| outcome),
    };
    let outcome = match outcome {
        Ok(view) => crate::platform::browser_diagnostics::attach(view, id.clone()).await,
        Err(error) => Err(error),
    };
    // Held until the UI is told: a `window.close()` in between would otherwise be announced before the popup.
    let mut waiting = pending();
    let closed = waiting.remove(&id).unwrap_or(true);
    match outcome {
        Ok(()) if !closed => announce(&app, Event::Popup { id: opener, popup: id, url }),
        outcome => {
            drop(waiting);
            if let Err(error) = outcome {
                eprintln!("[shell] the window agent surface {opener} opened for {url} is closed: {error}");
            }
            crate::platform::browser_diagnostics::remove(&id);
            super::surfaces().forget(&label);
            if let Some(view) = app.get_webview(&label) { let _ = view.close(); }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::popup_id;

    /// The host relays protocol calls and events only for surfaces whose id
    /// says they are an agent's, and a popup is one.
    #[test]
    fn a_popup_is_an_agent_surface_with_an_id_of_its_own() {
        let (first, second) = (popup_id(), popup_id());
        assert_ne!(first, second);
        for id in [&first, &second] {
            assert!(crate::browser_control::is_agent_surface(id), "{id}");
            assert!(super::super::label_of(id).is_ok(), "{id}");
        }
    }
}
