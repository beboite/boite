//! The one thing an acrylic theme needs that the webview cannot ask for.
//!
//! Everything else about the palettes is CSS and a `setEffects` call from
//! `lib/theme/backdrop.ts`. This is here because DWM tears a system backdrop
//! down the moment the window says it is no longer active, and Boite is a
//! multiplexer: the window it sits beside is a browser, an editor, another
//! terminal, and the acrylic would be gone for most of the session.

#[cfg(windows)]
mod keep_active {
    use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
    use windows::Win32::UI::Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass};
    use windows::Win32::UI::WindowsAndMessaging::{DefWindowProcW, WM_NCACTIVATE};

    const SUBCLASS_ID: usize = 0x626f_6974; // "boit"

    // Answering "still active" keeps the backdrop rendered while unfocused.
    // `lparam = -1` skips the non-client repaint, which costs nothing here: the
    // window is undecorated, so there is no frame to draw. tao's own focus
    // events are unaffected, because its active-focus state also needs
    // WM_SETFOCUS / WM_KILLFOCUS.
    unsafe extern "system" fn proc(
        hwnd: HWND,
        msg: u32,
        wparam: WPARAM,
        lparam: LPARAM,
        _id: usize,
        _data: usize,
    ) -> LRESULT {
        if msg == WM_NCACTIVATE && wparam.0 == 0 {
            return unsafe { DefWindowProcW(hwnd, WM_NCACTIVATE, WPARAM(1), LPARAM(-1)) };
        }
        unsafe { DefSubclassProc(hwnd, msg, wparam, lparam) }
    }

    pub fn set(hwnd: isize, enabled: bool) {
        let hwnd = HWND(hwnd as *mut core::ffi::c_void);
        unsafe {
            if enabled {
                let _ = SetWindowSubclass(hwnd, Some(proc), SUBCLASS_ID, 0);
            } else {
                let _ = RemoveWindowSubclass(hwnd, Some(proc), SUBCLASS_ID);
            }
        }
    }
}

/// Keeps the OS backdrop rendered while the window is unfocused, for as long as
/// an acrylic theme is on. No-op outside Windows: macOS vibrancy persists on its
/// own, and Linux has no backdrop to keep.
#[tauri::command]
pub fn set_keep_backdrop_active(window: tauri::WebviewWindow, enabled: bool) {
    #[cfg(windows)]
    if let Ok(hwnd) = window.hwnd() {
        let hwnd = hwnd.0 as isize;
        // Subclassing has to happen on the thread that owns the window.
        let _ = window.run_on_main_thread(move || keep_active::set(hwnd, enabled));
    }
    #[cfg(not(windows))]
    let _ = (window, enabled);
}
