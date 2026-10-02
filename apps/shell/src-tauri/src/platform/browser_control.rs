//! WebView2's own devtools channel; no debugging server or port is opened.
use serde_json::Value;
use std::{sync::mpsc, time::Duration};
use webview2_com::CallDevToolsProtocolMethodCompletedHandler;
use windows::core::HSTRING;

pub async fn call(view: tauri::Webview, method: String, params: Value) -> Result<Value, String> {
    let (sender, receiver) = mpsc::channel();
    let args = serde_json::to_string(&params).map_err(|e| e.to_string())?;
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
    tauri::async_runtime::spawn_blocking(move || receiver.recv_timeout(Duration::from_secs(15))
        .map_err(|_| "browser command timed out after 15 seconds".to_owned())?)
        .await.map_err(|e| e.to_string())?
}
