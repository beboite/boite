//! This app's door onto configuration sync.
//!
//! A codec, like every other file beside it: the trust boundary, the work and
//! the refusals all live in `boite_core::command`, and what is left here is
//! naming the command and handing over what the webview sent.
//!
//! Every one of these carries the store, because `Sync::prepare` reads which
//! switches the user set out of the settings row rather than being told by the
//! caller. That is what keeps "is this source on" to one answer: a webview that
//! passed its own list could disagree with the one it had just saved.

use serde_json::{json, Value};
use tauri::AppHandle;
use tauri::State;

use boite_core::command::{Command, Sync};
use boite_core::scope::ProjectRoots;

use super::bus::{self, DesktopHost};
use super::records::Rows;

/// Puts a sync command through the bus with this app's store behind it.
async fn on_sync(
    app: &AppHandle,
    scope: &ProjectRoots,
    rows: &Rows,
    command: Sync,
) -> Result<Value, String> {
    let store = rows.get(app)?;
    bus::through(DesktopHost::new(scope).with_store(store), Command::Sync(command)).await
}

fn decode(method: &str, params: Value) -> Result<Sync, String> {
    match Command::decode(method, &params)? {
        Command::Sync(command) => Ok(command),
        other => Err(format!("{} is not a sync command", other.name())),
    }
}

macro_rules! sync_command {
    ($name:ident, $method:literal) => {
        #[tauri::command]
        pub async fn $name(
            app: AppHandle,
            scope: State<'_, ProjectRoots>,
            rows: State<'_, Rows>,
            params: Option<Value>,
        ) -> Result<Value, String> {
            let command = decode($method, params.unwrap_or_else(|| json!({})))?;
            on_sync(&app, scope.inner(), rows.inner(), command).await
        }
    };
}

sync_command!(sync_sources, "sync.sources");
sync_command!(sync_status, "sync.status");
sync_command!(sync_probe, "sync.probe");
sync_command!(sync_pull, "sync.pull");
sync_command!(sync_conflicts, "sync.conflicts");
sync_command!(sync_resolve, "sync.resolve");
sync_command!(sync_skip, "sync.skip");
sync_command!(sync_push, "sync.push");
sync_command!(sync_cancel, "sync.cancel");
sync_command!(sync_dismiss, "sync.dismiss");
sync_command!(sync_repair, "sync.repair");
