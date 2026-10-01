use crate::browser::{only_main, view_of};
use serde_json::Value;
use tauri::{AppHandle, Webview};

#[tauri::command]
pub async fn browser_protocol(app: AppHandle, webview: Webview, id: String, method: String, params: Value) -> Result<Value, String> {
    only_main(&webview)?;
    if !["Runtime.evaluate", "Page.captureScreenshot", "Input.dispatchMouseEvent", "Input.dispatchKeyEvent", "Input.insertText", "Emulation.setDeviceMetricsOverride", "Emulation.clearDeviceMetricsOverride"].contains(&method.as_str()) {
        return Err(format!("browser protocol method {method:?} is not supported"));
    }
    if !params.is_object() || params.to_string().len() > 128 * 1024 { return Err("browser params must be an object smaller than 128 KB".into()); }
    let view = view_of(&app, &id)?;
    #[cfg(windows)]
    { crate::platform::browser_control::call(view, method, params).await }
    #[cfg(not(windows))]
    { let _ = (view, method, params); Err("browser automation currently requires Windows WebView2".into()) }
}
