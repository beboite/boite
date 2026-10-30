//! What the pointer window (`pointer_window.rs`) needs of Win32 that Tauri does
//! not set: it never takes the focus, has no Alt+Tab entry, and goes back on
//! top of the taskbar, which raises itself above topmost windows when clicked.

use windows_sys::Win32::Foundation::HWND;
use windows_sys::Win32::UI::WindowsAndMessaging::{
    GetWindowLongPtrW, SetWindowLongPtrW, SetWindowPos, GWL_EXSTYLE, HWND_TOPMOST, SWP_NOACTIVATE, SWP_NOMOVE,
    SWP_NOOWNERZORDER, SWP_NOSIZE, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_EX_TRANSPARENT,
};

/// `WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW | WS_EX_TRANSPARENT` on top of what the
/// window has: a click goes to the control under it and never activates it.
pub(crate) fn never_activate(hwnd: *mut core::ffi::c_void) -> Result<(), String> {
    let hwnd = hwnd as HWND;
    // SAFETY: `hwnd` is a live window of this process; reading and writing its
    // extended style has no other effect.
    unsafe {
        let style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        let wanted = style | (WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW | WS_EX_TRANSPARENT) as isize;
        if wanted != style && SetWindowLongPtrW(hwnd, GWL_EXSTYLE, wanted) == 0 && GetWindowLongPtrW(hwnd, GWL_EXSTYLE) != wanted {
            return Err(format!("SetWindowLongPtrW(GWL_EXSTYLE) kept {style:#x}"));
        }
    }
    Ok(())
}

/// First among the topmost windows again, without moving, sizing or activating it.
pub(crate) fn raise(hwnd: *mut core::ffi::c_void) {
    // SAFETY: `hwnd` is a window of this process; a stale handle only fails the call.
    unsafe { SetWindowPos(hwnd as HWND, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOOWNERZORDER) };
}
