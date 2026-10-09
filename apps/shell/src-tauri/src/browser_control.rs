use crate::browser::{only_main, view_of};
use serde_json::Value;
use std::time::{Duration, Instant};
use tauri::{ipc::{Channel, InvokeResponseBody}, AppHandle, Webview};

/// A surface the core's agent browser drives through the UI, by its id's prefix.
pub fn is_agent_surface(id: &str) -> bool { id.starts_with("agent-") }

/// What the UI may send to a surface the user browses: the panel's own needs.
const SURFACE_METHODS: [&str; 9] = ["Runtime.evaluate", "Page.captureScreenshot", "Input.dispatchMouseEvent", "Input.dispatchKeyEvent", "Input.insertText", "Emulation.setDeviceMetricsOverride", "Emulation.clearDeviceMetricsOverride", "Emulation.setEmulatedMedia", "Boite.diagnostics"];
/// The page-level domains an agent surface relays for the core's agent browser.
const AGENT_DOMAINS: [&str; 7] = ["Page", "Runtime", "Input", "Emulation", "Network", "Log", "DOM"];
/// Methods of those domains that reach past the page: every cookie of the
/// profile the user signs in with, or the page's own lifetime, which the UI owns.
const AGENT_REFUSED: [&str; 8] = ["Network.getAllCookies", "Network.getCookies", "Network.setCookie", "Network.setCookies", "Network.deleteCookies", "Network.clearBrowserCookies", "Page.close", "Page.crash"];
/// The core's own agent commands wait up to 30 s; the relay waits a little longer
/// so the core, not the shell, reports its own timeout.
const AGENT_TIMEOUT: Duration = Duration::from_secs(35);
const SURFACE_TIMEOUT: Duration = Duration::from_secs(15);
/// An agent uploads files and evaluates whole scripts; a user surface sends small inputs.
const AGENT_MAX_PARAMS: usize = 16 * 1024 * 1024;
const SURFACE_MAX_PARAMS: usize = 128 * 1024;

/// Whether the surface `id` may receive `method`, or a refusal naming both.
fn check_method(id: &str, method: &str) -> Result<(), String> {
    if method == "Boite.diagnostics" { return Ok(()); }
    if !is_agent_surface(id) {
        if SURFACE_METHODS.contains(&method) { return Ok(()); }
        return Err(format!("browser protocol method {method:?} is not supported for the surface {id:?}: only {} are", SURFACE_METHODS.join(", ")));
    }
    if AGENT_REFUSED.contains(&method) {
        return Err(format!("browser protocol method {method:?} is refused for the agent surface {id:?}: it reaches the whole profile or closes the page"));
    }
    let known = method.split_once('.').is_some_and(|(domain, name)| AGENT_DOMAINS.contains(&domain)
        && name.chars().next().is_some_and(|c| c.is_ascii_lowercase()) && name.chars().all(|c| c.is_ascii_alphanumeric()));
    if known { return Ok(()); }
    Err(format!("browser protocol method {method:?} is not supported for the agent surface {id:?}: it must be Domain.method in one of the domains {}", AGENT_DOMAINS.join(", ")))
}

/// The params size cap and reply wait for the surface `id`.
fn limits(id: &str) -> (usize, Duration) {
    if is_agent_surface(id) { (AGENT_MAX_PARAMS, AGENT_TIMEOUT) } else { (SURFACE_MAX_PARAMS, SURFACE_TIMEOUT) }
}

#[tauri::command]
pub async fn browser_protocol(app: AppHandle, webview: Webview, id: String, method: String, params: Value) -> Result<Value, String> {
    only_main(&webview)?;
    check_method(&id, &method)?;
    let (max_params, timeout) = limits(&id);
    if !params.is_object() || params.to_string().len() > max_params {
        return Err(format!("browser params of {method:?} must be an object smaller than {} KB", max_params / 1024));
    }
    let view = view_of(&app, &id)?;
    #[cfg(windows)]
    {
        if method == "Boite.diagnostics" { return crate::platform::browser_diagnostics::read(&id, params["clear"].as_bool().unwrap_or(false)); }
        crate::platform::browser_control::call_within(view, method, params, timeout).await
    }
    #[cfg(not(windows))]
    { let _ = (view, method, params, timeout); Err("browser automation currently requires Windows WebView2".into()) }
}

/// The DevTools events an agent surface relays to the UI, which hands them to
/// the core's agent browser. Page-level only, like the methods it may call.
pub const AGENT_EVENTS: [&str; 15] = [
    "Page.frameNavigated", "Page.javascriptDialogOpening", "Page.loadEventFired", "Page.domContentEventFired",
    "Page.screencastFrame", "Page.frameStartedLoading", "Page.frameStoppedLoading",
    "Runtime.consoleAPICalled", "Runtime.exceptionThrown", "Runtime.executionContextCreated", "Runtime.executionContextsCleared",
    "Network.requestWillBeSent", "Network.responseReceived", "Network.loadingFailed", "Log.entryAdded",
];
const MAX_EVENT_NAMES: usize = 32;

/// The events a subscription may name, or a refusal naming the first bad one.
fn check_events(id: &str, events: &[String]) -> Result<(), String> {
    if !is_agent_surface(id) {
        return Err(format!("browser protocol events are relayed only for agent surfaces, whose id starts with \"agent-\", not {id:?}"));
    }
    if events.len() > MAX_EVENT_NAMES {
        return Err(format!("browser protocol events for {id:?} name {} events: at most {MAX_EVENT_NAMES}", events.len()));
    }
    if let Some(bad) = events.iter().find(|name| !AGENT_EVENTS.contains(&name.as_str())) {
        return Err(format!("browser protocol event {bad:?} is not relayed for {id:?}: only {} are", AGENT_EVENTS.join(", ")));
    }
    Ok(())
}

/// One relayed event as the UI reads it. `params` is the object text WebView2
/// gave, spliced in rather than parsed again; an event without one gets `{}`.
pub fn event_message(name: &str, params: &str) -> String {
    let params = if params.trim().is_empty() { "{}" } else { params };
    format!("{{\"method\":\"{name}\",\"params\":{params}}}")
}

/// Relays the named DevTools events of an agent surface to `channel`, each as
/// the JSON text `{"method":<name>,"params":<params>}`. A new call replaces the
/// previous subscription of the same surface; an empty list ends it.
#[tauri::command]
pub async fn browser_protocol_events(app: AppHandle, webview: Webview, id: String, events: Vec<String>, channel: Channel<String>) -> Result<(), String> {
    only_main(&webview)?;
    check_events(&id, &events)?;
    let view = view_of(&app, &id)?;
    #[cfg(windows)]
    { crate::platform::browser_events::subscribe(view, id, events, channel).await }
    #[cfg(not(windows))]
    { let _ = (view, events, channel); Err("relaying browser protocol events currently requires Windows WebView2".into()) }
}

/// Every cookie of the profile a view runs in, for the owner copying that
/// profile's sign-ins to the browser of the machine its agents work on. Its own
/// command, never a `browser_protocol` method: only this exact read is allowed,
/// and only from the main UI.
#[tauri::command]
pub async fn browser_cookies(app: AppHandle, webview: Webview, id: String) -> Result<Value, String> {
    only_main(&webview)?;
    let view = view_of(&app, &id)?;
    #[cfg(windows)]
    { crate::platform::browser_control::call(view, "Network.getAllCookies".to_string(), serde_json::json!({})).await }
    #[cfg(not(windows))]
    { let _ = view; Err("reading a browser profile's cookies currently requires Windows WebView2".into()) }
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

    #[test]
    fn a_user_surface_keeps_the_panel_methods_only() {
        for method in SURFACE_METHODS { assert!(check_method("browser:1", method).is_ok(), "{method}"); }
        for method in ["Page.navigate", "DOM.getDocument", "Network.enable", "Network.getAllCookies"] {
            let error = check_method("browser:1", method).unwrap_err();
            assert!(error.contains(method) && error.contains("Runtime.evaluate"), "{error}");
        }
        assert_eq!(limits("browser:1"), (128 * 1024, Duration::from_secs(15)));
    }

    #[test]
    fn an_agent_surface_takes_its_page_domains_but_not_the_profile_cookies_or_the_page_lifetime() {
        for method in ["Page.navigate", "Page.captureScreenshot", "Runtime.callFunctionOn", "Input.dispatchTouchEvent", "Emulation.setUserAgentOverride",
            "Network.enable", "Network.setExtraHTTPHeaders", "Log.enable", "DOM.setFileInputFiles", "Boite.diagnostics"] {
            assert!(check_method("agent-1", method).is_ok(), "{method}");
        }
        for method in AGENT_REFUSED {
            let error = check_method("agent-1", method).unwrap_err();
            assert!(error.contains(method) && error.contains("refused"), "{error}");
        }
        for method in ["Browser.close", "Target.createTarget", "Storage.getCookies", "Fetch.enable", "Page", "Page.", "Page.Navigate", "Page.navigate.x", "page.navigate", ".navigate"] {
            let error = check_method("agent-1", method).unwrap_err();
            assert!(error.contains(&format!("{method:?}")) && error.contains("Page, Runtime, Input, Emulation, Network, Log, DOM"), "{error}");
        }
        assert_eq!(limits("agent-1"), (16 * 1024 * 1024, Duration::from_secs(35)));
    }

    #[test]
    fn events_are_relayed_for_agent_surfaces_from_the_allowlist_only() {
        let names = |list: &[&str]| list.iter().map(|name| name.to_string()).collect::<Vec<_>>();
        assert!(check_events("agent-1", &names(&AGENT_EVENTS)).is_ok());
        assert!(check_events("agent-1", &[]).is_ok());
        assert!(check_events("browser:1", &names(&["Page.loadEventFired"])).unwrap_err().contains("agent-"));
        let error = check_events("agent-1", &names(&["Page.loadEventFired", "Target.attachedToTarget"])).unwrap_err();
        assert!(error.contains("Target.attachedToTarget"), "{error}");
        assert!(check_events("agent-1", &names(&["page.loadEventFired"])).is_err());
        let error = check_events("agent-1", &vec!["Page.loadEventFired".to_string(); 33]).unwrap_err();
        assert!(error.contains("at most 32"), "{error}");
        assert!(check_events("agent-1", &vec!["Page.loadEventFired".to_string(); 32]).is_ok());
    }

    #[test]
    fn an_event_message_is_the_method_and_its_params_object() {
        let text = event_message("Page.frameNavigated", r#"{"frame":{"id":"F","url":"https://example.test/"}}"#);
        let value: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(value["method"], "Page.frameNavigated");
        assert_eq!(value["params"]["frame"]["url"], "https://example.test/");
        let empty: Value = serde_json::from_str(&event_message("Runtime.executionContextsCleared", "")).unwrap();
        assert_eq!(empty["params"], serde_json::json!({}));
    }

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
