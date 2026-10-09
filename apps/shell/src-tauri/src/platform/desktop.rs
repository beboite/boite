//! What the desktop companion asks of the system beyond its window: whether a
//! full-screen app is in front, when the last input came, a global shortcut
//! and a picture of the screen. Other systems than Windows answer with nothing
//! for now: no full-screen app, no shortcut, no capture.

/// `(left, top, right, bottom)` in physical pixels.
pub(crate) type Bounds = (i32, i32, i32, i32);

/// Whether `window` covers all of `screen`: a game or a video in full screen
/// does; a maximized window leaves the taskbar out, so it does not.
pub(crate) fn covers(window: Bounds, screen: Bounds) -> bool {
    window.0 <= screen.0 && window.1 <= screen.1 && window.2 >= screen.2 && window.3 >= screen.3
}

/// A shortcut as Settings names it, modifiers and one key joined by `+`
/// (`Alt+Shift+Space`), in Windows' terms: `(MOD_* flags, virtual key)`.
pub(crate) fn parse_hotkey(text: &str) -> Result<(u32, u32), String> {
    const MOD_ALT: u32 = 0x1;
    const MOD_CONTROL: u32 = 0x2;
    const MOD_SHIFT: u32 = 0x4;
    const MOD_WIN: u32 = 0x8;
    let mut modifiers = 0;
    let mut key = None;
    for part in text.split('+').map(str::trim) {
        let upper = part.to_ascii_uppercase();
        match upper.as_str() {
            "CTRL" | "CONTROL" => modifiers |= MOD_CONTROL,
            "ALT" => modifiers |= MOD_ALT,
            "SHIFT" => modifiers |= MOD_SHIFT,
            "WIN" | "SUPER" | "META" => modifiers |= MOD_WIN,
            _ if key.is_some() => return Err(format!("the shortcut {text:?} names two keys")),
            _ => key = Some(key_code(&upper).ok_or_else(|| format!("the shortcut {text:?} has an unknown key {part:?}"))?),
        }
    }
    let key = key.ok_or_else(|| format!("the shortcut {text:?} names no key"))?;
    if modifiers == 0 { return Err(format!("the shortcut {text:?} needs Ctrl, Alt, Shift or Win")); }
    Ok((modifiers, key))
}

/// Space, a letter, a digit or F1 to F12, as a Windows virtual key.
fn key_code(upper: &str) -> Option<u32> {
    if upper == "SPACE" { return Some(0x20); }
    if let [byte] = upper.as_bytes() {
        return byte.is_ascii_alphanumeric().then_some(u32::from(*byte));
    }
    let number = upper.strip_prefix('F')?.parse::<u32>().ok().filter(|number| (1..=12).contains(number))?;
    Some(0x6F + number)
}

#[cfg(windows)]
mod system {
    use super::Bounds;
    use std::sync::mpsc;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetClassNameW, GetForegroundWindow, GetMessageW, GetWindowRect, PeekMessageW, PostThreadMessageW, SetWindowDisplayAffinity, ShowWindow,
        MSG, PM_NOREMOVE, SW_HIDE, SW_SHOWNOACTIVATE, WDA_EXCLUDEFROMCAPTURE, WDA_NONE, WM_HOTKEY, WM_QUIT, WM_USER,
    };

    /// Whether the window in front, not `own`, covers `screen`. The desktop and
    /// the taskbar cover a screen too without being an app.
    pub(crate) fn fullscreen_in_front<R: tauri::Runtime>(own: &tauri::WebviewWindow<R>, screen: Bounds) -> bool {
        // SAFETY: no pointer kept; a null window (the lock screen) is handled.
        let front = unsafe { GetForegroundWindow() };
        if front.is_null() || own.hwnd().is_ok_and(|hwnd| hwnd.0 == front) { return false; }
        let mut class = [0u16; 64];
        // SAFETY: the buffer and its length are this array's.
        let length = unsafe { GetClassNameW(front, class.as_mut_ptr(), class.len() as i32) };
        let class = String::from_utf16_lossy(&class[..length.max(0) as usize]);
        if matches!(class.as_str(), "Progman" | "WorkerW" | "Shell_TrayWnd" | "Shell_SecondaryTrayWnd") { return false; }
        let mut rect = windows_sys::Win32::Foundation::RECT { left: 0, top: 0, right: 0, bottom: 0 };
        // SAFETY: the rect outlives the call.
        if unsafe { GetWindowRect(front, &mut rect) } == 0 { return false; }
        super::covers((rect.left, rect.top, rect.right, rect.bottom), screen)
    }

    /// Shows or hides `window` without taking the focus from the app in front.
    pub(crate) fn show_quietly<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>, visible: bool) {
        let Ok(hwnd) = window.hwnd() else { return };
        // SAFETY: the handle is this live window's.
        unsafe { ShowWindow(hwnd.0, if visible { SW_SHOWNOACTIVATE } else { SW_HIDE }) };
    }

    /// The tick of the last key, click or mouse move in this session. Only
    /// that it changed is read: never which key.
    pub(crate) fn last_input() -> Option<u32> {
        use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};
        let mut info = LASTINPUTINFO { cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32, dwTime: 0 };
        // SAFETY: cbSize names the structure the call fills, which outlives it.
        (unsafe { GetLastInputInfo(&mut info) } != 0).then_some(info.dwTime)
    }

    /// Leaves `window` out of screen captures, or puts it back in them.
    pub(crate) fn exclude_from_capture<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>, excluded: bool) {
        let Ok(hwnd) = window.hwnd() else { return };
        // SAFETY: the handle is this live window's.
        unsafe { SetWindowDisplayAffinity(hwnd.0, if excluded { WDA_EXCLUDEFROMCAPTURE } else { WDA_NONE }) };
    }

    /// The screen area `(x, y, width, height)`, scaled down to `max_side` on its
    /// longer side, as top-down BGRA rows: `(width, height, pixels)`.
    pub(crate) fn capture(area: (i32, i32, i32, i32), max_side: i32) -> Result<(u32, u32, Vec<u8>), String> {
        use windows_sys::Win32::Graphics::Gdi::{
            CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC, GetDIBits, ReleaseDC, SelectObject, SetBrushOrgEx,
            SetStretchBltMode, StretchBlt, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HALFTONE, SRCCOPY,
        };
        let (left, top, width, height) = area;
        if width <= 0 || height <= 0 { return Err("the screen has no size".into()); }
        let ratio = (f64::from(max_side) / f64::from(width.max(height))).min(1.0);
        let (out_width, out_height) = (((f64::from(width) * ratio).round() as i32).max(1), ((f64::from(height) * ratio).round() as i32).max(1));
        let mut pixels = vec![0u8; out_width as usize * out_height as usize * 4];
        // SAFETY: every handle made here is released on each path below; the
        // bitmap is deselected before GetDIBits reads it, as the call requires.
        unsafe {
            let screen = GetDC(std::ptr::null_mut());
            if screen.is_null() { return Err("the screen cannot be read".into()); }
            let memory = CreateCompatibleDC(screen);
            let bitmap = CreateCompatibleBitmap(screen, out_width, out_height);
            let previous = SelectObject(memory, bitmap);
            SetStretchBltMode(memory, HALFTONE);
            SetBrushOrgEx(memory, 0, 0, std::ptr::null_mut());
            let copied = StretchBlt(memory, 0, 0, out_width, out_height, screen, left, top, width, height, SRCCOPY) != 0;
            SelectObject(memory, previous);
            let mut info: BITMAPINFO = std::mem::zeroed();
            info.bmiHeader = BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: out_width,
                // Negative: rows top to bottom, as a canvas wants them.
                biHeight: -out_height,
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB,
                ..std::mem::zeroed()
            };
            let lines = if copied { GetDIBits(memory, bitmap, 0, out_height as u32, pixels.as_mut_ptr().cast(), &mut info, DIB_RGB_COLORS) } else { 0 };
            DeleteObject(bitmap);
            DeleteDC(memory);
            ReleaseDC(std::ptr::null_mut(), screen);
            if lines != out_height { return Err("the screen could not be copied".into()); }
        }
        Ok((out_width as u32, out_height as u32, pixels))
    }

    /// A shortcut that works whichever app is in front, for as long as it lives.
    /// Its own thread owns the registration and the message loop that hears it.
    pub(crate) struct Hotkey { thread: u32 }

    impl Hotkey {
        pub(crate) fn register(modifiers: u32, key: u32, pressed: impl Fn() + Send + 'static) -> Result<Self, String> {
            use windows_sys::Win32::System::Threading::GetCurrentThreadId;
            use windows_sys::Win32::UI::Input::KeyboardAndMouse::{RegisterHotKey, UnregisterHotKey, MOD_NOREPEAT};
            let (sender, receiver) = mpsc::channel();
            std::thread::Builder::new().name("companion-hotkey".into()).spawn(move || {
                // SAFETY: MSG is plain data; every call below takes this thread's own queue.
                let mut message: MSG = unsafe { std::mem::zeroed() };
                // The queue exists before the thread's id is handed out to post to it.
                unsafe { PeekMessageW(&mut message, std::ptr::null_mut(), WM_USER, WM_USER, PM_NOREMOVE) };
                let registered = unsafe { RegisterHotKey(std::ptr::null_mut(), 1, modifiers | MOD_NOREPEAT, key) } != 0;
                let _ = sender.send(registered.then(|| unsafe { GetCurrentThreadId() }));
                if !registered { return; }
                while unsafe { GetMessageW(&mut message, std::ptr::null_mut(), 0, 0) } > 0 {
                    if message.message == WM_HOTKEY { pressed(); }
                }
                unsafe { UnregisterHotKey(std::ptr::null_mut(), 1) };
            }).map_err(|error| format!("the shortcut thread did not start: {error}"))?;
            match receiver.recv() {
                Ok(Some(thread)) => Ok(Self { thread }),
                _ => Err("the shortcut is taken by another application".into()),
            }
        }
    }

    impl Drop for Hotkey {
        fn drop(&mut self) {
            // SAFETY: a thread id; posting to a thread that ended already fails harmlessly.
            unsafe { PostThreadMessageW(self.thread, WM_QUIT, 0, 0) };
        }
    }
}

#[cfg(not(windows))]
mod system {
    use super::Bounds;

    pub(crate) fn fullscreen_in_front<R: tauri::Runtime>(_own: &tauri::WebviewWindow<R>, _screen: Bounds) -> bool { false }

    pub(crate) fn show_quietly<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>, visible: bool) {
        let _ = if visible { window.show() } else { window.hide() };
    }

    pub(crate) fn last_input() -> Option<u32> { None }

    pub(crate) fn exclude_from_capture<R: tauri::Runtime>(_window: &tauri::WebviewWindow<R>, _excluded: bool) {}

    pub(crate) fn capture(_area: (i32, i32, i32, i32), _max_side: i32) -> Result<(u32, u32, Vec<u8>), String> {
        Err("no screen capture on this platform yet".into())
    }

    pub(crate) struct Hotkey;

    impl Hotkey {
        pub(crate) fn register(_modifiers: u32, _key: u32, _pressed: impl Fn() + Send + 'static) -> Result<Self, String> {
            Err("no global shortcut on this platform yet".into())
        }
    }
}

pub(crate) use system::{capture, exclude_from_capture, fullscreen_in_front, last_input, show_quietly, Hotkey};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_window_is_full_screen_when_it_covers_the_whole_screen() {
        let screen = (0, 0, 1920, 1080);
        assert!(covers((0, 0, 1920, 1080), screen));
        assert!(covers((-8, -8, 1928, 1088), screen), "a borderless window that overhangs");
        assert!(!covers((0, 0, 1920, 1040), screen), "maximized above the taskbar");
        assert!(!covers((0, 0, 1920, 1080), (1920, 0, 4480, 1440)), "full screen on the other screen");
    }

    #[test]
    fn a_shortcut_is_read_from_its_name() {
        assert_eq!(parse_hotkey("Alt+Shift+Space"), Ok((0x1 | 0x4, 0x20)));
        assert_eq!(parse_hotkey("ctrl + k"), Ok((0x2, u32::from(b'K'))));
        assert_eq!(parse_hotkey("Win+F12"), Ok((0x8, 0x7B)));
        assert!(parse_hotkey("Space").is_err(), "no modifier");
        assert!(parse_hotkey("Ctrl+A+B").is_err(), "two keys");
        assert!(parse_hotkey("Ctrl+Shift").is_err(), "no key");
        assert!(parse_hotkey("Ctrl+F13").is_err(), "unknown key");
    }
}
