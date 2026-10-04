//! A recording's page frames, pushed by the DevTools screencast instead of one
//! screenshot request per frame. Chromium keeps at most two frames unacknowledged
//! and drops the ones after, so delaying each acknowledgement holds the stream
//! to the requested rate without encoding a frame the recorder would discard.
use base64::Engine;
use serde_json::{json, Value};
use std::{collections::{HashMap, VecDeque}, sync::{LazyLock, Mutex, mpsc}, time::{Duration, Instant}};
use tauri::ipc::{Channel, InvokeResponseBody};
use webview2_com::{CallDevToolsProtocolMethodCompletedHandler, CoTaskMemPWSTR, DevToolsProtocolEventReceivedEventHandler};
use windows::core::{HSTRING, PWSTR};

const FRAME_EVENT: &str = "Page.screencastFrame";
/// A 1080p JPEG at quality 80 is a few hundred KB; a larger event is not a frame.
const MAX_FRAME_JSON: usize = 16 * 1024 * 1024;

enum Message { Frame(String, Instant), Stop }
struct Cast { token: i64, worker: mpsc::Sender<Message> }
static CASTS: LazyLock<Mutex<HashMap<String, Cast>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

pub async fn start(view: tauri::Webview, id: String, frame_rate: u32, channel: Channel<InvokeResponseBody>) -> Result<(), String> {
    if CASTS.lock().map_err(|_| "browser screencast is unavailable")?.contains_key(&id) { return Err("a browser screencast is already running".into()); }
    let (worker, frames) = mpsc::channel();
    let (sender, receiver) = mpsc::channel();
    let events = worker.clone();
    view.with_webview(move |platform| {
        let register = || -> windows::core::Result<i64> { unsafe {
            // The handler only copies the event off the window thread; decoding and pacing happen on the worker.
            let handler = DevToolsProtocolEventReceivedEventHandler::create(Box::new(move |_, args| {
                if let Some(args) = args {
                    let mut raw = PWSTR::null(); args.ParameterObjectAsJson(&mut raw)?;
                    let _ = events.send(Message::Frame(CoTaskMemPWSTR::from(raw).to_string(), Instant::now()));
                }
                Ok(())
            }));
            let mut token = 0;
            platform.controller().CoreWebView2()?.GetDevToolsProtocolEventReceiver(&HSTRING::from(FRAME_EVENT))?.add_DevToolsProtocolEventReceived(&handler, &mut token)?;
            Ok(token)
        }};
        let _ = sender.send(register().map_err(|error| error.to_string()));
    }).map_err(|error| error.to_string())?;
    let token = tauri::async_runtime::spawn_blocking(move || receiver.recv_timeout(Duration::from_secs(10)).map_err(|_| "browser screencast timed out".to_owned())?)
        .await.map_err(|error| error.to_string())??;
    {
        let mut casts = CASTS.lock().map_err(|_| "browser screencast is unavailable")?;
        if casts.contains_key(&id) { drop(casts); unregister(&view, token); return Err("a browser screencast is already running".into()); }
        casts.insert(id.clone(), Cast { token, worker: worker.clone() });
    }
    let paced = view.clone();
    std::thread::Builder::new().name("browser-screencast".into())
        .spawn(move || pump(paced, frames, channel, Duration::from_secs(1) / frame_rate))
        .map_err(|error| { stop_local(&view, &id); error.to_string() })?;
    let started = async {
        super::browser_control::call(view.clone(), "Page.enable".into(), json!({})).await?;
        super::browser_control::call(view.clone(), "Page.startScreencast".into(), json!({ "format": "jpeg", "quality": 80, "maxWidth": 1920, "maxHeight": 1080, "everyNthFrame": 1 })).await
    }.await;
    if let Err(error) = started { stop_local(&view, &id); return Err(error); }
    Ok(())
}

pub async fn stop(view: tauri::Webview, id: &str) -> Result<(), String> {
    if !stop_local(&view, id) { return Ok(()); }
    super::browser_control::call(view, "Page.stopScreencast".into(), json!({})).await.map(|_| ())
}

/// Forgets a tab's screencast without asking the page anything, as when the tab is destroyed.
pub fn remove(id: &str) {
    if let Some(cast) = CASTS.lock().ok().and_then(|mut casts| casts.remove(id)) { let _ = cast.worker.send(Message::Stop); }
}

/// Forgets every screencast, as when the UI reloads and closes all its tabs.
pub fn remove_all() {
    let Ok(mut casts) = CASTS.lock() else { return };
    for (_, cast) in casts.drain() { let _ = cast.worker.send(Message::Stop); }
}

fn stop_local(view: &tauri::Webview, id: &str) -> bool {
    let Some(cast) = CASTS.lock().ok().and_then(|mut casts| casts.remove(id)) else { return false };
    let _ = cast.worker.send(Message::Stop);
    unregister(view, cast.token);
    true
}

fn unregister(view: &tauri::Webview, token: i64) {
    let _ = view.with_webview(move |platform| unsafe {
        if let Ok(receiver) = platform.controller().CoreWebView2().and_then(|webview| webview.GetDevToolsProtocolEventReceiver(&HSTRING::from(FRAME_EVENT))) {
            let _ = receiver.remove_DevToolsProtocolEventReceived(token);
        }
    });
}

fn acknowledge(view: &tauri::Webview, session: i64) {
    let _ = view.with_webview(move |platform| unsafe {
        let done = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(|_, _| Ok(())));
        if let Ok(webview) = platform.controller().CoreWebView2() {
            let _ = webview.CallDevToolsProtocolMethod(&HSTRING::from("Page.screencastFrameAck"), &HSTRING::from(json!({ "sessionId": session }).to_string()), &done);
        }
    });
}

/// Sends each frame's JPEG to the recorder as it arrives and acknowledges it when the rate allows.
fn pump(view: tauri::Webview, frames: mpsc::Receiver<Message>, channel: Channel<InvokeResponseBody>, interval: Duration) {
    let mut pending: VecDeque<(i64, Instant)> = VecDeque::new();
    let mut next = None;
    loop {
        let wait = pending.front().map_or(Duration::from_secs(1), |(_, due)| due.saturating_duration_since(Instant::now()));
        match frames.recv_timeout(wait) {
            Ok(Message::Frame(text, at)) => {
                if text.len() > MAX_FRAME_JSON { continue; }
                let Ok(event) = serde_json::from_str::<Value>(&text) else { continue };
                let Some(session) = event["sessionId"].as_i64() else { continue };
                if let Some(bytes) = event["data"].as_str().and_then(|data| base64::engine::general_purpose::STANDARD.decode(data).ok()) {
                    if channel.send(InvokeResponseBody::Raw(bytes)).is_err() { break; }
                }
                let (due, following) = crate::browser_control::ack_at(at, next, interval);
                next = Some(following);
                pending.push_back((session, due));
            }
            Ok(Message::Stop) | Err(mpsc::RecvTimeoutError::Disconnected) => break,
            Err(mpsc::RecvTimeoutError::Timeout) => {}
        }
        while pending.front().is_some_and(|(_, due)| *due <= Instant::now()) {
            if let Some((session, _)) = pending.pop_front() { acknowledge(&view, session); }
        }
    }
}
