//! macOS fullscreen transitions, early enough to lay out against.
//!
//! Every fullscreen signal Tauri exposes lands once AppKit has finished
//! animating: `is_fullscreen()` flips at the end, and the single window resize
//! arrives at the end too. That is too late for the titlebar row, which has to
//! reserve room for the traffic lights again *before* they are handed back —
//! and during the animation the webview is frozen, so its repaint lands one or
//! two frames after the lights are already drawn.
//!
//! Two things fix the ordering. `NSWindowWillEnterFullScreen` /
//! `NSWindowWillExitFullScreen` are posted as the transition begins, and are
//! forwarded to the webview as `boite://fullscreen`. And on the way out the
//! lights are hidden here, which makes their return ours to time: the frontend
//! asks for them once it has painted the gap back. During fullscreen itself
//! they are left to macOS, so the titlebar it reveals on hover still carries
//! them — with our own controls gone, that is the only way back out.

/// Show or hide the three window buttons.
#[cfg(target_os = "macos")]
pub fn set_lights_hidden(window: &tauri::WebviewWindow, hidden: bool) {
    use objc2_app_kit::{NSWindow, NSWindowButton};

    let Ok(ptr) = window.ns_window() else { return };
    if ptr.is_null() {
        return;
    }
    let ns: &NSWindow = unsafe { &*(ptr as *const NSWindow) };
    for button in [
        NSWindowButton::CloseButton,
        NSWindowButton::MiniaturizeButton,
        NSWindowButton::ZoomButton,
    ] {
        if let Some(button) = ns.standardWindowButton(button) {
            button.setHidden(hidden);
        }
    }
}

#[cfg(not(target_os = "macos"))]
pub fn set_lights_hidden(_window: &tauri::WebviewWindow, _hidden: bool) {}

#[cfg(target_os = "macos")]
pub fn watch(app: &tauri::AppHandle) {
    use block2::RcBlock;
    use objc2_app_kit::{
        NSWindowWillEnterFullScreenNotification, NSWindowWillExitFullScreenNotification,
    };
    use objc2_foundation::{NSNotification, NSNotificationCenter};
    use tauri::{Emitter, Manager};

    let center = NSNotificationCenter::defaultCenter();

    for (name, entering) in [
        (unsafe { NSWindowWillEnterFullScreenNotification }, true),
        (unsafe { NSWindowWillExitFullScreenNotification }, false),
    ] {
        let handle = app.clone();
        let block = RcBlock::new(move |_: core::ptr::NonNull<NSNotification>| {
            // Left alone while fullscreen: macOS keeps them in the titlebar it
            // slides in on hover, which is the only way back out of fullscreen
            // once our own controls are gone. Only the exit is taken over —
            // hidden here, restored by the frontend once the gap is painted.
            if !entering {
                if let Some(window) = handle.get_webview_window("main") {
                    set_lights_hidden(&window, true);
                }
            }
            let _ = handle.emit("boite://fullscreen", entering);
        });
        // Never removed: the observer lives as long as the app, and dropping it
        // would put the frontend back on the late signal.
        unsafe {
            let _ =
                center.addObserverForName_object_queue_usingBlock(Some(name), None, None, &block);
        }
        core::mem::forget(block);
    }
}

#[cfg(not(target_os = "macos"))]
pub fn watch(_app: &tauri::AppHandle) {}
