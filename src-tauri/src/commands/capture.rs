//! A picture of one pane, taken by the window that draws it.
//!
//! The browser pane is a cross-origin frame, so nothing in the DOM can render
//! it to pixels: `drawImage` taints, `html2canvas` sees a hole, and the
//! WebGL terminals have the same problem for different reasons. The OS can:
//! `PrintWindow` asks the window to paint itself into a bitmap, full content,
//! occluded or not. The webview hands this command a rectangle in physical
//! client pixels (it knows the pane's box and its own devicePixelRatio) and
//! gets back a PNG.
//!
//! Windows only for now, and the other platforms say so in a sentence the
//! agent reads: a wrong screenshot is worse than none. The macOS and Linux
//! equivalents (`CGWindowListCreateImage`, a wayland/x11 grab) are their own
//! projects, and they land here behind the same command when they do.
//!
//! The long edge is capped before encoding: a pane can be 2500 physical
//! pixels wide, a model reads ~1500 comfortably, and the tokens are paid per
//! pixel shipped, not per pixel seen.

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Capture {
    /// PNG, base64. Data-URL free: the caller knows what it asked for.
    pub image: String,
    pub width: u32,
    pub height: u32,
}

/// Longest edge worth shipping. Chosen for what a vision model actually
/// resolves; anything above is tokens spent on pixels nobody reads.
const MAX_EDGE: u32 = 1568;

#[cfg(windows)]
#[tauri::command]
pub fn capture_pane(
    window: tauri::WebviewWindow,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
) -> Result<Capture, String> {
    use windows::Win32::Foundation::RECT;
    use windows::Win32::Graphics::Gdi::{
        CreateCompatibleDC, CreateDIBSection, DeleteDC, DeleteObject, GdiFlush, GetDC,
        ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS,
    };
    use windows::Win32::Storage::Xps::{PrintWindow, PRINT_WINDOW_FLAGS};
    use windows::Win32::UI::WindowsAndMessaging::GetClientRect;

    // PW_CLIENTONLY | PW_RENDERFULLCONTENT: the client area (which is the
    // whole webview in a frameless window), rendered by the window itself so
    // DirectComposition content (WebView2) is in it too.
    const FLAGS: PRINT_WINDOW_FLAGS = PRINT_WINDOW_FLAGS(3);

    let hwnd = window.hwnd().map_err(|e| format!("no window handle: {e}"))?;
    unsafe {
        let mut client = RECT::default();
        GetClientRect(hwnd, &mut client).map_err(|e| format!("GetClientRect: {e}"))?;
        let cw = client.right - client.left;
        let ch = client.bottom - client.top;
        if cw <= 0 || ch <= 0 {
            return Err("the window has no client area to photograph".into());
        }

        let screen = GetDC(None);
        if screen.is_invalid() {
            return Err("no screen device context".into());
        }
        let mem = CreateCompatibleDC(Some(screen));
        if mem.is_invalid() {
            ReleaseDC(None, screen);
            return Err("no memory device context".into());
        }

        // Top-down 32-bit rows, so `bits` reads left to right, top to bottom,
        // BGRA per pixel, with no stride arithmetic.
        let info = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: cw,
                biHeight: -ch,
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };
        let mut bits: *mut core::ffi::c_void = std::ptr::null_mut();
        let bitmap = CreateDIBSection(Some(screen), &info, DIB_RGB_COLORS, &mut bits, None, 0);
        let done = (|| -> Result<Capture, String> {
            let bitmap = bitmap.map_err(|e| format!("CreateDIBSection: {e}"))?;
            if bits.is_null() {
                return Err("CreateDIBSection handed back no pixels".into());
            }
            let previous = SelectObject(mem, bitmap.into());
            let painted = PrintWindow(hwnd, mem, FLAGS).as_bool();
            let _ = GdiFlush();
            SelectObject(mem, previous);
            if !painted {
                let _ = DeleteObject(bitmap.into());
                return Err("the window declined to paint itself".into());
            }

            // Crop to the pane, clamped to what actually exists.
            let cx = (x.max(0.0) as i32).min(cw);
            let cy = (y.max(0.0) as i32).min(ch);
            let cwid = (w as i32).clamp(0, cw - cx);
            let chei = (h as i32).clamp(0, ch - cy);
            if cwid < 8 || chei < 8 {
                let _ = DeleteObject(bitmap.into());
                return Err("that rectangle is not on the window".into());
            }

            let src = std::slice::from_raw_parts(bits.cast::<u8>(), (cw * ch * 4) as usize);
            let mut rgba = Vec::with_capacity((cwid * chei * 4) as usize);
            for row in cy..cy + chei {
                for col in cx..cx + cwid {
                    let at = ((row * cw + col) * 4) as usize;
                    // BGRA to RGBA, alpha forced opaque: a transparent window
                    // writes zero alpha where GDI painted, and the picture is
                    // of what the user sees, which is opaque.
                    rgba.extend_from_slice(&[src[at + 2], src[at + 1], src[at], 255]);
                }
            }
            let _ = DeleteObject(bitmap.into());
            let (rgba, out_w, out_h) = shrink(rgba, cwid as u32, chei as u32);
            encode(rgba, out_w, out_h)
        })();

        let _ = DeleteDC(mem);
        ReleaseDC(None, screen);
        done
    }
}

#[cfg(not(windows))]
#[tauri::command]
pub fn capture_pane(
    _window: tauri::WebviewWindow,
    _x: f64,
    _y: f64,
    _w: f64,
    _h: f64,
) -> Result<Capture, String> {
    Err("screenshots are Windows-only for now; browser_snapshot reads the page as text and \
         elements on every platform"
        .into())
}

/// Box-filter downscale to [`MAX_EDGE`], or the image untouched when it fits.
///
/// A box filter, not nearest: the pixels being kept are mostly text, and
/// nearest-neighbour turns 11px glyphs into confetti.
#[cfg_attr(not(windows), allow(dead_code))]
fn shrink(rgba: Vec<u8>, w: u32, h: u32) -> (Vec<u8>, u32, u32) {
    let edge = w.max(h);
    if edge <= MAX_EDGE {
        return (rgba, w, h);
    }
    let scale = MAX_EDGE as f64 / edge as f64;
    let ow = ((w as f64 * scale).round() as u32).max(1);
    let oh = ((h as f64 * scale).round() as u32).max(1);
    let mut out = Vec::with_capacity((ow * oh * 4) as usize);
    for oy in 0..oh {
        let y0 = (oy as f64 / scale) as u32;
        let y1 = (((oy + 1) as f64 / scale) as u32).clamp(y0 + 1, h);
        for ox in 0..ow {
            let x0 = (ox as f64 / scale) as u32;
            let x1 = (((ox + 1) as f64 / scale) as u32).clamp(x0 + 1, w);
            let mut sum = [0u64; 4];
            for sy in y0..y1 {
                for sx in x0..x1 {
                    let at = ((sy * w + sx) * 4) as usize;
                    for c in 0..4 {
                        sum[c] += rgba[at + c] as u64;
                    }
                }
            }
            let n = ((y1 - y0) * (x1 - x0)) as u64;
            out.extend_from_slice(&[
                (sum[0] / n) as u8,
                (sum[1] / n) as u8,
                (sum[2] / n) as u8,
                (sum[3] / n) as u8,
            ]);
        }
    }
    (out, ow, oh)
}

#[cfg_attr(not(windows), allow(dead_code))]
fn encode(rgba: Vec<u8>, w: u32, h: u32) -> Result<Capture, String> {
    use base64::Engine as _;
    let mut png = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut png, w, h);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().map_err(|e| format!("png: {e}"))?;
        writer
            .write_image_data(&rgba)
            .map_err(|e| format!("png: {e}"))?;
    }
    Ok(Capture {
        image: base64::engine::general_purpose::STANDARD.encode(&png),
        width: w,
        height: h,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The cap is a promise to the token budget: whatever comes in, the long
    /// edge out fits a model's eye and the aspect survives.
    #[test]
    fn a_wide_capture_is_shrunk_to_the_edge_cap_with_its_aspect() {
        let (out, w, h) = shrink(vec![255; 3136 * 100 * 4], 3136, 100);
        assert_eq!((w, h), (1568, 50));
        assert_eq!(out.len(), (1568 * 50 * 4) as usize);
        // Uniform white stays uniform white through the box filter.
        assert!(out.iter().all(|&b| b == 255));

        let (_, w, h) = shrink(vec![0; 800 * 600 * 4], 800, 600);
        assert_eq!((w, h), (800, 600));
    }

    #[test]
    fn a_capture_encodes_to_a_real_png() {
        let out = encode(vec![128; 16 * 16 * 4], 16, 16).unwrap();
        assert_eq!((out.width, out.height), (16, 16));
        use base64::Engine as _;
        let bytes = base64::engine::general_purpose::STANDARD.decode(&out.image).unwrap();
        assert_eq!(&bytes[1..4], b"PNG");
    }
}
