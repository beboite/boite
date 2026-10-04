// A separate harness keeps AppKit on the process's main thread. Windows/Linux skip it.
#[cfg(target_os = "macos")]
#[path = "../src/platform/macos_window.rs"]
mod native;

#[cfg(not(target_os = "macos"))]
fn main() {}

#[cfg(target_os = "macos")]
fn main() {
    use objc2::{rc::autoreleasepool, MainThreadOnly};
    use objc2_app_kit::{
        NSApplication, NSApplicationActivationPolicy, NSBackingStoreType, NSWindow, NSWindowButton,
        NSWindowStyleMask,
    };
    use objc2_foundation::{MainThreadMarker, NSPoint, NSRect, NSSize};
    autoreleasepool(|_| {
        let main = MainThreadMarker::new().expect("native window checks run on the main thread");
        let app = NSApplication::sharedApplication(main);
        app.setActivationPolicy(NSApplicationActivationPolicy::Prohibited);
        let window = unsafe {
            NSWindow::initWithContentRect_styleMask_backing_defer(
                NSWindow::alloc(main),
                NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(1280.0, 890.0)),
                NSWindowStyleMask::Titled
                    | NSWindowStyleMask::Closable
                    | NSWindowStyleMask::Miniaturizable
                    | NSWindowStyleMask::Resizable
                    | NSWindowStyleMask::FullSizeContentView,
                NSBackingStoreType::Buffered,
                false,
            )
        };
        window.setTitlebarAppearsTransparent(true);
        for size in [(1280.0, 890.0), (880.0, 560.0), (1440.0, 960.0)] {
            let mut frame = window.frame();
            frame.size = NSSize::new(size.0, size.1);
            window.setFrame_display(frame, false);
            native::align_traffic_lights(&window);
            let mut previous = None;
            for kind in [
                NSWindowButton::CloseButton,
                NSWindowButton::MiniaturizeButton,
                NSWindowButton::ZoomButton,
            ] {
                let button = window
                    .standardWindowButton(kind)
                    .expect("native caption button");
                let rect = button.convertRect_toView(button.bounds(), None);
                let center_from_top =
                    window.frame().size.height - rect.origin.y - rect.size.height / 2.0;
                assert!(
                    (center_from_top - 22.0).abs() < 0.5,
                    "button center {center_from_top} must match the toolbar center 22"
                );
                if let Some(right) = previous {
                    assert!(
                        rect.origin.x > right,
                        "native caption buttons must not overlap"
                    );
                } else {
                    assert!(
                        (rect.origin.x - 16.0).abs() < 0.5,
                        "native controls leave 16 points at the left edge"
                    );
                }
                previous = Some(rect.origin.x + rect.size.width);
                assert!(
                    previous.unwrap() < 80.0,
                    "native controls stay before the sidebar button"
                );
            }
        }
        println!("macOS native traffic lights: centered at 22 points, ordered and clear of navigation at three window sizes");
    });
}
