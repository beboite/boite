//! Native traffic lights for the 44 point toolbar, including multi-webview windows.
use objc2_app_kit::{NSView, NSWindow, NSWindowButton, NSWindowStyleMask};

/// Called on AppKit's main thread, after the window's native frame is laid out.
pub(crate) fn align_traffic_lights(window: &NSWindow) {
    // Fullscreen has its own sliding title bar. AppKit owns that layout.
    if window.styleMask().contains(NSWindowStyleMask::FullScreen) {
        return;
    }
    let Some(close) = window.standardWindowButton(NSWindowButton::CloseButton) else {
        return;
    };
    let Some(minimize) = window.standardWindowButton(NSWindowButton::MiniaturizeButton) else {
        return;
    };
    // AppKit owns these NSView ancestors; this call runs on the main thread.
    let Some(titlebar) = (unsafe { close.superview() }) else {
        return;
    };
    let Some(container) = (unsafe { titlebar.superview() }) else {
        return;
    };
    let spacing = NSView::frame(&minimize).origin.x - NSView::frame(&close).origin.x;
    let mut frame = container.frame();
    frame.size.height = 44.0;
    frame.origin.y = window.frame().size.height - frame.size.height;
    container.setFrame(frame);
    let mut frame = titlebar.frame();
    frame.origin.y = 0.0;
    frame.size.height = 44.0;
    titlebar.setFrame(frame);
    for (index, kind) in [
        NSWindowButton::CloseButton,
        NSWindowButton::MiniaturizeButton,
        NSWindowButton::ZoomButton,
    ]
    .into_iter()
    .enumerate()
    {
        if let Some(button) = window.standardWindowButton(kind) {
            let mut origin = NSView::frame(&button).origin;
            origin.x = 16.0 + index as f64 * spacing;
            origin.y = (titlebar.bounds().size.height - NSView::frame(&button).size.height) / 2.0;
            button.setFrameOrigin(origin);
        }
    }
}
