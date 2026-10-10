//! WebView2's own devtools channel; no debugging server or port is opened.
use serde_json::Value;
use std::{sync::mpsc, time::Duration};
use webview2_com::CallDevToolsProtocolMethodCompletedHandler;
use windows::core::HSTRING;

/// How long the shell's own commands (screencast, diagnostics, cookies) wait for an answer.
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(15);

/// `call_within` with the shell's own wait, for the shell's own commands.
pub async fn call(view: tauri::Webview, method: String, params: Value) -> Result<Value, String> {
    call_within(view, method, params, DEFAULT_TIMEOUT).await
}

/// Sends one DevTools method to the page and waits up to `timeout` for its answer.
pub async fn call_within(view: tauri::Webview, method: String, params: Value, timeout: Duration) -> Result<Value, String> {
    let (sender, receiver) = mpsc::channel();
    let args = serde_json::to_string(&params).map_err(|e| e.to_string())?;
    let name = method.clone();
    view.with_webview(move |platform| {
        let failed = sender.clone();
        let callback = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(move |result, json| {
            let answer = result.map_err(|e| e.to_string()).and_then(|_| {
                if json.len() > 8 * 1024 * 1024 { return Err("browser result exceeds 8 MB".into()); }
                serde_json::from_str::<Value>(&json).map_err(|e| format!("invalid browser result: {e}"))
            });
            let _ = sender.send(answer);
            Ok(())
        }));
        let result = unsafe {
            platform.controller().CoreWebView2().and_then(|webview| {
                webview.CallDevToolsProtocolMethod(&HSTRING::from(method), &HSTRING::from(args), &callback)
            })
        };
        if let Err(error) = result { let _ = failed.send(Err(error.to_string())); }
    }).map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || receiver.recv_timeout(timeout)
        .map_err(|_| format!("browser command {name} timed out after {} seconds", timeout.as_secs()))?)
        .await.map_err(|e| e.to_string())?
}
