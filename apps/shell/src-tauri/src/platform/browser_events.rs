//! DevTools events of an agent surface, relayed to the UI, which hands them to
//! the core's agent browser. The UI plays the browser end of the protocol and
//! the shell forwards each page's events, as the core would read them from a
//! debugging port that a surface never opens.
use std::{collections::HashMap, sync::{LazyLock, Mutex, mpsc}, time::Duration};
use tauri::ipc::Channel;
use webview2_com::{CoTaskMemPWSTR, DevToolsProtocolEventReceivedEventHandler};
use windows::core::{HSTRING, PWSTR};

/// Larger than any page event worth relaying: a screencast frame is a few
/// hundred KB, and the UI would have to hold the whole text at once.
const MAX_EVENT_JSON: usize = 16 * 1024 * 1024;

enum Message { Event(&'static str, String), Stop }
struct Subscription { tokens: Vec<(&'static str, i64)>, worker: mpsc::Sender<Message> }
static SUBSCRIPTIONS: LazyLock<Mutex<HashMap<String, Subscription>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

/// Registers one handler per event name on the surface, replacing the
/// surface's previous ones. The names were checked by the command.
pub async fn subscribe(view: tauri::Webview, id: String, events: Vec<String>, channel: Channel<String>) -> Result<(), String> {
    if let Some(previous) = take(&id) { end(&view, previous); }
    let mut names: Vec<&'static str> = Vec::new();
    for event in &events {
        let Some(name) = crate::browser_control::AGENT_EVENTS.iter().copied().find(|name| *name == event) else {
            return Err(format!("browser protocol event {event:?} is not relayed"));
        };
        if !names.contains(&name) { names.push(name); }
    }
    if names.is_empty() { return Ok(()); }
    let (worker, received) = mpsc::channel();
    let (sender, receiver) = mpsc::channel();
    let events = worker.clone();
    view.with_webview(move |platform| {
        let register = || -> windows::core::Result<Vec<(&'static str, i64)>> { unsafe {
            let webview = platform.controller().CoreWebView2()?;
            let mut tokens = Vec::new();
            for name in names {
                // The handler only copies the event off the window thread; the worker builds and sends the message.
                let events = events.clone();
                let handler = DevToolsProtocolEventReceivedEventHandler::create(Box::new(move |_, args| {
                    if let Some(args) = args {
                        let mut raw = PWSTR::null(); args.ParameterObjectAsJson(&mut raw)?;
                        let text = CoTaskMemPWSTR::from(raw).to_string();
                        if text.len() <= MAX_EVENT_JSON { let _ = events.send(Message::Event(name, text)); }
                    }
                    Ok(())
                }));
                let mut token = 0;
                let added = webview.GetDevToolsProtocolEventReceiver(&HSTRING::from(name))
                    .and_then(|receiver| receiver.add_DevToolsProtocolEventReceived(&handler, &mut token));
                if let Err(error) = added {
                    // Half a subscription is none: the ones already added go too.
                    for (name, token) in tokens {
                        if let Ok(receiver) = webview.GetDevToolsProtocolEventReceiver(&HSTRING::from(name)) { let _ = receiver.remove_DevToolsProtocolEventReceived(token); }
                    }
                    return Err(error);
                }
                tokens.push((name, token));
            }
            Ok(tokens)
        }};
        let _ = sender.send(register().map_err(|error| error.to_string()));
    }).map_err(|error| error.to_string())?;
    let tokens = tauri::async_runtime::spawn_blocking(move || receiver.recv_timeout(Duration::from_secs(10)).map_err(|_| "subscribing to browser protocol events timed out".to_owned())?)
        .await.map_err(|error| error.to_string())??;
    let relay = std::thread::Builder::new().name("browser-events".into()).spawn(move || pump(received, channel));
    if let Err(error) = relay {
        end(&view, Subscription { tokens, worker });
        return Err(error.to_string());
    }
    // Two calls for the same surface can race: the later insert wins and ends the other.
    let replaced = SUBSCRIPTIONS.lock().map_err(|_| "browser protocol events are unavailable")?.insert(id, Subscription { tokens, worker });
    if let Some(replaced) = replaced { end(&view, replaced); }
    Ok(())
}

/// Forgets a surface's subscription without touching the page, as when the surface is destroyed.
pub fn remove(id: &str) {
    if let Some(subscription) = take(id) { let _ = subscription.worker.send(Message::Stop); }
}

/// Forgets every subscription, as when the UI reloads and closes all its surfaces.
pub fn remove_all() {
    let Ok(mut subscriptions) = SUBSCRIPTIONS.lock() else { return };
    for (_, subscription) in subscriptions.drain() { let _ = subscription.worker.send(Message::Stop); }
}

fn take(id: &str) -> Option<Subscription> {
    SUBSCRIPTIONS.lock().ok().and_then(|mut subscriptions| subscriptions.remove(id))
}

/// Stops the relay and removes the subscription's handlers from the page.
fn end(view: &tauri::Webview, subscription: Subscription) {
    let _ = subscription.worker.send(Message::Stop);
    let tokens = subscription.tokens;
    let _ = view.with_webview(move |platform| unsafe {
        let Ok(webview) = platform.controller().CoreWebView2() else { return };
        for (name, token) in tokens {
            if let Ok(receiver) = webview.GetDevToolsProtocolEventReceiver(&HSTRING::from(name)) { let _ = receiver.remove_DevToolsProtocolEventReceived(token); }
        }
    });
}

/// The params text is spliced in as WebView2 gave it: re-parsing a large event
/// on every delivery would cost more than the relay itself.
fn pump(events: mpsc::Receiver<Message>, channel: Channel<String>) {
    while let Ok(Message::Event(name, params)) = events.recv() {
        if channel.send(crate::browser_control::event_message(name, &params)).is_err() { break; }
    }
}
