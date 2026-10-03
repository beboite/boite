//! Whether the user is at the PC, for the UI's attention report
//! (`packages/ui/src/lib/attention.ts`): the core holds back push about a
//! conversation someone is looking at, and a webview cannot tell on its own
//! that its window is behind another one, the screen locked or the PC left.

use serde::Serialize;
use tauri::Webview;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Presence {
    /// Since the last key or mouse move anywhere in the session; null where the OS does not say.
    idle_ms: Option<u64>,
    /// The Boite window is the one in front.
    foreground: bool,
}

#[tauri::command]
pub fn user_presence(webview: Webview) -> Result<Presence, String> {
    crate::quota_window::only_ui(&webview)?;
    Ok(Presence { idle_ms: crate::platform::idle_ms(), foreground: crate::platform::foreground(&webview.window()) })
}