//! The DWM attributes the shell sets on its own windows: the material behind
//! the main window and the corners of the quota popup. Read back as well, so a
//! value DWM did not keep is an error rather than a window that looks wrong.

use windows_sys::Win32::Foundation::HWND;
use windows_sys::Win32::Graphics::Dwm::{
    DwmGetWindowAttribute, DwmSetWindowAttribute, DWMWA_WINDOW_CORNER_PREFERENCE, DWMWCP_ROUND,
};

/// Sets a DWM attribute whose value is four bytes. A refusal names the
/// attribute, the value and the HRESULT.
pub(crate) fn set_attribute(hwnd: HWND, attribute: u32, value: u32) -> Result<(), String> {
    // SAFETY: the value lives until the call returns and is exactly four bytes.
    let result = unsafe { DwmSetWindowAttribute(hwnd, attribute, (&value as *const u32).cast(), 4) };
    if result < 0 {
        return Err(format!("DWM refused attribute {attribute} = {value}: HRESULT {:#010x}", result as u32));
    }
    Ok(())
}

/// The four-byte value DWM holds for an attribute.
pub(crate) fn attribute(hwnd: HWND, attribute: u32) -> Result<u32, String> {
    let mut value = 0u32;
    // SAFETY: the buffer is a live u32, and four bytes is its size.
    let result = unsafe { DwmGetWindowAttribute(hwnd, attribute, (&mut value as *mut u32).cast(), 4) };
    if result < 0 {
        return Err(format!("DWM could not read attribute {attribute}: HRESULT {:#010x}", result as u32));
    }
    Ok(value)
}

/// Asks Windows 11 to round the window's corners itself. It then also clips
/// the content and draws the border and shadow along the same curve, which a
/// CSS radius inside a square window can only imitate.
pub(crate) fn round_corners(hwnd: HWND) -> Result<(), String> {
    set_attribute(hwnd, DWMWA_WINDOW_CORNER_PREFERENCE as u32, DWMWCP_ROUND as u32)
}

/// A top-level window that is never shown, for tests that need a real handle
/// DWM accepts attributes on. Destroyed on drop, on the thread that made it.
#[cfg(test)]
pub(crate) struct HiddenWindow(pub(crate) HWND);

#[cfg(test)]
impl HiddenWindow {
    pub(crate) fn new() -> Self {
        use windows_sys::Win32::UI::WindowsAndMessaging::{CreateWindowExW, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_POPUP};
        let wide = |value: &str| value.encode_utf16().chain(std::iter::once(0)).collect::<Vec<u16>>();
        let (class, title) = (wide("STATIC"), wide("boite dwm test"));
        // No WS_VISIBLE and no ShowWindow: the window never reaches the screen.
        // SAFETY: both strings are NUL-terminated and outlive the call.
        let hwnd = unsafe {
            CreateWindowExW(WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE, class.as_ptr(), title.as_ptr(), WS_POPUP,
                0, 0, 200, 200, std::ptr::null_mut(), std::ptr::null_mut(), std::ptr::null_mut(), std::ptr::null())
        };
        assert!(!hwnd.is_null(), "CreateWindowExW refused a hidden test window");
        Self(hwnd)
    }
}

#[cfg(test)]
impl Drop for HiddenWindow {
    fn drop(&mut self) {
        // SAFETY: the handle came from CreateWindowExW on this thread.
        unsafe { windows_sys::Win32::UI::WindowsAndMessaging::DestroyWindow(self.0) };
    }
}

#[cfg(test)]
mod tests {
    use super::{attribute, round_corners, HiddenWindow};
    use windows_sys::Win32::Graphics::Dwm::{DWMWA_WINDOW_CORNER_PREFERENCE, DWMWCP_ROUND};

    #[test]
    fn rounded_corners_are_what_dwm_holds_afterwards() {
        if crate::material::windows_build() < 22000 {
            eprintln!("skipped: corner preferences exist from Windows 11 (22000)");
            return;
        }
        let window = HiddenWindow::new();
        round_corners(window.0).expect("DWM takes a corner preference on Windows 11");
        assert_eq!(attribute(window.0, DWMWA_WINDOW_CORNER_PREFERENCE as u32), Ok(DWMWCP_ROUND as u32));
    }
}
