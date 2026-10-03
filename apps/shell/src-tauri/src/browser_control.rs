use crate::browser::{only_main, view_of};
use serde_json::Value;
use std::time::{Duration, Instant};
use tauri::{ipc::{Channel, InvokeResponseBody}, AppHandle, Webview};

#[tauri::command]
pub async fn browser_protocol(app: AppHandle, webview: Webview, id: String, method: String, params: Value) -> Result<Value, String> {
    only_main(&webview)?;
    if !["Runtime.evaluate", "Page.captureScreenshot", "Input.dispatchMouseEvent", "Input.dispatchKeyEvent", "Input.insertText", "Emulation.setDeviceMetricsOverride", "Emulation.clearDeviceMetricsOverride", "Emulation.setEmulatedMedia", "Boite.diagnostics"].contains(&method.as_str()) {
        return Err(format!("browser protocol method {method:?} is not supported"));
    }
    if !params.is_object() || params.to_string().len() > 128 * 1024 { return Err("browser params must be an object smaller than 128 KB".into()); }
    let view = view_of(&app, &id)?;
    #[cfg(windows)]
    {
        if method == "Boite.diagnostics" { return crate::platform::browser_diagnostics::read(&id, params["clear"].as_bool().unwrap_or(false)); }
        crate::platform::browser_control::call(view, method, params).await
    }
    #[cfg(not(windows))]
    { let _ = (view, method, params); Err("browser automation currently requires Windows WebView2".into()) }
}

/// The rates a recording may ask for, as `BROWSER_RECORDING_FRAME_RATES` in the contracts.
const FRAME_RATES: [u32; 2] = [30, 60];

/// Streams a tab's frames as raw JPEG bytes to `channel` at most `frame_rate` times a second, until `browser_screencast_stop`.
#[tauri::command]
pub async fn browser_screencast_start(app: AppHandle, webview: Webview, id: String, frame_rate: u32, channel: Channel<InvokeResponseBody>) -> Result<(), String> {
    only_main(&webview)?;
    if !FRAME_RATES.contains(&frame_rate) { return Err(format!("frame rate must be one of {FRAME_RATES:?}, not {frame_rate}")); }
    let view = view_of(&app, &id)?;
    #[cfg(windows)]
    { crate::platform::browser_screencast::start(view, id, frame_rate, channel).await }
    #[cfg(not(windows))]
    { let _ = (view, channel); Err("browser recording currently requires Windows WebView2".into()) }
}

#[tauri::command]
pub async fn browser_screencast_stop(app: AppHandle, webview: Webview, id: String) -> Result<(), String> {
    only_main(&webview)?;
    #[cfg(windows)]
    {
        let Ok(view) = view_of(&app, &id) else { crate::platform::browser_screencast::remove(&id); return Ok(()) };
        crate::platform::browser_screencast::stop(view, &id).await
    }
    #[cfg(not(windows))]
    { let _ = (app, id); Ok(()) }
}

/// When to acknowledge a screencast frame that arrived at `at`, and when the
/// following one is due. Each acknowledgement lets Chromium send one more frame,
/// so spacing them by `interval` sets the rate. A late frame is acknowledged at
/// once but earns back at most one interval, so a stall never turns into a burst.
pub fn ack_at(at: Instant, next: Option<Instant>, interval: Duration) -> (Instant, Instant) {
    let due = next.map_or(at, |next| next.max(at.checked_sub(interval).unwrap_or(at)));
    (due.max(at), due + interval)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Feeds frames the way Chromium sends them: up to two unacknowledged, the next one
    /// a display refresh after an acknowledgement. Returns how many arrived in `seconds`.
    fn frames_delivered(refresh: Duration, frame_rate: u32, seconds: u64) -> usize {
        let start = Instant::now();
        let end = start + Duration::from_secs(seconds);
        let interval = Duration::from_secs(1) / frame_rate;
        let (mut next, mut acks, mut in_flight, mut delivered) = (None, Vec::<Instant>::new(), 0, 0);
        let mut tick = start;
        while tick < end {
            acks.retain(|due| if *due <= tick { in_flight -= 1; false } else { true });
            if in_flight < 2 {
                let (due, following) = ack_at(tick, next, interval);
                next = Some(following); in_flight += 1; delivered += 1; acks.push(due);
            }
            tick += refresh;
        }
        delivered
    }

    #[test]
    fn acknowledgements_hold_the_requested_rate_whatever_the_page_renders() {
        for (refresh_hz, frame_rate) in [(60, 30), (100, 30), (144, 30), (120, 60), (240, 60)] {
            let delivered = frames_delivered(Duration::from_secs(1) / refresh_hz, frame_rate, 10) as f64 / 10.0;
            assert!((delivered - f64::from(frame_rate)).abs() <= f64::from(frame_rate) * 0.05, "{refresh_hz} Hz page at {frame_rate} fps gave {delivered} fps");
        }
    }

    #[test]
    fn a_late_frame_is_acknowledged_at_once_and_catches_up_one_interval_only() {
        let at = Instant::now();
        let interval = Duration::from_millis(33);
        assert_eq!(ack_at(at, None, interval), (at, at + interval));
        // Early: waits for its turn.
        assert_eq!(ack_at(at, Some(at + interval), interval).0, at + interval);
        // A second late: acknowledged now, the next one due no sooner than now.
        let (due, following) = ack_at(at + Duration::from_secs(1), Some(at), interval);
        assert_eq!(due, at + Duration::from_secs(1));
        assert_eq!(following, at + Duration::from_secs(1));
    }
}
