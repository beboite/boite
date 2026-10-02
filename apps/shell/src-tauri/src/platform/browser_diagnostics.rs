//! Bounded DevTools observations. No request bodies, headers or remote debugging port.
use serde_json::{json, Value};
use std::{collections::{HashMap, VecDeque}, sync::{LazyLock, Mutex, mpsc}, time::{Duration, SystemTime, UNIX_EPOCH}};
use webview2_com::{CoTaskMemPWSTR, DevToolsProtocolEventReceivedEventHandler};
use windows::core::{HSTRING, PWSTR};

#[derive(Default)]
struct Log { entries: VecDeque<Value>, dropped: u64 }
static LOGS: LazyLock<Mutex<HashMap<String, Log>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

fn short(value: &str) -> String { value.chars().take(2000).collect() }
fn url(value: &Value) -> String {
    value.as_str().and_then(|value| tauri::Url::parse(value).ok()).map(|mut u| {
        u.set_query(None); u.set_fragment(None); let _ = u.set_username(""); let _ = u.set_password(None); short(u.as_str())
    }).unwrap_or_default()
}
fn entry(method: &str, data: &Value) -> Option<Value> {
    let at = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64;
    match method {
        "Runtime.consoleAPICalled" => Some(json!({ "at": at, "kind": "console", "level": data["type"].as_str().unwrap_or("log"),
            "text": short(&data["args"].as_array().map(|args| args.iter().take(12).map(|arg| {
                if let Some(value) = arg.get("value") { value.as_str().map(str::to_owned).unwrap_or_else(|| value.to_string()) }
                else { arg["description"].as_str().unwrap_or("[object]").to_owned() }
            }).collect::<Vec<_>>().join(" ")).unwrap_or_default()) })),
        "Runtime.exceptionThrown" => Some(json!({ "at": at, "kind": "exception", "level": "error",
            "text": short(data["exceptionDetails"]["exception"]["description"].as_str().or(data["exceptionDetails"]["text"].as_str()).unwrap_or("JavaScript exception")),
            "url": url(&data["exceptionDetails"]["url"]) })),
        "Network.loadingFailed" => Some(json!({ "at": at, "kind": "network", "level": "error", "text": short(data["errorText"].as_str().unwrap_or("Request failed")) })),
        "Network.responseReceived" if data["response"]["status"].as_u64().unwrap_or(0) >= 400 => Some(json!({ "at": at, "kind": "network", "level": "error",
            "text": format!("HTTP {}", data["response"]["status"]), "url": url(&data["response"]["url"]) })),
        _ => None,
    }
}
pub fn read(id: &str, clear: bool) -> Result<Value, String> {
    let mut logs = LOGS.lock().map_err(|_| "browser diagnostics are unavailable")?;
    let log = logs.get_mut(id).ok_or("browser diagnostics are not attached")?;
    let result = json!({ "entries": log.entries, "dropped": log.dropped });
    if clear { log.entries.clear(); log.dropped = 0; }
    Ok(result)
}
pub fn remove(id: &str) { if let Ok(mut logs) = LOGS.lock() { logs.remove(id); } }

pub async fn attach(view: tauri::Webview, id: String) -> Result<(), String> {
    LOGS.lock().map_err(|_| "browser diagnostics are unavailable")?.insert(id.clone(), Log::default());
    let (sender, receiver) = mpsc::channel();
    let failed_id = id.clone();
    let native = view.clone();
    native.with_webview(move |platform| {
        let register = || -> windows::core::Result<()> { unsafe {
            let webview = platform.controller().CoreWebView2()?;
            for method in ["Runtime.consoleAPICalled", "Runtime.exceptionThrown", "Network.loadingFailed", "Network.responseReceived"] {
                let target = id.clone();
                let handler = DevToolsProtocolEventReceivedEventHandler::create(Box::new(move |_, args| {
                    if let Some(args) = args {
                        let mut raw = PWSTR::null(); args.ParameterObjectAsJson(&mut raw)?;
                        let allocated = CoTaskMemPWSTR::from(raw);
                        let text = allocated.to_string();
                        if text.len() <= 128 * 1024 {
                            if let Ok(data) = serde_json::from_str::<Value>(&text) {
                                if let Some(value) = entry(method, &data) {
                                    if let Ok(mut logs) = LOGS.lock() {
                                        if let Some(log) = logs.get_mut(&target) {
                                            if log.entries.len() >= 200 { log.entries.pop_front(); log.dropped += 1; }
                                            log.entries.push_back(value);
                                        }
                                    }
                                }
                            }
                        } else if let Ok(mut logs) = LOGS.lock() { if let Some(log) = logs.get_mut(&target) { log.dropped += 1; } }
                    }
                    Ok(())
                }));
                let receiver = webview.GetDevToolsProtocolEventReceiver(&HSTRING::from(method))?;
                let mut token = 0; receiver.add_DevToolsProtocolEventReceived(&handler, &mut token)?;
            }
            Ok(())
        }};
        let _ = sender.send(register().map_err(|error| error.to_string()));
    }).map_err(|error| error.to_string())?;
    let result = tauri::async_runtime::spawn_blocking(move || receiver.recv_timeout(Duration::from_secs(10)).map_err(|_| "browser diagnostics timed out".to_owned())?)
        .await.map_err(|error| error.to_string())?;
    if result.is_err() { remove(&failed_id); }
    result?;
    super::browser_control::call(view.clone(), "Runtime.enable".into(), json!({})).await?;
    super::browser_control::call(view, "Network.enable".into(), json!({ "maxTotalBufferSize": 0, "maxResourceBufferSize": 0 })).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn diagnostics_keep_bounded_text_and_omit_network_credentials_and_bodies() {
        let value = entry("Network.responseReceived", &json!({"response":{"status":404,"url":"https://user:password@example.com/missing?token=secret#value","headers":{"authorization":"secret"}}})).unwrap();
        assert_eq!(value["url"], "https://example.com/missing");
        assert!(!value.to_string().contains("secret"));
        let exception = entry("Runtime.exceptionThrown", &json!({"exceptionDetails":{"text":"x".repeat(5000)}})).unwrap();
        assert_eq!(exception["text"].as_str().unwrap().len(), 2000);
        assert!(entry("Network.responseReceived", &json!({"response":{"status":200}})).is_none());
    }
}
