#[cfg(windows)]
pub(crate) fn hidden_appbars(monitor: (f64, f64, f64, f64)) -> Vec<(u32, f64)> {
    use windows_sys::Win32::{Foundation::{HWND, RECT}, UI::{Shell::{SHAppBarMessage, APPBARDATA, ABM_GETAUTOHIDEBAREX}, WindowsAndMessaging::GetWindowRect}};
    let mut bars = Vec::new();
    for edge in 0..4 {
        let mut data: APPBARDATA = unsafe { std::mem::zeroed() };
        data.cbSize = std::mem::size_of::<APPBARDATA>() as u32;
        data.uEdge = edge;
        data.rc = RECT { left: monitor.0 as i32, top: monitor.1 as i32, right: monitor.2 as i32, bottom: monitor.3 as i32 };
        // Unlike ABM_GETAUTOHIDEBAR, EX queries the specified monitor. Work
        // area alone only reserves the thin activation strip in auto-hide mode.
        let hwnd = unsafe { SHAppBarMessage(ABM_GETAUTOHIDEBAREX, &mut data) } as HWND;
        if hwnd.is_null() { continue; }
        let mut rect: RECT = unsafe { std::mem::zeroed() };
        if unsafe { GetWindowRect(hwnd, &mut rect) } == 0 { continue; }
        // An auto-hidden bar slides outside the monitor. Keep its full size,
        // anchored to its registered edge, rather than its animated position.
        let thickness = if edge == 0 || edge == 2 { rect.right - rect.left } else { rect.bottom - rect.top };
        if thickness > 0 { bars.push((edge, thickness as f64)); }
    }
    bars
}

#[cfg(not(windows))]
pub(crate) fn hidden_appbars(_monitor: (f64, f64, f64, f64)) -> Vec<(u32, f64)> { Vec::new() }
